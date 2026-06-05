use super::*;

pub(super) fn handle_editor_project_marker_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:add-editor-project-marker" => Some(add_editor_project_marker(state, payload)),
        "manuscripts:update-editor-project-marker" => {
            Some(update_editor_project_marker(state, payload))
        }
        "manuscripts:delete-editor-project-marker" => {
            Some(delete_editor_project_marker(state, payload))
        }
        _ => None,
    }
}

fn add_editor_project_marker(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
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
}

fn update_editor_project_marker(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let file_path = payload_string(&payload, "filePath").unwrap_or_default();
    let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
    if file_path.is_empty() || marker_id.is_empty() {
        return Ok(json!({ "success": false, "error": "filePath and markerId are required" }));
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
        return Ok(json!({ "success": false, "error": "Marker not found in editor project" }));
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
}

fn delete_editor_project_marker(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let file_path = payload_string(&payload, "filePath").unwrap_or_default();
    let marker_id = payload_string(&payload, "markerId").unwrap_or_default();
    if file_path.is_empty() || marker_id.is_empty() {
        return Ok(json!({ "success": false, "error": "filePath and markerId are required" }));
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
    markers.retain(|marker| marker.get("id").and_then(Value::as_str) != Some(marker_id.as_str()));
    if before == markers.len() {
        return Ok(json!({ "success": false, "error": "Marker not found in editor project" }));
    }
    write_json_value(&package_editor_project_path(&full_path), &project)?;
    Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
}
