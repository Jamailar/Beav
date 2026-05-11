use base64::Engine;
use reqwest::blocking::{Client, multipart};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::commands::library::persist_media_workspace_catalog;
use crate::helpers::{file_url_for_path, storage_safe_file_stem};
use crate::persistence::{ensure_store_hydrated_for_subjects, with_store, with_store_mut};
use crate::{
    AppState, MediaAssetRecord, SubjectRecord, file_content_hash, guess_mime_and_kind, make_id,
    media_root, normalize_legacy_workspace_path, now_iso, now_rfc3339,
    official_ai_api_key_from_settings, official_base_url_from_settings, payload_field,
    payload_string, persist_subjects_workspace, subjects_root, workspace_root,
};

const DEFAULT_CLONE_MODEL: &str = "minimax-voice-clone";
const DEFAULT_TTS_MODEL: &str = "speech-2.8-turbo";

#[derive(Debug, Clone)]
struct VoiceGatewayConfig {
    base_url: String,
    api_key: Option<String>,
    clone_model: String,
    tts_model: String,
}

fn payload_string_alias(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| payload_string(payload, key))
}

fn payload_bool_alias(payload: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| payload_field(payload, key).and_then(Value::as_bool))
}

fn clean_base_url(value: String) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn resolve_voice_config(
    state: &State<'_, AppState>,
    payload: Option<&Value>,
) -> Result<VoiceGatewayConfig, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let base_url = payload
        .and_then(|value| payload_string_alias(value, &["baseUrl", "base_url", "endpoint"]))
        .or_else(|| payload_string(&settings, "voice_endpoint"))
        .or_else(|| payload_string(&settings, "tts_endpoint"))
        .or_else(|| payload_string(&settings, "api_endpoint"))
        .unwrap_or_else(|| official_base_url_from_settings(&settings));
    let api_key = payload
        .and_then(|value| payload_string_alias(value, &["apiKey", "api_key"]))
        .or_else(|| payload_string(&settings, "voice_api_key"))
        .or_else(|| payload_string(&settings, "tts_api_key"))
        .or_else(|| payload_string(&settings, "api_key"))
        .or_else(|| official_ai_api_key_from_settings(&settings))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let clone_model = payload
        .and_then(|value| payload_string(value, "model"))
        .or_else(|| payload_string(&settings, "voice_clone_model"))
        .unwrap_or_else(|| DEFAULT_CLONE_MODEL.to_string());
    let tts_model = payload
        .and_then(|value| payload_string(value, "model"))
        .or_else(|| payload_string(&settings, "voice_tts_model"))
        .or_else(|| payload_string(&settings, "tts_model"))
        .unwrap_or_else(|| DEFAULT_TTS_MODEL.to_string());

    let base_url = clean_base_url(base_url);
    if base_url.is_empty() {
        return Err("voice gateway endpoint is not configured".to_string());
    }
    Ok(VoiceGatewayConfig {
        base_url,
        api_key,
        clone_model,
        tts_model,
    })
}

fn gateway_url(config: &VoiceGatewayConfig, path: &str) -> String {
    format!("{}/{}", config.base_url, path.trim_start_matches('/'))
}

fn authorized_request(
    client: &Client,
    method: reqwest::Method,
    url: &str,
    api_key: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    let request = client.request(method, url);
    match api_key.map(str::trim).filter(|value| !value.is_empty()) {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

fn extract_voice_id(value: &Value) -> Option<String> {
    payload_string_alias(value, &["voice_id", "voiceId"]).or_else(|| {
        value
            .get("data")
            .and_then(|data| payload_string_alias(data, &["voice_id", "voiceId"]))
    })
}

fn normalize_voice_response(value: Value, fallback_name: Option<String>) -> Result<Value, String> {
    let voice_id = extract_voice_id(&value)
        .ok_or_else(|| "voice clone response did not include voice_id".to_string())?;
    Ok(json!({
        "voiceId": voice_id,
        "voice_id": voice_id,
        "name": payload_string_alias(&value, &["name", "voiceName"])
            .or(fallback_name)
            .unwrap_or_default(),
        "language": payload_string(&value, "language"),
        "status": payload_string(&value, "status").unwrap_or_else(|| "ready".to_string()),
        "createdAt": payload_field(&value, "created_at")
            .or_else(|| payload_field(&value, "createdAt"))
            .cloned()
            .unwrap_or_else(|| json!(now_iso())),
    }))
}

fn voice_list_item_id(value: &Value) -> Option<String> {
    payload_string_alias(value, &["voice_id", "voiceId", "id", "value"]).or_else(|| {
        value
            .get("data")
            .and_then(|data| payload_string_alias(data, &["voice_id", "voiceId", "id", "value"]))
    })
}

fn voice_list_item_name(value: &Value) -> Option<String> {
    payload_string_alias(value, &["name", "title", "voiceName"]).or_else(|| {
        value
            .get("data")
            .and_then(|data| payload_string_alias(data, &["name", "title", "voiceName"]))
    })
}

fn voice_list_item_is_usable(value: &Value) -> bool {
    let status = payload_string(value, "status")
        .or_else(|| {
            value
                .get("data")
                .and_then(|data| payload_string(data, "status"))
        })
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    !matches!(
        status.as_str(),
        "failed" | "error" | "dead_lettered" | "deleted" | "cancelled" | "canceled"
    )
}

fn delete_platform_voice(config: &VoiceGatewayConfig, voice_id: &str) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let response = authorized_request(
        &client,
        reqwest::Method::DELETE,
        &gateway_url(config, &format!("/audio/voices/{voice_id}")),
        config.api_key.as_deref(),
    )
    .send()
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("voice delete failed with HTTP {status}: {body}"));
    }
    Ok(())
}

fn voice_list_items_from_value(value: &Value) -> Vec<Value> {
    if let Some(items) = value.as_array() {
        return items.clone();
    }
    if voice_list_item_id(value).is_some() {
        return vec![value.clone()];
    }
    for key in ["voices", "items", "data", "results"] {
        if let Some(nested) = value.get(key) {
            let items = voice_list_items_from_value(nested);
            if !items.is_empty() {
                return items;
            }
        }
    }
    Vec::new()
}

fn subject_voice_list_items(state: &State<'_, AppState>) -> Result<Vec<Value>, String> {
    ensure_store_hydrated_for_subjects(state)?;
    with_store(state, |store| {
        Ok(store
            .subjects
            .iter()
            .filter_map(|subject| {
                let voice = subject.voice.as_ref()?;
                let voice_id = payload_string_alias(voice, &["voiceId", "voice_id"])?;
                let status = payload_string(voice, "status").unwrap_or_else(|| "ready".to_string());
                if !voice_list_item_is_usable(voice) {
                    return None;
                }
                Some(json!({
                    "id": voice_id,
                    "value": voice_id,
                    "voiceId": voice_id,
                    "voice_id": voice_id,
                    "name": subject.name,
                    "title": subject.name,
                    "status": status,
                    "source": "subject",
                    "ownerAssetId": subject.id,
                    "assetId": subject.id,
                    "subjectId": subject.id,
                    "sampleFilePath": subject.voice_path,
                    "language": payload_string(voice, "language"),
                }))
            })
            .collect())
    })
}

fn subject_voice_id(
    state: &State<'_, AppState>,
    subject_id: &str,
) -> Result<Option<String>, String> {
    ensure_store_hydrated_for_subjects(state)?;
    with_store(state, |store| {
        Ok(store
            .subjects
            .iter()
            .find(|subject| subject.id == subject_id)
            .and_then(|subject| subject.voice.as_ref())
            .and_then(|voice| payload_string_alias(voice, &["voiceId", "voice_id"])))
    })
}

fn resolve_sample_path(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<(PathBuf, Option<String>), String> {
    let path = payload_string_alias(
        payload,
        &[
            "samplePath",
            "sampleFilePath",
            "filePath",
            "path",
            "voicePath",
        ],
    )
    .ok_or_else(|| "voice.clone requires samplePath".to_string())?;
    let owner_asset_id = payload_string_alias(payload, &["ownerAssetId", "assetId", "subjectId"]);
    let candidate = PathBuf::from(path.trim());
    if candidate.is_absolute() {
        return Ok((normalize_legacy_workspace_path(&candidate), owner_asset_id));
    }
    if let Some(asset_id) = owner_asset_id.as_deref().filter(|value| !value.is_empty()) {
        let resolved = subjects_root(state)?.join(asset_id).join(&candidate);
        return Ok((normalize_legacy_workspace_path(&resolved), owner_asset_id));
    }
    let resolved = workspace_root(state)?.join(candidate);
    Ok((normalize_legacy_workspace_path(&resolved), owner_asset_id))
}

fn voice_clone_sample_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn is_direct_voice_clone_sample(path: &Path) -> bool {
    matches!(
        voice_clone_sample_extension(path).as_str(),
        "mp3" | "wav" | "m4a"
    )
}

fn is_transcodable_voice_clone_sample(path: &Path) -> bool {
    matches!(
        voice_clone_sample_extension(path).as_str(),
        "aac" | "flac" | "ogg" | "opus" | "webm"
    )
}

fn transcode_voice_clone_sample_to_wav(path: &Path) -> Result<PathBuf, String> {
    let output_path = std::env::temp_dir().join(format!("{}-voice-clone.wav", make_id("redbox")));
    let output = Command::new("ffmpeg")
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(path)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("24000")
        .arg("-f")
        .arg("wav")
        .arg(&output_path)
        .output()
        .map_err(|error| {
            format!("声音复刻样本需要转成 wav，但无法启动 ffmpeg：{error}。请改用 mp3、wav 或 m4a 文件。")
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&output_path);
        return Err(if detail.is_empty() {
            "声音复刻样本转码失败，请改用 mp3、wav 或 m4a 文件。".to_string()
        } else {
            format!("声音复刻样本转码失败：{detail}")
        });
    }
    Ok(output_path)
}

fn prepare_voice_clone_sample_upload(path: &Path) -> Result<(PathBuf, Option<PathBuf>), String> {
    if is_direct_voice_clone_sample(path) {
        return Ok((path.to_path_buf(), None));
    }
    if is_transcodable_voice_clone_sample(path) {
        let converted = transcode_voice_clone_sample_to_wav(path)?;
        return Ok((converted.clone(), Some(converted)));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown");
    Err(format!(
        "声音复刻样本格式不支持：{}。请使用 mp3、wav 或 m4a 文件。",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(extension)
    ))
}

pub(crate) fn clone_voice(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let config = resolve_voice_config(state, Some(payload))?;
    let Some(api_key) = config.api_key.as_deref() else {
        return Err("voice clone requires an API key".to_string());
    };
    let owner_asset_id = payload_string_alias(payload, &["ownerAssetId", "assetId", "subjectId"]);
    if let Some(sample_file_key) =
        payload_string_alias(payload, &["sampleFileKey", "sample_file_key"])
            .filter(|value| !value.trim().is_empty())
    {
        return clone_voice_from_managed_key(
            state,
            payload,
            &config,
            api_key,
            owner_asset_id,
            sample_file_key,
        );
    }
    let (sample_path, owner_asset_id) = resolve_sample_path(state, payload)?;
    let (upload_path, temporary_upload_path) = prepare_voice_clone_sample_upload(&sample_path)?;
    let expected_bytes = fs::metadata(&upload_path)
        .map_err(|error| {
            format!(
                "failed to read voice sample metadata {}: {error}",
                upload_path.display()
            )
        })?
        .len();
    let bytes = fs::read(&upload_path).map_err(|error| {
        format!(
            "failed to read voice sample {}: {error}",
            upload_path.display()
        )
    })?;
    if bytes.len() as u64 != expected_bytes {
        return Err(format!(
            "音频采样文件读取不完整：{expected_bytes} 字节预期，实际 {} 字节",
            bytes.len()
        ));
    }
    let file_name = upload_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("voice-sample.wav")
        .to_string();
    let (mime_type, _, _) = guess_mime_and_kind(&upload_path);
    if let Some(temp_path) = temporary_upload_path.as_deref() {
        let _ = fs::remove_file(temp_path);
    }
    let part = match multipart::Part::bytes(bytes.clone())
        .file_name(file_name.clone())
        .mime_str(&mime_type)
    {
        Ok(typed_part) => typed_part,
        Err(_) => multipart::Part::bytes(bytes).file_name(file_name),
    };
    let name = payload_string(payload, "name").or_else(|| {
        sample_path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(ToString::to_string)
    });
    let mut form = multipart::Form::new().part("file", part);
    if let Some(value) = name.as_deref().filter(|value| !value.trim().is_empty()) {
        form = form.text("name", value.to_string());
    }
    if let Some(value) =
        payload_string(payload, "language").filter(|value| !value.trim().is_empty())
    {
        form = form.text("language", value);
    }
    let model = payload_string(payload, "model").unwrap_or_else(|| config.clone_model.clone());
    if !model.trim().is_empty() {
        form = form.text("model", model);
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;
    let url = gateway_url(&config, "/audio/voices/clone");
    let response = authorized_request(&client, reqwest::Method::POST, &url, Some(api_key))
        .multipart(form)
        .send()
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("voice clone failed with HTTP {status}: {body}"));
    }
    let raw = serde_json::from_str::<Value>(&body).map_err(|error| error.to_string())?;
    let voice = normalize_voice_response(raw.clone(), name)?;
    if owner_asset_id.is_some()
        && payload_bool_alias(payload, &["writeBack", "write_back"]).unwrap_or(true)
    {
        if let Some(subject_id) = owner_asset_id.as_deref() {
            let previous_voice_id = subject_voice_id(state, subject_id)?;
            patch_subject_voice_state(state, subject_id, voice.clone())?;
            if let (Some(previous), Some(next)) = (
                previous_voice_id,
                payload_string_alias(&voice, &["voiceId", "voice_id"]),
            ) {
                if previous != next {
                    let _ = delete_platform_voice(&config, &previous);
                }
            }
        }
    }
    Ok(json!({
        "success": true,
        "voice": voice,
        "ownerAssetId": owner_asset_id,
        "samplePath": sample_path.display().to_string(),
        "raw": raw,
    }))
}

fn clone_voice_from_managed_key(
    state: &State<'_, AppState>,
    payload: &Value,
    config: &VoiceGatewayConfig,
    api_key: &str,
    owner_asset_id: Option<String>,
    sample_file_key: String,
) -> Result<Value, String> {
    let model = payload_string(payload, "model").unwrap_or_else(|| config.clone_model.clone());
    let name = payload_string(payload, "name");
    let mut body = Map::new();
    body.insert(
        "sample_file_key".to_string(),
        json!(sample_file_key.clone()),
    );
    if let Some(value) = name.as_deref().filter(|value| !value.trim().is_empty()) {
        body.insert("name".to_string(), json!(value));
    }
    if let Some(value) =
        payload_string(payload, "language").filter(|value| !value.trim().is_empty())
    {
        body.insert("language".to_string(), json!(value));
    }
    if !model.trim().is_empty() {
        body.insert("model".to_string(), json!(model));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;
    let response = authorized_request(
        &client,
        reqwest::Method::POST,
        &gateway_url(config, "/audio/voices/clone"),
        Some(api_key),
    )
    .json(&Value::Object(body))
    .send()
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("voice clone failed with HTTP {status}: {body}"));
    }
    let raw = serde_json::from_str::<Value>(&body).map_err(|error| error.to_string())?;
    let mut voice = normalize_voice_response(raw.clone(), name)?;
    if let Some(object) = voice.as_object_mut() {
        object.insert("sampleFileKey".to_string(), json!(sample_file_key.clone()));
    }
    if owner_asset_id.is_some()
        && payload_bool_alias(payload, &["writeBack", "write_back"]).unwrap_or(true)
    {
        if let Some(subject_id) = owner_asset_id.as_deref() {
            let previous_voice_id = subject_voice_id(state, subject_id)?;
            patch_subject_voice_state(state, subject_id, voice.clone())?;
            if let (Some(previous), Some(next)) = (
                previous_voice_id,
                payload_string_alias(&voice, &["voiceId", "voice_id"]),
            ) {
                if previous != next {
                    let _ = delete_platform_voice(config, &previous);
                }
            }
        }
    }
    Ok(json!({
        "success": true,
        "voice": voice,
        "ownerAssetId": owner_asset_id,
        "sampleFileKey": sample_file_key,
        "raw": raw,
    }))
}

pub(crate) fn list_voices(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let mut voices = Vec::new();
    let mut seen = HashSet::new();
    let mut local_subject_voice_names = HashSet::new();
    for item in subject_voice_list_items(state)? {
        if voice_list_item_is_usable(&item) {
            if let Some(name) = voice_list_item_name(&item) {
                local_subject_voice_names.insert(name.trim().to_ascii_lowercase());
            }
            if let Some(id) = voice_list_item_id(&item) {
                if seen.insert(id) {
                    voices.push(item);
                }
            }
        }
    }

    let push_remote_voice = |voices: &mut Vec<Value>,
                             seen: &mut HashSet<String>,
                             local_subject_voice_names: &HashSet<String>,
                             config: &VoiceGatewayConfig,
                             item: Value| {
        if !voice_list_item_is_usable(&item) {
            if let Some(id) = voice_list_item_id(&item) {
                let _ = delete_platform_voice(config, &id);
            }
            return;
        }
        if let Some(name) = voice_list_item_name(&item) {
            if local_subject_voice_names.contains(&name.trim().to_ascii_lowercase()) {
                return;
            }
        }
        if let Some(id) = voice_list_item_id(&item) {
            if seen.insert(id) {
                voices.push(item);
            }
        }
    };

    let config = match resolve_voice_config(state, Some(payload)) {
        Ok(config) => config,
        Err(error) => {
            return Ok(json!({ "success": true, "voices": voices, "configError": error }));
        }
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;
    let response = match authorized_request(
        &client,
        reqwest::Method::GET,
        &gateway_url(&config, "/audio/voices"),
        config.api_key.as_deref(),
    )
    .send()
    {
        Ok(response) => response,
        Err(error) => {
            return Ok(json!({
                "success": true,
                "voices": voices,
                "remoteError": error.to_string(),
            }));
        }
    };
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Ok(json!({
            "success": true,
            "voices": voices,
            "remoteError": format!("voice list failed with HTTP {status}: {body}"),
        }));
    }
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| json!({ "raw": body }));
    for item in voice_list_items_from_value(&parsed) {
        push_remote_voice(
            &mut voices,
            &mut seen,
            &local_subject_voice_names,
            &config,
            item,
        );
    }
    Ok(json!({ "success": true, "voices": voices, "raw": parsed }))
}

pub(crate) fn get_voice(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let voice_id = payload_string_alias(payload, &["voiceId", "voice_id", "id"])
        .ok_or_else(|| "voice.get requires voiceId".to_string())?;
    let config = resolve_voice_config(state, Some(payload))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;
    let response = authorized_request(
        &client,
        reqwest::Method::GET,
        &gateway_url(&config, &format!("/audio/voices/{voice_id}")),
        config.api_key.as_deref(),
    )
    .send()
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("voice get failed with HTTP {status}: {body}"));
    }
    let voice = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| json!({ "raw": body }));
    Ok(json!({ "success": true, "voice": voice }))
}

pub(crate) fn delete_voice(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let voice_id = payload_string_alias(payload, &["voiceId", "voice_id", "id"])
        .ok_or_else(|| "voice.delete requires voiceId".to_string())?;
    let config = resolve_voice_config(state, Some(payload))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;
    let response = authorized_request(
        &client,
        reqwest::Method::DELETE,
        &gateway_url(&config, &format!("/audio/voices/{voice_id}")),
        config.api_key.as_deref(),
    )
    .send()
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("voice delete failed with HTTP {status}: {body}"));
    }
    Ok(json!({ "success": true, "voiceId": voice_id }))
}

fn content_type_to_extension(content_type: Option<&str>, fallback: &str) -> String {
    let normalized = content_type.unwrap_or("").to_ascii_lowercase();
    if normalized.contains("wav") {
        "wav".to_string()
    } else if normalized.contains("mpeg") || normalized.contains("mp3") {
        "mp3".to_string()
    } else if normalized.contains("ogg") {
        "ogg".to_string()
    } else if normalized.contains("webm") {
        "webm".to_string()
    } else {
        fallback.to_string()
    }
}

fn decode_audio_response(
    content_type: Option<&str>,
    bytes: Vec<u8>,
    fallback_ext: &str,
) -> Result<(Vec<u8>, String), String> {
    let is_json = content_type
        .map(|value| value.to_ascii_lowercase().contains("json"))
        .unwrap_or(false);
    if !is_json {
        return Ok((bytes, content_type_to_extension(content_type, fallback_ext)));
    }
    let value = serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string())?;
    let audio_base64 = payload_string_alias(&value, &["b64_json", "audio", "audio_base64"])
        .or_else(|| {
            value
                .get("data")
                .and_then(|data| payload_string_alias(data, &["b64_json", "audio", "audio_base64"]))
        })
        .ok_or_else(|| "speech response JSON did not include audio bytes".to_string())?;
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|error| error.to_string())?;
    Ok((audio, fallback_ext.to_string()))
}

pub(crate) fn synthesize_speech(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let input = payload_string(payload, "input")
        .or_else(|| payload_string(payload, "text"))
        .ok_or_else(|| "voice.speech requires input".to_string())?;
    let voice_id = payload_string_alias(payload, &["voiceId", "voice_id", "voice"])
        .ok_or_else(|| "voice.speech requires voiceId".to_string())?;
    let config = resolve_voice_config(state, Some(payload))?;
    let model = payload_string(payload, "model").unwrap_or_else(|| config.tts_model.clone());
    let response_format = payload_string_alias(payload, &["responseFormat", "response_format"])
        .unwrap_or_else(|| "mp3".to_string());
    let mut body = Map::new();
    body.insert("model".to_string(), json!(model.clone()));
    body.insert("input".to_string(), json!(input));
    body.insert("voice_id".to_string(), json!(voice_id));
    body.insert(
        "response_format".to_string(),
        json!(response_format.clone()),
    );
    body.insert("return_audio_binary".to_string(), json!(true));
    if let Some(language_boost) =
        payload_string_alias(payload, &["languageBoost", "language_boost"])
    {
        body.insert("language_boost".to_string(), json!(language_boost));
    }
    if let Some(extra) = payload_field(payload, "extra").and_then(Value::as_object) {
        for (key, value) in extra {
            body.entry(key.clone()).or_insert(value.clone());
        }
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;
    let response = authorized_request(
        &client,
        reqwest::Method::POST,
        &gateway_url(&config, "/audio/speech"),
        config.api_key.as_deref(),
    )
    .json(&Value::Object(body))
    .send()
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let bytes = response
        .bytes()
        .map_err(|error| error.to_string())?
        .to_vec();
    if !status.is_success() {
        let text = String::from_utf8_lossy(&bytes);
        return Err(format!("voice speech failed with HTTP {status}: {text}"));
    }
    let (audio_bytes, extension) =
        decode_audio_response(content_type.as_deref(), bytes, response_format.as_str())?;
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher.update(voice_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let title = payload_string(payload, "title").unwrap_or_else(|| {
        let stem = input.chars().take(24).collect::<String>();
        if stem.trim().is_empty() {
            "TTS".to_string()
        } else {
            stem
        }
    });
    let file_stem = storage_safe_file_stem(&format!("{}-{}", title, &digest[..12]));
    let relative_path = format!("generated/tts/{file_stem}.{extension}");
    let absolute_path = media_root(state)?.join(&relative_path);
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&absolute_path, audio_bytes).map_err(|error| error.to_string())?;
    let (mime_type, _, _) = guess_mime_and_kind(&absolute_path);
    let now = now_rfc3339();
    let asset = MediaAssetRecord {
        id: make_id("media"),
        source: "generated".to_string(),
        source_domain: Some("voice".to_string()),
        source_link: Some(format!("voice:{voice_id}")),
        project_id: payload_string(payload, "projectId"),
        title: Some(title),
        prompt: Some(input),
        provider: Some("voice".to_string()),
        provider_template: Some("tts".to_string()),
        model: Some(model),
        aspect_ratio: None,
        size: None,
        quality: None,
        mime_type: Some(mime_type),
        content_hash: file_content_hash(&absolute_path).ok(),
        relative_path: Some(relative_path.clone()),
        bound_manuscript_path: payload_string(payload, "boundManuscriptPath"),
        created_at: now.clone(),
        updated_at: now,
        absolute_path: Some(absolute_path.display().to_string()),
        preview_url: Some(file_url_for_path(&absolute_path)),
        exists: true,
    };
    with_store_mut(state, |store| {
        store.media_assets.insert(0, asset.clone());
        Ok(())
    })?;
    persist_media_workspace_catalog(state)?;
    Ok(json!({
        "success": true,
        "asset": asset,
        "voiceId": voice_id,
        "path": absolute_path.display().to_string(),
        "relativePath": relative_path,
    }))
}

fn voice_status(record: &SubjectRecord) -> Option<String> {
    record
        .voice
        .as_ref()
        .and_then(|value| payload_string(value, "status"))
}

fn subject_voice_has_id(record: &SubjectRecord) -> bool {
    record
        .voice
        .as_ref()
        .and_then(|value| payload_string_alias(value, &["voiceId", "voice_id"]))
        .is_some()
}

pub(crate) fn spawn_subject_voice_clone_if_needed(
    app: &AppHandle,
    record: &SubjectRecord,
) -> Result<(), String> {
    if record.voice_path.is_none() || subject_voice_has_id(record) {
        return Ok(());
    }
    if !matches!(
        voice_status(record).as_deref(),
        Some("queued") | Some("failed") | None
    ) {
        return Ok(());
    }
    let state = app.state::<AppState>();
    let payload = voice_clone_payload_for_subject(record)?;
    let submitted =
        match crate::media_runtime::submit_media_job(app, &state, "voice_clone", &payload) {
            Ok(value) => value,
            Err(error) => {
                let _ = patch_subject_voice_failure(&state, &record.id, error);
                return Ok(());
            }
        };
    let job_id = submitted
        .get("jobId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut queued = json!({
        "status": "queued",
        "jobId": job_id,
        "updatedAt": now_iso(),
    });
    if let Some(path) = payload.get("samplePath").cloned() {
        queued["sampleFilePath"] = path;
    }
    patch_subject_voice_state(&state, &record.id, queued)?;
    Ok(())
}

fn voice_clone_payload_for_subject(subject: &SubjectRecord) -> Result<Value, String> {
    let relative_path = subject
        .voice_path
        .clone()
        .ok_or_else(|| "subject has no voice sample".to_string())?;
    let mut payload = json!({
        "ownerAssetId": subject.id,
        "samplePath": relative_path,
        "name": subject.name,
        "writeBack": true,
    });
    if let Some(language) = subject
        .voice
        .as_ref()
        .and_then(|value| payload_string(value, "language"))
    {
        payload["language"] = json!(language);
    }
    Ok(payload)
}

fn patch_subject_voice_state(
    state: &State<'_, AppState>,
    subject_id: &str,
    voice: Value,
) -> Result<(), String> {
    ensure_store_hydrated_for_subjects(state)?;
    let root = subjects_root(state)?;
    let (categories, mut subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    let Some(index) = subjects.iter().position(|subject| subject.id == subject_id) else {
        return Ok(());
    };
    let mut merged = subjects[index].voice.clone().unwrap_or_else(|| json!({}));
    if !merged.is_object() {
        merged = json!({});
    }
    if let (Some(target), Some(source)) = (merged.as_object_mut(), voice.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
        target.insert("updatedAt".to_string(), json!(now_iso()));
        target.remove("lastError");
    }
    subjects[index].voice = Some(merged);
    subjects[index].updated_at = now_iso();
    persist_subjects_workspace(&root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(())
    })
}

pub(crate) fn bind_subject_voice(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let subject_id = payload_string_alias(payload, &["ownerAssetId", "assetId", "subjectId", "id"])
        .ok_or_else(|| "voice.bindAsset requires ownerAssetId".to_string())?;
    let voice_id = payload_string_alias(payload, &["voiceId", "voice_id", "voice"])
        .ok_or_else(|| "voice.bindAsset requires voiceId".to_string())?;
    ensure_store_hydrated_for_subjects(state)?;
    let exists = with_store(state, |store| {
        Ok(store
            .subjects
            .iter()
            .any(|subject| subject.id == subject_id))
    })?;
    if !exists {
        return Ok(json!({ "success": false, "error": "资产不存在" }));
    }
    let mut voice = json!({
        "voiceId": voice_id,
        "voice_id": voice_id,
        "status": payload_string(payload, "status").unwrap_or_else(|| "ready".to_string()),
        "updatedAt": now_iso(),
    });
    for key in [
        "name",
        "language",
        "cloneModel",
        "provider",
        "sampleFileKey",
        "sampleFilePath",
    ] {
        if let Some(value) = payload_field(payload, key).cloned() {
            voice[key] = value;
        }
    }
    patch_subject_voice_state(state, &subject_id, voice.clone())?;
    Ok(json!({ "success": true, "ownerAssetId": subject_id, "voice": voice }))
}

pub(crate) fn patch_subject_voice_queued(
    state: &State<'_, AppState>,
    subject_id: &str,
    job_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let mut voice = json!({
        "status": "queued",
        "jobId": job_id,
        "updatedAt": now_iso(),
    });
    if let Some(path) = payload_string_alias(payload, &["samplePath", "sampleFilePath"]) {
        voice["sampleFilePath"] = json!(path);
    }
    if let Some(key) = payload_string_alias(payload, &["sampleFileKey", "sample_file_key"]) {
        voice["sampleFileKey"] = json!(key);
    }
    if let Some(language) = payload_string(payload, "language") {
        voice["language"] = json!(language);
    }
    patch_subject_voice_state(state, subject_id, voice)
}

pub(crate) fn patch_subject_voice_failure(
    state: &State<'_, AppState>,
    subject_id: &str,
    error: String,
) -> Result<(), String> {
    ensure_store_hydrated_for_subjects(state)?;
    let root = subjects_root(state)?;
    let (categories, mut subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    let Some(index) = subjects.iter().position(|subject| subject.id == subject_id) else {
        return Ok(());
    };
    let mut merged = subjects[index].voice.clone().unwrap_or_else(|| json!({}));
    if !merged.is_object() {
        merged = json!({});
    }
    if let Some(target) = merged.as_object_mut() {
        target.insert("status".to_string(), json!("failed"));
        target.insert("lastError".to_string(), json!(error));
        target.insert("updatedAt".to_string(), json!(now_iso()));
    }
    subjects[index].voice = Some(merged);
    subjects[index].updated_at = now_iso();
    persist_subjects_workspace(&root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(())
    })
}
