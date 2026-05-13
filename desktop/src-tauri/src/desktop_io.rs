use arboard::{Clipboard, ImageData};
use image::ImageReader;
use serde_json::Value;
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use crate::{
    configure_background_command, normalize_base_url, now_iso, now_ms, payload_string,
    AdvisorVideoRecord,
};

pub(crate) fn write_base64_payload_to_file(
    encoded: &str,
    output_path: &Path,
) -> Result<(), String> {
    let normalized = encoded
        .trim()
        .split_once(',')
        .map(|(_, payload)| payload.trim())
        .filter(|payload| !payload.is_empty())
        .unwrap_or_else(|| encoded.trim());
    let encoded_path = std::env::temp_dir().join(format!("redbox-audio-{}.b64", now_ms()));
    fs::write(&encoded_path, normalized).map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new("base64");
    configure_background_command(&mut command);
    let output = command
        .arg("-D")
        .arg("-i")
        .arg(&encoded_path)
        .arg("-o")
        .arg(output_path)
        .output()
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&encoded_path);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "base64 decode failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

pub(crate) fn normalize_transcription_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/audio/transcriptions") {
        normalized
    } else {
        format!("{normalized}/audio/transcriptions")
    }
}

pub(crate) fn run_curl_transcription(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    run_curl_transcription_with_response_format(
        endpoint, api_key, model_name, file_path, mime_type, None,
    )
}

pub(crate) fn run_curl_transcription_with_response_format(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
    response_format: Option<&str>,
) -> Result<String, String> {
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    command
        .arg("-sS")
        .arg("-X")
        .arg("POST")
        .arg(normalize_transcription_url(endpoint))
        .arg("-F")
        .arg(format!("model={model_name}"))
        .arg("-F")
        .arg(format!("file=@{};type={mime_type}", file_path.display()));
    if let Some(format) = response_format
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("-F").arg(format!("response_format={format}"));
    }
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err("转写接口返回了空结果".to_string());
    }

    let preferred_format = response_format
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("json");
    if preferred_format != "json" && !stdout.starts_with('{') && !stdout.starts_with('[') {
        return Ok(stdout);
    }

    let value: Value =
        serde_json::from_str(&stdout).map_err(|error| format!("Invalid JSON response: {error}"))?;
    let text = value
        .get("text")
        .or_else(|| value.get("transcript"))
        .or_else(|| value.get("srt"))
        .and_then(|item| item.as_str())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .ok_or_else(|| "转写接口返回了空结果".to_string())?;
    Ok(text)
}

pub(crate) fn resolve_transcription_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String)> {
    let endpoint = payload_string(settings, "transcription_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let model_name = payload_string(settings, "transcription_model")
        .or_else(|| Some("whisper-1".to_string()))?;
    let api_key = payload_string(settings, "transcription_key")
        .or_else(|| payload_string(settings, "api_key"));
    Some((endpoint, api_key, model_name))
}

const YTDLP_DISABLED_MESSAGE: &str = "内置 yt-dlp 服务已移除。";

fn is_probable_youtube_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

pub(crate) fn detect_ytdlp() -> Option<(String, String)> {
    None
}

pub(crate) fn fetch_ytdlp_channel_info(channel_url: &str, limit: i64) -> Result<Value, String> {
    let _ = (channel_url, limit);
    Err(YTDLP_DISABLED_MESSAGE.to_string())
}

pub(crate) fn parse_ytdlp_videos(
    advisor_id: &str,
    channel_id: Option<&str>,
    value: &Value,
) -> Vec<AdvisorVideoRecord> {
    value
        .get("entries")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())?;
            if !is_probable_youtube_video_id(&id) {
                return None;
            }
            let title = entry
                .get("title")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string())
                .unwrap_or_else(|| format!("Video {}", id));
            let published_at = entry
                .get("release_timestamp")
                .or_else(|| entry.get("timestamp"))
                .and_then(|item| item.as_i64())
                .map(|item| item.to_string())
                .or_else(|| {
                    entry
                        .get("upload_date")
                        .and_then(|item| item.as_str())
                        .map(|item| item.to_string())
                })
                .unwrap_or_else(now_iso);
            let video_url = entry
                .get("url")
                .or_else(|| entry.get("webpage_url"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string())
                .filter(|item| item.starts_with("http"))
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
            Some(AdvisorVideoRecord {
                id,
                advisor_id: advisor_id.to_string(),
                title,
                published_at,
                status: "pending".to_string(),
                retry_count: 0,
                error_message: None,
                subtitle_file: None,
                video_url: Some(video_url),
                channel_id: channel_id.map(|item| item.to_string()),
                created_at: now_iso(),
                updated_at: now_iso(),
            })
        })
        .collect()
}

pub(crate) fn download_ytdlp_subtitle(
    video_url: &str,
    target_dir: &Path,
    file_prefix: &str,
) -> Result<PathBuf, String> {
    let _ = (video_url, target_dir, file_prefix);
    Err(YTDLP_DISABLED_MESSAGE.to_string())
}

pub(crate) fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    if let Ok(reader) = ImageReader::open(path) {
        if let Ok(decoded) = reader.decode() {
            let rgba = decoded.to_rgba8();
            let width = usize::try_from(rgba.width())
                .map_err(|_| "image width is too large for clipboard".to_string())?;
            let height = usize::try_from(rgba.height())
                .map_err(|_| "image height is too large for clipboard".to_string())?;
            Clipboard::new()
                .and_then(|mut clipboard| {
                    clipboard.set_image(ImageData {
                        width,
                        height,
                        bytes: Cow::Owned(rgba.into_raw()),
                    })
                })
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
    }

    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let image_class = match ext.as_str() {
        "png" => Some("PNG picture"),
        "jpg" | "jpeg" => Some("JPEG picture"),
        "gif" => Some("GIF picture"),
        _ => None,
    };
    if let Some(image_class) = image_class {
        let script = format!(
            "set the clipboard to (read (POSIX file {}) as {})",
            format!("{:?}", path.display().to_string()),
            image_class
        );
        let mut command = std::process::Command::new("osascript");
        configure_background_command(&mut command);
        let output = command
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(());
        }
    }
    Err(format!(
        "无法将图片复制到剪贴板：暂不支持该图片格式 ({})",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
    ))
}
