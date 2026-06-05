use std::fs;
use std::path::Path;

pub(super) fn wav_duration_seconds(path: &Path) -> Option<f64> {
    let metadata = fs::metadata(path).ok()?;
    let bytes = metadata.len().saturating_sub(44);
    if bytes == 0 {
        return None;
    }
    Some(bytes as f64 / 32_000.0)
}

fn split_transcript_cues(text: &str) -> Vec<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut cues = Vec::new();
    let mut current = String::new();
    for ch in normalized.chars() {
        current.push(ch);
        let punctuation = matches!(ch, '。' | '！' | '？' | '.' | '!' | '?' | ';' | '；');
        if current.chars().count() >= 32 || (punctuation && current.chars().count() >= 12) {
            cues.push(current.trim().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        cues.push(current.trim().to_string());
    }
    cues
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

pub(super) fn render_estimated_subtitles(
    text: &str,
    duration_seconds: f64,
    format: &str,
) -> Result<String, String> {
    reject_invalid_estimated_subtitle_text(text)?;
    let cues = split_transcript_cues(text);
    if cues.is_empty() {
        return Err("转写接口只返回了空文本，无法生成字幕".to_string());
    }
    let safe_duration = duration_seconds.max(cues.len() as f64 * 1.2);
    let cue_duration = safe_duration / cues.len() as f64;
    let mut output = String::new();
    if format == "vtt" {
        output.push_str("WEBVTT\n\n");
    }
    for (index, cue) in cues.iter().enumerate() {
        let start = index as f64 * cue_duration;
        let end = if index + 1 == cues.len() {
            safe_duration
        } else {
            (index + 1) as f64 * cue_duration
        };
        if format == "srt" {
            output.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                index + 1,
                format_srt_time(start),
                format_srt_time(end.max(start + 0.5)),
                cue
            ));
        } else {
            output.push_str(&format!(
                "{} --> {}\n{}\n\n",
                format_vtt_time(start),
                format_vtt_time(end.max(start + 0.5)),
                cue
            ));
        }
    }
    Ok(output)
}

fn reject_invalid_estimated_subtitle_text(text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("转写接口只返回了空文本，无法生成字幕".to_string());
    }
    let normalized = trimmed.to_ascii_lowercase();
    let is_provider_error = matches!(
        normalized.as_str(),
        "bad gateway" | "gateway timeout" | "service unavailable" | "upstream timeout"
    ) || normalized.contains("502 bad gateway")
        || normalized.contains("503 service unavailable")
        || normalized.contains("504 gateway timeout")
        || normalized.contains("upstream request timeout");
    if is_provider_error {
        return Err(format!("转写接口上游错误：{trimmed}"));
    }
    if trimmed.chars().count() < 2 {
        return Err("转写接口返回内容过短，无法生成字幕".to_string());
    }
    Ok(())
}
