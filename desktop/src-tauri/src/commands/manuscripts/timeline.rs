use super::*;
use crate::store::media as media_store;

pub(super) fn handle_timeline_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:update-package-track-ui" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let track_ui = payload_field(&payload, "trackUi")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            write_json_value(&package_track_ui_path(&full_path), &track_ui)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:update-package-scene-ui" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let scene_ui = payload_field(&payload, "sceneUi")
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "itemVisibility": {},
                        "itemOrder": [],
                        "itemLocks": {},
                        "itemGroups": {},
                        "focusedGroupId": Value::Null
                    })
                });
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            write_json_value(&package_scene_ui_path(&full_path), &scene_ui)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:add-package-track" => Some((|| -> Result<Value, String> {
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
            let (prefix, kind_label) = match kind.as_str() {
                "audio" => ("A", "Audio"),
                "subtitle" | "caption" | "text" => ("S", "Subtitle"),
                _ => ("V", "Video"),
            };
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
            let _ =
                ensure_timeline_track(&mut timeline, &format!("{prefix}{next_index}"), kind_label);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:delete-package-track" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let track_id = payload_string(&payload, "trackId").unwrap_or_default();
            if file_path.is_empty() || track_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and trackId are required" }),
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
            let Some(track_index) = tracks.iter().position(|track| {
                track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|value| value == track_id)
                    .unwrap_or(false)
            }) else {
                return Ok(json!({ "success": false, "error": "Track not found in timeline" }));
            };
            let track_kind = timeline_track_kind(&track_id);
            let same_kind_count = tracks
                .iter()
                .filter(|track| {
                    track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(timeline_track_kind)
                        .unwrap_or("Video")
                        == track_kind
                })
                .count();
            if same_kind_count <= 1 {
                return Ok(
                    json!({ "success": false, "error": "At least one track per media kind must remain" }),
                );
            }
            let has_children = tracks[track_index]
                .get("children")
                .and_then(Value::as_array)
                .map(|children| !children.is_empty())
                .unwrap_or(false);
            if has_children {
                return Ok(
                    json!({ "success": false, "error": "Only empty tracks can be deleted" }),
                );
            }
            tracks.remove(track_index);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:move-package-track" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let track_id = payload_string(&payload, "trackId").unwrap_or_default();
            let direction =
                payload_string(&payload, "direction").unwrap_or_else(|| "up".to_string());
            if file_path.is_empty() || track_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and trackId are required" }),
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
            let Some(track_index) = tracks.iter().position(|track| {
                track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|value| value == track_id)
                    .unwrap_or(false)
            }) else {
                return Ok(json!({ "success": false, "error": "Track not found in timeline" }));
            };
            let target_index = if direction == "down" {
                (track_index + 1).min(tracks.len().saturating_sub(1))
            } else {
                track_index.saturating_sub(1)
            };
            if target_index == track_index {
                return Ok(
                    json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }),
                );
            }
            let track = tracks.remove(track_index);
            tracks.insert(target_index, track);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:add-package-clip" => Some((|| -> Result<Value, String> {
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
        "manuscripts:update-package-clip" => Some((|| -> Result<Value, String> {
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
                let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
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
                .clamp(0, target_children.len() as i64) as usize;
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
                if let Some(asset_kind) = payload_field(&payload, "assetKind") {
                    metadata.insert("assetKind".to_string(), asset_kind.clone());
                }
                if let Some(subtitle_style) = payload_field(&payload, "subtitleStyle") {
                    metadata.insert("subtitleStyle".to_string(), subtitle_style.clone());
                }
                if let Some(text_style) = payload_field(&payload, "textStyle") {
                    metadata.insert("textStyle".to_string(), text_style.clone());
                }
                if let Some(transition_style) = payload_field(&payload, "transitionStyle") {
                    metadata.insert("transitionStyle".to_string(), transition_style.clone());
                }
            }
            if let Some(name) = payload_string(&payload, "name") {
                if let Some(object) = clip.as_object_mut() {
                    object.insert("name".to_string(), json!(name));
                }
            }
            target_children.insert(desired_order, clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:delete-package-clip" => Some((|| -> Result<Value, String> {
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
                if let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) {
                    let before = children.len();
                    children.retain(|clip| timeline_clip_identity(clip, &track_name, 0) != clip_id);
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
        })()),
        "manuscripts:split-package-clip" => Some((|| -> Result<Value, String> {
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
                let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
                    continue;
                };
                let mut next_children = Vec::new();
                for clip in children.iter() {
                    let mut clip_value = clip.clone();
                    next_children.push(clip_value.clone());
                    if timeline_clip_identity(clip, &track_name, 0) != clip_id {
                        continue;
                    }
                    let min_duration =
                        min_clip_duration_ms_for_asset_kind(&timeline_clip_asset_kind(clip));
                    let current_duration = timeline_clip_duration_ms(clip);
                    let first_duration = ((current_duration as f64) * split_ratio).round() as i64;
                    let first_duration = first_duration.max(min_duration);
                    let second_duration = (current_duration - first_duration).max(min_duration);
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
                    if let Some(obj) = new_clip.get_mut("metadata").and_then(Value::as_object_mut) {
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
        })()),
        _ => None,
    }
}
