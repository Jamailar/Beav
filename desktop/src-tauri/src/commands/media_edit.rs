use crate::cli_runtime::{run_managed_cli_command, CliExecuteRequest, CliVerifyRule};
use crate::commands::library::persist_media_workspace_catalog;
use crate::{
    file_url_for_path, guess_mime_and_kind, make_id, media_root, now_ms, now_rfc3339,
    workspace_root, AppState, MediaAssetRecord,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

fn ffmpeg_seconds(ms: i64) -> String {
    format!("{:.3}", (ms.max(0) as f64) / 1000.0)
}

fn normalized_operation_type(operation: &Value) -> Result<&str, String> {
    operation
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "media.edit operation requires type".to_string())
}

fn resolve_media_edit_path(state: &State<'_, AppState>, raw_path: &str) -> Result<PathBuf, String> {
    let normalized = raw_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("media.edit requires a non-empty sourcePath".to_string());
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
            "media.edit source file not found: {}",
            resolved.display()
        ));
    }
    Ok(resolved)
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
            media_root(state)
                .unwrap_or_else(|_| PathBuf::from("media"))
                .join("edits")
        });
    let dir = base.join(job_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn media_edit_output_path(
    output_dir: &Path,
    step_index: usize,
    op_name: &str,
    label: Option<&str>,
) -> PathBuf {
    let safe_label = label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                        ch
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .trim_matches('-')
                .chars()
                .take(32)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| op_name.to_string());
    output_dir.join(format!(
        "{:02}-{}-{}.mp4",
        step_index + 1,
        safe_label,
        now_ms()
    ))
}

fn run_ffmpeg_args(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    cwd: &Path,
    output_path: &Path,
    args: &[String],
) -> Result<(), String> {
    let argv = std::iter::once("ffmpeg".to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    run_managed_cli_command(
        app,
        state,
        CliExecuteRequest {
            session_id: session_id.map(ToString::to_string),
            runtime_id: Some("media-edit".to_string()),
            tool_id: Some("ffmpeg".to_string()),
            argv,
            cwd: Some(cwd.to_string_lossy().to_string()),
            verification_rules: vec![
                CliVerifyRule::ExitCode { expected: Some(0) },
                CliVerifyRule::FileExists {
                    path: output_path.to_string_lossy().to_string(),
                },
            ],
            ..CliExecuteRequest::default()
        },
        8_000,
    )
    .map_err(|error| format!("ffmpeg failed: {error}"))?;
    Ok(())
}

fn operation_input_path(
    operation: &Value,
    current_path: Option<&PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(input_path) = operation.get("inputPath").and_then(Value::as_str) {
        let trimmed = input_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    current_path
        .cloned()
        .ok_or_else(|| "operation requires inputPath or previous output".to_string())
}

fn concat_filter_for_inputs(input_count: usize) -> String {
    let mut filter = String::new();
    for input_index in 0..input_count {
        filter.push_str(&format!("[{input_index}:v:0][{input_index}:a:0]"));
    }
    filter.push_str(&format!("concat=n={input_count}:v=1:a=1[v][a]"));
    filter
}

fn output_kind(request: &Value) -> String {
    request
        .pointer("/output/kind")
        .or_else(|| request.get("outputKind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase()
}

fn register_media_edit_assets(
    state: &State<'_, AppState>,
    paths: &[PathBuf],
    request: &Value,
    job_id: &str,
) -> Result<Vec<MediaAssetRecord>, String> {
    let intent_summary = request
        .get("intentSummary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let created_at = now_rfc3339();
    let assets = crate::persistence::with_store_mut(state, |store| {
        let mut assets = Vec::<MediaAssetRecord>::new();
        for (index, path) in paths.iter().enumerate() {
            let (mime_type, _, _) = guess_mime_and_kind(path);
            let base_id = make_id("media-edit");
            let asset = MediaAssetRecord {
                id: if paths.len() > 1 {
                    format!("{base_id}-{}", index + 1)
                } else {
                    base_id
                },
                source: "media-edit".to_string(),
                source_domain: None,
                source_link: None,
                project_id: Some(job_id.to_string()),
                title: Some(
                    intent_summary
                        .map(|summary| {
                            if paths.len() > 1 {
                                format!("{summary} {}", index + 1)
                            } else {
                                summary.to_string()
                            }
                        })
                        .unwrap_or_else(|| format!("Video edit {}", index + 1)),
                ),
                prompt: request
                    .get("instruction")
                    .or_else(|| request.get("intentSummary"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                provider: Some("ffmpeg".to_string()),
                provider_template: Some("media.edit".to_string()),
                model: None,
                aspect_ratio: None,
                size: None,
                quality: None,
                mime_type: Some(mime_type),
                relative_path: None,
                bound_manuscript_path: None,
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
                absolute_path: Some(path.display().to_string()),
                preview_url: Some(file_url_for_path(path)),
                exists: path.is_file(),
            };
            store.media_assets.push(asset.clone());
            assets.push(asset);
        }
        Ok(assets)
    })?;
    persist_media_workspace_catalog(state)?;
    Ok(assets)
}

pub(crate) fn execute_media_edit(
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
        .ok_or_else(|| "media.edit requires sourcePath".to_string())?;
    let source_path = resolve_media_edit_path(state, source_path)?;
    let operations = request
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if operations.is_empty() {
        return Err("media.edit requires at least one operation".to_string());
    }

    let job_id = make_id("media-edit-job");
    let output_dir = output_dir_for_request(state, request, &job_id)?;
    let mut current_path: Option<PathBuf> = Some(source_path.clone());
    let mut segment_paths: Vec<PathBuf> = Vec::new();
    let mut artifacts = Vec::<Value>::new();

    for (index, operation) in operations.iter().enumerate() {
        let op_name = normalized_operation_type(operation)?;
        match op_name {
            "trim" => {
                let input_path = operation
                    .get("inputPath")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| source_path.clone());
                let output_path = media_edit_output_path(
                    &output_dir,
                    index,
                    "trim",
                    operation.get("label").and_then(Value::as_str),
                );
                let start_ms = operation
                    .get("startMs")
                    .or_else(|| operation.get("start"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let duration_ms = operation
                    .get("durationMs")
                    .or_else(|| operation.get("duration"))
                    .and_then(Value::as_i64);
                let mut args = vec!["-y".to_string()];
                if start_ms > 0 {
                    args.push("-ss".to_string());
                    args.push(ffmpeg_seconds(start_ms));
                }
                args.push("-i".to_string());
                args.push(input_path.display().to_string());
                if let Some(duration_ms) = duration_ms.filter(|value| *value > 0) {
                    args.push("-t".to_string());
                    args.push(ffmpeg_seconds(duration_ms));
                }
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    output_path.display().to_string(),
                ]);
                run_ffmpeg_args(app, state, session_id, &output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                segment_paths.push(output_path.clone());
                artifacts.push(json!({
                    "type": "trim",
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path.display().to_string(),
                    "startMs": start_ms,
                    "durationMs": duration_ms,
                    "label": operation.get("label").cloned().unwrap_or(Value::Null)
                }));
            }
            "concat" => {
                let mut inputs = operation
                    .get("inputPaths")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|value| PathBuf::from(value.trim()))
                            .filter(|path| !path.as_os_str().is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if inputs.is_empty() {
                    inputs = segment_paths.clone();
                }
                if inputs.is_empty() {
                    if let Some(path) = current_path.clone() {
                        inputs.push(path);
                    }
                }
                if inputs.len() < 2 {
                    current_path = inputs.first().cloned();
                    continue;
                }
                let output_path = media_edit_output_path(&output_dir, index, "concat", None);
                let mut args = vec!["-y".to_string()];
                for input in &inputs {
                    args.push("-i".to_string());
                    args.push(input.display().to_string());
                }
                args.extend([
                    "-filter_complex".to_string(),
                    concat_filter_for_inputs(inputs.len()),
                    "-map".to_string(),
                    "[v]".to_string(),
                    "-map".to_string(),
                    "[a]".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    output_path.display().to_string(),
                ]);
                run_ffmpeg_args(app, state, session_id, &output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                segment_paths = vec![output_path.clone()];
                artifacts.push(json!({
                    "type": "concat",
                    "path": output_path.display().to_string(),
                    "inputs": inputs.iter().map(|input| input.display().to_string()).collect::<Vec<_>>()
                }));
            }
            "crop_scale" => {
                let input_path = operation_input_path(operation, current_path.as_ref())?;
                let output_path = media_edit_output_path(&output_dir, index, "crop-scale", None);
                let crop_width = operation.get("width").and_then(Value::as_i64).unwrap_or(0);
                let crop_height = operation.get("height").and_then(Value::as_i64).unwrap_or(0);
                let crop_x = operation.get("x").and_then(Value::as_i64).unwrap_or(0);
                let crop_y = operation.get("y").and_then(Value::as_i64).unwrap_or(0);
                let target_width = operation
                    .get("targetWidth")
                    .or_else(|| operation.get("outputWidth"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let target_height = operation
                    .get("targetHeight")
                    .or_else(|| operation.get("outputHeight"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let mut filters = Vec::<String>::new();
                if crop_width > 0 && crop_height > 0 {
                    filters.push(format!("crop={crop_width}:{crop_height}:{crop_x}:{crop_y}"));
                }
                if target_width > 0 && target_height > 0 {
                    filters.push(format!("scale={target_width}:{target_height}"));
                }
                if filters.is_empty() {
                    return Err("crop_scale requires crop or target dimensions".to_string());
                }
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.display().to_string(),
                    "-vf".to_string(),
                    filters.join(","),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, &output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": "crop_scale",
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path.display().to_string()
                }));
            }
            "speed" => {
                let input_path = operation_input_path(operation, current_path.as_ref())?;
                let output_path = media_edit_output_path(&output_dir, index, "speed", None);
                let speed = operation
                    .get("speed")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0);
                if speed <= 0.0 {
                    return Err("speed must be greater than 0".to_string());
                }
                let setpts = 1.0 / speed;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.display().to_string(),
                    "-filter:v".to_string(),
                    format!("setpts={setpts:.6}*PTS"),
                    "-an".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, &output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": "speed",
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path.display().to_string(),
                    "speed": speed
                }));
            }
            "mute" => {
                let input_path = operation_input_path(operation, current_path.as_ref())?;
                let output_path = media_edit_output_path(&output_dir, index, "mute", None);
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.display().to_string(),
                    "-an".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, &output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": "mute",
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path.display().to_string()
                }));
            }
            "replace_audio" => {
                let input_path = operation_input_path(operation, current_path.as_ref())?;
                let audio_path = operation
                    .get("audioPath")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| "replace_audio requires audioPath".to_string())?;
                let output_path = media_edit_output_path(&output_dir, index, "replace-audio", None);
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.display().to_string(),
                    "-i".to_string(),
                    audio_path.display().to_string(),
                    "-map".to_string(),
                    "0:v:0".to_string(),
                    "-map".to_string(),
                    "1:a:0".to_string(),
                    "-c:v".to_string(),
                    "copy".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-shortest".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, &output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": "replace_audio",
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path.display().to_string(),
                    "audioPath": audio_path.display().to_string()
                }));
            }
            _ => return Err(format!("unsupported media.edit operation: {op_name}")),
        }
    }

    let kind = output_kind(request);
    let output_paths = if kind == "clips"
        || (kind == "auto"
            && segment_paths.len() > 1
            && !operations
                .iter()
                .any(|operation| normalized_operation_type(operation).unwrap_or("") == "concat"))
    {
        segment_paths.clone()
    } else {
        current_path
            .clone()
            .map(|path| vec![path])
            .unwrap_or_else(Vec::new)
    };
    if output_paths.is_empty() {
        return Err("media.edit did not produce output".to_string());
    }
    let assets = register_media_edit_assets(state, &output_paths, request, &job_id)?;
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "sourcePath": source_path.display().to_string(),
        "outputKind": kind,
        "outputDir": output_dir.display().to_string(),
        "outputs": output_paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        "artifacts": artifacts,
        "assets": assets
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concat_filter_includes_audio_and_video_streams() {
        assert_eq!(
            concat_filter_for_inputs(2),
            "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]"
        );
    }

    #[test]
    fn output_kind_defaults_to_auto() {
        assert_eq!(output_kind(&json!({})), "auto");
        assert_eq!(
            output_kind(&json!({ "output": { "kind": "clips" } })),
            "clips"
        );
    }
}
