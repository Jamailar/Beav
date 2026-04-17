use crate::commands::library::persist_media_workspace_catalog;
use crate::persistence::{with_store, with_store_mut};
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
    payload: &Value,
    raw_prompt: &str,
    title: Option<&str>,
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> String {
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let reference_count = payload_field(payload, "referenceImages")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0)
        .min(4);
    [
        format!("原始提示词：{}", raw_prompt.trim()),
        format!("标题：{}", title.unwrap_or("(无标题)")),
        format!("生成模式：{}", generation_mode),
        format!("参考图数量：{}", reference_count),
        format!("画幅比例：{}", aspect_ratio.unwrap_or("未指定")),
        format!("尺寸：{}", size.unwrap_or("未指定")),
        format!("质量：{}", quality.unwrap_or("未指定")),
        "请按已加载 skill 和 rules，把上面的原始需求整理成一段最终生图提示词。".to_string(),
        "要求：保留用户主体意图；参考图模式优先保留主体身份、构图重心与色彩关系；默认补足构图、镜头、光线、材质、环境和完成度；不要把提示词原文、布局标签、水印或 AI 标签直接画进图里；不要输出负向提示词字段，不要输出解释。".to_string(),
    ]
    .join("\n")
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

fn build_fallback_optimized_image_prompt(
    payload: &Value,
    raw_prompt: &str,
    title: Option<&str>,
    aspect_ratio: Option<&str>,
    size: Option<&str>,
    quality: Option<&str>,
) -> String {
    let trimmed = raw_prompt.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-image".to_string());
    let reference_count = payload_field(payload, "referenceImages")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0)
        .min(4);
    let mut parts = Vec::<String>::new();
    if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("主题：{title}"));
    }
    parts.push(trimmed.to_string());
    match generation_mode.as_str() {
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
    if reference_count > 0 {
        parts.push(format!("参考图约束生效，共 {} 张", reference_count));
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
    let fallback = build_fallback_optimized_image_prompt(
        payload,
        raw_prompt,
        title,
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
        payload,
        raw_prompt,
        title,
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
            let normalized = truncate_chars(optimized.trim(), max_chars);
            if !normalized.trim().is_empty() {
                return normalized;
            }
        }
    }
    if fallback.trim().is_empty() {
        raw_prompt.trim().to_string()
    } else {
        fallback
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

        let created = with_store_mut(state, |store| {
            let mut assets = Vec::new();
            for index in 0..count {
                let mut effective_mime_type = mime_type.clone();
                let mut file_ext = if channel == "video-gen:generate" {
                    "mp4"
                } else {
                    "png"
                };
                let relative_path =
                    format!("generated/media-{}-{}.{}", now_ms(), index + 1, file_ext);
                let mut relative_path = relative_path;
                let mut absolute_path = media_root(state)?.join(&relative_path);
                let preview_url = if channel == "video-gen:generate" {
                    let mut wrote_real_asset = false;
                    if let Some((endpoint, api_key, default_model)) = &real_video_config {
                        let effective_video_model = model.clone().unwrap_or_else(|| {
                            match payload_field(payload, "generationMode")
                                .and_then(|value| value.as_str())
                                .unwrap_or("text-to-video")
                            {
                                "reference-guided" => "wan2.7-r2v-video".to_string(),
                                "first-last-frame" | "continuation" => {
                                    "wan2.7-i2v-video".to_string()
                                }
                                _ => default_model.clone(),
                            }
                        });
                        if let Ok(response) = run_video_generation_request(
                            endpoint,
                            api_key.as_deref(),
                            effective_video_model.as_str(),
                            payload,
                        ) {
                            if let Some(item) = extract_first_media_result(&response) {
                                if let Some(url) = extract_media_url(item).or_else(|| {
                                    poll_video_generation_result(
                                        endpoint,
                                        api_key.as_deref(),
                                        effective_video_model.as_str(),
                                        &response,
                                    )
                                }) {
                                    let bytes = run_curl_bytes("GET", &url, None, &[], None)?;
                                    if let Some(parent) = absolute_path.parent() {
                                        fs::create_dir_all(parent)
                                            .map_err(|error| error.to_string())?;
                                    }
                                    fs::write(&absolute_path, bytes)
                                        .map_err(|error| error.to_string())?;
                                    wrote_real_asset = true;
                                } else if let Some(b64) =
                                    item.get("b64_json").and_then(|value| value.as_str())
                                {
                                    let bytes = decode_base64_bytes(b64)?;
                                    if let Some(parent) = absolute_path.parent() {
                                        fs::create_dir_all(parent)
                                            .map_err(|error| error.to_string())?;
                                    }
                                    fs::write(&absolute_path, bytes)
                                        .map_err(|error| error.to_string())?;
                                    wrote_real_asset = true;
                                }
                            }
                        }
                    }
                    if !wrote_real_asset {
                        file_ext = "md";
                        effective_mime_type = Some("text/markdown".to_string());
                        relative_path =
                            format!("generated/media-{}-{}.{}", now_ms(), index + 1, file_ext);
                        absolute_path = media_root(state)?.join(&relative_path);
                        let fallback_note = format!(
                            "# Video Generation Fallback\n\nTitle: {}\n\nPrompt:\n{}\n\nThe configured video provider did not return a downloadable video within the polling window. This file records the request so it can be retried or inspected.",
                            title.clone().unwrap_or_else(|| "视频生成".to_string()),
                            prompt.clone().unwrap_or_default()
                        );
                        if let Some(parent) = absolute_path.parent() {
                            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                        }
                        fs::write(&absolute_path, fallback_note)
                            .map_err(|error| error.to_string())?;
                    }
                    if wrote_real_asset {
                        Some(file_url_for_path(&absolute_path))
                    } else {
                        None
                    }
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
                store.media_assets.push(asset.clone());
                assets.push(asset);
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
                normalize_optional_string(Some(
                    if (channel == "image-gen:generate" && real_image_config.is_some())
                        || (channel == "video-gen:generate" && real_video_config.is_some())
                    {
                        "RedBox 已尝试通过已配置 endpoint 执行真实生成。".to_string()
                    } else {
                        "RedBox 已保存生成请求；当前缺少可用 provider 配置，已生成本地可追踪产物。"
                            .to_string()
                    },
                )),
                if channel == "image-gen:generate" {
                    effective_image_prompt.clone()
                } else {
                    prompt.clone()
                },
                project_id.clone().map(|value| {
                    json!({
                        "projectId": value,
                        "generationChannel": channel,
                        "usedConfiguredEndpoint": if channel == "video-gen:generate" {
                            real_video_config.is_some()
                        } else {
                            real_image_config.is_some()
                        }
                    })
                }),
                2,
            ));
            Ok(assets)
        })?;
        persist_media_workspace_catalog(state)?;
        Ok(json!({ "success": true, "assets": created }))
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
        let payload = json!({
            "generationMode": "reference-guided",
            "referenceImages": ["a", "b"],
        });
        let prompt = build_fallback_optimized_image_prompt(
            &payload,
            "一只橘猫坐在木椅上",
            Some("猫咪写真"),
            Some("3:4"),
            None,
            Some("high"),
        );
        assert!(prompt.contains("保持参考图主体身份"));
        assert!(prompt.contains("画幅比例 3:4"));
        assert!(prompt.contains("不要出现提示词原文"));
        assert!(prompt.contains("高完成度"));
    }
}
