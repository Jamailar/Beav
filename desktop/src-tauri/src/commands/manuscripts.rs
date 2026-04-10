use crate::persistence::{with_store, with_store_mut};
use crate::*;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};

pub fn handle_manuscripts_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !channel.starts_with("manuscripts:") {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "manuscripts:list" => {
                let root = manuscripts_root(state)?;
                Ok(serde_json::to_value(list_tree(&root, &root)?)
                    .map_err(|error| error.to_string())?)
            }
            "manuscripts:read" => {
                let relative = payload_value_as_string(&payload).unwrap_or_default();
                let path = resolve_manuscript_path(state, &relative)?;
                if path.is_dir()
                    && is_manuscript_package_name(
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    let file_name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    let manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                    let content =
                        fs::read_to_string(package_entry_path(&path, file_name, Some(&manifest)))
                            .unwrap_or_default();
                    return Ok(json!({
                        "content": content,
                        "metadata": manifest
                    }));
                }
                let content = fs::read_to_string(&path).unwrap_or_default();
                Ok(json!({
                    "content": content,
                    "metadata": {
                        "id": slug_from_relative_path(&relative),
                        "title": title_from_relative_path(&relative),
                        "draftType": get_draft_type_from_file_name(&relative),
                    }
                }))
            }
            "manuscripts:save" => {
                let target = payload_string(&payload, "path").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                let path = resolve_manuscript_path(state, &target)?;
                if path.is_dir()
                    && is_manuscript_package_name(
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    let file_name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    let mut manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                    if let Some(object) = manifest.as_object_mut() {
                        if let Some(metadata) =
                            payload_field(&payload, "metadata").and_then(Value::as_object)
                        {
                            for (key, value) in metadata {
                                object.insert(key.clone(), value.clone());
                            }
                        }
                        object.insert("updatedAt".to_string(), json!(now_i64()));
                        object
                            .entry("title".to_string())
                            .or_insert(json!(title_from_relative_path(file_name)));
                        object
                            .entry("entry".to_string())
                            .or_insert(json!(get_default_package_entry(file_name)));
                        object
                            .entry("draftType".to_string())
                            .or_insert(json!(get_draft_type_from_file_name(file_name)));
                        object
                            .entry("packageKind".to_string())
                            .or_insert(json!(get_package_kind_from_file_name(file_name)));
                    }
                    write_json_value(&package_manifest_path(&path), &manifest)?;
                    write_text_file(
                        &package_entry_path(&path, file_name, Some(&manifest)),
                        &content,
                    )?;
                    return Ok(json!({ "success": true }));
                }
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&path, content).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "manuscripts:create-folder" => {
                let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
                let name =
                    payload_string(&payload, "name").unwrap_or_else(|| "New Folder".to_string());
                let relative = join_relative(&parent_path, &name);
                let path = resolve_manuscript_path(state, &relative)?;
                fs::create_dir_all(&path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
            }
            "manuscripts:create-file" => {
                let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
                let name =
                    payload_string(&payload, "name").unwrap_or_else(|| "Untitled.md".to_string());
                let content = payload_string(&payload, "content").unwrap_or_default();
                let fallback_extension = if is_manuscript_package_name(&name) {
                    ""
                } else {
                    ".md"
                };
                let relative = normalize_relative_path(&join_relative(
                    &parent_path,
                    &ensure_manuscript_file_name(&name, fallback_extension),
                ));
                let path = resolve_manuscript_path(state, &relative)?;
                if is_manuscript_package_name(&relative) {
                    let title = payload_string(&payload, "title")
                        .unwrap_or_else(|| title_from_relative_path(&relative));
                    create_manuscript_package(&path, &content, &relative, &title)?;
                } else {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    }
                    fs::write(&path, content).map_err(|error| error.to_string())?;
                }
                Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
            }
            "manuscripts:upgrade-to-package" => {
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                let target_kind =
                    payload_string(&payload, "targetKind").unwrap_or_else(|| "article".to_string());
                let target_extension = if target_kind == "post" {
                    POST_DRAFT_EXTENSION
                } else {
                    ARTICLE_DRAFT_EXTENSION
                };
                let new_path =
                    upgrade_markdown_manuscript_to_package(state, &source_path, target_extension)?;
                Ok(json!({ "success": true, "newPath": new_path }))
            }
            "manuscripts:delete" => {
                let relative = payload_value_as_string(&payload).unwrap_or_default();
                let path = resolve_manuscript_path(state, &relative)?;
                if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
                } else if path.exists() {
                    fs::remove_file(&path).map_err(|error| error.to_string())?;
                }
                Ok(json!({ "success": true }))
            }
            "manuscripts:rename" => {
                let old_path = payload_string(&payload, "oldPath").unwrap_or_default();
                let new_name = payload_string(&payload, "newName").unwrap_or_default();
                if new_name.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少新名称" }));
                }
                let source = resolve_manuscript_path(state, &old_path)?;
                let parent_rel = normalize_relative_path(
                    old_path
                        .rsplit_once('/')
                        .map(|(parent, _)| parent)
                        .unwrap_or(""),
                );
                let mut target_relative = join_relative(&parent_rel, &new_name);
                if source.is_file() && !target_relative.contains('.') {
                    target_relative = ensure_markdown_extension(&target_relative);
                } else {
                    target_relative = normalize_relative_path(&target_relative);
                }
                let target = resolve_manuscript_path(state, &target_relative)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::rename(&source, &target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "newPath": target_relative }))
            }
            "manuscripts:move" => {
                let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
                let target_dir = payload_string(&payload, "targetDir").unwrap_or_default();
                let source = resolve_manuscript_path(state, &source_path)?;
                let file_name = source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| "Invalid manuscript source".to_string())?;
                let target_relative =
                    normalize_relative_path(&join_relative(&target_dir, file_name));
                let target = resolve_manuscript_path(state, &target_relative)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::rename(&source, &target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "newPath": target_relative }))
            }
            "manuscripts:get-package-state" => {
                let file_path = payload_value_as_string(&payload).unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-package-track" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let kind = payload_string(&payload, "kind").unwrap_or_else(|| "video".to_string());
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let prefix = if kind == "audio" { "A" } else { "V" };
                let kind_label = if kind == "audio" { "Audio" } else { "Video" };
                let existing_indexes = timeline
                    .pointer("/tracks/children")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|track| {
                        track
                            .get("name")
                            .and_then(|value| value.as_str())
                            .map(ToString::to_string)
                    })
                    .filter(|name| name.starts_with(prefix))
                    .filter_map(|name| name[1..].parse::<i64>().ok())
                    .collect::<Vec<_>>();
                let next_index = existing_indexes.into_iter().max().unwrap_or(0) + 1;
                let _ = ensure_timeline_track(
                    &mut timeline,
                    &format!("{prefix}{next_index}"),
                    kind_label,
                );
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:add-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
                if file_path.is_empty() || asset_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and assetId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let asset = with_store(state, |store| {
                    Ok(store
                        .media_assets
                        .iter()
                        .find(|item| item.id == asset_id)
                        .cloned())
                })?;
                let Some(asset) = asset else {
                    return Ok(json!({ "success": false, "error": "Media asset not found" }));
                };
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let preferred_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                    if asset
                        .mime_type
                        .clone()
                        .unwrap_or_default()
                        .starts_with("audio/")
                    {
                        "A1".to_string()
                    } else {
                        "V1".to_string()
                    }
                });
                let kind_label = if preferred_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                };
                let target_track =
                    ensure_timeline_track(&mut timeline, &preferred_track_name, kind_label);
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline track children missing".to_string())?;
                let desired_order = payload_field(&payload, "order")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(target_children.len() as i64)
                    .clamp(0, target_children.len() as i64)
                    as usize;
                let asset_kind = if asset
                    .mime_type
                    .clone()
                    .unwrap_or_default()
                    .starts_with("audio/")
                {
                    "audio"
                } else if asset
                    .mime_type
                    .clone()
                    .unwrap_or_default()
                    .starts_with("video/")
                {
                    "video"
                } else {
                    "image"
                };
                let clip = json!({
                    "OTIO_SCHEMA": "Clip.2",
                    "name": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
                    "source_range": Value::Null,
                    "media_references": {
                        "DEFAULT_MEDIA": {
                            "OTIO_SCHEMA": "ExternalReference.1",
                            "target_url": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                            "available_range": Value::Null,
                            "metadata": {
                                "assetId": asset.id,
                                "mimeType": asset.mime_type
                            }
                        }
                    },
                    "active_media_reference_key": "DEFAULT_MEDIA",
                    "metadata": {
                        "clipId": create_timeline_clip_id(),
                        "assetId": asset.id,
                        "assetKind": asset_kind,
                        "source": "media-library",
                        "order": desired_order,
                        "durationMs": payload_field(&payload, "durationMs").cloned().unwrap_or(json!(Value::Null)),
                        "trimInMs": 0,
                        "trimOutMs": 0,
                        "enabled": true,
                        "addedAt": now_iso()
                    }
                });
                target_children.insert(desired_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:attach-external-files" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                if file_path.is_empty() {
                    return Ok(json!({ "success": false, "error": "filePath is required" }));
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir()
                    || !is_manuscript_package_name(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(""),
                    )
                {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let picked = pick_files_native("选择要导入的素材文件", false, true)?;
                if picked.is_empty() {
                    return Ok(json!({ "success": true, "canceled": true, "imported": [] }));
                }
                let imports_root = media_root(state)?.join("imports");
                fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
                let mut imported = Vec::<Value>::new();
                for file in picked {
                    let (relative_name, target) = copy_file_into_dir(&file, &imports_root)?;
                    let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                    let asset = with_store_mut(state, |store| {
                        let asset = MediaAssetRecord {
                            id: make_id("media"),
                            source: "imported".to_string(),
                            project_id: None,
                            title: file
                                .file_name()
                                .and_then(|value| value.to_str())
                                .map(ToString::to_string),
                            prompt: None,
                            provider: None,
                            provider_template: None,
                            model: None,
                            aspect_ratio: None,
                            size: None,
                            quality: None,
                            mime_type: Some(mime_type.clone()),
                            relative_path: Some(format!("imports/{}", relative_name)),
                            bound_manuscript_path: Some(file_path.clone()),
                            created_at: now_iso(),
                            updated_at: now_iso(),
                            absolute_path: Some(target.display().to_string()),
                            preview_url: Some(file_url_for_path(&target)),
                            exists: true,
                        };
                        store.media_assets.push(asset.clone());
                        Ok(asset)
                    })?;
                    let track = if mime_type.starts_with("audio/") {
                        "A1"
                    } else {
                        "V1"
                    };
                    let _ = handle_manuscripts_channel(
                        app,
                        state,
                        "manuscripts:add-package-clip",
                        &json!({
                            "filePath": file_path,
                            "assetId": asset.id,
                            "track": track,
                        }),
                    );
                    imported.push(json!({
                        "absolutePath": target.display().to_string(),
                        "title": asset.title,
                        "mimeType": mime_type,
                        "assetId": asset.id,
                    }));
                }
                Ok(json!({
                    "success": true,
                    "canceled": false,
                    "imported": imported,
                    "state": get_manuscript_package_state(&full_path)?,
                }))
            }
            "manuscripts:update-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                if file_path.is_empty() || clip_id.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "filePath and clipId are required" }),
                    );
                }
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut clip_to_move: Option<Value> = None;
                let mut current_track_index = 0usize;
                for (track_index, track) in tracks.iter_mut().enumerate() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    if let Some(index) = children
                        .iter()
                        .position(|clip| timeline_clip_identity(clip, &track_name, 0) == clip_id)
                    {
                        clip_to_move = Some(children.remove(index));
                        current_track_index = track_index;
                        break;
                    }
                }
                let Some(mut clip) = clip_to_move else {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                };
                let target_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                    tracks[current_track_index]
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("V1")
                        .to_string()
                });
                let target_track = ensure_timeline_track(
                    &mut timeline,
                    &target_track_name,
                    if target_track_name.starts_with('A') {
                        "Audio"
                    } else {
                        "Video"
                    },
                );
                let target_children = target_track
                    .get_mut("children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline target children missing".to_string())?;
                let desired_order = payload_field(&payload, "order")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(target_children.len() as i64)
                    .clamp(0, target_children.len() as i64)
                    as usize;
                if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut) {
                    metadata.insert("clipId".to_string(), json!(clip_id));
                    if let Some(duration_ms) = payload_field(&payload, "durationMs") {
                        metadata.insert("durationMs".to_string(), duration_ms.clone());
                    }
                    if let Some(trim_in_ms) = payload_field(&payload, "trimInMs") {
                        metadata.insert("trimInMs".to_string(), trim_in_ms.clone());
                    }
                    if let Some(trim_out_ms) = payload_field(&payload, "trimOutMs") {
                        metadata.insert("trimOutMs".to_string(), trim_out_ms.clone());
                    }
                    if let Some(enabled) = payload_field(&payload, "enabled") {
                        metadata.insert("enabled".to_string(), enabled.clone());
                    }
                }
                target_children.insert(desired_order, clip);
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:delete-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut removed = false;
                for track in tracks.iter_mut() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    {
                        let before = children.len();
                        children
                            .retain(|clip| timeline_clip_identity(clip, &track_name, 0) != clip_id);
                        if before != children.len() {
                            removed = true;
                        }
                    }
                }
                if !removed {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                }
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:split-package-clip" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
                let split_ratio = payload_field(&payload, "splitRatio")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.5)
                    .clamp(0.1, 0.9);
                let full_path = resolve_manuscript_path(state, &file_path)?;
                let mut timeline = read_json_value_or(
                    &package_timeline_path(&full_path),
                    create_empty_otio_timeline(
                        full_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Untitled"),
                    ),
                );
                let tracks = timeline
                    .pointer_mut("/tracks/children")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Timeline tracks missing".to_string())?;
                let mut split_done = false;
                for track in tracks.iter_mut() {
                    let track_name = track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let Some(children) = track.get_mut("children").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    let mut next_children = Vec::new();
                    for clip in children.iter() {
                        let mut clip_value = clip.clone();
                        next_children.push(clip_value.clone());
                        if timeline_clip_identity(clip, &track_name, 0) != clip_id {
                            continue;
                        }
                        let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
                        let current_duration = metadata
                            .get("durationMs")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(4000)
                            .max(1000);
                        let first_duration =
                            ((current_duration as f64) * split_ratio).round() as i64;
                        let first_duration = first_duration.max(1000);
                        let second_duration = (current_duration - first_duration).max(1000);
                        if let Some(obj) = clip_value
                            .get_mut("metadata")
                            .and_then(Value::as_object_mut)
                        {
                            obj.insert("clipId".to_string(), json!(clip_id.clone()));
                            obj.insert("durationMs".to_string(), json!(first_duration));
                        }
                        if let Some(last) = next_children.last_mut() {
                            *last = clip_value.clone();
                        }
                        let mut new_clip = clip.clone();
                        if let Some(obj) =
                            new_clip.get_mut("metadata").and_then(Value::as_object_mut)
                        {
                            let trim_in = obj.get("trimInMs").and_then(|v| v.as_i64()).unwrap_or(0);
                            obj.insert("clipId".to_string(), json!(create_timeline_clip_id()));
                            obj.insert("durationMs".to_string(), json!(second_duration));
                            obj.insert("trimInMs".to_string(), json!(trim_in + first_duration));
                        }
                        next_children.push(new_clip);
                        split_done = true;
                    }
                    *children = next_children;
                    if split_done {
                        break;
                    }
                }
                if !split_done {
                    return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
                }
                normalize_package_timeline(&mut timeline);
                write_json_value(&package_timeline_path(&full_path), &timeline)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:save-remotion-scene" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let fallback = build_default_remotion_scene(&title, &clips);
                let raw_scene = payload_field(&payload, "scene")
                    .cloned()
                    .unwrap_or(Value::Null);
                let normalized = normalize_ai_remotion_scene(&raw_scene, &fallback, &clips, &title);
                write_json_value(&package_remotion_path(&full_path), &normalized)?;
                Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
            }
            "manuscripts:generate-remotion-scene" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let instructions = payload_string(&payload, "instructions").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                if clips.is_empty() {
                    return Ok(
                        json!({ "success": false, "error": "当前视频工程还没有时间线片段" }),
                    );
                }
                let fallback = build_default_remotion_scene(&title, &clips);
                let prompt = format!(
                "你是 RedClaw 的视频动画导演。请基于当前视频脚本和时间线，为 RedBox 生成 Remotion JSON 动画方案。\n\
只输出 JSON，不要输出解释。\n\
允许的 motionPreset 只有：static, slow-zoom-in, slow-zoom-out, pan-left, pan-right, slide-up, slide-down。\n\
字段结构：{{\"title\":string,\"width\":1080,\"height\":1920,\"fps\":30,\"backgroundColor\":\"#05070b\",\"scenes\":[{{\"id\":string,\"clipId\":string,\"assetId\":string,\"durationInFrames\":number,\"motionPreset\":string,\"overlayTitle\":string,\"overlayBody\":string,\"overlays\":[{{\"id\":string,\"text\":string,\"startFrame\":number,\"durationInFrames\":number,\"position\":\"top|center|bottom\",\"animation\":\"fade-up|fade-in|slide-left|pop\",\"fontSize\":number}}]}}]}}\n\
要求：\n\
1. 每个场景必须对应现有片段。\n\
2. 先做成适合短视频的动画：慢推、慢拉、平移、标题、底部字幕卡。\n\
3. 不要修改 src / assetKind / trimInFrames，这些字段由宿主兜底。\n\
4. overlayTitle 用镜头标题，overlayBody 用屏幕文案或强调点。\n\
5. 如果脚本有明确节奏，请让前几个场景更强，后面更稳。\n\
\n\
工程标题：{}\n\
脚本：{}\n\
时间线片段 JSON：{}",
                title,
                instructions,
                serde_json::to_string(&clips).map_err(|error| error.to_string())?
            );
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let raw = generate_response_with_settings(&settings_snapshot, None, &prompt);
                let candidate = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
                let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &clips, &title);
                write_json_value(&package_remotion_path(&full_path), &normalized)?;
                Ok(json!({
                    "success": true,
                    "state": get_manuscript_package_state(&full_path)?,
                    "raw": raw
                }))
            }
            "manuscripts:render-remotion-video" => {
                let file_path = payload_string(&payload, "filePath").unwrap_or_default();
                let full_path = resolve_manuscript_path(state, &file_path)?;
                if !full_path.is_dir() {
                    return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
                }
                let package_state = get_manuscript_package_state(&full_path)?;
                let title = package_state
                    .pointer("/manifest/title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("RedBox Motion")
                    .to_string();
                let clips = package_state
                    .pointer("/timelineSummary/clips")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut scene = read_json_value_or(
                    &package_remotion_path(&full_path),
                    build_default_remotion_scene(&title, &clips),
                );
                let export_dir = full_path.join("exports");
                fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
                let file_stem = full_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(slug_from_relative_path)
                    .unwrap_or_else(|| "redbox-video".to_string());
                let output_path = export_dir.join(format!("{file_stem}-remotion-{}.mp4", now_ms()));
                let render_result = render_remotion_video(&scene, &output_path)?;
                if let Some(object) = scene.as_object_mut() {
                    object.insert(
                    "render".to_string(),
                    json!({
                        "outputPath": output_path.display().to_string(),
                        "renderedAt": now_i64(),
                        "durationInFrames": render_result.get("durationInFrames").cloned().unwrap_or(Value::Null)
                    }),
                );
                }
                write_json_value(&package_remotion_path(&full_path), &scene)?;
                Ok(json!({
                    "success": true,
                    "outputPath": output_path.display().to_string(),
                    "state": get_manuscript_package_state(&full_path)?
                }))
            }
            "manuscripts:get-layout" => {
                let path = manuscript_layouts_path(state)?;
                if path.exists() {
                    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                    let layout: Value =
                        serde_json::from_str(&content).map_err(|error| error.to_string())?;
                    Ok(layout)
                } else {
                    Ok(json!({}))
                }
            }
            "manuscripts:save-layout" => {
                let path = manuscript_layouts_path(state)?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(
                    &path,
                    serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "manuscripts:format-wechat" => {
                let title = payload_string(&payload, "title").unwrap_or_default();
                let content = payload_string(&payload, "content").unwrap_or_default();
                Ok(json!({
                    "success": true,
                    "html": markdown_to_html(&title, &content),
                    "plainText": content,
                }))
            }
            _ => Err(format!(
                "RedBox host does not recognize channel `{channel}`."
            )),
        }
    })())
}
