use super::*;

pub(super) fn collect_package_bound_assets(
    state: Option<&State<'_, AppState>>,
    package_path: &std::path::Path,
) -> Result<(Option<PackageBoundAsset>, Vec<PackageBoundAsset>), String> {
    let Some(state) = state else {
        return Ok((None, Vec::new()));
    };
    let cover_asset_id = read_json_value_or(&package_cover_path(package_path), json!({}))
        .get("assetId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let image_asset_ids =
        read_json_value_or(&package_images_path(package_path), json!({ "items": [] }))
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("assetId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(ToString::to_string)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
    with_store(state, |store| {
        let resolve_asset = |asset_id: &str| -> Option<PackageBoundAsset> {
            let asset = media_store::get_asset(&store, asset_id)?;
            let url = asset_prompt_url(&asset)?;
            Some(PackageBoundAsset {
                id: asset.id.clone(),
                title: asset
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(asset.id.as_str())
                    .to_string(),
                url,
                role: "image".to_string(),
            })
        };
        let cover = cover_asset_id
            .as_deref()
            .and_then(resolve_asset)
            .map(|mut asset| {
                asset.role = "cover".to_string();
                asset
            });
        let images = image_asset_ids
            .iter()
            .filter_map(|asset_id| resolve_asset(asset_id))
            .collect::<Vec<_>>();
        Ok((cover, images))
    })
}

fn asset_prompt_url(asset: &MediaAssetRecord) -> Option<String> {
    asset
        .preview_url
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            asset
                .absolute_path
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(|value| file_url_for_path(std::path::Path::new(value)))
        })
}

pub(super) fn resolve_project_media_source_path(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    source: &str,
) -> Result<(std::path::PathBuf, bool), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("当前片段缺少素材路径".to_string());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let bytes = run_curl_bytes("GET", trimmed, None, &[], None)?;
        let temp_root = store_root(state)?.join("tmp");
        fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
        let extension = std::path::Path::new(trimmed)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("media");
        let target = temp_root.join(format!("subtitle-source-{}.{}", now_ms(), extension));
        fs::write(&target, bytes).map_err(|error| error.to_string())?;
        return Ok((target, true));
    }

    let Some(raw_path) = resolve_local_path(trimmed) else {
        return Err("当前片段的素材路径不可解析".to_string());
    };
    let mut candidates = Vec::new();
    if raw_path.is_absolute() {
        candidates.push(raw_path);
    } else {
        candidates.push(raw_path.clone());
        candidates.push(package_path.join(&raw_path));
        if let Ok(media_root_path) = media_root(state) {
            candidates.push(media_root_path.join(&raw_path));
        }
        if let Ok(workspace_root_path) = workspace_root(state) {
            candidates.push(workspace_root_path.join(&raw_path));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|path| (path, false))
        .ok_or_else(|| format!("找不到素材文件: {trimmed}"))
}

pub(super) fn ensure_package_asset_entry(
    package_path: &std::path::Path,
    asset: &MediaAssetRecord,
    package_kind: Option<&str>,
    label: Option<&str>,
    role: Option<&str>,
) -> Result<(), String> {
    let mut assets = read_json_value_or(&package_assets_path(package_path), json!({ "items": [] }));
    let Some(items) = assets.get_mut("items").and_then(Value::as_array_mut) else {
        return Err("Package assets items missing".to_string());
    };
    let mut next_entry = json!({
        "assetId": asset.id,
        "title": asset.title.clone(),
        "mimeType": asset.mime_type.clone(),
        "relativePath": asset.relative_path.clone(),
        "absolutePath": asset.absolute_path.clone(),
        "mediaPath": asset.absolute_path.clone().or(asset.relative_path.clone()),
        "previewUrl": asset.preview_url.clone(),
        "boundManuscriptPath": asset.bound_manuscript_path.clone(),
        "exists": asset.exists,
        "updatedAt": asset.updated_at.clone(),
    });
    if let Some(value) = package_kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("kind".to_string(), json!(value));
    }
    if let Some(value) = label.map(str::trim).filter(|value| !value.is_empty()) {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("label".to_string(), json!(value));
    }
    if let Some(value) = role.map(str::trim).filter(|value| !value.is_empty()) {
        next_entry
            .as_object_mut()
            .ok_or_else(|| "Package asset entry must be an object".to_string())?
            .insert("role".to_string(), json!(value));
    }
    if let Some(existing) = items.iter_mut().find(|item| {
        item.get("assetId")
            .and_then(|value| value.as_str())
            .map(|value| value == asset.id)
            .unwrap_or(false)
    }) {
        *existing = next_entry;
    } else {
        items.push(next_entry);
    }
    write_json_value(&package_assets_path(package_path), &assets)?;
    let editor_project_path = package_editor_project_path(package_path);
    if editor_project_path.exists() {
        let mut editor_project = read_json_value_or(&editor_project_path, json!({}));
        if let Some(editor_assets) = editor_project
            .get_mut("assets")
            .and_then(Value::as_array_mut)
        {
            let editor_asset = json!({
                "id": asset.id,
                "kind": infer_editor_asset_kind(
                    asset.mime_type.as_deref(),
                    asset.absolute_path.as_deref().or(asset.relative_path.as_deref())
                ),
                "title": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
                "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                "mimeType": asset.mime_type.clone(),
                "durationMs": Value::Null,
                "metadata": {
                    "relativePath": asset.relative_path.clone(),
                    "absolutePath": asset.absolute_path.clone(),
                    "previewUrl": asset.preview_url.clone(),
                    "boundManuscriptPath": asset.bound_manuscript_path.clone(),
                    "exists": asset.exists
                }
            });
            if let Some(existing) = editor_assets.iter_mut().find(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == asset.id)
                    .unwrap_or(false)
            }) {
                *existing = editor_asset;
            } else {
                editor_assets.push(editor_asset);
            }
            write_json_value(&editor_project_path, &editor_project)?;
        }
    }
    if get_package_kind_from_manifest(package_path).as_deref() == Some("video") {
        let manifest = read_json_value_or(&package_manifest_path(package_path), json!({}));
        let title = manifest
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Motion");
        let mut remotion = read_json_value_or(
            &package_remotion_path(package_path),
            build_default_remotion_scene(title, &[]),
        );
        let asset_src = asset
            .absolute_path
            .clone()
            .or(asset.relative_path.clone())
            .unwrap_or_default();
        let asset_kind = infer_editor_asset_kind(asset.mime_type.as_deref(), Some(&asset_src));
        let can_seed_base_media = matches!(asset_kind, "video" | "image");
        let has_base_media = remotion
            .pointer("/baseMedia/outputPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        if can_seed_base_media && !has_base_media {
            if let Some(object) = remotion.as_object_mut() {
                let fallback_duration_in_frames =
                    object.get("durationInFrames").cloned().unwrap_or(json!(90));
                object.insert("version".to_string(), json!(2));
                object.insert("renderMode".to_string(), json!("full"));
                object.insert(
                    "baseMedia".to_string(),
                    json!({
                        "sourceAssetIds": [asset.id.clone()],
                        "outputPath": asset_src,
                        "durationMs": object
                            .get("baseMedia")
                            .and_then(|value| value.get("durationMs"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        "status": "ready",
                        "updatedAt": now_i64()
                    }),
                );
                let scenes = object
                    .entry("scenes".to_string())
                    .or_insert_with(|| json!([]));
                if !scenes.is_array() {
                    *scenes = json!([]);
                }
                let scenes_array = scenes
                    .as_array_mut()
                    .ok_or_else(|| "Remotion scenes must be an array".to_string())?;
                if scenes_array.is_empty() {
                    scenes_array.push(json!({
                        "id": "scene-1",
                        "clipId": Value::Null,
                        "assetId": asset.id,
                        "assetKind": asset_kind,
                        "src": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                        "startFrame": 0,
                        "durationInFrames": fallback_duration_in_frames,
                        "trimInFrames": 0,
                        "motionPreset": "static",
                        "overlayTitle": Value::Null,
                        "overlayBody": Value::Null,
                        "overlays": [],
                        "entities": []
                    }));
                } else if let Some(primary_scene) =
                    scenes_array.first_mut().and_then(Value::as_object_mut)
                {
                    let current_src = primary_scene
                        .get("src")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if current_src.is_empty() {
                        primary_scene.insert(
                            "src".to_string(),
                            json!(asset
                                .absolute_path
                                .clone()
                                .or(asset.relative_path.clone())
                                .unwrap_or_default()),
                        );
                        primary_scene.insert("assetKind".to_string(), json!(asset_kind));
                        primary_scene.insert("assetId".to_string(), json!(asset.id.clone()));
                    }
                }
            }
            persist_remotion_composition_artifacts(package_path, &remotion)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_media_asset() -> MediaAssetRecord {
        MediaAssetRecord {
            id: "asset-1".to_string(),
            source: "test".to_string(),
            source_domain: None,
            source_link: None,
            project_id: None,
            title: None,
            prompt: None,
            provider: None,
            provider_template: None,
            model: None,
            aspect_ratio: None,
            size: None,
            quality: None,
            mime_type: None,
            content_hash: None,
            relative_path: None,
            bound_manuscript_path: None,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            absolute_path: None,
            preview_url: Some("https://example.com/preview.png".to_string()),
            thumbnail_url: None,
            exists: true,
        }
    }

    #[test]
    fn asset_prompt_url_prefers_preview_url() {
        assert_eq!(
            asset_prompt_url(&test_media_asset()),
            Some("https://example.com/preview.png".to_string())
        );
    }
}
