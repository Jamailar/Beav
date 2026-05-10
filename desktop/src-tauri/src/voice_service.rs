use base64::Engine;
use reqwest::blocking::{multipart, Client};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::commands::library::persist_media_workspace_catalog;
use crate::helpers::{file_url_for_path, storage_safe_file_stem};
use crate::persistence::{ensure_store_hydrated_for_subjects, with_store, with_store_mut};
use crate::{
    guess_mime_and_kind, make_id, media_root, normalize_legacy_workspace_path, now_iso,
    now_rfc3339, official_ai_api_key_from_settings, official_base_url_from_settings, payload_field,
    payload_string, persist_subjects_workspace, subjects_root, workspace_root, AppState,
    MediaAssetRecord, SubjectRecord,
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

pub(crate) fn clone_voice(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let config = resolve_voice_config(state, Some(payload))?;
    let Some(api_key) = config.api_key.as_deref() else {
        return Err("voice clone requires an API key".to_string());
    };
    let (sample_path, owner_asset_id) = resolve_sample_path(state, payload)?;
    let bytes = fs::read(&sample_path).map_err(|error| {
        format!(
            "failed to read voice sample {}: {error}",
            sample_path.display()
        )
    })?;
    let file_name = sample_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("voice-sample.wav")
        .to_string();
    let (mime_type, _, _) = guess_mime_and_kind(&sample_path);
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
    Ok(json!({
        "success": true,
        "voice": voice,
        "ownerAssetId": owner_asset_id,
        "samplePath": sample_path.display().to_string(),
        "raw": raw,
    }))
}

pub(crate) fn list_voices(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let config = resolve_voice_config(state, Some(payload))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;
    let response = authorized_request(
        &client,
        reqwest::Method::GET,
        &gateway_url(&config, "/audio/voices"),
        config.api_key.as_deref(),
    )
    .send()
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("voice list failed with HTTP {status}: {body}"));
    }
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| json!({ "raw": body }));
    Ok(json!({ "success": true, "voices": parsed }))
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
    let app_handle = app.clone();
    let subject = record.clone();
    std::thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let result = clone_voice_for_subject(&state, &subject);
        let patch_result = match result {
            Ok(voice) => patch_subject_voice_state(&state, &subject.id, voice),
            Err(error) => patch_subject_voice_failure(&state, &subject.id, error),
        };
        if let Err(error) = patch_result {
            eprintln!("failed to update subject voice state: {error}");
        }
    });
    Ok(())
}

fn clone_voice_for_subject(
    state: &State<'_, AppState>,
    subject: &SubjectRecord,
) -> Result<Value, String> {
    let relative_path = subject
        .voice_path
        .clone()
        .ok_or_else(|| "subject has no voice sample".to_string())?;
    let mut payload = json!({
        "ownerAssetId": subject.id,
        "samplePath": relative_path,
        "name": subject.name,
    });
    if let Some(language) = subject
        .voice
        .as_ref()
        .and_then(|value| payload_string(value, "language"))
    {
        payload["language"] = json!(language);
    }
    clone_voice(state, &payload).and_then(|value| {
        value
            .get("voice")
            .cloned()
            .ok_or_else(|| "voice clone result did not include voice".to_string())
    })
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
        target.insert("status".to_string(), json!("ready"));
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

fn patch_subject_voice_failure(
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
