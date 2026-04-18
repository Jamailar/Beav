use crate::commands::library::persist_media_workspace_catalog;
use crate::events::emit_runtime_tool_partial;
use crate::persistence::{ensure_store_hydrated_for_subjects, with_store, with_store_mut};
use crate::skills::{
    load_skill_bundle_sections_from_root, load_skill_bundle_sections_from_sources,
    split_skill_body, SkillBundleSections,
};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Manager, State};

const IMAGE_PROMPT_OPTIMIZER_SKILL_NAME: &str = "image-prompt-optimizer";
const DEFAULT_IMAGE_PROMPT_MAX_CHARS: usize = 2200;

#[derive(Debug, Clone, Default)]
struct RuntimeToolLogContext {
    session_id: Option<String>,
    tool_call_id: Option<String>,
    tool_name: String,
}

fn load_image_prompt_optimizer_bundle(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> SkillBundleSections {
    let workspace = workspace_root(state).ok();
    let direct_bundle = load_skill_bundle_sections_from_sources(
        IMAGE_PROMPT_OPTIMIZER_SKILL_NAME,
        workspace.as_deref(),
    );
    if !direct_bundle.body.trim().is_empty() {
        return direct_bundle;
    }
    let Ok(resource_dir) = app.path().resource_dir() else {
        return direct_bundle;
    };
    let bundled_root = resource_dir
        .join("builtin-skills")
        .join(IMAGE_PROMPT_OPTIMIZER_SKILL_NAME);
    let bundled =
        load_skill_bundle_sections_from_root(IMAGE_PROMPT_OPTIMIZER_SKILL_NAME, &bundled_root);
    if !bundled.body.trim().is_empty() {
        return bundled;
    }
    direct_bundle
}

fn build_image_prompt_optimizer_system_prompt(bundle: &SkillBundleSections) -> (String, usize) {
    let (metadata, skill_body) = split_skill_body(&bundle.body);
    let max_chars = metadata
        .max_prompt_chars
        .unwrap_or(DEFAULT_IMAGE_PROMPT_MAX_CHARS);
    let mut sections = vec![
        "你是 RedBox 内置的 image-prompt-optimizer。你的任务是把用户原始需求整理成一段可直接发送给图片模型的最终提示词。".to_string(),
        "输出必须是严格 JSON，格式为 {\"optimizedPrompt\":\"...\"}。不要输出 Markdown，不要解释，不要附加多余字段。".to_string(),
    ];
    if !skill_body.trim().is_empty() {
        sections.push(format!("## Loaded skill\n{}", skill_body.trim()));
    }
    for (rule_name, rule_body) in &bundle.rules {
        let (_, content) = split_skill_body(rule_body);
        if content.trim().is_empty() {
            continue;
        }
        sections.push(format!("## Loaded rule: {rule_name}\n{}", content.trim()));
    }
    (sections.join("\n\n"), max_chars)
}

fn build_image_prompt_optimizer_user_prompt(
    raw_prompt: &str,
    title: Option<&str>,
    generation_mode: &str,
    reference_role_notes: &[String],
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> String {
    let reference_count = reference_role_notes.len();
    let mut lines = vec![
        format!("原始提示词：{}", raw_prompt.trim()),
        format!("标题：{}", title.unwrap_or("(无标题)")),
        format!("生成模式：{}", generation_mode),
        format!("参考图数量：{}", reference_count),
        format!("画幅比例：{}", aspect_ratio.unwrap_or("未指定")),
        format!("尺寸：{}", size.unwrap_or("未指定")),
        format!("质量：{}", quality.unwrap_or("未指定")),
    ];
    if reference_role_notes.is_empty() {
        lines.push("参考图角色说明：无".to_string());
    } else {
        lines.push("参考图角色说明：".to_string());
        lines.extend(reference_role_notes.iter().map(|item| format!("- {item}")));
    }
    lines.extend([
        "请按已加载 skill 和 rules，把上面的原始需求整理成一段最终生图提示词。".to_string(),
        "要求：保留用户主体意图；参考图模式优先保留主体身份、构图重心与色彩关系；默认补足构图、镜头、光线、材质、环境和完成度；不要把提示词原文、布局标签、水印或 AI 标签直接画进图里；不要输出负向提示词字段，不要输出解释。".to_string(),
        "如果存在参考图，最终提示词里必须逐张写出“参考图1/参考图2/...”各自的作用，明确哪张图负责主体身份，哪张图负责构图、风格、材质或环境线索；不要只写笼统的“参考图约束生效”。".to_string(),
    ]);
    lines.join("\n")
}

fn extract_optimized_prompt(raw_response: &str) -> Option<String> {
    let parsed = parse_json_value_from_text(raw_response)?;
    for key in [
        "optimizedPrompt",
        "effectivePrompt",
        "finalPrompt",
        "prompt",
    ] {
        let value = parsed
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(value) = value {
            return Some(value.to_string());
        }
    }
    None
}

fn summarize_json_for_log(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }
    let snippet = trimmed.chars().take(400).collect::<String>();
    if snippet.chars().count() == trimmed.chars().count() {
        snippet
    } else {
        format!("{snippet}...")
    }
}

fn build_fallback_optimized_image_prompt(
    raw_prompt: &str,
    title: Option<&str>,
    generation_mode: &str,
    reference_role_notes: &[String],
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> String {
    let trimmed = raw_prompt.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut parts = Vec::<String>::new();
    if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("主题：{title}"));
    }
    parts.push(trimmed.to_string());
    match generation_mode {
        "reference-guided" => {
            parts.push("保持参考图主体身份、核心轮廓、构图重心与主色调一致".to_string());
            parts.push("在不跑偏换主体的前提下补足场景、光线、材质与完成度".to_string());
        }
        "image-to-image" => {
            parts.push("保留原图主体、姿态和核心轮廓，只做受控风格增强".to_string());
            parts.push("重点优化光线、背景、材质细节与画面完成度".to_string());
        }
        _ => {
            parts.push("主体清晰，构图稳定，镜头明确，光线自然，材质细节可读".to_string());
        }
    }
    if !reference_role_notes.is_empty() {
        parts.push(reference_role_notes.join("；"));
    }
    if let Some(aspect_ratio) = aspect_ratio
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("画幅比例 {aspect_ratio}"));
    }
    if let Some(size) = size.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("输出尺寸倾向 {size}"));
    }
    parts.push("画面中不要出现提示词原文、布局标注、水印或 AI 标签".to_string());
    match quality.map(str::trim).unwrap_or_default() {
        "high" | "hd" => parts.push("高完成度，边缘干净，细节密度高".to_string()),
        "standard" => parts.push("细节清楚，视觉中心明确，背景不过载".to_string()),
        _ => {}
    }
    truncate_chars(&parts.join("，"), 900)
}

fn payload_string_list(payload: &Value, key: &str, limit: usize) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .take(limit)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_reference_image_key(path: &str) -> String {
    path.trim().trim_start_matches("file://").to_string()
}

fn build_reference_image_role_notes(state: &State<'_, AppState>, payload: &Value) -> Vec<String> {
    let reference_images = payload_string_list(payload, "referenceImages", 4);
    if reference_images.is_empty() {
        return Vec::new();
    }
    let _ = ensure_store_hydrated_for_subjects(state);
    let subject_ids = payload_string_list(payload, "subjectIds", 8);
    let subject_images = with_store(state, |store| {
        Ok(subject_ids
            .iter()
            .filter_map(|subject_id| store.subjects.iter().find(|item| item.id == *subject_id))
            .flat_map(|subject| {
                subject.absolute_image_paths.iter().map(move |path| {
                    (
                        normalize_reference_image_key(path),
                        subject.name.trim().to_string(),
                    )
                })
            })
            .collect::<Vec<(String, String)>>())
    })
    .unwrap_or_default();
    let multiple_refs = reference_images.len() > 1;
    reference_images
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let label = format!("参考图{}", index + 1);
            let normalized = normalize_reference_image_key(path);
            if let Some((_, subject_name)) = subject_images
                .iter()
                .find(|(subject_path, _)| *subject_path == normalized)
            {
                return format!(
                    "{label}：用于锁定主体 {subject_name} 的身份、面部特征、发型/体态和整体气质，不要替换主体。"
                );
            }
            if index == 0 {
                if multiple_refs {
                    format!(
                        "{label}：作为主要辅助参考图，用于继承整体构图、镜头关系、主色调和场景气质，不要用它替换主体身份。"
                    )
                } else {
                    format!(
                        "{label}：用于继承主体身份、构图重心、主色关系和主要材质特征，不要偏离参考图的核心视觉锚点。"
                    )
                }
            } else {
                format!(
                    "{label}：作为补充参考图，用于补充服装、材质、道具、光线或环境细节；除非用户明确要求，不要用它替换主体身份。"
                )
            }
        })
        .collect()
}

fn append_missing_reference_role_notes(prompt: &str, reference_role_notes: &[String]) -> String {
    if reference_role_notes.is_empty() {
        return prompt.trim().to_string();
    }
    let trimmed = prompt.trim();
    let missing = reference_role_notes
        .iter()
        .filter(|item| {
            item.split('：')
                .next()
                .map(|label| !trimmed.contains(label))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return trimmed.to_string();
    }
    if trimmed.is_empty() {
        return missing.join("；");
    }
    format!("{trimmed}，{}", missing.join("；"))
}

fn optimize_image_generation_prompt(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings_snapshot: &Value,
    payload: &Value,
    raw_prompt: &str,
    title: Option<&str>,
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> String {
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let reference_role_notes = build_reference_image_role_notes(state, payload);
    let fallback = build_fallback_optimized_image_prompt(
        raw_prompt,
        title,
        &generation_mode,
        &reference_role_notes,
        aspect_ratio,
        size,
        quality,
    );
    let bundle = load_image_prompt_optimizer_bundle(app, state);
    if bundle.body.trim().is_empty() {
        return if fallback.trim().is_empty() {
            raw_prompt.trim().to_string()
        } else {
            fallback
        };
    }
    let (system_prompt, max_chars) = build_image_prompt_optimizer_system_prompt(&bundle);
    let user_prompt = build_image_prompt_optimizer_user_prompt(
        raw_prompt,
        title,
        &generation_mode,
        &reference_role_notes,
        aspect_ratio,
        size,
        quality,
    );
    if let Ok(raw_response) = generate_structured_response_with_settings(
        settings_snapshot,
        None,
        &system_prompt,
        &user_prompt,
        true,
    ) {
        if let Some(optimized) = extract_optimized_prompt(&raw_response) {
            let normalized = truncate_chars(
                &append_missing_reference_role_notes(&optimized, &reference_role_notes),
                max_chars,
            );
            if !normalized.trim().is_empty() {
                return normalized;
            }
        }
    }
    if fallback.trim().is_empty() {
        truncate_chars(
            &append_missing_reference_role_notes(raw_prompt, &reference_role_notes),
            max_chars,
        )
    } else {
        truncate_chars(
            &append_missing_reference_role_notes(&fallback, &reference_role_notes),
            max_chars,
        )
    }
}

fn runtime_tool_log_context_from_payload(payload: &Value) -> RuntimeToolLogContext {
    RuntimeToolLogContext {
        session_id: normalize_optional_string(
            payload_string(payload, "sessionId").or_else(|| payload_string(payload, "session_id")),
        ),
        tool_call_id: normalize_optional_string(
            payload_string(payload, "toolCallId")
                .or_else(|| payload_string(payload, "tool_call_id")),
        ),
        tool_name: payload_string(payload, "toolName").unwrap_or_else(|| "app_cli".to_string()),
    }
}

fn emit_video_generation_progress(app: &AppHandle, context: &RuntimeToolLogContext, message: &str) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }
    println!("[video-gen] {trimmed}");
    let Some(tool_call_id) = context.tool_call_id.as_deref() else {
        return;
    };
    emit_runtime_tool_partial(
        app,
        context.session_id.as_deref(),
        tool_call_id,
        context.tool_name.as_str(),
        trimmed,
    );
}

fn video_generation_asset_label(index: i64, count: i64) -> String {
    if count > 1 {
        format!("第 {}/{} 个视频", index + 1, count)
    } else {
        "视频任务".to_string()
    }
}

pub fn handle_generation_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(channel, "image-gen:generate" | "video-gen:generate") {
        return None;
    }

    Some((|| -> Result<Value, String> {
        let count = payload_field(payload, "count")
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
            .clamp(1, 4);
        let prompt = normalize_optional_string(payload_string(payload, "prompt"));
        let project_id = normalize_optional_string(payload_string(payload, "projectId"));
        let title = normalize_optional_string(payload_string(payload, "title"));
        let provider = normalize_optional_string(payload_string(payload, "provider"));
        let provider_template =
            normalize_optional_string(payload_string(payload, "providerTemplate"));
        let model = normalize_optional_string(payload_string(payload, "model"));
        let aspect_ratio = normalize_optional_string(payload_string(payload, "aspectRatio"));
        let size = normalize_optional_string(payload_string(payload, "size"));
        let quality = normalize_optional_string(payload_string(payload, "quality"));
        let mime_type = if channel == "video-gen:generate" {
            Some("video/mp4".to_string())
        } else {
            Some("image/png".to_string())
        };
        let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
        let auth_runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings_snapshot =
            crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime);
        let real_image_config = if channel == "image-gen:generate" {
            resolve_image_generation_settings(&settings_snapshot)
        } else {
            None
        };
        let real_video_config = if channel == "video-gen:generate" {
            resolve_video_generation_settings(&settings_snapshot)
        } else {
            None
        };
        let effective_image_prompt = if channel == "image-gen:generate" {
            prompt.clone().map(|raw| {
                optimize_image_generation_prompt(
                    app,
                    state,
                    &settings_snapshot,
                    payload,
                    &raw,
                    title.as_deref(),
                    aspect_ratio.as_deref(),
                    size.as_deref(),
                    quality.as_deref(),
                )
            })
        } else {
            None
        };

        let used_configured_endpoint = if channel == "video-gen:generate" {
            real_video_config.is_some()
        } else {
            real_image_config.is_some()
        };
        let video_log_context = if channel == "video-gen:generate" {
            Some(runtime_tool_log_context_from_payload(payload))
        } else {
            None
        };
        let media_root_path = media_root(state)?;
        let mut created = Vec::new();
        for index in 0..count {
            let effective_mime_type = mime_type.clone();
            let file_ext = if channel == "video-gen:generate" {
                "mp4"
            } else {
                "png"
            };
            let relative_path = format!("generated/media-{}-{}.{}", now_ms(), index + 1, file_ext);
            let absolute_path = media_root_path.join(&relative_path);
            let preview_url = if channel == "video-gen:generate" {
                let Some((endpoint, api_key, default_model)) = &real_video_config else {
                    return Err("video generation requires a configured video provider".to_string());
                };
                let effective_video_model = model.clone().unwrap_or_else(|| {
                    match payload_field(payload, "generationMode")
                        .and_then(|value| value.as_str())
                        .unwrap_or("text-to-video")
                    {
                        "reference-guided" => "wan2.7-r2v-video".to_string(),
                        "first-last-frame" | "continuation" => "wan2.7-i2v-video".to_string(),
                        _ => default_model.clone(),
                    }
                });
                let asset_label = video_generation_asset_label(index, count);
                if let Some(context) = video_log_context.as_ref() {
                    let generation_mode = payload_field(payload, "generationMode")
                        .and_then(Value::as_str)
                        .unwrap_or("text-to-video");
                    let duration_seconds = payload_field(payload, "durationSeconds")
                        .and_then(Value::as_i64)
                        .unwrap_or(5);
                    let reference_count = payload_field(payload, "referenceImages")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0);
                    emit_video_generation_progress(
                        app,
                        context,
                        &format!(
                            "{asset_label}：开始请求 provider，mode={generation_mode}，model={effective_video_model}，duration={duration_seconds}s，referenceImages={reference_count}。"
                        ),
                    );
                }
                let response = match run_video_generation_request(
                    endpoint,
                    api_key.as_deref(),
                    effective_video_model.as_str(),
                    payload,
                ) {
                    Ok(response) => response,
                    Err(error) => {
                        if let Some(context) = video_log_context.as_ref() {
                            emit_video_generation_progress(
                                app,
                                context,
                                &format!("{asset_label}：提交 provider 请求失败：{error}"),
                            );
                        }
                        return Err(error);
                    }
                };
                if let Some(context) = video_log_context.as_ref() {
                    if let Some((task_id, source)) = extract_task_id_details(&response) {
                        emit_video_generation_progress(
                            app,
                            context,
                            &format!("{asset_label}：create_response task_id[{source}]={task_id}"),
                        );
                    } else {
                        emit_video_generation_progress(
                            app,
                            context,
                            &format!("{asset_label}：create_response task_id=<missing>"),
                        );
                        emit_video_generation_progress(
                            app,
                            context,
                            &format!(
                                "{asset_label}：create_response body={}",
                                summarize_json_for_log(&response)
                            ),
                        );
                    }
                    if let Some((status, source)) =
                        extract_video_generation_status_details(&response)
                    {
                        emit_video_generation_progress(
                            app,
                            context,
                            &format!(
                                "{asset_label}：create_response api_status[{source}]={status}"
                            ),
                        );
                    }
                    if let Some(status_url) =
                        extract_status_url(&response).filter(|item| !item.trim().is_empty())
                    {
                        emit_video_generation_progress(
                            app,
                            context,
                            &format!("{asset_label}：create_response status_url={status_url}"),
                        );
                    }
                }
                if let Some(item) = extract_first_media_result(&response) {
                    if let Some(b64) = item.get("b64_json").and_then(|value| value.as_str()) {
                        if let Some(context) = video_log_context.as_ref() {
                            emit_video_generation_progress(
                                app,
                                context,
                                &format!(
                                    "{asset_label}：provider 已直接返回视频数据，正在写入媒体库。"
                                ),
                            );
                        }
                        let bytes = decode_base64_bytes(b64)?;
                        if let Some(parent) = absolute_path.parent() {
                            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                        }
                        fs::write(&absolute_path, bytes).map_err(|error| error.to_string())?;
                    } else {
                        let url = poll_video_generation_result(
                            endpoint,
                            api_key.as_deref(),
                            effective_video_model.as_str(),
                            &response,
                            |message| {
                                if let Some(context) = video_log_context.as_ref() {
                                    emit_video_generation_progress(
                                        app,
                                        context,
                                        &format!("{asset_label}：{message}"),
                                    );
                                }
                            },
                        )?;
                        if let Some(context) = video_log_context.as_ref() {
                            emit_video_generation_progress(
                                app,
                                context,
                                &format!("{asset_label}：任务已完成，开始下载视频结果。"),
                            );
                        }
                        let bytes =
                            run_curl_bytes("GET", &url, None, &[], None).map_err(|error| {
                                if let Some(context) = video_log_context.as_ref() {
                                    emit_video_generation_progress(
                                        app,
                                        context,
                                        &format!("{asset_label}：下载生成结果失败：{error}"),
                                    );
                                }
                                error
                            })?;
                        if let Some(parent) = absolute_path.parent() {
                            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                        }
                        fs::write(&absolute_path, bytes).map_err(|error| error.to_string())?;
                    }
                } else {
                    return Err(
                        "video generation response did not include a usable media result"
                            .to_string(),
                    );
                }
                if let Some(context) = video_log_context.as_ref() {
                    emit_video_generation_progress(
                        app,
                        context,
                        &format!("{asset_label}：已写入媒体库 {}。", absolute_path.display()),
                    );
                }
                Some(file_url_for_path(&absolute_path))
            } else {
                let mut wrote_real_asset = false;
                if let Some((
                    endpoint,
                    api_key,
                    default_model,
                    default_provider,
                    default_template,
                )) = &real_image_config
                {
                    let mut effective_payload = payload.clone();
                    if let Some(object) = effective_payload.as_object_mut() {
                        object.insert(
                            "prompt".to_string(),
                            json!(effective_image_prompt.clone().unwrap_or_default()),
                        );
                    }
                    if let Ok(response) = run_image_generation_request(
                        endpoint,
                        api_key.as_deref(),
                        model
                            .clone()
                            .unwrap_or_else(|| default_model.clone())
                            .as_str(),
                        provider.as_deref().unwrap_or(default_provider.as_str()),
                        provider_template
                            .as_deref()
                            .unwrap_or(default_template.as_str()),
                        &effective_payload,
                    ) {
                        if let Some(item) = extract_first_media_result(&response) {
                            if write_generated_image_asset(&absolute_path, item).is_ok() {
                                wrote_real_asset = true;
                            }
                        }
                    }
                }
                if !wrote_real_asset {
                    write_placeholder_svg(
                        &absolute_path,
                        &title.clone().unwrap_or_else(|| "RedBox Image".to_string()),
                        &effective_image_prompt
                            .clone()
                            .unwrap_or_default()
                            .chars()
                            .take(48)
                            .collect::<String>(),
                        "#E76F51",
                    )?;
                }
                Some(file_url_for_path(&absolute_path))
            };
            let asset = MediaAssetRecord {
                id: make_id("media"),
                source: "generated".to_string(),
                project_id: project_id.clone(),
                title: title
                    .clone()
                    .or_else(|| {
                        prompt
                            .clone()
                            .map(|item| item.chars().take(24).collect::<String>())
                    })
                    .map(|item| {
                        if count > 1 {
                            format!("{item} {}", index + 1)
                        } else {
                            item
                        }
                    }),
                prompt: if channel == "image-gen:generate" {
                    effective_image_prompt.clone()
                } else {
                    prompt.clone()
                },
                provider: provider.clone(),
                provider_template: provider_template.clone(),
                model: model.clone(),
                aspect_ratio: aspect_ratio.clone(),
                size: size.clone(),
                quality: quality.clone(),
                mime_type: effective_mime_type.clone(),
                relative_path: Some(relative_path),
                bound_manuscript_path: None,
                created_at: now_iso(),
                updated_at: now_iso(),
                absolute_path: Some(absolute_path.display().to_string()),
                preview_url: preview_url.clone(),
                exists: true,
            };
            created.push(asset);
        }
        with_store_mut(state, |store| {
            for asset in &created {
                store.media_assets.push(asset.clone());
            }
            store.work_items.push(create_work_item(
                if channel == "video-gen:generate" {
                    "video-generation"
                } else {
                    "image-generation"
                },
                title.clone().unwrap_or_else(|| {
                    if channel == "video-gen:generate" {
                        "视频生成"
                    } else {
                        "图片生成"
                    }
                    .to_string()
                }),
                normalize_optional_string(Some(if used_configured_endpoint {
                    "RedBox 已尝试通过已配置 endpoint 执行真实生成。".to_string()
                } else {
                    "RedBox 已保存生成请求；当前缺少可用 provider 配置，已生成本地可追踪产物。"
                        .to_string()
                })),
                if channel == "image-gen:generate" {
                    effective_image_prompt.clone()
                } else {
                    prompt.clone()
                },
                project_id.clone().map(|value| {
                    json!({
                        "projectId": value,
                        "generationChannel": channel,
                        "usedConfiguredEndpoint": used_configured_endpoint
                    })
                }),
                2,
            ));
            Ok(())
        })?;
        persist_media_workspace_catalog(state)?;
        Ok(json!({
            "success": true,
            "kind": if channel == "video-gen:generate" {
                "generated-videos"
            } else {
                "generated-images"
            },
            "assets": created
        }))
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_optimized_prompt_prefers_structured_json_field() {
        let optimized =
            extract_optimized_prompt(r#"{"optimizedPrompt":"主体清晰，晨光客厅，真实摄影"}"#);
        assert_eq!(optimized.as_deref(), Some("主体清晰，晨光客厅，真实摄影"));
    }

    #[test]
    fn fallback_optimizer_adds_mode_specific_guidance() {
        let prompt = build_fallback_optimized_image_prompt(
            "一只橘猫坐在木椅上",
            Some("猫咪写真"),
            "reference-guided",
            &[
                "参考图1：用于锁定主体身份".to_string(),
                "参考图2：用于补充材质与环境".to_string(),
            ],
            Some("3:4"),
            None,
            Some("high"),
        );
        assert!(prompt.contains("保持参考图主体身份"));
        assert!(prompt.contains("参考图1：用于锁定主体身份"));
        assert!(prompt.contains("画幅比例 3:4"));
        assert!(prompt.contains("不要出现提示词原文"));
        assert!(prompt.contains("高完成度"));
    }

    #[test]
    fn append_missing_reference_role_notes_injects_per_image_roles() {
        let prompt = append_missing_reference_role_notes(
            "Jamba 坐在餐桌前吃面，真实摄影风格",
            &[
                "参考图1：用于锁定主体 Jamba 的身份和面部特征。".to_string(),
                "参考图2：用于补充餐馆环境和暖色灯光。".to_string(),
            ],
        );
        assert!(prompt.contains("参考图1"));
        assert!(prompt.contains("参考图2"));
    }
}
