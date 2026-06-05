mod video_retalk;

use crate::media_runtime;
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::*;
use reqwest::blocking::{multipart, Client};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, State};

const TEMP_UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;
const TEMP_UPLOAD_MAX_ATTEMPTS: usize = 2;

pub fn handle_media_jobs_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "generation:submit-image" => Some(media_runtime::submit_media_job(
            app, state, "image", payload,
        )),
        "generation:submit-video" => Some(media_runtime::submit_media_job(
            app, state, "video", payload,
        )),
        "generation:submit-audio" => Some(media_runtime::submit_media_job(
            app, state, "audio", payload,
        )),
        "generation:submit-voice-clone" => Some(media_runtime::submit_media_job(
            app,
            state,
            "voice_clone",
            payload,
        )),
        "generation:upload-temp-file" => Some(upload_official_temp_file(state, payload)),
        "generation:prepare-video-retalk-source" => {
            Some(video_retalk::prepare_source(app, state, payload))
        }
        "generation:list-job-summaries" => {
            Some(media_runtime::list_media_job_summaries(state, payload))
        }
        "generation:list-jobs" => Some(media_runtime::list_media_jobs(state, payload)),
        "generation:get-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:get-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::get_media_job_projection(state, &job_id)),
        ),
        "generation:get-job-artifacts" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:get-job-artifacts requires jobId".to_string())
                .and_then(|job_id| media_runtime::get_media_job_artifacts(state, &job_id)),
        ),
        "generation:cancel-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:cancel-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::cancel_media_job(app, state, &job_id)),
        ),
        "generation:delete-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:delete-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::delete_media_job(app, state, &job_id)),
        ),
        "generation:retry-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:retry-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::retry_media_job(app, state, &job_id)),
        ),
        "generation:await-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:await-job requires jobId".to_string())
                .and_then(|job_id| {
                    let timeout_ms = payload_field(payload, "timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or_else(media_runtime::default_media_job_wait_timeout_ms);
                    media_runtime::await_media_job_completion(state, &job_id, timeout_ms)
                }),
        ),
        "generation:get-runtime-status" => Some((|| {
            let runtime_ready = media_runtime::ensure_media_runtime_ready(state).is_ok();
            let runtime_running = state
                .media_generation_runtime
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false);
            let pressure = media_runtime::media_runtime_pressure_snapshot(state).ok();
            Ok(json!({
                "success": true,
                "runtimeReady": runtime_ready,
                "runtimeRunning": runtime_running,
                "pressure": pressure,
            }))
        })()),
        _ => None,
    }
}

fn upload_official_temp_file(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let path = payload_string_any(payload, &["path", "filePath", "sourcePath"])
        .ok_or_else(|| "generation:upload-temp-file requires path".to_string())?;
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err(format!("file does not exist: {path}"));
    }

    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("failed to inspect upload file: {error}"))?;
    if metadata.len() == 0 {
        return Err("upload file is empty".to_string());
    }
    if metadata.len() > TEMP_UPLOAD_MAX_BYTES {
        return Err(format!(
            "upload file is too large: {} bytes exceeds {} bytes",
            metadata.len(),
            TEMP_UPLOAD_MAX_BYTES
        ));
    }

    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let access_token = official_access_token_from_settings(&settings)
        .ok_or_else(|| "official account login is required before uploading media".to_string())?;
    let base_url = official_base_url_from_settings(&settings);
    let endpoint = format!(
        "{}/{}",
        http_utils::normalize_base_url(&base_url),
        "upload/file-buffer"
    );

    let bytes =
        std::fs::read(file_path).map_err(|error| format!("failed to read upload file: {error}"))?;
    let file_name = payload_string_any(payload, &["fileName", "filename"]).unwrap_or_else(|| {
        file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("media-upload.bin")
            .to_string()
    });
    let content_type = payload_string_any(payload, &["contentType", "content_type"])
        .unwrap_or_else(|| guess_upload_content_type(file_path));
    let key_prefix = payload_string_any(payload, &["keyPrefix", "key_prefix"])
        .unwrap_or_else(|| "ai/digital-human".to_string());
    append_debug_trace_state(
        state,
        format!(
            "[media-upload] start path={} bytes={} contentType={} keyPrefix={}",
            file_path.display(),
            metadata.len(),
            content_type,
            key_prefix
        ),
    );

    let client = Client::builder()
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())?;
    let mut body = Value::Null;
    for attempt in 1..=TEMP_UPLOAD_MAX_ATTEMPTS {
        match upload_official_temp_file_once(
            &client,
            &endpoint,
            &access_token,
            &bytes,
            &file_name,
            &content_type,
            &key_prefix,
        ) {
            Ok(value) => {
                body = value;
                append_debug_trace_state(
                    state,
                    format!(
                        "[media-upload] done attempt={} bytes={} keyPrefix={}",
                        attempt,
                        metadata.len(),
                        key_prefix
                    ),
                );
                break;
            }
            Err(error) => {
                append_debug_trace_state(
                    state,
                    format!(
                        "[media-upload] failed attempt={} bytes={} keyPrefix={} error={}",
                        attempt,
                        metadata.len(),
                        key_prefix,
                        error
                    ),
                );
                if attempt >= TEMP_UPLOAD_MAX_ATTEMPTS {
                    return Err(error);
                }
            }
        }
    }

    let unwrapped = official_unwrap_response_payload(&body);
    let file_url = payload_string_any(&unwrapped, &["file_url", "fileUrl", "url"])
        .or_else(|| payload_string_any(&body, &["file_url", "fileUrl", "url"]))
        .ok_or_else(|| format!("official media upload response missing file_url: {body}"))?;

    Ok(json!({
        "success": true,
        "fileUrl": file_url,
        "url": file_url,
        "contentType": content_type,
        "keyPrefix": key_prefix,
        "upload": unwrapped,
    }))
}

fn upload_official_temp_file_once(
    client: &Client,
    endpoint: &str,
    access_token: &str,
    bytes: &[u8],
    file_name: &str,
    content_type: &str,
    key_prefix: &str,
) -> Result<Value, String> {
    let fallback_bytes = bytes.to_vec();
    let part = multipart::Part::bytes(bytes.to_vec())
        .file_name(file_name.to_string())
        .mime_str(content_type)
        .unwrap_or_else(|_| {
            multipart::Part::bytes(fallback_bytes).file_name(file_name.to_string())
        });
    let form = multipart::Form::new()
        .part("file", part)
        .text("key_prefix", key_prefix.to_string())
        .text("content_type", content_type.to_string());

    let response = client
        .post(endpoint)
        .bearer_auth(access_token)
        .multipart(form)
        .send()
        .map_err(|error| format!("official media upload failed: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|error| format!("failed to read upload response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "official media upload failed ({}): {}",
            status.as_u16(),
            truncate_upload_response(&text)
        ));
    }
    serde_json::from_str::<Value>(&text).map_err(|error| {
        format!(
            "official media upload returned invalid JSON ({}): {}: {}",
            status.as_u16(),
            error,
            truncate_upload_response(&text)
        )
    })
}

fn truncate_upload_response(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() > 500 {
        format!("{}...", trimmed.chars().take(500).collect::<String>())
    } else if trimmed.is_empty() {
        "<empty response>".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(super) fn payload_string_any(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload_string(payload, key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn guess_upload_content_type(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::video_retalk::{
        target_video_retalk_dimensions, video_retalk_target_short_edge, VideoDimensions,
    };

    #[test]
    fn video_retalk_1080p_preparation_upscales_short_edge() {
        let target = target_video_retalk_dimensions(
            VideoDimensions {
                width: 544,
                height: 960,
            },
            video_retalk_target_short_edge(Some("1080p")),
        )
        .expect("target dimensions")
        .expect("resize target");

        assert_eq!(target.width, 1080);
        assert_eq!(target.height, 1906);
    }

    #[test]
    fn video_retalk_1080p_keeps_existing_high_resolution_source() {
        let target = target_video_retalk_dimensions(
            VideoDimensions {
                width: 1080,
                height: 1920,
            },
            video_retalk_target_short_edge(Some("1080p")),
        )
        .expect("target dimensions");

        assert!(target.is_none());
    }
}
