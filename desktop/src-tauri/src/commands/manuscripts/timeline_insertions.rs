use super::*;
use crate::store::media as media_store;

pub(super) fn handle_timeline_insertion_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:add-package-clip" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            if file_path.is_empty() || asset_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and assetId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let asset = with_store(state, |store| Ok(media_store::get_asset(&store, &asset_id)))?;
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
            let preferred_track_name = payload_string(&payload, "track")
                .unwrap_or_else(|| default_track_name_for_asset(&asset).to_string());
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
                .clamp(0, target_children.len() as i64) as usize;
            let clip = build_timeline_clip_from_asset(
                &asset,
                desired_order,
                payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
            );
            let inserted_clip_id = clip
                .get("metadata")
                .and_then(|value| value.get("clipId"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            target_children.insert(desired_order, clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            ensure_package_asset_entry(&full_path, &asset, None, None, None)?;
            Ok(json!({
                "success": true,
                "insertedClipId": inserted_clip_id,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:attach-package-file" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
            if file_path.is_empty() || source_path.is_empty() {
                return Ok(json!({
                    "success": false,
                    "error": "filePath and sourcePath are required"
                }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !is_manuscript_package_path(&full_path) {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let source = std::path::PathBuf::from(source_path.trim());
            if !source.exists() || !source.is_file() {
                return Ok(json!({ "success": false, "error": "Source file not found" }));
            }
            let package_asset_kind =
                normalize_video_project_asset_kind(payload_string(&payload, "kind").as_deref())?;
            let label = payload_string(&payload, "label");
            let role = payload_string(&payload, "role");
            let imports_root = media_root(state)?.join("imports");
            fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
            let content_hash = file_content_hash(&source)?;
            if let Some(asset) = crate::commands::library::existing_media_asset_by_content_hash(
                state,
                &content_hash,
            )? {
                ensure_package_asset_entry(
                    &full_path,
                    &asset,
                    package_asset_kind.as_deref(),
                    label.as_deref(),
                    role.as_deref(),
                )?;
                return Ok(json!({
                    "success": true,
                    "reused": true,
                    "asset": {
                        "id": asset.id,
                        "title": asset.title,
                        "mimeType": asset.mime_type,
                        "relativePath": asset.relative_path,
                        "absolutePath": asset.absolute_path,
                        "previewUrl": asset.preview_url,
                        "kind": package_asset_kind,
                        "label": label,
                        "role": role
                    },
                    "state": get_manuscript_package_state(&full_path)?
                }));
            }
            let (relative_name, target) = copy_file_into_dir(&source, &imports_root)?;
            let (mime_type, kind, _) = guess_mime_and_kind(&target);
            let thumbnail_url = if kind == "video" {
                ensure_video_thumbnail_for_path(Some(app), state, &target)
            } else {
                None
            };
            let asset = with_store_mut(state, |store| {
                let asset = MediaAssetRecord {
                    id: make_id("media"),
                    source: "imported".to_string(),
                    source_domain: None,
                    source_link: None,
                    project_id: None,
                    title: source
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
                    content_hash: file_content_hash(&target).ok(),
                    relative_path: Some(format!("imports/{}", relative_name)),
                    bound_manuscript_path: Some(file_path.clone()),
                    created_at: now_rfc3339(),
                    updated_at: now_rfc3339(),
                    absolute_path: Some(target.display().to_string()),
                    preview_url: Some(file_url_for_path(&target)),
                    thumbnail_url,
                    exists: true,
                };
                media_store::push_asset(store, asset.clone());
                Ok(asset)
            })?;
            persist_media_workspace_catalog(state)?;
            ensure_package_asset_entry(
                &full_path,
                &asset,
                package_asset_kind.as_deref(),
                label.as_deref(),
                role.as_deref(),
            )?;
            Ok(json!({
                "success": true,
                "asset": {
                    "id": asset.id,
                    "title": asset.title,
                    "mimeType": asset.mime_type,
                    "relativePath": asset.relative_path,
                    "absolutePath": asset.absolute_path,
                    "previewUrl": asset.preview_url,
                    "kind": package_asset_kind,
                    "label": label,
                    "role": role
                },
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:insert-package-subtitle-at-playhead" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                .map(|record| record.playhead_seconds)
                .unwrap_or(0.0)
                .max(0.0);
            let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let preferred_track_name = payload_string(&payload, "track")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    timeline
                        .pointer("/tracks/children")
                        .and_then(Value::as_array)
                        .and_then(|tracks| {
                            tracks
                                .iter()
                                .filter_map(|track| {
                                    track
                                        .get("name")
                                        .and_then(|value| value.as_str())
                                        .map(ToString::to_string)
                                })
                                .filter(|name| name.starts_with('S'))
                                .last()
                        })
                        .unwrap_or_else(|| "S1".to_string())
                });
            let target_track =
                ensure_timeline_track(&mut timeline, &preferred_track_name, "Subtitle");
            let target_children = target_track
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline track children missing".to_string())?;

            let mut desired_order = target_children.len();
            if let Some(order) = payload_field(&payload, "order").and_then(|value| value.as_i64()) {
                desired_order = order.clamp(0, target_children.len() as i64) as usize;
            } else {
                let mut cursor_ms = 0_i64;
                for (index, clip) in target_children.iter().enumerate() {
                    let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                    if playhead_ms <= cursor_ms {
                        desired_order = index;
                        break;
                    }
                    desired_order = index + 1;
                    cursor_ms = next_cursor_ms;
                    if playhead_ms < next_cursor_ms {
                        break;
                    }
                }
            }

            let clip = build_timeline_subtitle_clip(
                desired_order,
                &payload_string(&payload, "text").unwrap_or_default(),
                payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
            );
            let inserted_clip_id = clip
                .get("metadata")
                .and_then(|value| value.get("clipId"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            target_children.insert(desired_order.min(target_children.len()), clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({
                "success": true,
                "insertedClipId": inserted_clip_id,
                "playheadSeconds": playhead_seconds,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:insert-package-clip-at-playhead" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            if file_path.is_empty() || asset_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and assetId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let asset = with_store(state, |store| Ok(media_store::get_asset(&store, &asset_id)))?;
            let Some(asset) = asset else {
                return Ok(json!({ "success": false, "error": "Media asset not found" }));
            };

            let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                .map(|record| record.playhead_seconds)
                .unwrap_or(0.0)
                .max(0.0);
            let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let requested_track = payload_string(&payload, "track")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let default_track_name = default_track_name_for_asset(&asset).to_string();
            let track_prefix = if default_track_name.starts_with('A') {
                'A'
            } else {
                'V'
            };
            let preferred_track_name = requested_track.unwrap_or_else(|| {
                timeline
                    .pointer("/tracks/children")
                    .and_then(Value::as_array)
                    .and_then(|tracks| {
                        tracks
                            .iter()
                            .filter_map(|track| {
                                track
                                    .get("name")
                                    .and_then(|value| value.as_str())
                                    .map(ToString::to_string)
                            })
                            .filter(|name| name.starts_with(track_prefix))
                            .last()
                    })
                    .unwrap_or(default_track_name)
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

            let mut desired_order = target_children.len();
            let mut split_target: Option<(usize, f64)> = None;
            if let Some(order) = payload_field(&payload, "order").and_then(|value| value.as_i64()) {
                desired_order = order.clamp(0, target_children.len() as i64) as usize;
            } else {
                let mut cursor_ms = 0_i64;
                for (index, clip) in target_children.iter().enumerate() {
                    let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                    if playhead_ms > cursor_ms && playhead_ms < next_cursor_ms {
                        let duration_ms = (next_cursor_ms - cursor_ms).max(1000);
                        let split_ratio =
                            ((playhead_ms - cursor_ms) as f64 / duration_ms as f64).clamp(0.1, 0.9);
                        split_target = Some((index, split_ratio));
                        desired_order = index + 1;
                        break;
                    }
                    if playhead_ms <= cursor_ms {
                        desired_order = index;
                        break;
                    }
                    desired_order = index + 1;
                    cursor_ms = next_cursor_ms;
                }
            }

            if let Some((split_index, split_ratio)) = split_target {
                let original_clip = target_children.remove(split_index);
                let original_clip_id =
                    timeline_clip_identity(&original_clip, &preferred_track_name, split_index);
                let (first_clip, second_clip) =
                    split_timeline_clip_value(&original_clip, &original_clip_id, split_ratio);
                target_children.insert(split_index, first_clip);
                target_children.insert(split_index + 1, second_clip);
            }

            let clip = build_timeline_clip_from_asset(
                &asset,
                desired_order,
                payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
            );
            let inserted_clip_id = clip
                .get("metadata")
                .and_then(|value| value.get("clipId"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let safe_order = desired_order.min(target_children.len());
            target_children.insert(safe_order, clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            ensure_package_asset_entry(&full_path, &asset, None, None, None)?;
            Ok(json!({
                "success": true,
                "insertedClipId": inserted_clip_id,
                "playheadSeconds": playhead_seconds,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:insert-package-text-at-playhead" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let playhead_seconds = editor_runtime_state_record(state, &file_path)?
                .map(|record| record.playhead_seconds)
                .unwrap_or(0.0)
                .max(0.0);
            let playhead_ms = (playhead_seconds * 1000.0).round() as i64;

            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let preferred_track_name = payload_string(&payload, "track")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    timeline
                        .pointer("/tracks/children")
                        .and_then(Value::as_array)
                        .and_then(|tracks| {
                            tracks
                                .iter()
                                .filter_map(|track| {
                                    track
                                        .get("name")
                                        .and_then(|value| value.as_str())
                                        .map(ToString::to_string)
                                })
                                .filter(|name| name.starts_with('T'))
                                .last()
                        })
                        .unwrap_or_else(|| "T1".to_string())
                });
            let target_track =
                ensure_timeline_track(&mut timeline, &preferred_track_name, "Subtitle");
            let target_children = target_track
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline track children missing".to_string())?;

            let mut desired_order = target_children.len();
            let mut cursor_ms = 0_i64;
            for (index, clip) in target_children.iter().enumerate() {
                let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
                if playhead_ms <= cursor_ms {
                    desired_order = index;
                    break;
                }
                desired_order = index + 1;
                cursor_ms = next_cursor_ms;
                if playhead_ms < next_cursor_ms {
                    break;
                }
            }

            let mut clip = build_timeline_text_clip(
                desired_order,
                &payload_string(&payload, "text").unwrap_or_default(),
                payload_field(&payload, "durationMs").and_then(|value| value.as_i64()),
            );
            if let Some(text_style) = payload_field(&payload, "textStyle").cloned() {
                if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut) {
                    metadata.insert("textStyle".to_string(), text_style);
                }
            }
            let inserted_clip_id = clip
                .get("metadata")
                .and_then(|value| value.get("clipId"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            target_children.insert(desired_order.min(target_children.len()), clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({
                "success": true,
                "insertedClipId": inserted_clip_id,
                "playheadSeconds": playhead_seconds,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        _ => None,
    }
}
