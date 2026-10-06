use super::*;
use crate::store::settings as settings_store;

pub(super) fn handle_remotion_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:save-remotion-scene" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_state = get_manuscript_package_state(&full_path)?;
            let title = package_state
                .pointer("/manifest/title")
                .and_then(|value| value.as_str())
                .unwrap_or("Motion")
                .to_string();
            let clips = package_state
                .pointer("/timelineSummary/clips")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let existing_scene = package_state
                .get("remotion")
                .cloned()
                .unwrap_or_else(|| build_default_remotion_scene(&title, &clips));
            let raw_scene = payload_field(&payload, "scene")
                .cloned()
                .unwrap_or(Value::Null);
            let merged_scene = merge_remotion_scene_patch(&existing_scene, &raw_scene);
            let normalized =
                normalize_ai_remotion_scene(&merged_scene, &existing_scene, &clips, &title);
            persist_remotion_composition_artifacts(&full_path, &normalized)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:generate-remotion-scene" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let instructions = payload_string(&payload, "instructions").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_state = get_manuscript_package_state(&full_path)?;
            let title = package_state
                .pointer("/manifest/title")
                .and_then(|value| value.as_str())
                .unwrap_or("Motion")
                .to_string();
            let clips = package_state
                .pointer("/timelineSummary/clips")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let remotion_context = remotion_context_value(state, &full_path, &file_path)?;
            let fallback = package_state
                .get("remotion")
                .cloned()
                .unwrap_or_else(|| build_default_remotion_scene(&title, &clips));
            let prompt = format!(
                    "请基于当前脚本、时间线和当前 Remotion 状态，设计一份 Remotion JSON 动画方案。\n\
要求：\n\
1. 默认只维护一个主 scene（通常就是 scene-1），后续动画默认都加到这个 scene 里，而不是按底层片段数量机械拆多个场景。\n\
2. 先确定动画主体元素，再设计动画表达。像“苹果下落”必须先落成一个 element，例如 `shape=apple`，再给它配置 `fall-bounce` 等动画；不要退化成说明性文字。\n\
3. 只有当脚本明确要求动画跟随某个现有镜头时，才填写 clipId / assetId；否则它们保持为空，让动画独立存在于默认 scene / M1 动画轨道。\n\
4. Remotion 的时序是按帧控制的；请用 durationInFrames 和 overlay.startFrame / overlay.durationInFrames 表达节奏，不要描述宿主不存在的自由动画系统。\n\
5. 每个场景内部等价于一个 Sequence，overlay.startFrame + overlay.durationInFrames 必须落在该场景 durationInFrames 之内。\n\
6. 如需真正的对象动画（例如苹果掉落、图形弹跳、logo reveal），优先使用 scenes[].entities[]，不要退化成说明性文字。\n\
7. entities 支持 text / shape / image / svg / video / group；shape 优先使用 rect / circle / apple。\n\
8. 对象动画优先用 entities[].animations[] 表达，例如 fall-bounce、slide-in-left、pop、fade-in。\n\
9. 不要通过文字轨道片段模拟动画；动画只能体现在 Remotion scene / M1 动画轨道。\n\
10. 不要修改 src / assetKind / trimInFrames，这些字段由宿主兜底；如果是独立动画层，src 可以为空。\n\
11. 默认只生成动画主体本身；如果脚本没有明确要求标题、字幕、说明或其他屏幕文字，请把 overlayTitle / overlayBody 设为 null，overlays 设为空数组。\n\
12. 只有当脚本明确要求屏幕文字时，才使用 overlayTitle / overlayBody / overlays 或 text entity；不要自动补顶部标题或底部说明。\n\
13. entities 默认使用 `positionMode=\"canvas-space\"`；如果任务明确要求与视频中已有元素精准对位，才使用 `positionMode=\"video-space\"`，并同时提供 `referenceWidth` / `referenceHeight`，其基准应与 baseMedia 一致。\n\
14. `x` / `y` 表示实体最终停留位置的左上角坐标，不是中心点坐标；如果需要水平居中，必须按 `(referenceWidth - width) / 2` 计算。\n\
15. `fall-bounce` 的 `params.fromY` / `params.floorY` 是相对位移，不是绝对位置；常规下落动画应把实体最终落点写在 `entity.y`，并把 `floorY` 设为 `0`。\n\
16. 如果对象需要跨越较大画面范围运动，位移幅度必须与 `referenceHeight` / `referenceWidth` 成比例，不要只写很小的固定像素，避免动画只停留在画面一角。\n\
17. 对于 `video-space` 实体，x / y / width / height 与动画位移参数都必须按同一参考坐标系表达，不要混用画布像素和视频像素。\n\
18. 如果任务涉及镜头切换，可以使用顶层 transitions[]，字段必须遵守 leftClipId / rightClipId / presentation / timing / durationInFrames；不要把转场偷偷降级成说明文字。\n\
\n\
工程标题：{}\n\
脚本：{}\n\
Remotion 读取结果 JSON：{}\n\
时间线片段 JSON：{}",
                    title,
                    instructions,
                    serde_json::to_string(&remotion_context).map_err(|error| error.to_string())?,
                    serde_json::to_string(&clips).map_err(|error| error.to_string())?
                );
            let model_config = payload_field(&payload, "modelConfig").cloned();
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let auth_runtime = state
                .auth_runtime
                .lock()
                .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
            let settings_snapshot =
                crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime);
            let resolved_config = resolve_chat_config(&settings_snapshot, model_config.as_ref());
            let session_id = payload_string(&payload, "sessionId");
            let model_config_summary = model_config
                .as_ref()
                .and_then(Value::as_object)
                .map(|object| {
                    format!(
                        "baseURL={} | modelName={} | protocol={} | apiKeyPresent={}",
                        object.get("baseURL").and_then(Value::as_str).unwrap_or(""),
                        object
                            .get("modelName")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        object.get("protocol").and_then(Value::as_str).unwrap_or(""),
                        object
                            .get("apiKey")
                            .and_then(Value::as_str)
                            .map(|value| !value.trim().is_empty())
                            .unwrap_or(false)
                    )
                })
                .unwrap_or_else(|| "none".to_string());
            let resolved_config_summary = resolved_config
                .as_ref()
                .map(|config| {
                    format!(
                        "base_url={} | model_name={} | protocol={} | api_key_present={}",
                        config.base_url,
                        config.model_name,
                        config.protocol,
                        config
                            .api_key
                            .as_ref()
                            .map(|value| !value.trim().is_empty())
                            .unwrap_or(false)
                    )
                })
                .unwrap_or_else(|| "none".to_string());
            let start_log = format!(
                    "[video][remotion_generate] start | filePath={} | sessionId={} | clips={} | instructionsChars={} | payloadModelConfig={} | resolvedConfig={}",
                    file_path,
                    session_id.clone().unwrap_or_default(),
                    clips.len(),
                    instructions.chars().count(),
                    model_config_summary,
                    resolved_config_summary
                );
            eprintln!("{}", start_log);
            append_debug_log_state(state, start_log);
            let (candidate, subagent_summary) = run_animation_director_subagent(
                app,
                state,
                session_id.as_deref(),
                model_config.as_ref(),
                &prompt,
            )?;
            let raw_log = format!(
                "[video][remotion_generate] subagent-response | parsedJson=true | summary={}",
                subagent_summary.replace('\n', "\\n")
            );
            eprintln!("{}", raw_log);
            append_debug_log_state(state, raw_log);
            let mut normalized = normalize_ai_remotion_scene(&candidate, &fallback, &clips, &title);
            if !instructions_request_visual_text_layers(&instructions) {
                strip_incidental_remotion_text_layers(&mut normalized);
            }
            let normalized_scene_count = normalized
                .get("scenes")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let normalized_log = format!(
                "[video][remotion_generate] normalized | scenes={} | title={}",
                normalized_scene_count,
                normalized
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            );
            eprintln!("{}", normalized_log);
            append_debug_log_state(state, normalized_log);
            persist_remotion_composition_artifacts(&full_path, &normalized)?;
            Ok(json!({
                "success": true,
                "state": get_manuscript_package_state(&full_path)?,
                "summary": subagent_summary
            }))
        })()),
        "manuscripts:pick-export-path" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let resolution_preset =
                payload_string(&payload, "resolutionPreset").unwrap_or_else(|| "1080p".to_string());
            let render_mode = payload_string(&payload, "renderMode")
                .filter(|value| value == "full" || value == "motion-layer")
                .unwrap_or_else(|| "full".to_string());
            let export_dir = full_path.join("exports");
            fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
            let file_stem = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(slug_from_relative_path)
                .unwrap_or_else(|| "redbox-video".to_string());
            let extension = if render_mode == "motion-layer" {
                "mov"
            } else {
                "mp4"
            };
            let default_name = if resolution_preset.is_empty() || resolution_preset == "source" {
                format!("{file_stem}.{extension}")
            } else {
                format!("{file_stem}-{resolution_preset}.{extension}")
            };
            let picked = pick_save_file_native("选择导出位置", &default_name, Some(&export_dir))?;
            let Some(path) = picked else {
                return Ok(json!({ "success": true, "canceled": true }));
            };
            let normalized_path = ensure_export_extension(path, extension);
            Ok(json!({
                "success": true,
                "canceled": false,
                "path": normalized_path.display().to_string(),
            }))
        })()),
        "manuscripts:render-remotion-video" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_state = get_manuscript_package_state(&full_path)?;
            let mut scene = package_state
                .get("remotion")
                .cloned()
                .unwrap_or_else(|| build_default_remotion_scene("Motion", &[]));
            let render_mode = payload_string(&payload, "renderMode")
                .filter(|value| value == "full" || value == "motion-layer")
                .unwrap_or_else(|| {
                    if scene
                        .pointer("/baseMedia/outputPath")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .is_some()
                    {
                        "full".to_string()
                    } else {
                        scene
                            .get("renderMode")
                            .and_then(Value::as_str)
                            .filter(|value| *value == "full" || *value == "motion-layer")
                            .unwrap_or("motion-layer")
                            .to_string()
                    }
                });
            if let Some(object) = scene.as_object_mut() {
                object.insert("renderMode".to_string(), json!(render_mode.clone()));
            }
            let width = scene.get("width").and_then(Value::as_i64).unwrap_or(1920);
            let height = scene.get("height").and_then(Value::as_i64).unwrap_or(1080);
            let resolution_preset = payload_string(&payload, "resolutionPreset")
                .unwrap_or_else(|| "source".to_string());
            let scale = remotion_export_scale(width, height, &resolution_preset);
            let extension = if render_mode == "motion-layer" {
                "mov"
            } else {
                "mp4"
            };
            let output_path = payload_string(&payload, "outputPath")
                .map(std::path::PathBuf::from)
                .map(|path| ensure_export_extension(path, extension))
                .unwrap_or_else(|| {
                    let export_dir = full_path.join("exports");
                    let _ = fs::create_dir_all(&export_dir);
                    let file_stem = full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(slug_from_relative_path)
                        .unwrap_or_else(|| "redbox-video".to_string());
                    export_dir.join(format!("{file_stem}-remotion-{}.{extension}", now_ms()))
                });
            let render_result = render_remotion_video(
                state,
                &scene,
                &output_path,
                scale,
                Some(app),
                Some(&file_path),
            )?;
            let scene_title = scene
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Motion")
                .to_string();
            if let Some(object) = scene.as_object_mut() {
                object.insert(
                        "render".to_string(),
                        normalized_remotion_render_config(
                            Some(&json!({
                                "defaultOutName": render_result.get("defaultOutName").cloned().unwrap_or(Value::Null),
                                "codec": render_result.get("codec").cloned().unwrap_or(Value::Null),
                                "imageFormat": render_result.get("imageFormat").cloned().unwrap_or(Value::Null),
                                "pixelFormat": render_result.get("pixelFormat").cloned().unwrap_or(Value::Null),
                                "proResProfile": render_result.get("proResProfile").cloned().unwrap_or(Value::Null),
                                "outputPath": output_path.display().to_string(),
                                "renderedAt": now_i64(),
                                "durationInFrames": render_result.get("durationInFrames").cloned().unwrap_or(Value::Null),
                                "renderMode": render_mode,
                                "compositionId": render_result.get("compositionId").cloned().unwrap_or_else(|| json!("RedBoxVideoMotion"))
                            })),
                            &scene_title,
                            &render_mode,
                        ),
                    );
            }
            persist_remotion_composition_artifacts(&full_path, &scene)?;
            Ok(json!({
                "success": true,
                "outputPath": output_path.display().to_string(),
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        _ => None,
    }
}
