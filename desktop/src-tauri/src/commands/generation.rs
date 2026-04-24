use crate::commands::library::persist_media_workspace_catalog;
use crate::events::emit_runtime_tool_partial;
use crate::persistence::{with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};

const REDBOX_OFFICIAL_VIDEO_ENDPOINT: &str = "https://api.ziz.hk/redbox/v1";
const MAX_IMAGE_BATCH_ITEMS: usize = 6;

#[derive(Debug, Clone, Default)]
struct RuntimeToolLogContext {
    session_id: Option<String>,
    tool_call_id: Option<String>,
    tool_name: String,
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

fn official_video_model_for_mode(generation_mode: &str, default_model: &str) -> String {
    match generation_mode {
        "reference-guided" => "wan2.7-r2v-video".to_string(),
        "first-last-frame" | "continuation" => "wan2.7-i2v-video".to_string(),
        _ => default_model.to_string(),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PlannedImageGenerationItem {
    title: Option<String>,
    prompt: String,
}

fn planned_image_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn extract_planned_image_generation_items(payload: &Value) -> Vec<PlannedImageGenerationItem> {
    payload_field(payload, "imagePlanItems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_IMAGE_BATCH_ITEMS)
                .filter(|item| item.is_object())
                .filter_map(|item| {
                    let prompt = planned_image_string_field(
                        item,
                        &[
                            "compiledPrompt",
                            "prompt",
                            "visual",
                            "description",
                            "picture",
                        ],
                    )?;
                    Some(PlannedImageGenerationItem {
                        title: planned_image_string_field(item, &["title", "name", "label"]),
                        prompt,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn build_generated_image_title(
    batch_title: Option<&str>,
    item_title: Option<&str>,
    prompt: &str,
    index: usize,
    total: usize,
) -> Option<String> {
    if let Some(item_title) = item_title.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(item_title.to_string());
    }
    if let Some(batch_title) = batch_title.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(if total > 1 {
            format!("{batch_title} {}", index + 1)
        } else {
            batch_title.to_string()
        });
    }
    let excerpt = prompt.trim().chars().take(24).collect::<String>();
    if excerpt.is_empty() {
        None
    } else {
        Some(excerpt)
    }
}

fn generate_planned_image_batch(
    payload: &Value,
    media_root_path: &Path,
    planned_items: &[PlannedImageGenerationItem],
    real_image_config: Option<(String, Option<String>, String, String, String)>,
    provider: Option<String>,
    provider_template: Option<String>,
    model: Option<String>,
    title: Option<String>,
    project_id: Option<String>,
    aspect_ratio: Option<String>,
    size: Option<String>,
    quality: Option<String>,
    placeholder_fallback_allowed: bool,
) -> Result<(Vec<MediaAssetRecord>, bool), String> {
    if planned_items.is_empty() {
        return Ok((Vec::new(), real_image_config.is_some()));
    }

    let total = planned_items.len();
    let batch_stamp = now_ms();
    let mime_type = Some("image/png".to_string());

    if let Some((endpoint, api_key, default_model, default_provider, default_template)) =
        real_image_config
    {
        let effective_model = model.unwrap_or(default_model);
        let effective_provider = provider.unwrap_or(default_provider);
        let effective_template = provider_template.unwrap_or(default_template);
        let mut created = Vec::with_capacity(planned_items.len());
        for (index, item) in planned_items.iter().enumerate() {
            let mut request_payload = payload.clone();
            let request_prompt = item.prompt.clone();
            let request_title = build_generated_image_title(
                title.as_deref(),
                item.title.as_deref(),
                request_prompt.as_str(),
                index,
                total,
            );
            if let Some(object) = request_payload.as_object_mut() {
                object.insert("prompt".to_string(), json!(request_prompt.clone()));
                object.insert("count".to_string(), json!(1));
                if let Some(request_title) = request_title.clone() {
                    object.insert("title".to_string(), json!(request_title));
                }
                object.remove("imagePlanItems");
                object.remove("planConfirmed");
                object.remove("sharedStyleGuide");
            }
            let relative_path = format!("generated/media-{}-{}.png", batch_stamp, index + 1);
            let absolute_path = media_root_path.join(&relative_path);
            let response = match run_image_generation_request(
                endpoint.as_str(),
                api_key.as_deref(),
                effective_model.as_str(),
                effective_provider.as_str(),
                effective_template.as_str(),
                &request_payload,
            ) {
                Ok(response) => Some(response),
                Err(error) => {
                    if placeholder_fallback_allowed {
                        write_placeholder_svg(
                            &absolute_path,
                            request_title.as_deref().unwrap_or("RedBox Image"),
                            &request_prompt.chars().take(48).collect::<String>(),
                            "#E76F51",
                        )?;
                        None
                    } else {
                        return Err(format!("图片 {} 生成请求失败：{error}", index + 1));
                    }
                }
            };

            if let Some(response) = response {
                if let Some(item) = extract_first_media_result(&response) {
                    write_generated_image_asset(&absolute_path, item)
                        .map_err(|error| format!("图片 {} 生成结果写入失败：{error}", index + 1))?;
                } else if placeholder_fallback_allowed {
                    write_placeholder_svg(
                        &absolute_path,
                        request_title.as_deref().unwrap_or("RedBox Image"),
                        &request_prompt.chars().take(48).collect::<String>(),
                        "#E76F51",
                    )?;
                } else {
                    return Err(format!(
                        "图片 {} 生成请求已发出，但 provider 返回里没有可用图片结果。",
                        index + 1
                    ));
                }
            }

            created.push(MediaAssetRecord {
                id: make_id("media"),
                source: "generated".to_string(),
                source_domain: None,
                source_link: None,
                project_id: project_id.clone(),
                title: request_title,
                prompt: Some(request_prompt),
                provider: Some(effective_provider.clone()),
                provider_template: Some(effective_template.clone()),
                model: Some(effective_model.clone()),
                aspect_ratio: aspect_ratio.clone(),
                size: size.clone(),
                quality: quality.clone(),
                mime_type: mime_type.clone(),
                relative_path: Some(relative_path),
                bound_manuscript_path: None,
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
                absolute_path: Some(absolute_path.display().to_string()),
                preview_url: Some(file_url_for_path(&absolute_path)),
                exists: true,
            });
        }
        created.sort_by_key(|asset| asset.relative_path.clone().unwrap_or_default());
        return Ok((created, true));
    }

    if !placeholder_fallback_allowed {
        return Err("图片生成未执行：请先在设置中配置生图 Endpoint、API Key 和模型。".to_string());
    }

    let created = planned_items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let asset_title = build_generated_image_title(
                title.as_deref(),
                item.title.as_deref(),
                item.prompt.as_str(),
                index,
                total,
            );
            let relative_path = format!("generated/media-{}-{}.png", batch_stamp, index + 1);
            let absolute_path = media_root_path.join(&relative_path);
            write_placeholder_svg(
                &absolute_path,
                asset_title.as_deref().unwrap_or("RedBox Image"),
                &item.prompt.chars().take(48).collect::<String>(),
                "#E76F51",
            )?;
            Ok(MediaAssetRecord {
                id: make_id("media"),
                source: "generated".to_string(),
                source_domain: None,
                source_link: None,
                project_id: project_id.clone(),
                title: asset_title,
                prompt: Some(item.prompt.clone()),
                provider: provider.clone(),
                provider_template: provider_template.clone(),
                model: model.clone(),
                aspect_ratio: aspect_ratio.clone(),
                size: size.clone(),
                quality: quality.clone(),
                mime_type: mime_type.clone(),
                relative_path: Some(relative_path),
                bound_manuscript_path: None,
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
                absolute_path: Some(absolute_path.display().to_string()),
                preview_url: Some(file_url_for_path(&absolute_path)),
                exists: true,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok((created, false))
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

fn emit_image_generation_log(state: &State<'_, AppState>, line: impl Into<String>) {
    let line = line.into();
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    eprintln!("{trimmed}");
    append_debug_log_state(state, trimmed.to_string());
}

fn video_generation_asset_label(index: i64, count: i64) -> String {
    if count > 1 {
        format!("第 {}/{} 个视频", index + 1, count)
    } else {
        "视频任务".to_string()
    }
}

fn allow_placeholder_fallback(payload: &Value) -> bool {
    payload_field(payload, "allowPlaceholderFallback")
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

    let runtime_bypass = payload_field(payload, "runtimeBypass")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !runtime_bypass {
        return Some(crate::media_runtime::compat_generate_and_wait(
            app, state, channel, payload,
        ));
    }

    Some((|| -> Result<Value, String> {
        let planned_image_items = if channel == "image-gen:generate" {
            extract_planned_image_generation_items(payload)
        } else {
            Vec::new()
        };
        let count = if channel == "image-gen:generate" && !planned_image_items.is_empty() {
            planned_image_items.len() as i64
        } else {
            payload_field(payload, "count")
                .and_then(|value| value.as_i64())
                .unwrap_or(1)
                .clamp(1, 4)
        };
        let prompt = if channel == "image-gen:generate" {
            normalize_optional_string(
                payload_string(payload, "compiledPrompt")
                    .or_else(|| payload_string(payload, "prompt")),
            )
        } else {
            normalize_optional_string(payload_string(payload, "prompt"))
        };
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
        let settings_snapshot = {
            let auth_runtime = state
                .auth_runtime
                .lock()
                .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
            crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime)
        };
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
            prompt.clone()
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
        let placeholder_fallback_allowed = allow_placeholder_fallback(payload);
        let media_root_path = media_root(state)?;
        if channel == "image-gen:generate" && planned_image_items.len() > 1 {
            emit_image_generation_log(
                state,
                format!(
                    "[image-gen] batch:start count={} mode={} refs={}",
                    planned_image_items.len(),
                    payload_string(payload, "generationMode")
                        .unwrap_or_else(|| "text-to-image".to_string()),
                    payload_field(payload, "referenceImages")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0),
                ),
            );
            let (created, used_configured_endpoint) = generate_planned_image_batch(
                payload,
                media_root_path.as_path(),
                &planned_image_items,
                real_image_config.clone(),
                provider.clone(),
                provider_template.clone(),
                model.clone(),
                title.clone(),
                project_id.clone(),
                aspect_ratio.clone(),
                size.clone(),
                quality.clone(),
                placeholder_fallback_allowed,
            )?;
            with_store_mut(state, |store| {
                for asset in &created {
                    store.media_assets.push(asset.clone());
                }
                store.work_items.push(create_work_item(
                    "image-generation",
                    title.clone().unwrap_or_else(|| "图片生成".to_string()),
                    normalize_optional_string(Some(if used_configured_endpoint {
                        "RedBox 已通过已配置 endpoint 并发执行多图生成。".to_string()
                    } else {
                        "RedBox 已保存多图生成请求；当前缺少可用 provider 配置，仅生成了本地占位产物。"
                            .to_string()
                    })),
                    prompt.clone(),
                    project_id.clone().map(|value| {
                        json!({
                            "projectId": value,
                            "generationChannel": channel,
                            "usedConfiguredEndpoint": used_configured_endpoint,
                            "batchCount": created.len()
                        })
                    }),
                    2,
                ));
                Ok(())
            })?;
            persist_media_workspace_catalog(state)?;
            return Ok(json!({
                "success": true,
                "kind": "generated-images",
                "assets": created
            }));
        }
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
                let generation_mode = payload_field(payload, "generationMode")
                    .and_then(|value| value.as_str())
                    .unwrap_or("text-to-video");
                let effective_video_model = if endpoint.trim() == REDBOX_OFFICIAL_VIDEO_ENDPOINT {
                    official_video_model_for_mode(generation_mode, default_model)
                } else {
                    model.clone().unwrap_or_else(|| {
                        official_video_model_for_mode(generation_mode, default_model)
                    })
                };
                let asset_label = video_generation_asset_label(index, count);
                if let Some(context) = video_log_context.as_ref() {
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
            } else if let Some((
                endpoint,
                api_key,
                default_model,
                default_provider,
                default_template,
            )) = &real_image_config
            {
                let effective_model = model.clone().unwrap_or_else(|| default_model.clone());
                let effective_provider = provider
                    .as_deref()
                    .unwrap_or(default_provider.as_str())
                    .to_string();
                let effective_template = provider_template
                    .as_deref()
                    .unwrap_or(default_template.as_str())
                    .to_string();
                emit_image_generation_log(
                    state,
                    format!(
                        "[image-gen] request:start endpoint={} provider={} template={} model={} mode={} refs={}",
                        endpoint,
                        effective_provider,
                        effective_template,
                        effective_model,
                        payload_string(payload, "generationMode")
                            .unwrap_or_else(|| "text-to-image".to_string()),
                        payload_field(payload, "referenceImages")
                            .and_then(Value::as_array)
                            .map(|items| items.len())
                            .unwrap_or(0),
                    ),
                );
                let mut effective_payload = payload.clone();
                if let Some(object) = effective_payload.as_object_mut() {
                    object.insert(
                        "prompt".to_string(),
                        json!(effective_image_prompt.clone().unwrap_or_default()),
                    );
                }
                let response = match run_image_generation_request(
                    endpoint,
                    api_key.as_deref(),
                    effective_model.as_str(),
                    effective_provider.as_str(),
                    effective_template.as_str(),
                    &effective_payload,
                ) {
                    Ok(response) => Some(response),
                    Err(error) => {
                        emit_image_generation_log(
                            state,
                            format!(
                                "[image-gen] request:error endpoint={} provider={} template={} model={} error={error}",
                                endpoint, effective_provider, effective_template, effective_model
                            ),
                        );
                        if placeholder_fallback_allowed {
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
                            None
                        } else {
                            return Err(format!("图片生成请求失败：{error}"));
                        }
                    }
                };
                if let Some(response) = response {
                    if let Some(item) = extract_first_media_result(&response) {
                        if let Err(error) = write_generated_image_asset(&absolute_path, item) {
                            emit_image_generation_log(
                                state,
                                format!(
                                    "[image-gen] asset:write-error path={} error={error}",
                                    absolute_path.display()
                                ),
                            );
                            emit_image_generation_log(
                                state,
                                format!(
                                    "[image-gen] asset:write-error response={}",
                                    summarize_json_for_log(&response)
                                ),
                            );
                            emit_image_generation_log(
                                state,
                                format!(
                                    "[image-gen] asset:write-error first-item={}",
                                    summarize_json_for_log(item)
                                ),
                            );
                            if placeholder_fallback_allowed {
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
                            } else {
                                return Err(format!("图片生成结果写入失败：{error}"));
                            }
                        } else {
                            emit_image_generation_log(
                                state,
                                format!(
                                    "[image-gen] request:ok path={} provider={} template={} model={}",
                                    absolute_path.display(),
                                    effective_provider,
                                    effective_template,
                                    effective_model
                                ),
                            );
                        }
                    } else if placeholder_fallback_allowed {
                        emit_image_generation_log(
                            state,
                            format!(
                                "[image-gen] response:empty fallback response={}",
                                summarize_json_for_log(&response)
                            ),
                        );
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
                    } else {
                        emit_image_generation_log(
                            state,
                            format!(
                                "[image-gen] response:empty endpoint={} provider={} template={} model={}",
                                endpoint, effective_provider, effective_template, effective_model
                            ),
                        );
                        emit_image_generation_log(
                            state,
                            format!(
                                "[image-gen] response:empty body={}",
                                summarize_json_for_log(&response)
                            ),
                        );
                        return Err(
                            "图片生成请求已发出，但 provider 返回里没有可用图片结果。".to_string()
                        );
                    }
                }
                Some(file_url_for_path(&absolute_path))
            } else if placeholder_fallback_allowed {
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
                Some(file_url_for_path(&absolute_path))
            } else {
                emit_image_generation_log(
                    state,
                    format!(
                        "[image-gen] missing provider config channel={channel} mode={} title={}",
                        payload_string(payload, "generationMode")
                            .unwrap_or_else(|| "text-to-image".to_string()),
                        title.clone().unwrap_or_default(),
                    ),
                );
                return Err(
                    "图片生成未执行：请先在设置中配置生图 Endpoint、API Key 和模型。".to_string(),
                );
            };
            let asset = MediaAssetRecord {
                id: make_id("media"),
                source: "generated".to_string(),
                source_domain: None,
                source_link: None,
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
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
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
                    "RedBox 已通过已配置 endpoint 执行真实生成。".to_string()
                } else {
                    "RedBox 已保存生成请求；当前缺少可用 provider 配置，仅生成了本地占位产物。"
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
    fn extract_planned_image_generation_items_prefers_compiled_prompt() {
        let items = extract_planned_image_generation_items(&json!({
            "imagePlanItems": [
                {
                    "title": "封面",
                    "prompt": "原始描述",
                    "compiledPrompt": "最终执行提示词"
                },
                {
                    "label": "第二张",
                    "description": "细节补图"
                }
            ]
        }));

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title.as_deref(), Some("封面"));
        assert_eq!(items[0].prompt, "最终执行提示词");
        assert_eq!(items[1].title.as_deref(), Some("第二张"));
        assert_eq!(items[1].prompt, "细节补图");
    }

    #[test]
    fn extract_planned_image_generation_items_keeps_six_entries() {
        let items = extract_planned_image_generation_items(&json!({
            "imagePlanItems": [
                { "title": "1", "prompt": "p1" },
                { "title": "2", "prompt": "p2" },
                { "title": "3", "prompt": "p3" },
                { "title": "4", "prompt": "p4" },
                { "title": "5", "prompt": "p5" },
                { "title": "6", "prompt": "p6" }
            ]
        }));

        assert_eq!(items.len(), 6);
        assert_eq!(items[5].title.as_deref(), Some("6"));
        assert_eq!(items[5].prompt, "p6");
    }

    #[test]
    fn build_generated_image_title_prefers_item_title_then_batch_title() {
        assert_eq!(
            build_generated_image_title(
                Some("春日咖啡海报"),
                Some("第 2 张 细节页"),
                "咖啡杯特写",
                1,
                3,
            ),
            Some("第 2 张 细节页".to_string())
        );
        assert_eq!(
            build_generated_image_title(Some("春日咖啡海报"), None, "咖啡杯特写", 1, 3),
            Some("春日咖啡海报 2".to_string())
        );
    }
}
