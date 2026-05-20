use crate::media_runtime;
use crate::persistence::with_store;
use crate::*;
use reqwest::blocking::{multipart, Client};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, State};

const TEMP_UPLOAD_MAX_BYTES: u64 = 100 * 1024 * 1024;
const TEMP_UPLOAD_MAX_ATTEMPTS: usize = 2;
const VIDEO_RETALK_MIN_EDGE: u32 = 640;
const VIDEO_RETALK_MAX_EDGE: u32 = 2048;
const VIDEO_RETALK_DEFAULT_SHORT_EDGE: u32 = 720;
const VIDEO_RETALK_HIGH_SHORT_EDGE: u32 = 1080;

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
            Some(prepare_video_retalk_source(app, state, payload))
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
                        .unwrap_or(30 * 60 * 1000);
                    media_runtime::await_media_job_completion(state, &job_id, timeout_ms)
                }),
        ),
        "generation:get-runtime-status" => Some(Ok(json!({
            "success": true,
            "runtimeReady": media_runtime::ensure_media_runtime_ready(state).is_ok(),
            "runtimeRunning": state
                .media_generation_runtime
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false),
        }))),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy)]
struct VideoDimensions {
    width: u32,
    height: u32,
}

fn resolve_local_video_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("generation:prepare-video-retalk-source requires path".to_string());
    }
    let normalized = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let candidate = PathBuf::from(normalized);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root(state)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(candidate)
    };
    if !resolved.is_file() {
        return Err(format!(
            "VideoRetalk reference video does not exist: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn probe_video_dimensions(app: &AppHandle, path: &Path) -> Result<VideoDimensions, String> {
    let output = crate::background_command(crate::ffmpeg_runtime::ffprobe_executable(Some(app))?)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("failed to start ffprobe: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "failed to inspect VideoRetalk reference video: {}",
            if stderr.is_empty() {
                "ffprobe exited with error".to_string()
            } else {
                stderr
            }
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("failed to parse ffprobe output: {error}"))?;
    let stream = value
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "VideoRetalk reference video has no video stream".to_string())?;
    let width = stream
        .get("width")
        .and_then(Value::as_u64)
        .ok_or_else(|| "VideoRetalk reference video is missing width metadata".to_string())?;
    let height = stream
        .get("height")
        .and_then(Value::as_u64)
        .ok_or_else(|| "VideoRetalk reference video is missing height metadata".to_string())?;
    if width == 0 || height == 0 || width > u32::MAX as u64 || height > u32::MAX as u64 {
        return Err("VideoRetalk reference video has invalid dimensions".to_string());
    }
    Ok(VideoDimensions {
        width: width as u32,
        height: height as u32,
    })
}

fn even_ceil(value: f64) -> u32 {
    let rounded = value.ceil() as u32;
    if rounded % 2 == 0 {
        rounded
    } else {
        rounded + 1
    }
}

fn even_floor(value: f64) -> u32 {
    let rounded = value.floor() as u32;
    if rounded % 2 == 0 {
        rounded
    } else {
        rounded.saturating_sub(1)
    }
}

fn video_retalk_target_short_edge(resolution: Option<&str>) -> u32 {
    match resolution
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "1080p" | "1080" | "fullhd" | "full_hd" | "fhd" => VIDEO_RETALK_HIGH_SHORT_EDGE,
        "720p" | "720" | "hd" => VIDEO_RETALK_DEFAULT_SHORT_EDGE,
        _ => VIDEO_RETALK_DEFAULT_SHORT_EDGE,
    }
}

fn target_video_retalk_dimensions(
    dimensions: VideoDimensions,
    target_short_edge: u32,
) -> Result<Option<VideoDimensions>, String> {
    let min_edge = dimensions.width.min(dimensions.height);
    let max_edge = dimensions.width.max(dimensions.height);
    let target_short_edge = target_short_edge.clamp(VIDEO_RETALK_MIN_EDGE, VIDEO_RETALK_MAX_EDGE);
    if min_edge >= target_short_edge && max_edge <= VIDEO_RETALK_MAX_EDGE {
        return Ok(None);
    }
    let target = if max_edge > VIDEO_RETALK_MAX_EDGE {
        let scale = VIDEO_RETALK_MAX_EDGE as f64 / max_edge as f64;
        VideoDimensions {
            width: even_floor(dimensions.width as f64 * scale),
            height: even_floor(dimensions.height as f64 * scale),
        }
    } else {
        let scale = target_short_edge as f64 / min_edge as f64;
        let scaled_width = dimensions.width as f64 * scale;
        let scaled_height = dimensions.height as f64 * scale;
        let scaled_max = scaled_width.max(scaled_height);
        if scaled_max > VIDEO_RETALK_MAX_EDGE as f64 {
            let fallback_scale = VIDEO_RETALK_MAX_EDGE as f64 / max_edge as f64;
            VideoDimensions {
                width: even_floor(dimensions.width as f64 * fallback_scale),
                height: even_floor(dimensions.height as f64 * fallback_scale),
            }
        } else {
            VideoDimensions {
                width: even_ceil(scaled_width),
                height: even_ceil(scaled_height),
            }
        }
    };
    let target_min = target.width.min(target.height);
    let target_max = target.width.max(target.height);
    if target_min < VIDEO_RETALK_MIN_EDGE || target_max > VIDEO_RETALK_MAX_EDGE {
        return Err(format!(
            "VideoRetalk reference video aspect ratio cannot fit {}~{}px bounds without cropping: {}x{}",
            VIDEO_RETALK_MIN_EDGE,
            VIDEO_RETALK_MAX_EDGE,
            dimensions.width,
            dimensions.height
        ));
    }
    Ok(Some(target))
}

fn prepare_video_retalk_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let path = payload_string_any(payload, &["path", "filePath", "sourcePath"])
        .ok_or_else(|| "generation:prepare-video-retalk-source requires path".to_string())?;
    if path.trim().starts_with("http://") || path.trim().starts_with("https://") {
        return Ok(json!({
            "success": true,
            "path": path,
            "normalized": false,
            "remote": true,
        }));
    }
    let source_path = resolve_local_video_path(state, &path)?;
    let source_dimensions = probe_video_dimensions(app, &source_path)?;
    let target_short_edge =
        video_retalk_target_short_edge(payload_string_any(payload, &["resolution"]).as_deref());
    let Some(target_dimensions) =
        target_video_retalk_dimensions(source_dimensions, target_short_edge)?
    else {
        return Ok(json!({
            "success": true,
            "path": source_path.to_string_lossy(),
            "normalized": false,
            "width": source_dimensions.width,
            "height": source_dimensions.height,
        }));
    };

    let output_dir = media_root(state)
        .unwrap_or_else(|_| PathBuf::from("media"))
        .join("prepared")
        .join("video-retalk");
    fs::create_dir_all(&output_dir).map_err(|error| {
        format!("failed to create VideoRetalk prepared video directory: {error}")
    })?;
    let output_path = output_dir.join(format!("video-retalk-source-{}.mp4", now_ms()));
    let scale_filter = format!(
        "scale={}:{}:flags=lanczos",
        target_dimensions.width, target_dimensions.height
    );
    let output = crate::background_command(crate::ffmpeg_runtime::ffmpeg_executable(Some(app))?)
        .args(["-y", "-i"])
        .arg(&source_path)
        .args([
            "-vf",
            &scale_filter,
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ])
        .arg(&output_path)
        .output()
        .map_err(|error| format!("failed to start ffmpeg: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "failed to prepare VideoRetalk reference video: {}",
            if stderr.is_empty() {
                "ffmpeg exited with error".to_string()
            } else {
                stderr
            }
        ));
    }
    let prepared_dimensions = probe_video_dimensions(app, &output_path)?;
    Ok(json!({
        "success": true,
        "path": output_path.to_string_lossy(),
        "normalized": true,
        "width": prepared_dimensions.width,
        "height": prepared_dimensions.height,
        "sourceWidth": source_dimensions.width,
        "sourceHeight": source_dimensions.height,
        "targetShortEdge": target_short_edge,
    }))
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

    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
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

fn payload_string_any(payload: &Value, keys: &[&str]) -> Option<String> {
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
    use super::*;

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
