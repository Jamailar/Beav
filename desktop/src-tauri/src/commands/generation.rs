use crate::commands::library::persist_media_workspace_catalog;
use crate::persistence::{with_store, with_store_mut};
use crate::store::{
    media as media_store, settings as settings_store, work_items as work_items_store,
};
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

mod image_batch;
mod image_plan;
mod image_single;
mod progress;
mod video_bypass;

use image_batch::generate_planned_image_batch;
use image_plan::extract_planned_image_generation_items;
use image_single::{generate_single_image_assets, SingleImageGenerationInput};
use progress::emit_image_generation_log;
use video_bypass::handle_video_generation_bypass;

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

    let assets = generate_single_image_assets(
        state,
        payload,
        SingleImageGenerationInput {
            media_root_path,
            count,
            real_image_config,
            provider,
            provider_template,
            model,
            title: title.clone(),
            project_id: project_id.clone(),
            aspect_ratio,
            size,
            quality,
            prompt: prompt.clone(),
            effective_image_prompt,
            placeholder_fallback_allowed,
        },
    )?;
    for (index, asset) in assets.iter().enumerate() {
        on_asset_created(asset, index + 1, count as usize)?;
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

        handle_video_generation_bypass(app, state, channel, payload)
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
