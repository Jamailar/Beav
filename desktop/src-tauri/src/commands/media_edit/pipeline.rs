use crate::cli_runtime::{run_managed_cli_command, CliExecuteRequest, CliVerifyRule};
use crate::{ffmpeg_program, now_ms, AppState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

pub(super) struct MediaEditOperationOutputs {
    pub(super) current_path: Option<PathBuf>,
    pub(super) segment_paths: Vec<PathBuf>,
    pub(super) artifacts: Vec<Value>,
}

fn ffmpeg_seconds(ms: i64) -> String {
    format!("{:.3}", (ms.max(0) as f64) / 1000.0)
}

pub(super) fn normalized_operation_type(operation: &Value) -> Result<&str, String> {
    operation
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "media.edit operation requires type".to_string())
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
    let argv = std::iter::once(ffmpeg_program(Some(app))?)
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

pub(super) fn run_media_edit_operations(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    source_path: &Path,
    output_dir: &Path,
    operations: &[Value],
) -> Result<MediaEditOperationOutputs, String> {
    let mut current_path: Option<PathBuf> = Some(source_path.to_path_buf());
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
                    .unwrap_or_else(|| source_path.to_path_buf());
                let output_path = media_edit_output_path(
                    output_dir,
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
                run_ffmpeg_args(app, state, session_id, output_dir, &output_path, &args)?;
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
                let output_path = media_edit_output_path(output_dir, index, "concat", None);
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
                run_ffmpeg_args(app, state, session_id, output_dir, &output_path, &args)?;
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
                let output_path = media_edit_output_path(output_dir, index, "crop-scale", None);
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
                run_ffmpeg_args(app, state, session_id, output_dir, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": "crop_scale",
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path.display().to_string()
                }));
            }
            "speed" => {
                let input_path = operation_input_path(operation, current_path.as_ref())?;
                let output_path = media_edit_output_path(output_dir, index, "speed", None);
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
                run_ffmpeg_args(app, state, session_id, output_dir, &output_path, &args)?;
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
                let output_path = media_edit_output_path(output_dir, index, "mute", None);
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
                run_ffmpeg_args(app, state, session_id, output_dir, &output_path, &args)?;
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
                let output_path = media_edit_output_path(output_dir, index, "replace-audio", None);
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
                run_ffmpeg_args(app, state, session_id, output_dir, &output_path, &args)?;
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

    Ok(MediaEditOperationOutputs {
        current_path,
        segment_paths,
        artifacts,
    })
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
}
