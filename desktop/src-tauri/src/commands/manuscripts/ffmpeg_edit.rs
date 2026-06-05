use super::*;
use crate::cli_runtime::{run_managed_cli_command, CliExecuteRequest, CliVerifyRule};

#[path = "ffmpeg_edit/assets.rs"]
mod assets;

pub(super) use assets::ffmpeg_asset_items;
use assets::{ffmpeg_operation_input_path, resolve_ffmpeg_asset_path};

fn ffmpeg_seconds(ms: i64) -> String {
    format!("{:.3}", (ms.max(0) as f64) / 1000.0)
}

fn ffmpeg_output_path(
    package_path: &std::path::Path,
    step_index: usize,
    op_name: &str,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = package_path.join("cache").join("ai-edits");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(format!(
        "{:02}-{}-{}.{}",
        step_index + 1,
        op_name,
        now_ms(),
        extension
    )))
}

fn run_ffmpeg_args(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    cwd: &std::path::Path,
    output_path: &std::path::Path,
    args: &[String],
) -> Result<(), String> {
    let argv = std::iter::once(ffmpeg_program(Some(app))?)
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let _ = run_managed_cli_command(
        app,
        state,
        CliExecuteRequest {
            session_id: Some(session_id.to_string()),
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
    .map_err(|error| format!("执行 ffmpeg 失败: {error}"))?;
    Ok(())
}

pub(super) fn ffmpeg_recipe_source_asset_ids(operations: &[Value]) -> Vec<String> {
    let mut ids = Vec::<String>::new();
    let push_id = |ids: &mut Vec<String>, candidate: Option<&str>| {
        let Some(candidate) = candidate.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if !ids.iter().any(|value| value == candidate) {
            ids.push(candidate.to_string());
        }
    };
    for operation in operations {
        push_id(&mut ids, operation.get("assetId").and_then(Value::as_str));
        if let Some(asset_ids) = operation.get("assetIds").and_then(Value::as_array) {
            for asset_id in asset_ids {
                push_id(&mut ids, asset_id.as_str());
            }
        }
        push_id(
            &mut ids,
            operation.get("audioAssetId").and_then(Value::as_str),
        );
    }
    ids
}

pub(super) fn ffmpeg_recipe_duration_ms(operations: &[Value], fallback_duration_ms: i64) -> i64 {
    let trimmed_sum = operations
        .iter()
        .filter(|operation| operation.get("type").and_then(Value::as_str) == Some("trim"))
        .filter_map(|operation| operation.get("durationMs").and_then(Value::as_i64))
        .sum::<i64>();
    if trimmed_sum > 0 {
        return trimmed_sum;
    }
    operations
        .iter()
        .rev()
        .find_map(|operation| operation.get("durationMs").and_then(Value::as_i64))
        .unwrap_or(fallback_duration_ms.max(0))
}

pub(super) fn execute_ffmpeg_edit_recipe(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    package_path: &std::path::Path,
    assets: &[Value],
    operations: &[Value],
) -> Result<(std::path::PathBuf, Vec<Value>), String> {
    let mut current_path: Option<std::path::PathBuf> = None;
    let mut segment_paths: Vec<std::path::PathBuf> = Vec::new();
    let mut artifacts = Vec::<Value>::new();

    for (index, operation) in operations.iter().enumerate() {
        let op_name = operation
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "ffmpeg operation 缺少 type".to_string())?;
        match op_name {
            "trim" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "trim", "mp4")?;
                let mut args = vec!["-y".to_string()];
                let start_ms = operation
                    .get("startMs")
                    .and_then(Value::as_i64)
                    .unwrap_or_else(|| {
                        operation
                            .get("trimInMs")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                    });
                if start_ms > 0 {
                    args.push("-ss".to_string());
                    args.push(ffmpeg_seconds(start_ms));
                }
                args.push("-i".to_string());
                args.push(input_path.clone());
                if let Some(duration_ms) = operation.get("durationMs").and_then(Value::as_i64) {
                    if duration_ms > 0 {
                        args.push("-t".to_string());
                        args.push(ffmpeg_seconds(duration_ms));
                    }
                }
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    output_path.display().to_string(),
                ]);
                run_ffmpeg_args(app, state, session_id, package_path, &output_path, &args)?;
                current_path = Some(output_path.clone());
                segment_paths.push(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path
                }));
            }
            "concat" => {
                let mut inputs = operation
                    .get("assetIds")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(|asset_id| resolve_ffmpeg_asset_path(assets, asset_id))
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?
                    .unwrap_or_default()
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect::<Vec<_>>();
                if inputs.is_empty() {
                    inputs = segment_paths.clone();
                }
                if inputs.is_empty() {
                    if let Some(path) = current_path.clone() {
                        inputs.push(path);
                    }
                }
                if inputs.is_empty() {
                    return Err("concat 操作缺少可拼接的输入片段".to_string());
                }
                if inputs.len() == 1 {
                    current_path = inputs.first().cloned();
                    continue;
                }
                let output_path = ffmpeg_output_path(package_path, index, "concat", "mp4")?;
                let mut args = vec!["-y".to_string()];
                for input in &inputs {
                    args.push("-i".to_string());
                    args.push(input.display().to_string());
                }
                let mut filter = String::new();
                for input_index in 0..inputs.len() {
                    filter.push_str(&format!("[{input_index}:v:0]"));
                }
                filter.push_str(&format!("concat=n={}:v=1:a=0[v]", inputs.len()));
                args.extend([
                    "-filter_complex".to_string(),
                    filter,
                    "-map".to_string(),
                    "[v]".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    output_path.display().to_string(),
                ]);
                run_ffmpeg_args(app, state, session_id, package_path, &output_path, &args)?;
                current_path = Some(output_path.clone());
                segment_paths = vec![output_path.clone()];
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "inputs": inputs.iter().map(|input| input.display().to_string()).collect::<Vec<_>>()
                }));
            }
            "crop_scale" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "crop-scale", "mp4")?;
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
                    return Err("crop_scale 至少需要裁剪参数或目标尺寸".to_string());
                }
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-vf".to_string(),
                    filters.join(","),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "veryfast".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, package_path, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path
                }));
            }
            "speed" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "speed", "mp4")?;
                let speed = operation
                    .get("speed")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0);
                if speed <= 0.0 {
                    return Err("speed 必须大于 0".to_string());
                }
                let setpts = 1.0 / speed;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-filter:v".to_string(),
                    format!("setpts={setpts:.6}*PTS"),
                    "-an".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, package_path, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path,
                    "speed": speed
                }));
            }
            "mute" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let output_path = ffmpeg_output_path(package_path, index, "mute", "mp4")?;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-an".to_string(),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, package_path, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path
                }));
            }
            "replace_audio" => {
                let input_path =
                    ffmpeg_operation_input_path(operation, current_path.as_ref(), assets)?;
                let audio_asset_id = operation
                    .get("audioAssetId")
                    .or_else(|| operation.get("assetId"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "replace_audio 缺少 audioAssetId".to_string())?;
                let audio_path = resolve_ffmpeg_asset_path(assets, audio_asset_id)?;
                let output_path = ffmpeg_output_path(package_path, index, "replace-audio", "mp4")?;
                let args = vec![
                    "-y".to_string(),
                    "-i".to_string(),
                    input_path.clone(),
                    "-i".to_string(),
                    audio_path.clone(),
                    "-map".to_string(),
                    "0:v:0".to_string(),
                    "-map".to_string(),
                    "1:a:0".to_string(),
                    "-c:v".to_string(),
                    "copy".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-shortest".to_string(),
                    output_path.display().to_string(),
                ];
                run_ffmpeg_args(app, state, session_id, package_path, &output_path, &args)?;
                current_path = Some(output_path.clone());
                artifacts.push(json!({
                    "type": op_name,
                    "path": output_path.display().to_string(),
                    "sourcePath": input_path,
                    "audioPath": audio_path
                }));
            }
            _ => {
                return Err(format!("暂不支持的 ffmpeg operation: {op_name}"));
            }
        }
    }

    let final_path = current_path.ok_or_else(|| "ffmpeg_edit 没有生成任何输出".to_string())?;
    Ok((final_path, artifacts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_unique_source_asset_ids_from_recipe() {
        let operations = vec![
            json!({ "type": "trim", "assetId": "video-1" }),
            json!({ "type": "concat", "assetIds": ["video-1", "video-2", ""] }),
            json!({ "type": "replace_audio", "audioAssetId": "audio-1" }),
        ];

        assert_eq!(
            ffmpeg_recipe_source_asset_ids(&operations),
            vec!["video-1", "video-2", "audio-1"]
        );
    }

    #[test]
    fn duration_prefers_trim_sum_then_last_operation_duration() {
        assert_eq!(
            ffmpeg_recipe_duration_ms(
                &[
                    json!({ "type": "trim", "durationMs": 1200 }),
                    json!({ "type": "trim", "durationMs": 800 }),
                ],
                5000,
            ),
            2000
        );
        assert_eq!(
            ffmpeg_recipe_duration_ms(
                &[
                    json!({ "type": "speed", "durationMs": 1600 }),
                    json!({ "type": "mute", "durationMs": 1400 }),
                ],
                5000,
            ),
            1400
        );
    }
}
