use super::payload_string_any;
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{
    append_debug_trace_state, http_utils, official_access_token_from_settings,
    official_base_url_from_settings, official_unwrap_response_payload, AppState,
};
use reqwest::blocking::{multipart, Client};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tauri::State;

const TEMP_UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;
const TEMP_UPLOAD_MAX_ATTEMPTS: usize = 2;

pub(super) fn upload_official_temp_file(
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
    use super::{guess_upload_content_type, truncate_upload_response};
    use std::path::Path;

    #[test]
    fn upload_content_type_covers_media_extensions() {
        assert_eq!(
            guess_upload_content_type(Path::new("clip.mp4")),
            "video/mp4"
        );
        assert_eq!(
            guess_upload_content_type(Path::new("voice.wav")),
            "audio/wav"
        );
        assert_eq!(
            guess_upload_content_type(Path::new("unknown.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn upload_response_truncation_handles_empty_and_long_values() {
        assert_eq!(truncate_upload_response("   "), "<empty response>");
        let long = "a".repeat(501);
        assert_eq!(truncate_upload_response(&long).chars().count(), 503);
    }
}
