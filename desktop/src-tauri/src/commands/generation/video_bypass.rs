use super::progress::{
    emit_video_generation_progress, runtime_tool_log_context_from_payload, summarize_json_for_log,
    video_generation_asset_label,
};
use crate::commands::library::persist_media_workspace_catalog;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::append_runtime_event_for_session;
use crate::store::{
    media as media_store, settings as settings_store, work_items as work_items_store,
};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};

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

fn append_video_generation_event(
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
        Ok(())
    });
    if let Err(error) = result {
        eprintln!("[video-gen] runtime-event:write-error error={error}");
    } else {
        crate::analytics::observe_media_generation_event(
            state,
            "video",
            event_type,
            &event_payload,
        );
    }
}

pub(super) fn handle_video_generation_bypass(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Result<Value, String> {
    let count = payload_field(payload, "count")
        .and_then(|value| value.as_i64())
        .unwrap_or(1)
        .clamp(1, 4);
    let prompt = normalize_optional_string(payload_string(payload, "prompt"));
    let project_id = normalize_optional_string(payload_string(payload, "projectId"));
    let title = normalize_optional_string(payload_string(payload, "title"));
    let provider = normalize_optional_string(payload_string(payload, "provider"));
    let provider_template = normalize_optional_string(payload_string(payload, "providerTemplate"));
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
                append_video_generation_event(
                    state,
                    payload,
                    project_id.clone(),
                    "request.failed",
                    json!({
                        "mediaKind": "video",
                        "channel": channel,
                        "generationMode": payload_field(payload, "generationMode")
                            .and_then(Value::as_str)
                            .unwrap_or("text-to-video"),
                        "referenceCount": reference_image_count(payload),
                        "assetIndex": index,
                        "assetCount": count,
                        "error": "video generation requires a configured video provider"
                    }),
                );
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
            append_video_generation_event(
                state,
                payload,
                project_id.clone(),
                "request.started",
                json!({
                    "mediaKind": "video",
                    "channel": channel,
                    "model": effective_video_model,
                    "generationMode": generation_mode,
                    "durationSeconds": duration_seconds,
                    "referenceCount": reference_count,
                    "assetIndex": index,
                    "assetCount": count
                }),
            );
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
                    append_video_generation_event(
                        state,
                        payload,
                        project_id.clone(),
                        "request.failed",
                        json!({
                            "mediaKind": "video",
                            "channel": channel,
                            "model": effective_video_model,
                            "generationMode": generation_mode,
                            "durationSeconds": duration_seconds,
                            "referenceCount": reference_count,
                            "assetIndex": index,
                            "assetCount": count,
                            "error": truncate_event_text(&error, 600)
                        }),
                    );
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
                        &format!("{asset_label}：provider 已直接返回视频数据，正在写入媒体库。"),
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
                    let bytes = run_curl_bytes("GET", &url, None, &[], None).map_err(|error| {
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
                append_video_generation_event(
                    state,
                    payload,
                    project_id.clone(),
                    "response.empty",
                    json!({
                        "mediaKind": "video",
                        "channel": channel,
                        "model": effective_video_model,
                        "generationMode": generation_mode,
                        "durationSeconds": duration_seconds,
                        "referenceCount": reference_count,
                        "assetIndex": index,
                        "assetCount": count
                    }),
                );
                return Err(
                    "video generation response did not include a usable media result".to_string(),
                );
            }
            let thumbnail_url =
                crate::ensure_video_thumbnail_for_path(Some(app), state, &absolute_path);
            append_video_generation_event(
                state,
                payload,
                project_id.clone(),
                "request.completed",
                json!({
                    "mediaKind": "video",
                    "channel": channel,
                    "model": effective_video_model,
                    "generationMode": generation_mode,
                    "durationSeconds": duration_seconds,
                    "referenceCount": reference_count,
                    "assetIndex": index,
                    "assetCount": count,
                    "relativePath": relative_path
                }),
            );
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
}
