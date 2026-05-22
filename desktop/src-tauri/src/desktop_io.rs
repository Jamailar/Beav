use arboard::{Clipboard, ImageData};
use base64::Engine;
use image::ImageReader;
use serde_json::Value;
use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use crate::{background_command, normalize_base_url, now_iso, payload_string, AdvisorVideoRecord};

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
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(normalized)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(normalized))
        .map_err(|error| format!("base64 decode failed: {error}"))?;
    fs::write(output_path, bytes).map_err(|error| error.to_string())?;
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
    run_curl_transcription_with_parse_format(
        endpoint,
        api_key,
        model_name,
        file_path,
        mime_type,
        response_format,
        None,
    )
}

pub(crate) fn run_curl_transcription_with_parse_format(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
    response_format: Option<&str>,
    parse_format: Option<&str>,
) -> Result<String, String> {
    let mut last_error = None;
    for attempt in 1..=3 {
        match run_curl_transcription_request(
            endpoint,
            api_key,
            model_name,
            file_path,
            mime_type,
            response_format,
        ) {
            Ok(stdout) => {
                let preferred_format = parse_format
                    .or(response_format)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("json");
                match parse_transcription_response(&stdout, preferred_format) {
                    Ok(transcript) => return Ok(transcript),
                    Err(error) if attempt < 3 && is_retryable_transcription_error(&error) => {
                        last_error = Some(error);
                        std::thread::sleep(std::time::Duration::from_millis(match attempt {
                            1 => 1_000,
                            2 => 3_000,
                            _ => 0,
                        }));
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) if attempt < 3 && is_retryable_transcription_error(&error) => {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(match attempt {
                    1 => 1_000,
                    2 => 3_000,
                    _ => 0,
                }));
            }
            Err(error) => return Err(error),
        }
    }
    Err(format!(
        "转写接口连续重试失败：{}",
        last_error.unwrap_or_else(|| "unknown transcription error".to_string())
    ))
}

fn run_curl_transcription_request(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
    response_format: Option<&str>,
) -> Result<String, String> {
    const HTTP_STATUS_MARKER: &str = "\n__redbox_http_status__:";
    let mut command = background_command("curl");
    command
        .arg("-sS")
        .arg("-X")
        .arg("POST")
        .arg(normalize_transcription_url(endpoint))
        .arg("-F")
        .arg(format!("model={model_name}"))
        .arg("-F")
        .arg(format!("file=@{};type={mime_type}", file_path.display()))
        .arg("-w")
        .arg(format!("{HTTP_STATUS_MARKER}%{{http_code}}"));
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
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "转写接口不可用：未找到 curl 程序".to_string()
        } else {
            error.to_string()
        }
    })?;
    let raw_stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let (stdout, http_status) = split_curl_http_status(&raw_stdout, HTTP_STATUS_MARKER)?;
    if !(200..300).contains(&http_status) {
        return Err(format!("转写接口 HTTP {http_status}: {}", stdout.trim()));
    }
    if stdout.trim().is_empty() {
        return Err("转写接口返回了空结果：服务响应 stdout 为空".to_string());
    }
    Ok(stdout.trim().to_string())
}

fn split_curl_http_status(stdout: &str, marker: &str) -> Result<(String, u16), String> {
    let Some((body, status)) = stdout.rsplit_once(marker) else {
        return Err("转写接口响应缺少 HTTP 状态码".to_string());
    };
    let status = status
        .trim()
        .parse::<u16>()
        .map_err(|error| format!("转写接口 HTTP 状态码无效：{error}"))?;
    Ok((body.to_string(), status))
}

fn is_retryable_transcription_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("http 502")
        || normalized.contains("http 503")
        || normalized.contains("http 504")
        || normalized.contains("bad gateway")
        || normalized.contains("service unavailable")
        || normalized.contains("gateway timeout")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("empty")
        || normalized.contains("空结果")
}

pub(crate) fn parse_transcription_response(
    stdout: &str,
    preferred_format: &str,
) -> Result<String, String> {
    let stdout = stdout.trim();
    if stdout.is_empty() {
        return Err("转写接口返回了空结果：服务响应 stdout 为空".to_string());
    }
    if looks_like_transcription_gateway_error(stdout) {
        return Err(format!("转写接口上游错误：{stdout}"));
    }
    if preferred_format != "json" && !stdout.starts_with('{') && !stdout.starts_with('[') {
        if is_subtitle_format(preferred_format) && !looks_like_subtitle(stdout, preferred_format) {
            return Err(format!(
                "转写接口返回了纯文本，不是 {} 字幕：缺少字幕序号/时间轴",
                preferred_format.to_ascii_uppercase()
            ));
        }
        return Ok(stdout.to_string());
    }

    let value: Value =
        serde_json::from_str(&stdout).map_err(|error| format!("Invalid JSON response: {error}"))?;
    if let Some(message) = transcription_error_message(&value) {
        return Err(format!("转写接口返回错误：{message}"));
    }
    let transcript = extract_transcription_text(&value, preferred_format).ok_or_else(|| {
        format!(
            "转写接口返回了空结果：未在响应中找到可用转写字段（{}）",
            transcription_response_shape(&value)
        )
    })?;
    if is_subtitle_format(preferred_format) && !looks_like_subtitle(&transcript, preferred_format) {
        return Err(format!(
            "转写接口返回了转录文本，但不是 {} 字幕：缺少字幕序号/时间轴（{}）",
            preferred_format.to_ascii_uppercase(),
            transcription_response_shape(&value)
        ));
    }
    Ok(transcript)
}

fn looks_like_transcription_gateway_error(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    matches!(
        normalized.as_str(),
        "bad gateway" | "gateway timeout" | "service unavailable" | "upstream timeout"
    ) || normalized.contains("502 bad gateway")
        || normalized.contains("503 service unavailable")
        || normalized.contains("504 gateway timeout")
        || normalized.contains("upstream request timeout")
}

fn extract_transcription_text(value: &Value, preferred_format: &str) -> Option<String> {
    if is_subtitle_format(preferred_format) {
        if let Some(text) = value
            .get(preferred_format)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            return Some(text.to_string());
        }
        if let Some(data) = value.get("data") {
            if let Some(text) = extract_transcription_text(data, preferred_format) {
                return Some(text);
            }
        }
        return extract_timed_segments(value, preferred_format);
    }

    for key in ["text", "transcript", "srt", "vtt", "content", "result"] {
        if let Some(text) = value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            return Some(text.to_string());
        }
    }
    if let Some(data) = value.get("data") {
        if let Some(text) = extract_transcription_text(data, preferred_format) {
            return Some(text);
        }
    }
    if let Some(text) = extract_timed_segments(value, preferred_format) {
        return Some(text);
    }
    None
}

fn extract_timed_segments(value: &Value, preferred_format: &str) -> Option<String> {
    let segments = value
        .get("segments")
        .or_else(|| value.get("sentences"))
        .or_else(|| value.pointer("/data/segments"))
        .or_else(|| value.pointer("/data/sentences"))
        .and_then(Value::as_array)?;
    if segments.is_empty() {
        return None;
    }
    if matches!(preferred_format, "srt" | "vtt") {
        let rendered = render_timed_segments(segments, preferred_format);
        if !rendered.trim().is_empty() {
            return Some(rendered);
        }
    }
    let text = segments
        .iter()
        .filter_map(segment_text)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn segment_text(segment: &Value) -> Option<String> {
    if let Some(text) = segment
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        return Some(text.to_string());
    }
    for key in ["text", "transcript", "content", "sentence"] {
        if let Some(text) = segment
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            return Some(text.to_string());
        }
    }
    None
}

fn segment_time_seconds(segment: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(number) = segment.get(key).and_then(Value::as_f64) {
            return Some(if number > 10_000.0 {
                number / 1000.0
            } else {
                number
            });
        }
        if let Some(text) = segment.get(key).and_then(Value::as_str) {
            if let Ok(number) = text.trim().parse::<f64>() {
                return Some(if number > 10_000.0 {
                    number / 1000.0
                } else {
                    number
                });
            }
        }
    }
    None
}

fn segment_duration_seconds(segment: &Value) -> Option<f64> {
    segment_time_seconds(segment, &["duration", "duration_s", "durationSeconds"])
}

fn format_srt_time(seconds: f64) -> String {
    let millis = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = millis / 3_600_000;
    let minutes = (millis % 3_600_000) / 60_000;
    let seconds = (millis % 60_000) / 1000;
    let millis = millis % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn format_vtt_time(seconds: f64) -> String {
    format_srt_time(seconds).replace(',', ".")
}

fn render_timed_segments(segments: &[Value], preferred_format: &str) -> String {
    let mut output = String::new();
    if preferred_format == "vtt" {
        output.push_str("WEBVTT\n\n");
    }
    let mut cue_index = 1usize;
    for segment in segments {
        let Some(text) = segment_text(segment) else {
            continue;
        };
        let start = segment_time_seconds(segment, &["start", "start_time", "startTime", "begin"])
            .or_else(|| segment_time_seconds(segment, &["from", "from_time", "fromTime"]));
        let Some(start) = start else {
            continue;
        };
        let end = segment_time_seconds(
            segment,
            &["end", "end_time", "endTime", "to", "to_time", "toTime"],
        )
        .or_else(|| segment_duration_seconds(segment).map(|duration| start + duration));
        let Some(end) = end else {
            continue;
        };
        if preferred_format == "srt" {
            output.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                cue_index,
                format_srt_time(start),
                format_srt_time(end.max(start + 0.1)),
                text
            ));
        } else {
            output.push_str(&format!(
                "{} --> {}\n{}\n\n",
                format_vtt_time(start),
                format_vtt_time(end.max(start + 0.1)),
                text
            ));
        }
        cue_index += 1;
    }
    output
}

fn is_subtitle_format(format: &str) -> bool {
    matches!(format, "srt" | "vtt")
}

fn looks_like_subtitle(value: &str, format: &str) -> bool {
    let trimmed = value.trim_start();
    if format == "vtt" && trimmed.starts_with("WEBVTT") {
        return true;
    }
    if format == "srt"
        && trimmed
            .lines()
            .any(|line| line.contains(" --> ") && line.contains(','))
    {
        return true;
    }
    trimmed.lines().any(|line| line.contains(" --> "))
}

fn transcription_response_shape(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let keys = object
                .keys()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            let segment_count = value
                .get("segments")
                .or_else(|| value.get("sentences"))
                .or_else(|| value.pointer("/data/segments"))
                .or_else(|| value.pointer("/data/sentences"))
                .and_then(Value::as_array)
                .map(|items| items.len());
            match segment_count {
                Some(count) => format!("topLevelKeys=[{keys}], segmentCount={count}"),
                None => format!("topLevelKeys=[{keys}]"),
            }
        }
        Value::Array(items) => format!("arrayLength={}", items.len()),
        _ => format!("jsonType={}", value_type_name(value)),
    }
}

fn transcription_error_message(value: &Value) -> Option<String> {
    let error = value
        .get("error")
        .or_else(|| value.pointer("/data/error"))?;
    if let Some(text) = error
        .as_str()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        return Some(text.to_string());
    }
    if let Some(message) = error
        .get("message")
        .or_else(|| error.get("msg"))
        .or_else(|| error.get("detail"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        return Some(message.to_string());
    }
    Some(error.to_string())
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn resolve_transcription_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String)> {
    let resolved = crate::ai_model_manager::AiModelManager::resolve(
        settings,
        crate::ai_model_manager::AiModelScope::Transcription,
        None,
    );
    let endpoint = resolved
        .as_ref()
        .map(|route| route.base_url.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "transcription_endpoint"))
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let model_name = resolved
        .as_ref()
        .map(|route| route.model_name.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "transcription_model"))?;
    let api_key = resolved
        .as_ref()
        .and_then(|route| route.api_key.clone())
        .or_else(|| payload_string(settings, "transcription_key"))
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
        let mut command = background_command("osascript");
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_plain_text_from_provider_json() {
        let value = json!({ "text": "  hello world  " });

        assert_eq!(
            extract_transcription_text(&value, "json").as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn renders_srt_from_segment_json() {
        let value = json!({
            "segments": [
                { "start": 0.0, "end": 1.5, "text": "第一句" },
                { "start": 1.5, "end": 3.0, "text": "第二句" }
            ]
        });
        let rendered = extract_transcription_text(&value, "srt").expect("srt");

        assert!(rendered.contains("1\n00:00:00,000 --> 00:00:01,500\n第一句"));
        assert!(rendered.contains("2\n00:00:01,500 --> 00:00:03,000\n第二句"));
    }

    #[test]
    fn rejects_plain_text_when_srt_was_requested() {
        let error = parse_transcription_response("hello world", "srt").expect_err("plain text");

        assert!(error.contains("不是 SRT 字幕"));
    }

    #[test]
    fn rejects_gateway_error_text_before_format_fallback() {
        let error = parse_transcription_response("Bad Gateway", "text").expect_err("gateway");

        assert!(error.contains("上游错误"));
    }

    #[test]
    fn parses_curl_http_status_marker() {
        let (body, status) = split_curl_http_status(
            "Bad Gateway\n__redbox_http_status__:502",
            "\n__redbox_http_status__:",
        )
        .expect("status marker");

        assert_eq!(body, "Bad Gateway");
        assert_eq!(status, 502);
    }

    #[test]
    fn rejects_text_field_when_srt_was_requested() {
        let value = json!({ "text": "hello world" });
        let error = parse_transcription_response(&value.to_string(), "srt").expect_err("text");

        assert!(error.contains("未在响应中找到可用转写字段"));
    }

    #[test]
    fn reports_provider_error_message() {
        let value = json!({ "error": { "message": "unsupported response_format" } });
        let error = parse_transcription_response(&value.to_string(), "srt").expect_err("provider");

        assert!(error.contains("unsupported response_format"));
    }

    #[test]
    fn skips_segments_without_timing_for_srt() {
        let value = json!({
            "segments": [
                { "text": "第一句" }
            ]
        });
        let error = parse_transcription_response(&value.to_string(), "srt").expect_err("timing");

        assert!(error.contains("不是 SRT 字幕"));
    }

    #[test]
    fn reports_shape_when_transcription_fields_are_missing() {
        let value = json!({ "segments": [], "request_id": "abc" });
        let shape = transcription_response_shape(&value);

        assert!(shape.contains("topLevelKeys=[request_id, segments]"));
        assert!(shape.contains("segmentCount=0"));
    }
}
