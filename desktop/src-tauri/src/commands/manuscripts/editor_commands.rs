use super::*;

#[path = "editor_commands/actions.rs"]
mod actions;

use actions::{
    collect_string_array, default_track_ui, delete_item_ids, merge_object_patch, next_track_id,
    renumber_tracks,
};

pub(super) fn apply_editor_commands(project: &mut Value, commands: &[Value]) -> Result<(), String> {
    ensure_motion_track(project)?;
    for command in commands {
        let command_type = command
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match command_type {
            "upsert_assets" => {
                let assets = command
                    .get("assets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let current_assets = project
                    .get_mut("assets")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| "Editor project assets missing".to_string())?;
                for asset in assets {
                    let asset_id = asset
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if asset_id.is_empty() {
                        continue;
                    }
                    if let Some(existing) = current_assets.iter_mut().find(|item| {
                        item.get("id").and_then(|value| value.as_str()) == Some(asset_id)
                    }) {
                        *existing = asset.clone();
                    } else {
                        current_assets.push(asset.clone());
                    }
                }
            }
            "add_track" => {
                let kind = command
                    .get("kind")
                    .and_then(|value| value.as_str())
                    .unwrap_or("video");
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| next_track_id(project, kind));
                let order = editor_project_tracks_mut(project)?.len();
                editor_project_tracks_mut(project)?.push(json!({
                    "id": track_id,
                    "kind": kind,
                    "name": track_id,
                    "order": order,
                    "ui": default_track_ui()
                }));
            }
            "delete_tracks" => {
                let track_ids = collect_string_array(command, "trackIds");
                editor_project_tracks_mut(project)?.retain(|track| {
                    let track_id = track
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                editor_project_items_mut(project)?.retain(|item| {
                    let track_id = item
                        .get("trackId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !track_ids.iter().any(|value| value == track_id)
                });
                renumber_tracks(editor_project_tracks_mut(project)?);
            }
            "add_item" => {
                if let Some(item) = command.get("item") {
                    editor_project_items_mut(project)?.push(item.clone());
                }
            }
            "update_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    merge_object_patch(item, &patch);
                }
            }
            "delete_item" => {
                let normalized = delete_item_ids(command);
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !normalized.iter().any(|value| value == item_id)
                });
            }
            "delete_items" => {
                let item_ids = collect_string_array(command, "itemIds");
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !item_ids.iter().any(|value| value == item_id)
                });
            }
            "split_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let split_ms = command
                    .get("splitMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let items = editor_project_items_mut(project)?;
                let Some(index) = items.iter().position(|item| {
                    item.get("id").and_then(|value| value.as_str()) == Some(item_id)
                }) else {
                    continue;
                };
                let mut original = items[index].clone();
                let from_ms = original
                    .get("fromMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let duration_ms = original
                    .get("durationMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                if split_ms <= from_ms || split_ms >= from_ms + duration_ms {
                    continue;
                }
                let first_duration = split_ms - from_ms;
                let second_duration = duration_ms - first_duration;
                if let Some(object) = original.as_object_mut() {
                    object.insert("durationMs".to_string(), json!(first_duration));
                }
                items[index] = original;
                let mut second = items[index].clone();
                if let Some(object) = second.as_object_mut() {
                    object.insert("id".to_string(), json!(make_id("item")));
                    object.insert("fromMs".to_string(), json!(split_ms));
                    object.insert("durationMs".to_string(), json!(second_duration));
                    if let Some(trim_in_ms) =
                        object.get("trimInMs").and_then(|value| value.as_i64())
                    {
                        object.insert("trimInMs".to_string(), json!(trim_in_ms + first_duration));
                    }
                }
                items.insert(index + 1, second);
            }
            "move_items" => {
                let delta_ms = command
                    .get("deltaMs")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let target_track_id = command
                    .get("targetTrackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string);
                let item_ids = collect_string_array(command, "itemIds");
                for item in editor_project_items_mut(project)?.iter_mut() {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if !item_ids.iter().any(|value| value == item_id) {
                        continue;
                    }
                    if let Some(object) = item.as_object_mut() {
                        let from_ms = object
                            .get("fromMs")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0);
                        object.insert("fromMs".to_string(), json!((from_ms + delta_ms).max(0)));
                        if let Some(track_id) = target_track_id.as_ref() {
                            object.insert("trackId".to_string(), json!(track_id));
                        }
                    }
                }
            }
            "retime_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if let Some(item) = editor_project_items_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(|value| value.as_str()) == Some(item_id))
                {
                    if let Some(object) = item.as_object_mut() {
                        if let Some(from_ms) = command.get("fromMs") {
                            object.insert("fromMs".to_string(), from_ms.clone());
                        }
                        if let Some(duration_ms) = command.get("durationMs") {
                            object.insert("durationMs".to_string(), duration_ms.clone());
                        }
                    }
                }
            }
            "set_track_ui" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(track) = editor_project_tracks_mut(project)?
                    .iter_mut()
                    .find(|track| {
                        track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                    })
                {
                    let current_ui = track.get("ui").cloned().unwrap_or_else(|| json!({}));
                    let mut next_ui = current_ui;
                    merge_object_patch(&mut next_ui, &patch);
                    if let Some(object) = track.as_object_mut() {
                        object.insert("ui".to_string(), next_ui);
                    }
                }
            }
            "reorder_tracks" => {
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let direction = command
                    .get("direction")
                    .and_then(|value| value.as_str())
                    .unwrap_or("up");
                let tracks = editor_project_tracks_mut(project)?;
                let Some(index) = tracks.iter().position(|track| {
                    track.get("id").and_then(|value| value.as_str()) == Some(track_id)
                }) else {
                    continue;
                };
                let target_index = if direction == "down" {
                    (index + 1).min(tracks.len().saturating_sub(1))
                } else {
                    index.saturating_sub(1)
                };
                let track = tracks.remove(index);
                tracks.insert(target_index, track);
                renumber_tracks(tracks);
            }
            "update_stage_item" => {
                let item_id = command
                    .get("itemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let stage = project
                    .get_mut("stage")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| "Editor project stage missing".to_string())?;
                if let Some(transform_patch) = command.get("patch").and_then(Value::as_object) {
                    let transforms = stage
                        .entry("itemTransforms".to_string())
                        .or_insert_with(|| json!({}));
                    let entry = transforms
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemTransforms missing".to_string())?
                        .entry(item_id.to_string())
                        .or_insert_with(|| json!({}));
                    merge_object_patch(entry, &Value::Object(transform_patch.clone()));
                }
                if let Some(visible) = command.get("visible") {
                    stage
                        .entry("itemVisibility".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemVisibility missing".to_string())?
                        .insert(item_id.to_string(), visible.clone());
                }
                if let Some(locked) = command.get("locked") {
                    stage
                        .entry("itemLocks".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemLocks missing".to_string())?
                        .insert(item_id.to_string(), locked.clone());
                }
                if let Some(group_id) = command.get("groupId") {
                    stage
                        .entry("itemGroups".to_string())
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                        .ok_or_else(|| "Stage itemGroups missing".to_string())?
                        .insert(item_id.to_string(), group_id.clone());
                }
            }
            "animation_layer_create" => {
                let layer = command.get("layer").cloned().unwrap_or_else(|| json!({}));
                editor_project_animation_layers_mut(project)?.push(layer);
            }
            "animation_layer_update" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                let patch = command.get("patch").cloned().unwrap_or_else(|| json!({}));
                if let Some(layer) = editor_project_animation_layers_mut(project)?
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(layer_id))
                {
                    merge_object_patch(layer, &patch);
                }
            }
            "animation_layer_delete" => {
                let layer_id = command.get("layerId").and_then(Value::as_str).unwrap_or("");
                editor_project_animation_layers_mut(project)?
                    .retain(|item| item.get("id").and_then(Value::as_str) != Some(layer_id));
            }
            _ => {}
        }
    }
    normalize_editor_project_timeline(project)?;
    Ok(())
}
