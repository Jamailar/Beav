use super::*;

pub(super) fn editor_runtime_state_value(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Value, String> {
    let guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard.get(file_path).cloned();
    Ok(editor_runtime_state_snapshot(file_path, record.as_ref()))
}

pub(super) fn editor_runtime_state_record(
    state: &State<'_, AppState>,
    file_path: &str,
) -> Result<Option<EditorRuntimeStateRecord>, String> {
    let guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    Ok(guard.get(file_path).cloned())
}

fn editor_runtime_state_snapshot(
    file_path: &str,
    record: Option<&EditorRuntimeStateRecord>,
) -> Value {
    match record {
        Some(record) => json!({
            "filePath": record.file_path,
            "sessionId": record.session_id,
            "playheadSeconds": record.playhead_seconds,
            "selectedClipId": record.selected_clip_id,
            "selectedClipIds": record.selected_clip_ids,
            "activeTrackId": record.active_track_id,
            "selectedTrackIds": record.selected_track_ids,
            "selectedSceneId": record.selected_scene_id,
            "previewTab": record.preview_tab,
            "canvasRatioPreset": record.canvas_ratio_preset,
            "activePanel": record.active_panel,
            "drawerPanel": record.drawer_panel,
            "sceneItemTransforms": record.scene_item_transforms,
            "sceneItemVisibility": record.scene_item_visibility,
            "sceneItemOrder": record.scene_item_order,
            "sceneItemLocks": record.scene_item_locks,
            "sceneItemGroups": record.scene_item_groups,
            "focusedGroupId": record.focused_group_id,
            "trackUi": record.track_ui,
            "viewportScrollLeft": record.viewport_scroll_left,
            "viewportMaxScrollLeft": record.viewport_max_scroll_left,
            "viewportScrollTop": record.viewport_scroll_top,
            "viewportMaxScrollTop": record.viewport_max_scroll_top,
            "timelineZoomPercent": record.timeline_zoom_percent,
            "canUndo": !record.undo_stack.is_empty(),
            "canRedo": !record.redo_stack.is_empty(),
            "updatedAt": record.updated_at,
        }),
        None => json!({
            "filePath": file_path,
            "sessionId": Value::Null,
            "playheadSeconds": 0.0,
            "selectedClipId": Value::Null,
            "selectedClipIds": json!([]),
            "activeTrackId": Value::Null,
            "selectedTrackIds": json!([]),
            "selectedSceneId": Value::Null,
            "previewTab": Value::Null,
            "canvasRatioPreset": Value::Null,
            "activePanel": Value::Null,
            "drawerPanel": Value::Null,
            "sceneItemTransforms": Value::Null,
            "sceneItemVisibility": Value::Null,
            "sceneItemOrder": Value::Null,
            "sceneItemLocks": Value::Null,
            "sceneItemGroups": Value::Null,
            "focusedGroupId": Value::Null,
            "trackUi": Value::Null,
            "viewportScrollLeft": 0.0,
            "viewportMaxScrollLeft": 0.0,
            "viewportScrollTop": 0.0,
            "viewportMaxScrollTop": 0.0,
            "timelineZoomPercent": 100.0,
            "canUndo": false,
            "canRedo": false,
            "updatedAt": now_ms(),
        }),
    }
}

fn empty_editor_runtime_state_record(file_path: &str) -> EditorRuntimeStateRecord {
    EditorRuntimeStateRecord {
        file_path: file_path.to_string(),
        session_id: None,
        playhead_seconds: 0.0,
        selected_clip_id: None,
        selected_clip_ids: Some(json!([])),
        active_track_id: None,
        selected_track_ids: Some(json!([])),
        selected_scene_id: None,
        preview_tab: None,
        canvas_ratio_preset: None,
        active_panel: None,
        drawer_panel: None,
        scene_item_transforms: None,
        scene_item_visibility: None,
        scene_item_order: None,
        scene_item_locks: None,
        scene_item_groups: None,
        focused_group_id: None,
        track_ui: None,
        viewport_scroll_left: 0.0,
        viewport_max_scroll_left: 0.0,
        viewport_scroll_top: 0.0,
        viewport_max_scroll_top: 0.0,
        timeline_zoom_percent: 100.0,
        undo_stack: Vec::new(),
        redo_stack: Vec::new(),
        updated_at: now_ms(),
    }
}

pub(super) fn update_editor_runtime_state(
    state: &State<'_, AppState>,
    file_path: &str,
    payload: &Value,
) -> Result<Value, String> {
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let previous = guard.get(file_path).cloned();
    let updated_at = now_ms();
    let next_record = EditorRuntimeStateRecord {
        file_path: file_path.to_string(),
        session_id: payload_string(&payload, "sessionId"),
        playhead_seconds: payload_field(&payload, "playheadSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        selected_clip_id: payload_string(&payload, "selectedClipId"),
        selected_clip_ids: payload_field(&payload, "selectedClipIds")
            .cloned()
            .or_else(|| {
                previous
                    .as_ref()
                    .and_then(|record| record.selected_clip_ids.clone())
            }),
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
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        viewport_max_scroll_left: payload_field(&payload, "viewportMaxScrollLeft")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        viewport_scroll_top: payload_field(&payload, "viewportScrollTop")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        viewport_max_scroll_top: payload_field(&payload, "viewportMaxScrollTop")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        timeline_zoom_percent: payload_field(&payload, "timelineZoomPercent")
            .and_then(Value::as_f64)
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
    };
    let snapshot = editor_runtime_state_snapshot(file_path, Some(&next_record));
    guard.insert(file_path.to_string(), next_record);
    Ok(snapshot)
}

pub(super) fn push_editor_project_undo_snapshot(
    state: &State<'_, AppState>,
    file_path: &str,
    project: &Value,
) -> Result<(), String> {
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard
        .entry(file_path.to_string())
        .or_insert_with(|| empty_editor_runtime_state_record(file_path));
    record.undo_stack.push(project.clone());
    if record.undo_stack.len() > 80 {
        record.undo_stack.remove(0);
    }
    record.redo_stack.clear();
    record.updated_at = now_ms();
    Ok(())
}

pub(super) fn restore_editor_project_from_history(
    state: &State<'_, AppState>,
    file_path: &str,
    full_path: &Path,
    direction: &str,
) -> Result<Value, String> {
    let current_project = ensure_editor_project(full_path)?;
    let mut guard = state
        .editor_runtime_states
        .lock()
        .map_err(|_| "editor runtime state lock 已损坏".to_string())?;
    let record = guard
        .entry(file_path.to_string())
        .or_insert_with(|| empty_editor_runtime_state_record(file_path));
    let source_stack = if direction == "redo" {
        &mut record.redo_stack
    } else {
        &mut record.undo_stack
    };
    let Some(next_project) = source_stack.pop() else {
        return Ok(json!({
            "success": false,
            "error": if direction == "redo" { "Nothing to redo" } else { "Nothing to undo" }
        }));
    };
    if direction == "redo" {
        record.undo_stack.push(current_project.clone());
    } else {
        record.redo_stack.push(current_project.clone());
    }
    record.updated_at = now_ms();
    drop(guard);
    write_json_value(&package_editor_project_path(full_path), &next_project)?;
    Ok(json!({
        "success": true,
        "state": get_manuscript_package_state(full_path)?
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_runtime_state_snapshot_has_stable_defaults() {
        let snapshot = editor_runtime_state_snapshot("demo", None);

        assert_eq!(
            snapshot.get("filePath").and_then(Value::as_str),
            Some("demo")
        );
        assert_eq!(
            snapshot.get("timelineZoomPercent").and_then(Value::as_f64),
            Some(100.0)
        );
        assert_eq!(
            snapshot.get("canUndo").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn runtime_state_snapshot_reports_history_flags() {
        let mut record = empty_editor_runtime_state_record("demo");
        record.undo_stack.push(json!({ "v": 1 }));
        let snapshot = editor_runtime_state_snapshot("demo", Some(&record));

        assert_eq!(snapshot.get("canUndo").and_then(Value::as_bool), Some(true));
        assert_eq!(
            snapshot.get("canRedo").and_then(Value::as_bool),
            Some(false)
        );
    }
}
