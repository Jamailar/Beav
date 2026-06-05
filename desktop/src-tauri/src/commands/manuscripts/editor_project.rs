use super::*;

use super::ffmpeg_edit::{
    execute_ffmpeg_edit_recipe, ffmpeg_asset_items, ffmpeg_recipe_duration_ms,
    ffmpeg_recipe_source_asset_ids,
};

pub(super) fn handle_editor_project_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:ffmpeg-edit" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            if get_package_kind_from_manifest(&full_path).as_deref() != Some("video") {
                return Ok(json!({ "success": false, "error": "当前类型不支持 ffmpeg_edit" }));
            }
            let operations = payload
                .get("operations")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if operations.is_empty() {
                return Ok(json!({ "success": false, "error": "operations 不能为空" }));
            }
            let intent_summary = payload_string(&payload, "intentSummary")
                .unwrap_or_else(|| "AI video edit".to_string());
            let package_state = get_manuscript_package_state(&full_path)?;
            let assets = ffmpeg_asset_items(&package_state);
            let remotion = package_state.get("remotion").cloned().unwrap_or_else(|| {
                build_default_remotion_scene(
                    package_state
                        .pointer("/manifest/title")
                        .and_then(Value::as_str)
                        .unwrap_or("Motion"),
                    &[],
                )
            });
            let session_id = format!("manuscript-video:{}", file_path.trim());
            let (output_path, artifacts) = execute_ffmpeg_edit_recipe(
                app,
                state,
                &session_id,
                &full_path,
                &assets,
                &operations,
            )?;
            let fallback_duration_ms = remotion
                .pointer("/baseMedia/durationMs")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let duration_ms = ffmpeg_recipe_duration_ms(&operations, fallback_duration_ms);
            let source_asset_ids = ffmpeg_recipe_source_asset_ids(&operations);
            let mut next_remotion = remotion.clone();
            if let Some(object) = next_remotion.as_object_mut() {
                object.insert("version".to_string(), json!(2));
                object.insert("renderMode".to_string(), json!("full"));
                object.insert(
                    "baseMedia".to_string(),
                    json!({
                        "sourceAssetIds": source_asset_ids,
                        "outputPath": output_path.display().to_string(),
                        "durationMs": duration_ms,
                        "status": "ready",
                        "updatedAt": now_i64()
                    }),
                );
                object.insert(
                    "ffmpegRecipe".to_string(),
                    json!({
                        "operations": operations,
                        "artifacts": artifacts,
                        "summary": intent_summary,
                        "updatedAt": now_i64()
                    }),
                );
                if !object.contains_key("scenes") {
                    object.insert("scenes".to_string(), json!([]));
                }
                if !object.contains_key("transitions") {
                    object.insert("transitions".to_string(), json!([]));
                }
                let fps = object
                    .get("fps")
                    .and_then(Value::as_i64)
                    .filter(|value| *value > 0)
                    .unwrap_or(30);
                if duration_ms > 0 {
                    object.insert(
                        "durationInFrames".to_string(),
                        json!(((duration_ms as f64 / 1000.0) * fps as f64).round() as i64),
                    );
                }
                if let Some(scene) = object
                    .get_mut("scenes")
                    .and_then(Value::as_array_mut)
                    .and_then(|items| items.first_mut())
                    .and_then(Value::as_object_mut)
                {
                    scene.insert("src".to_string(), json!(output_path.display().to_string()));
                    scene.insert("assetKind".to_string(), json!("video"));
                    if duration_ms > 0 {
                        scene.insert(
                            "durationInFrames".to_string(),
                            json!(((duration_ms as f64 / 1000.0) * fps as f64).round() as i64),
                        );
                    }
                }
            }
            persist_remotion_composition_artifacts(&full_path, &next_remotion)?;
            Ok(json!({
                "success": true,
                "outputPath": output_path.display().to_string(),
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:get-editor-project" => Some((|| -> Result<Value, String> {
            let file_path = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "filePath"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            Ok(json!({
                "success": true,
                "project": ensure_editor_project(&full_path)?,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:save-editor-project" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let mut project = payload_field(&payload, "project")
                .cloned()
                .unwrap_or(Value::Null);
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let existing_project = ensure_editor_project(&full_path)?;
            let next_script_body = project
                .pointer("/script/body")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let existing_script_body = existing_project
                .pointer("/script/body")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            if let Some(script_body) = next_script_body.as_deref() {
                if existing_script_body.as_deref() != Some(script_body) {
                    mark_editor_project_script_pending(&mut project, script_body, "user")?;
                } else {
                    let _ = ensure_editor_project_ai_state(&mut project)?;
                }
            }
            let _ = hydrate_editor_project_motion_from_remotion(&mut project, &full_path)?;
            if existing_project != project {
                push_editor_project_undo_snapshot(state, &file_path, &existing_project)?;
            }
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            if let Some(script_body) = next_script_body.as_deref() {
                let manifest =
                    read_json_value_or(package_manifest_path(&full_path).as_path(), json!({}));
                let entry_path = package_entry_path(&full_path, &file_path, Some(&manifest));
                write_text_file(&entry_path, script_body)?;
            }
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:duplicate-editor-project-clip" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            if file_path.is_empty() || clip_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and clipId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let mut project = ensure_editor_project(&full_path)?;
            push_editor_project_undo_snapshot(state, &file_path, &project)?;
            let items = project
                .pointer_mut("/items")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Editor project items missing".to_string())?;
            let Some(source_item) = items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(clip_id.as_str()))
                .cloned()
            else {
                return Ok(
                    json!({ "success": false, "error": "Clip not found in editor project" }),
                );
            };
            let mut duplicate = source_item;
            let from_ms = payload_field(&payload, "fromMs")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| {
                    duplicate.get("fromMs").and_then(Value::as_i64).unwrap_or(0)
                        + duplicate
                            .get("durationMs")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                });
            if let Some(object) = duplicate.as_object_mut() {
                object.insert("id".to_string(), json!(create_timeline_clip_id()));
                object.insert("fromMs".to_string(), json!(from_ms.max(0)));
                if let Some(track_id) = payload_string(&payload, "trackId") {
                    object.insert("trackId".to_string(), json!(track_id));
                }
            }
            items.push(duplicate);
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:replace-editor-project-clip-asset" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            if file_path.is_empty() || clip_id.is_empty() || asset_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath, clipId, and assetId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let mut project = ensure_editor_project(&full_path)?;
            push_editor_project_undo_snapshot(state, &file_path, &project)?;
            let items = project
                .pointer_mut("/items")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Editor project items missing".to_string())?;
            let Some(target_item) = items
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(clip_id.as_str()))
            else {
                return Ok(
                    json!({ "success": false, "error": "Clip not found in editor project" }),
                );
            };
            if let Some(object) = target_item.as_object_mut() {
                object.insert("assetId".to_string(), json!(asset_id));
            }
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:add-editor-project-marker" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let mut project = ensure_editor_project(&full_path)?;
            push_editor_project_undo_snapshot(state, &file_path, &project)?;
            let markers = project
                .as_object_mut()
                .ok_or_else(|| "Editor project malformed".to_string())?
                .entry("markers".to_string())
                .or_insert_with(|| json!([]));
            let markers = markers
                .as_array_mut()
                .ok_or_else(|| "Editor project markers malformed".to_string())?;
            markers.push(json!({
                    "id": make_id("marker"),
                    "frame": payload_field(&payload, "frame").and_then(Value::as_i64).unwrap_or(0).max(0),
                    "color": payload_string(&payload, "color").unwrap_or_else(|| "#3B82F6".to_string()),
                    "label": payload_string(&payload, "label").unwrap_or_default(),
                }));
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:update-editor-project-marker" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
            if file_path.is_empty() || marker_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and markerId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let mut project = ensure_editor_project(&full_path)?;
            push_editor_project_undo_snapshot(state, &file_path, &project)?;
            let markers = project
                .as_object_mut()
                .and_then(|object| object.get_mut("markers"))
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Editor project markers missing".to_string())?;
            let Some(marker) = markers
                .iter_mut()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(marker_id.as_str()))
            else {
                return Ok(
                    json!({ "success": false, "error": "Marker not found in editor project" }),
                );
            };
            if let Some(object) = marker.as_object_mut() {
                if let Some(frame) = payload_field(&payload, "frame").and_then(Value::as_i64) {
                    object.insert("frame".to_string(), json!(frame.max(0)));
                }
                if let Some(color) = payload_string(&payload, "color") {
                    object.insert("color".to_string(), json!(color));
                }
                if let Some(label) = payload_string(&payload, "label") {
                    object.insert("label".to_string(), json!(label));
                }
            }
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:delete-editor-project-marker" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
            if file_path.is_empty() || marker_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and markerId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let mut project = ensure_editor_project(&full_path)?;
            push_editor_project_undo_snapshot(state, &file_path, &project)?;
            let markers = project
                .as_object_mut()
                .and_then(|object| object.get_mut("markers"))
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Editor project markers missing".to_string())?;
            let before = markers.len();
            markers.retain(|marker| {
                marker.get("id").and_then(Value::as_str) != Some(marker_id.as_str())
            });
            if before == markers.len() {
                return Ok(
                    json!({ "success": false, "error": "Marker not found in editor project" }),
                );
            }
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:undo-editor-project" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            restore_editor_project_from_history(state, &file_path, &full_path, "undo")
        })()),
        "manuscripts:redo-editor-project" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            restore_editor_project_from_history(state, &file_path, &full_path, "redo")
        })()),
        "manuscripts:import-legacy-editor-project" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let file_name = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled");
            let project = build_editor_project_from_legacy(&full_path, file_name)?;
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:apply-editor-commands" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let commands = payload_field(&payload, "commands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let mut project = ensure_editor_project(&full_path)?;
            apply_editor_commands(&mut project, &commands)?;
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:generate-motion-items" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let instructions = payload_string(&payload, "instructions").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let selected_item_ids = payload_field(&payload, "selectedItemIds")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToString::to_string))
                .collect::<Vec<_>>();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let mut project = ensure_editor_project(&full_path)?;
            let (motion_items, brief) = generate_motion_items_for_project(
                state,
                &project,
                &instructions,
                &selected_item_ids,
                payload_field(&payload, "modelConfig"),
            )?;
            ensure_motion_track(&mut project)?;
            let target_bind_ids = motion_items
                .iter()
                .filter_map(|item| {
                    item.get("bindItemId")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .collect::<Vec<_>>();
            editor_project_items_mut(&mut project)?.retain(|item| {
                if item.get("type").and_then(|value| value.as_str()) != Some("motion") {
                    return true;
                }
                let bind_item_id = item
                    .get("bindItemId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                !target_bind_ids.iter().any(|value| value == bind_item_id)
            });
            editor_project_items_mut(&mut project)?.extend(motion_items.clone());
            if let Some(ai) = project.get_mut("ai").and_then(Value::as_object_mut) {
                ai.insert("lastMotionBrief".to_string(), json!(brief.clone()));
                ai.insert("motionPrompt".to_string(), json!(instructions));
            }
            write_json_value(&package_editor_project_path(&full_path), &project)?;
            Ok(json!({
                "success": true,
                "brief": brief,
                "items": motion_items,
                "state": get_manuscript_package_state(&full_path)?
            }))
        })()),
        "manuscripts:generate-editor-commands" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let instructions = payload_string(&payload, "instructions").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let project = ensure_editor_project(&full_path)?;
            let (commands, brief) = generate_editor_commands_for_project(
                state,
                &project,
                &instructions,
                payload_field(&payload, "modelConfig"),
            )?;
            Ok(json!({
                "success": true,
                "brief": brief,
                "commands": commands
            }))
        })()),
        "manuscripts:get-editor-runtime-state" => Some((|| -> Result<Value, String> {
            let file_path = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "filePath"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            Ok(json!({
                "success": true,
                "state": editor_runtime_state_value(state, &file_path)?
            }))
        })()),
        "manuscripts:get-remotion-context" => Some((|| -> Result<Value, String> {
            let file_path = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "filePath"))
                .unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            Ok(json!({
                "success": true,
                "state": remotion_context_value(state, &full_path, &file_path)?
            }))
        })()),
        "manuscripts:update-editor-runtime-state" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let mut guard = state
                .editor_runtime_states
                .lock()
                .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
            let previous = guard.get(&file_path).cloned();
            let updated_at = now_ms();
            guard.insert(
                file_path.clone(),
                EditorRuntimeStateRecord {
                    file_path: file_path.clone(),
                    session_id: payload_string(&payload, "sessionId"),
                    playhead_seconds: payload_field(&payload, "playheadSeconds")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0),
                    selected_clip_id: payload_string(&payload, "selectedClipId"),
                    selected_clip_ids: payload_field(&payload, "selectedClipIds").cloned().or_else(
                        || {
                            previous
                                .as_ref()
                                .and_then(|record| record.selected_clip_ids.clone())
                        },
                    ),
                    active_track_id: payload_string(&payload, "activeTrackId"),
                    selected_track_ids: payload_field(&payload, "selectedTrackIds")
                        .cloned()
                        .or_else(|| {
                            previous
                                .as_ref()
                                .and_then(|record| record.selected_track_ids.clone())
                        }),
                    selected_scene_id: payload_string(&payload, "selectedSceneId"),
                    preview_tab: payload_string(&payload, "previewTab"),
                    canvas_ratio_preset: payload_string(&payload, "canvasRatioPreset"),
                    active_panel: payload_string(&payload, "activePanel"),
                    drawer_panel: payload_string(&payload, "drawerPanel"),
                    scene_item_transforms: payload_field(&payload, "sceneItemTransforms").cloned(),
                    scene_item_visibility: payload_field(&payload, "sceneItemVisibility").cloned(),
                    scene_item_order: payload_field(&payload, "sceneItemOrder").cloned(),
                    scene_item_locks: payload_field(&payload, "sceneItemLocks").cloned(),
                    scene_item_groups: payload_field(&payload, "sceneItemGroups").cloned(),
                    focused_group_id: payload_string(&payload, "focusedGroupId"),
                    track_ui: payload_field(&payload, "trackUi").cloned(),
                    viewport_scroll_left: payload_field(&payload, "viewportScrollLeft")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0),
                    viewport_max_scroll_left: payload_field(&payload, "viewportMaxScrollLeft")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0),
                    viewport_scroll_top: payload_field(&payload, "viewportScrollTop")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0),
                    viewport_max_scroll_top: payload_field(&payload, "viewportMaxScrollTop")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0),
                    timeline_zoom_percent: payload_field(&payload, "timelineZoomPercent")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(100.0),
                    undo_stack: previous
                        .as_ref()
                        .map(|record| record.undo_stack.clone())
                        .unwrap_or_default(),
                    redo_stack: previous
                        .as_ref()
                        .map(|record| record.redo_stack.clone())
                        .unwrap_or_default(),
                    updated_at,
                },
            );
            drop(guard);
            Ok(json!({
                "success": true,
                "state": editor_runtime_state_value(state, &file_path)?
            }))
        })()),
        _ => None,
    }
}
