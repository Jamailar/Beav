use crate::commands::library::persist_media_workspace_catalog;
use crate::persistence::{with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};

pub fn handle_generation_channel(
    _app: &AppHandle,
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
                    None
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
                                json!(prompt.clone().unwrap_or_default()),
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
                            &prompt
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
                    prompt: prompt.clone(),
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
                prompt.clone(),
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
