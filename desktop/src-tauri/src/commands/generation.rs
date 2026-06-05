use crate::commands::library::persist_media_workspace_catalog;
use crate::persistence::{with_store, with_store_mut};
use crate::store::{
    media as media_store, settings as settings_store, work_items as work_items_store,
};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};

mod image_batch;
mod image_plan;
mod progress;

use image_batch::generate_planned_image_batch;
use image_plan::extract_planned_image_generation_items;
use progress::{
    emit_image_generation_log, emit_video_generation_progress,
    runtime_tool_log_context_from_payload, summarize_json_for_log, video_generation_asset_label,
};

#[cfg(test)]
fn is_redbox_official_video_endpoint(endpoint: &str) -> bool {
    crate::media_generation::is_redbox_official_endpoint(endpoint)
}

#[derive(Debug, Clone)]
pub(crate) struct ImageGenerationExecutionResult {
    pub assets: Vec<MediaAssetRecord>,
    pub used_configured_endpoint: bool,
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub project_id: Option<String>,
}

pub(crate) fn generate_image_assets(
    state: &State<'_, AppState>,
    payload: &Value,
    mut on_asset_created: impl FnMut(&MediaAssetRecord, usize, usize) -> Result<(), String>,
) -> Result<ImageGenerationExecutionResult, String> {
    let planned_image_items = extract_planned_image_generation_items(payload);
    let count = if !planned_image_items.is_empty() {
        planned_image_items.len() as i64
    } else {
        payload_field(payload, "count")
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
            .clamp(1, 4)
    };
    let prompt = normalize_optional_string(
        payload_string(payload, "compiledPrompt").or_else(|| payload_string(payload, "prompt")),
    );
    let project_id = normalize_optional_string(payload_string(payload, "projectId"));
    let title = normalize_optional_string(payload_string(payload, "title"));
    let provider = normalize_optional_string(payload_string(payload, "provider"));
    let provider_template = normalize_optional_string(payload_string(payload, "providerTemplate"));
    let model = normalize_optional_string(payload_string(payload, "model"));
    let aspect_ratio = normalize_optional_string(
        payload_string(payload, "aspectRatio")
            .or_else(|| payload_string(payload, "aspect_ratio"))
            .or_else(|| payload_string(payload, "ratio")),
    );
    let size = normalize_optional_string(
        payload_string(payload, "size")
            .or_else(|| payload_string(payload, "imageSize"))
            .or_else(|| payload_string(payload, "image_size")),
    );
    let quality = normalize_optional_string(
        payload_string(payload, "quality")
            .or_else(|| payload_string(payload, "imageQuality"))
            .or_else(|| payload_string(payload, "image_quality")),
    );
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let settings_snapshot = {
        let auth_runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime)
    };
    let real_image_config =
        resolve_image_generation_settings_with_override(&settings_snapshot, Some(payload));
    let used_configured_endpoint = real_image_config.is_some();
    let effective_image_prompt = prompt.clone();
    let placeholder_fallback_allowed = allow_placeholder_fallback(payload);
    let media_root_path = media_root(state)?;

    if planned_image_items.len() > 1 {
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
        let (assets, used_configured_endpoint) = generate_planned_image_batch(
            payload,
            media_root_path.as_path(),
            &planned_image_items,
            real_image_config,
            provider,
            provider_template,
            model,
            title.clone(),
            project_id.clone(),
            aspect_ratio,
            size,
            quality,
            placeholder_fallback_allowed,
            on_asset_created,
        )?;
        return Ok(ImageGenerationExecutionResult {
            assets,
            used_configured_endpoint,
            title,
            prompt,
            project_id,
        });
    }

    let mut assets = Vec::new();
    for index in 0..count {
        let relative_path = format!("generated/media-{}-{}.png", now_ms(), index + 1);
        let absolute_path = media_root_path.join(&relative_path);
        let preview_url = if let Some((
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
                            &title
                                .clone()
                                .unwrap_or_else(|| "Generated Image".to_string()),
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
                                &title
                                    .clone()
                                    .unwrap_or_else(|| "Generated Image".to_string()),
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
                        &title
                            .clone()
                            .unwrap_or_else(|| "Generated Image".to_string()),
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
                &title
                    .clone()
                    .unwrap_or_else(|| "Generated Image".to_string()),
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
                    "[image-gen] missing provider config channel=image-gen:generate mode={} title={}",
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
            prompt: effective_image_prompt.clone(),
            provider: provider.clone(),
            provider_template: provider_template.clone(),
            model: model.clone(),
            aspect_ratio: aspect_ratio.clone(),
            size: size.clone(),
            quality: quality.clone(),
            mime_type: Some("image/png".to_string()),
            content_hash: file_content_hash(&absolute_path).ok(),
            relative_path: Some(relative_path),
            bound_manuscript_path: None,
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
            absolute_path: Some(absolute_path.display().to_string()),
            preview_url,
            thumbnail_url: None,
            exists: true,
        };
        on_asset_created(&asset, (index + 1) as usize, count as usize)?;
        assets.push(asset);
    }

    Ok(ImageGenerationExecutionResult {
        assets,
        used_configured_endpoint,
        title,
        prompt,
        project_id,
    })
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
        if channel == "image-gen:generate" {
            let execution =
                generate_image_assets(state, payload, |_asset, _completed, _total| Ok(()))?;
            with_store_mut(state, |store| {
                for asset in &execution.assets {
                    media_store::push_asset(store, asset.clone());
                }
                work_items_store::push_item(
                    store,
                    create_work_item(
                        "image-generation",
                        execution
                            .title
                            .clone()
                            .unwrap_or_else(|| "图片生成".to_string()),
                        normalize_optional_string(Some(if execution.used_configured_endpoint {
                            format!(
                                "{} 已通过已配置 endpoint 执行真实生成。",
                                app_brand_display_name()
                            )
                        } else {
                            format!(
                            "{} 已保存生成请求；当前缺少可用 provider 配置，仅生成了本地占位产物。",
                            app_brand_display_name()
                        )
                        })),
                        execution.prompt.clone(),
                        execution.project_id.clone().map(|value| {
                            json!({
                                "projectId": value,
                                "generationChannel": channel,
                                "usedConfiguredEndpoint": execution.used_configured_endpoint,
                                "batchCount": execution.assets.len(),
                            })
                        }),
                        2,
                    ),
                );
                Ok(())
            })?;
            persist_media_workspace_catalog(state)?;
            return Ok(json!({
                "success": true,
                "kind": "generated-images",
                "assets": execution.assets,
            }));
        }

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
        let mime_type = Some("video/mp4".to_string());
        let settings_snapshot =
            with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
        let settings_snapshot = {
            let auth_runtime = state
                .auth_runtime
                .lock()
                .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
            crate::auth::project_settings_for_runtime(&settings_snapshot, &auth_runtime)
        };
        let real_video_config =
            resolve_video_generation_settings_with_override(&settings_snapshot, Some(payload));
        let used_configured_endpoint = real_video_config.is_some();
        let video_log_context = runtime_tool_log_context_from_payload(payload);
        let media_root_path = media_root(state)?;
        let mut created = Vec::new();
        for index in 0..count {
            let effective_mime_type = mime_type.clone();
            let relative_path = format!("generated/media-{}-{}.mp4", now_ms(), index + 1);
            let absolute_path = media_root_path.join(&relative_path);
            let (preview_url, thumbnail_url) = {
                let Some((endpoint, api_key, default_model)) = &real_video_config else {
                    return Err("video generation requires a configured video provider".to_string());
                };
                let generation_mode = payload_field(payload, "generationMode")
                    .and_then(|value| value.as_str())
                    .unwrap_or("text-to-video");
                let effective_video_model = model.clone().unwrap_or_else(|| default_model.clone());
                let asset_label = video_generation_asset_label(index, count);
                let duration_seconds = payload_field(payload, "durationSeconds")
                    .and_then(Value::as_i64)
                    .unwrap_or(5);
                let reference_count = payload_field(payload, "referenceImages")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                emit_video_generation_progress(
                    app,
                    &video_log_context,
                    &format!(
                        "{asset_label}：开始请求 provider，mode={generation_mode}，model={effective_video_model}，duration={duration_seconds}s，referenceImages={reference_count}。"
                    ),
                );
                let response = match run_video_generation_request(
                    endpoint,
                    api_key.as_deref(),
                    effective_video_model.as_str(),
                    payload,
                ) {
                    Ok(response) => response,
                    Err(error) => {
                        emit_video_generation_progress(
                            app,
                            &video_log_context,
                            &format!("{asset_label}：提交 provider 请求失败：{error}"),
                        );
                        return Err(error);
                    }
                };
                if let Some((task_id, source)) = extract_task_id_details(&response) {
                    emit_video_generation_progress(
                        app,
                        &video_log_context,
                        &format!("{asset_label}：create_response task_id[{source}]={task_id}"),
                    );
                } else {
                    emit_video_generation_progress(
                        app,
                        &video_log_context,
                        &format!("{asset_label}：create_response task_id=<missing>"),
                    );
                    emit_video_generation_progress(
                        app,
                        &video_log_context,
                        &format!(
                            "{asset_label}：create_response body={}",
                            summarize_json_for_log(&response)
                        ),
                    );
                }
                if let Some((status, source)) = extract_video_generation_status_details(&response) {
                    emit_video_generation_progress(
                        app,
                        &video_log_context,
                        &format!("{asset_label}：create_response api_status[{source}]={status}"),
                    );
                }
                if let Some(status_url) =
                    extract_status_url(&response).filter(|item| !item.trim().is_empty())
                {
                    emit_video_generation_progress(
                        app,
                        &video_log_context,
                        &format!("{asset_label}：create_response status_url={status_url}"),
                    );
                }
                if let Some(item) = extract_first_media_result(&response) {
                    if let Some(b64) = item.get("b64_json").and_then(|value| value.as_str()) {
                        emit_video_generation_progress(
                            app,
                            &video_log_context,
                            &format!(
                                "{asset_label}：provider 已直接返回视频数据，正在写入媒体库。"
                            ),
                        );
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
                                emit_video_generation_progress(
                                    app,
                                    &video_log_context,
                                    &format!("{asset_label}：{message}"),
                                );
                            },
                        )?;
                        emit_video_generation_progress(
                            app,
                            &video_log_context,
                            &format!("{asset_label}：任务已完成，开始下载视频结果。"),
                        );
                        let bytes =
                            run_curl_bytes("GET", &url, None, &[], None).map_err(|error| {
                                emit_video_generation_progress(
                                    app,
                                    &video_log_context,
                                    &format!("{asset_label}：下载生成结果失败：{error}"),
                                );
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
                let thumbnail_url =
                    crate::ensure_video_thumbnail_for_path(Some(app), state, &absolute_path);
                emit_video_generation_progress(
                    app,
                    &video_log_context,
                    &format!("{asset_label}：已写入媒体库 {}。", absolute_path.display()),
                );
                (Some(file_url_for_path(&absolute_path)), thumbnail_url)
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
                prompt: prompt.clone(),
                provider: provider.clone(),
                provider_template: provider_template.clone(),
                model: model.clone(),
                aspect_ratio: aspect_ratio.clone(),
                size: size.clone(),
                quality: quality.clone(),
                mime_type: effective_mime_type.clone(),
                content_hash: file_content_hash(&absolute_path).ok(),
                relative_path: Some(relative_path),
                bound_manuscript_path: None,
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
                absolute_path: Some(absolute_path.display().to_string()),
                preview_url: preview_url.clone(),
                thumbnail_url,
                exists: true,
            };
            created.push(asset);
        }
        with_store_mut(state, |store| {
            for asset in &created {
                media_store::push_asset(store, asset.clone());
            }
            work_items_store::push_item(
                store,
                create_work_item(
                    "video-generation",
                    title.clone().unwrap_or_else(|| "视频生成".to_string()),
                    normalize_optional_string(Some(if used_configured_endpoint {
                        format!(
                            "{} 已通过已配置 endpoint 执行真实生成。",
                            app_brand_display_name()
                        )
                    } else {
                        format!(
                            "{} 已保存生成请求；当前缺少可用 provider 配置，仅生成了本地占位产物。",
                            app_brand_display_name()
                        )
                    })),
                    prompt.clone(),
                    project_id.clone().map(|value| {
                        json!({
                            "projectId": value,
                            "generationChannel": channel,
                            "usedConfiguredEndpoint": used_configured_endpoint
                        })
                    }),
                    2,
                ),
            );
            Ok(())
        })?;
        persist_media_workspace_catalog(state)?;
        Ok(json!({
            "success": true,
            "kind": "generated-videos",
            "assets": created
        }))
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_thrive_gateway_is_detected_as_official_video_endpoint() {
        assert!(is_redbox_official_video_endpoint(
            "https://api.ziz.hk/thrive/v1"
        ));
    }

    #[test]
    fn image_batch_parallelism_is_four() {
        assert_eq!(image_batch::IMAGE_BATCH_PARALLELISM, 4);
    }
}
