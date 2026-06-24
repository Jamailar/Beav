use super::progress::{emit_image_generation_log, summarize_json_for_log};
use crate::persistence::with_store_mut;
use crate::runtime::append_runtime_event_for_session;
use crate::{
    extract_first_media_result, file_content_hash, file_url_for_path, make_id, now_ms, now_rfc3339,
    payload_field, payload_string, run_image_generation_request, write_generated_image_asset,
    write_placeholder_svg, AppState, MediaAssetRecord,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::State;

pub(super) struct SingleImageGenerationInput {
    pub media_root_path: PathBuf,
    pub count: i64,
    pub real_image_config: Option<(String, Option<String>, String, String, String)>,
    pub provider: Option<String>,
    pub provider_template: Option<String>,
    pub model: Option<String>,
    pub title: Option<String>,
    pub project_id: Option<String>,
    pub aspect_ratio: Option<String>,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub prompt: Option<String>,
    pub effective_image_prompt: Option<String>,
    pub placeholder_fallback_allowed: bool,
}

fn optional_payload_string(payload: &Value, key: &str) -> Option<String> {
    payload_string(payload, key).and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn reference_image_count(payload: &Value) -> usize {
    payload_field(payload, "referenceImages")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn truncate_event_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn append_image_generation_event(
    state: &State<'_, AppState>,
    payload: &Value,
    project_id: Option<String>,
    event_type: &str,
    event_payload: Value,
) {
    let result = with_store_mut(state, |store| {
        append_runtime_event_for_session(
            store,
            "media_generation",
            event_type,
            optional_payload_string(payload, "sessionId")
                .or_else(|| optional_payload_string(payload, "session_id")),
            optional_payload_string(payload, "taskId")
                .or_else(|| optional_payload_string(payload, "sourceTaskId")),
            optional_payload_string(payload, "toolCallId")
                .or_else(|| optional_payload_string(payload, "tool_call_id")),
            project_id,
            Some(event_payload.clone()),
        );
        crate::analytics::observe_media_generation_event(
            state,
            "image",
            event_type,
            &event_payload,
        );
        Ok(())
    });
    if let Err(error) = result {
        emit_image_generation_log(
            state,
            format!("[image-gen] runtime-event:write-error error={error}"),
        );
    }
}

pub(super) fn generate_single_image_assets(
    state: &State<'_, AppState>,
    payload: &Value,
    input: SingleImageGenerationInput,
) -> Result<Vec<MediaAssetRecord>, String> {
    let SingleImageGenerationInput {
        media_root_path,
        count,
        real_image_config,
        provider,
        provider_template,
        model,
        title,
        project_id,
        aspect_ratio,
        size,
        quality,
        prompt,
        effective_image_prompt,
        placeholder_fallback_allowed,
    } = input;
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
            append_image_generation_event(
                state,
                payload,
                project_id.clone(),
                "request.started",
                json!({
                    "mediaKind": "image",
                    "provider": effective_provider,
                    "providerTemplate": effective_template,
                    "model": effective_model,
                    "generationMode": payload_string(payload, "generationMode")
                        .unwrap_or_else(|| "text-to-image".to_string()),
                    "referenceCount": reference_image_count(payload),
                    "assetIndex": index,
                    "assetCount": count,
                    "placeholderFallbackAllowed": placeholder_fallback_allowed
                }),
            );
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
                    append_image_generation_event(
                        state,
                        payload,
                        project_id.clone(),
                        "request.failed",
                        json!({
                            "mediaKind": "image",
                            "provider": effective_provider,
                            "providerTemplate": effective_template,
                            "model": effective_model,
                            "generationMode": payload_string(payload, "generationMode")
                                .unwrap_or_else(|| "text-to-image".to_string()),
                            "referenceCount": reference_image_count(payload),
                            "assetIndex": index,
                            "assetCount": count,
                            "error": truncate_event_text(&error, 600),
                            "placeholderFallbackAllowed": placeholder_fallback_allowed
                        }),
                    );
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
                        append_image_generation_event(
                            state,
                            payload,
                            project_id.clone(),
                            "asset.write_failed",
                            json!({
                                "mediaKind": "image",
                                "provider": effective_provider,
                                "providerTemplate": effective_template,
                                "model": effective_model,
                                "generationMode": payload_string(payload, "generationMode")
                                    .unwrap_or_else(|| "text-to-image".to_string()),
                                "referenceCount": reference_image_count(payload),
                                "assetIndex": index,
                                "assetCount": count,
                                "relativePath": relative_path,
                                "error": truncate_event_text(&error, 600),
                                "placeholderFallbackAllowed": placeholder_fallback_allowed
                            }),
                        );
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
                        append_image_generation_event(
                            state,
                            payload,
                            project_id.clone(),
                            "request.completed",
                            json!({
                                "mediaKind": "image",
                                "provider": effective_provider,
                                "providerTemplate": effective_template,
                                "model": effective_model,
                                "generationMode": payload_string(payload, "generationMode")
                                    .unwrap_or_else(|| "text-to-image".to_string()),
                                "referenceCount": reference_image_count(payload),
                                "assetIndex": index,
                                "assetCount": count,
                                "relativePath": relative_path,
                            }),
                        );
                    }
                } else if placeholder_fallback_allowed {
                    append_image_generation_event(
                        state,
                        payload,
                        project_id.clone(),
                        "response.empty",
                        json!({
                            "mediaKind": "image",
                            "provider": effective_provider,
                            "providerTemplate": effective_template,
                            "model": effective_model,
                            "generationMode": payload_string(payload, "generationMode")
                                .unwrap_or_else(|| "text-to-image".to_string()),
                            "referenceCount": reference_image_count(payload),
                            "assetIndex": index,
                            "assetCount": count,
                            "placeholderFallbackAllowed": placeholder_fallback_allowed
                        }),
                    );
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
                    append_image_generation_event(
                        state,
                        payload,
                        project_id.clone(),
                        "response.empty",
                        json!({
                            "mediaKind": "image",
                            "provider": effective_provider,
                            "providerTemplate": effective_template,
                            "model": effective_model,
                            "generationMode": payload_string(payload, "generationMode")
                                .unwrap_or_else(|| "text-to-image".to_string()),
                            "referenceCount": reference_image_count(payload),
                            "assetIndex": index,
                            "assetCount": count,
                            "placeholderFallbackAllowed": placeholder_fallback_allowed
                        }),
                    );
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
        assets.push(asset);
    }
    Ok(assets)
}
