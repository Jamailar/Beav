use crate::cli_runtime::{CliExecuteRequest, CliVerifyRule, run_managed_cli_command};
use crate::desktop_io::{
    resolve_transcription_settings, run_curl_transcription_with_response_format,
};
use crate::{AppState, make_id, now_ms, payload_string, workspace_root};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

fn resolve_media_transcribe_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let normalized = raw_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("media.transcribe requires a non-empty sourcePath".to_string());
    }
    let candidate = PathBuf::from(&normalized);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root(state)
            .map_err(|error| error.to_string())?
            .join(normalized)
    };
    if !resolved.is_file() {
        return Err(format!(
            "media.transcribe source file not found: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn normalize_transcript_format(value: Option<&str>) -> (&'static str, &'static str) {
    match value.unwrap_or("srt").trim().to_ascii_lowercase().as_str() {
        "txt" | "text" => ("text", "txt"),
        "vtt" | "webvtt" => ("vtt", "vtt"),
        "json" => ("json", "json"),
        "verbose_json" | "verbose-json" => ("verbose_json", "json"),
        _ => ("srt", "srt"),
    }
}

fn output_dir_for_request(
    state: &State<'_, AppState>,
    request: &Value,
    job_id: &str,
) -> Result<PathBuf, String> {
    let base = request
        .pointer("/output/directory")
        .or_else(|| request.get("outputDirectory"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                workspace_root(state)
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        })
        .unwrap_or_else(|| {
            workspace_root(state)
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".redbox")
                .join("media-transcripts")
        });
    let dir = base.join(job_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn extract_audio_for_transcription(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    source_path: &Path,
    output_dir: &Path,
) -> Result<PathBuf, String> {
    let audio_path = output_dir.join(format!("audio-{}.m4a", now_ms()));
    let args = vec![
        "-y".to_string(),
        "-i".to_string(),
        source_path.display().to_string(),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-ar".to_string(),
        "16000".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "96k".to_string(),
        audio_path.display().to_string(),
    ];
    let argv = std::iter::once("ffmpeg".to_string())
        .chain(args)
        .collect::<Vec<_>>();
    run_managed_cli_command(
        app,
        state,
        CliExecuteRequest {
            session_id: session_id.map(ToString::to_string),
            runtime_id: Some("media-transcribe".to_string()),
            tool_id: Some("ffmpeg".to_string()),
            argv,
            cwd: Some(output_dir.to_string_lossy().to_string()),
            verification_rules: vec![
                CliVerifyRule::ExitCode { expected: Some(0) },
                CliVerifyRule::FileExists {
                    path: audio_path.to_string_lossy().to_string(),
                },
            ],
            ..CliExecuteRequest::default()
        },
        8_000,
    )
    .map_err(|error| format!("ffmpeg audio extraction failed: {error}"))?;
    Ok(audio_path)
}

fn text_preview(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub(crate) fn execute_media_transcribe(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    request: &Value,
) -> Result<Value, String> {
    let source_path = request
        .get("sourcePath")
        .or_else(|| request.get("path"))
        .or_else(|| request.get("toolPath"))
        .and_then(Value::as_str)
        .ok_or_else(|| "media.transcribe requires sourcePath".to_string())?;
    let source_path = resolve_media_transcribe_path(state, source_path)?;
    let (response_format, extension) = normalize_transcript_format(
        request
            .get("format")
            .or_else(|| request.get("responseFormat"))
            .and_then(Value::as_str),
    );
    let settings_snapshot =
        crate::persistence::with_store(state, |store| Ok(store.settings.clone()))?;
    let Some((endpoint, api_key, model_name)) = resolve_transcription_settings(&settings_snapshot)
    else {
        return Err(
            "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。".to_string(),
        );
    };

    let job_id = make_id("media-transcribe-job");
    let output_dir = output_dir_for_request(state, request, &job_id)?;
    let audio_path =
        extract_audio_for_transcription(app, state, session_id, &source_path, &output_dir)?;
    let transcript = run_curl_transcription_with_response_format(
        &endpoint,
        api_key.as_deref(),
        &model_name,
        &audio_path,
        "audio/mp4",
        Some(response_format),
    )?;

    let output_path = output_dir.join(format!("transcript.{extension}"));
    fs::write(&output_path, &transcript).map_err(|error| error.to_string())?;

    let language = payload_string(request, "language");
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "sourcePath": source_path.display().to_string(),
        "audioPath": audio_path.display().to_string(),
        "format": response_format,
        "language": language,
        "subtitlePath": output_path.display().to_string(),
        "transcriptPath": output_path.display().to_string(),
        "outputDir": output_dir.display().to_string(),
        "contentPreview": text_preview(&transcript, 4000),
        "contentChars": transcript.chars().count(),
        "modelName": model_name
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_format_defaults_to_srt() {
        assert_eq!(normalize_transcript_format(None), ("srt", "srt"));
        assert_eq!(normalize_transcript_format(Some("txt")), ("text", "txt"));
        assert_eq!(
            normalize_transcript_format(Some("verbose-json")),
            ("verbose_json", "json")
        );
    }
}
