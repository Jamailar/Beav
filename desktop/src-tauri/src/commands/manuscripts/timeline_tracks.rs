use super::*;

pub(super) fn handle_timeline_track_channel(
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
        _ => None,
    }
}
