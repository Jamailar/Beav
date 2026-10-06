use super::*;

fn merge_json_objects(base: &Value, patch: &Value) -> Value {
    match (base, patch) {
        (Value::Object(base_object), Value::Object(patch_object)) => {
            let mut merged = base_object.clone();
            for (key, value) in patch_object {
                let next = if let Some(existing) = merged.get(key) {
                    merge_json_objects(existing, value)
                } else {
                    value.clone()
                };
                merged.insert(key.clone(), next);
            }
            Value::Object(merged)
        }
        (_, value) => value.clone(),
    }
}

pub(super) fn merge_remotion_scene_patch(existing: &Value, patch: &Value) -> Value {
    if !patch.is_object() {
        return existing.clone();
    }
    let mut merged = merge_json_objects(existing, patch);
    let patch_scenes = patch
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if patch_scenes.is_empty() {
        return merged;
    }
    let existing_scenes = existing
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_scenes = existing_scenes.clone();
    for (index, patch_scene) in patch_scenes.iter().enumerate() {
        let target_index = patch_scene
            .get("id")
            .and_then(Value::as_str)
            .and_then(|scene_id| {
                existing_scenes.iter().position(|scene| {
                    scene
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == scene_id)
                        .unwrap_or(false)
                })
            })
            .or_else(|| (index < next_scenes.len()).then_some(index))
            .unwrap_or(next_scenes.len());
        let merged_scene = next_scenes
            .get(target_index)
            .map(|scene| merge_json_objects(scene, patch_scene))
            .unwrap_or_else(|| patch_scene.clone());
        if target_index < next_scenes.len() {
            next_scenes[target_index] = merged_scene;
        } else {
            next_scenes.push(merged_scene);
        }
    }
    if let Some(object) = merged.as_object_mut() {
        object.insert("scenes".to_string(), Value::Array(next_scenes));
    }
    merged
}

fn remotion_scene_summary_items(composition: &Value) -> Vec<Value> {
    composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|scene| {
            let entity_count = scene
                .get("entities")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let overlay_count = scene
                .get("overlays")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            json!({
                "id": scene.get("id").cloned().unwrap_or(Value::Null),
                "clipId": scene.get("clipId").cloned().unwrap_or(Value::Null),
                "assetId": scene.get("assetId").cloned().unwrap_or(Value::Null),
                "startFrame": scene.get("startFrame").cloned().unwrap_or_else(|| json!(0)),
                "durationInFrames": scene.get("durationInFrames").cloned().unwrap_or_else(|| json!(0)),
                "entityCount": entity_count,
                "overlayCount": overlay_count,
                "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn remotion_asset_metadata(project: &Value) -> Vec<Value> {
    project
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|asset| {
            json!({
                "id": asset.get("id").cloned().unwrap_or(Value::Null),
                "title": asset.get("title").cloned().unwrap_or(Value::Null),
                "kind": asset.get("kind").cloned().unwrap_or(Value::Null),
                "src": asset.get("src").cloned().unwrap_or(Value::Null),
                "mimeType": asset.get("mimeType").cloned().unwrap_or(Value::Null),
                "durationMs": asset.get("durationMs").cloned().unwrap_or(Value::Null),
                "metadata": asset.get("metadata").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

pub(super) fn remotion_context_value(
    state: &State<'_, AppState>,
    package_path: &std::path::Path,
    file_path: &str,
) -> Result<Value, String> {
    let package_state = get_manuscript_package_state(package_path)?;
    let composition = package_state
        .get("remotion")
        .cloned()
        .unwrap_or_else(|| build_default_remotion_scene("Motion", &[]));
    let asset_container = package_state
        .pointer("/videoProject/assets")
        .cloned()
        .map(|items| json!({ "assets": items }))
        .or_else(|| {
            package_state
                .get("editorProject")
                .and_then(|project| project.get("assets"))
                .cloned()
                .map(|items| json!({ "assets": items }))
        })
        .unwrap_or_else(|| json!({ "assets": [] }));
    let runtime_state = editor_runtime_state_record(state, file_path)?;
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let playhead_seconds = runtime_state
        .as_ref()
        .map(|record| record.playhead_seconds)
        .unwrap_or(0.0)
        .max(0.0);
    let playhead_frame = (playhead_seconds * fps as f64).round() as i64;
    let scenes = composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let transitions = composition
        .get("transitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let active_scene = runtime_state
        .as_ref()
        .and_then(|record| record.selected_scene_id.as_deref())
        .and_then(|scene_id| {
            scenes.iter().find(|scene| {
                scene
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == scene_id)
                    .unwrap_or(false)
            })
        })
        .cloned()
        .or_else(|| {
            scenes
                .iter()
                .find(|scene| {
                    let start_frame = scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
                    let duration_in_frames = scene
                        .get("durationInFrames")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .max(1);
                    playhead_frame >= start_frame
                        && playhead_frame < start_frame + duration_in_frames
                })
                .cloned()
        })
        .or_else(|| scenes.first().cloned())
        .unwrap_or(Value::Null);
    let scene_ids_at_playhead = scenes
        .iter()
        .filter(|scene| {
            let start_frame = scene.get("startFrame").and_then(Value::as_i64).unwrap_or(0);
            let duration_in_frames = scene
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(1);
            playhead_frame >= start_frame && playhead_frame < start_frame + duration_in_frames
        })
        .filter_map(|scene| {
            scene
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "composition": {
            "title": composition.get("title").cloned().unwrap_or(Value::Null),
            "entryCompositionId": composition.get("entryCompositionId").cloned().unwrap_or_else(|| json!("RedBoxVideoMotion")),
            "width": composition.get("width").cloned().unwrap_or_else(|| json!(1080)),
            "height": composition.get("height").cloned().unwrap_or_else(|| json!(1920)),
            "fps": composition.get("fps").cloned().unwrap_or_else(|| json!(30)),
            "durationInFrames": composition.get("durationInFrames").cloned().unwrap_or_else(|| json!(90)),
            "renderMode": composition.get("renderMode").cloned().unwrap_or_else(|| json!("motion-layer")),
            "backgroundColor": composition.get("backgroundColor").cloned().unwrap_or(Value::Null),
            "sceneCount": scenes.len(),
            "transitionCount": transitions.len(),
            "render": normalized_remotion_render_config(
                composition.get("render"),
                composition.get("title").and_then(Value::as_str).unwrap_or("Motion"),
                composition.get("renderMode").and_then(Value::as_str).unwrap_or("motion-layer"),
            )
        },
        "scenes": remotion_scene_summary_items(&composition),
        "transitions": transitions,
        "activeScene": active_scene,
        "assetMetadata": remotion_asset_metadata(&asset_container),
        "selectionMapping": {
            "selectedClipId": runtime_state.as_ref().and_then(|record| record.selected_clip_id.clone()),
            "selectedSceneId": runtime_state.as_ref().and_then(|record| record.selected_scene_id.clone()).or_else(|| active_scene.get("id").and_then(Value::as_str).map(ToString::to_string)),
            "playheadSeconds": playhead_seconds,
            "playheadFrame": playhead_frame,
            "sceneIdsAtPlayhead": scene_ids_at_playhead,
            "activeSceneId": active_scene.get("id").cloned().unwrap_or(Value::Null),
            "activeSceneClipId": active_scene.get("clipId").cloned().unwrap_or(Value::Null),
        }
    }))
}

#[allow(dead_code)]
pub(super) fn sync_project_transitions_from_remotion_scene(
    project: &mut Value,
    composition: &Value,
) -> Result<(), String> {
    let project_object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    project_object.insert(
        "transitions".to_string(),
        composition
            .get("transitions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_remotion_scene_patch_preserves_unmodified_scene_data() {
        let existing = json!({
            "title": "Demo",
            "scenes": [{
                "id": "scene-1",
                "overlayTitle": "旧标题",
                "entities": [{ "id": "apple-1", "shape": "apple" }]
            }]
        });
        let patch = json!({
            "scenes": [{ "id": "scene-1", "overlayTitle": "新标题" }]
        });

        let merged = merge_remotion_scene_patch(&existing, &patch);

        assert_eq!(
            merged
                .pointer("/scenes/0/overlayTitle")
                .and_then(Value::as_str),
            Some("新标题")
        );
        assert_eq!(
            merged
                .pointer("/scenes/0/entities/0/shape")
                .and_then(Value::as_str),
            Some("apple")
        );
    }

    #[test]
    fn remotion_scene_summary_counts_entities_and_overlays() {
        let composition = json!({
            "scenes": [{
                "id": "scene-1",
                "entities": [{ "id": "a" }, { "id": "b" }],
                "overlays": [{ "id": "title" }]
            }]
        });

        let summary = remotion_scene_summary_items(&composition);

        assert_eq!(summary.len(), 1);
        assert_eq!(
            summary[0].get("entityCount").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            summary[0].get("overlayCount").and_then(Value::as_u64),
            Some(1)
        );
    }
}
