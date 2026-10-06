use super::image_plan::{build_generated_image_title, PlannedImageGenerationItem};
use crate::{
    extract_first_media_result, file_content_hash, file_url_for_path, make_id, now_ms, now_rfc3339,
    run_image_generation_request, write_generated_image_asset, write_placeholder_svg,
    MediaAssetRecord,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

pub(super) const IMAGE_BATCH_PARALLELISM: usize = 4;

fn execute_planned_image_generation_item(
    payload: Value,
    media_root_path: PathBuf,
    index: usize,
    total: usize,
    batch_stamp: u128,
    item: PlannedImageGenerationItem,
    endpoint: String,
    api_key: Option<String>,
    effective_model: String,
    effective_provider: String,
    effective_template: String,
    title: Option<String>,
    project_id: Option<String>,
    aspect_ratio: Option<String>,
    size: Option<String>,
    quality: Option<String>,
    mime_type: Option<String>,
    placeholder_fallback_allowed: bool,
) -> Result<(usize, MediaAssetRecord), String> {
    let mut request_payload = payload;
    let request_prompt = item.prompt;
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
                    request_title.as_deref().unwrap_or("Generated Image"),
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
                request_title.as_deref().unwrap_or("Generated Image"),
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

    Ok((
        index,
        MediaAssetRecord {
            id: make_id("media"),
            source: "generated".to_string(),
            source_domain: None,
            source_link: None,
            project_id,
            title: request_title,
            prompt: Some(request_prompt),
            provider: Some(effective_provider),
            provider_template: Some(effective_template),
            model: Some(effective_model),
            aspect_ratio,
            size,
            quality,
            mime_type,
            relative_path: Some(relative_path),
            bound_manuscript_path: None,
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
            absolute_path: Some(absolute_path.display().to_string()),
            preview_url: Some(file_url_for_path(&absolute_path)),
            thumbnail_url: None,
            exists: true,
            content_hash: file_content_hash(&absolute_path).ok(),
        },
    ))
}

pub(super) fn generate_planned_image_batch(
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
    mut on_asset_created: impl FnMut(&MediaAssetRecord, usize, usize) -> Result<(), String>,
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
        let indexed_items = planned_items
            .iter()
            .cloned()
            .enumerate()
            .collect::<Vec<_>>();
        for chunk in indexed_items.chunks(IMAGE_BATCH_PARALLELISM) {
            let (tx, rx) = mpsc::channel();
            let handles = chunk
                .iter()
                .map(|(index, item)| {
                    let tx = tx.clone();
                    let request_payload = payload.clone();
                    let media_root_path = media_root_path.to_path_buf();
                    let endpoint = endpoint.clone();
                    let api_key = api_key.clone();
                    let effective_model = effective_model.clone();
                    let effective_provider = effective_provider.clone();
                    let effective_template = effective_template.clone();
                    let title = title.clone();
                    let project_id = project_id.clone();
                    let aspect_ratio = aspect_ratio.clone();
                    let size = size.clone();
                    let quality = quality.clone();
                    let mime_type = mime_type.clone();
                    let item = item.clone();
                    let index = *index;
                    tauri::async_runtime::spawn_blocking(move || {
                        let result = execute_planned_image_generation_item(
                            request_payload,
                            media_root_path,
                            index,
                            total,
                            batch_stamp,
                            item,
                            endpoint,
                            api_key,
                            effective_model,
                            effective_provider,
                            effective_template,
                            title,
                            project_id,
                            aspect_ratio,
                            size,
                            quality,
                            mime_type,
                            placeholder_fallback_allowed,
                        );
                        let _ = tx.send(result);
                    })
                })
                .collect::<Vec<_>>();
            drop(tx);

            let mut first_error: Option<String> = None;
            for result in rx.iter().take(handles.len()) {
                match result {
                    Ok((index, asset)) => {
                        on_asset_created(&asset, index + 1, total)?;
                        created.push(asset);
                    }
                    Err(error) => {
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                }
            }

            for handle in handles {
                tauri::async_runtime::block_on(handle)
                    .map_err(|error| format!("planned image batch worker failed: {error}"))?;
            }

            if let Some(error) = first_error {
                return Err(error);
            }
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
                asset_title.as_deref().unwrap_or("Generated Image"),
                &item.prompt.chars().take(48).collect::<String>(),
                "#E76F51",
            )?;
            let asset = MediaAssetRecord {
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
                content_hash: file_content_hash(&absolute_path).ok(),
                relative_path: Some(relative_path),
                bound_manuscript_path: None,
                created_at: now_rfc3339(),
                updated_at: now_rfc3339(),
                absolute_path: Some(absolute_path.display().to_string()),
                preview_url: Some(file_url_for_path(&absolute_path)),
                thumbnail_url: None,
                exists: true,
            };
            on_asset_created(&asset, index + 1, total)?;
            Ok(asset)
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok((created, false))
}
