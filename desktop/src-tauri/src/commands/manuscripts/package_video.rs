use super::*;

pub(super) fn get_video_project_state_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let file_path = payload_value_as_string(payload)
        .or_else(|| payload_string(payload, "filePath"))
        .unwrap_or_default();
    if file_path.is_empty() {
        return Ok(json!({ "success": false, "error": "filePath is required" }));
    }
    let full_path = resolve_manuscript_path(state, &file_path)?;
    if !full_path.is_dir() {
        return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
    }
    if get_package_kind_from_manifest(&full_path).as_deref() != Some("video") {
        return Ok(json!({ "success": false, "error": "Not a video manuscript package" }));
    }
    let file_name = full_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled");
    let package_state = get_manuscript_package_state(&full_path)?;
    let manifest = package_state
        .get("manifest")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let assets = package_state
        .get("assets")
        .cloned()
        .unwrap_or_else(|| json!({ "items": [] }));
    let remotion = package_state
        .get("remotion")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let timeline_summary = package_state
        .get("timelineSummary")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "trackCount": 0,
                "clipCount": 0,
                "sourceRefs": [],
                "clips": [],
                "trackNames": [],
                "trackUi": {}
            })
        });
    let project = read_json_value_or(&package_editor_project_path(&full_path), Value::Null);
    let editor_project = if project.is_object() {
        Some(&project)
    } else {
        None
    };
    Ok(json!({
        "success": true,
        "project": get_video_project_state(
            &full_path,
            file_name,
            &manifest,
            &assets,
            &remotion,
            editor_project,
            &timeline_summary,
        )
    }))
}

pub(super) fn save_video_project_brief_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let file_path = payload_value_as_string(payload)
        .or_else(|| payload_string(payload, "filePath"))
        .unwrap_or_default();
    if file_path.is_empty() {
        return Ok(json!({ "success": false, "error": "filePath is required" }));
    }
    let full_path = resolve_manuscript_path(state, &file_path)?;
    if !full_path.is_dir() {
        return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
    }
    if get_package_kind_from_manifest(&full_path).as_deref() != Some("video") {
        return Ok(json!({ "success": false, "error": "Not a video manuscript package" }));
    }
    let brief = payload_string(payload, "content")
        .or_else(|| payload_string(payload, "brief"))
        .unwrap_or_default();
    let source = payload_string(payload, "source").unwrap_or_else(|| "user".to_string());
    let (next_state, brief_state) = persist_video_project_brief(&full_path, &brief, &source)?;
    Ok(json!({
        "success": true,
        "brief": brief_state,
        "project": next_state.get("videoProject").cloned().unwrap_or(Value::Null),
        "state": next_state
    }))
}
