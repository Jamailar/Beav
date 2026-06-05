use super::*;

use super::ffmpeg_edit::{
    execute_ffmpeg_edit_recipe, ffmpeg_asset_items, ffmpeg_recipe_duration_ms,
    ffmpeg_recipe_source_asset_ids,
};

pub(super) fn handle_editor_project_ffmpeg_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "manuscripts:ffmpeg-edit" => Some(handle_ffmpeg_edit(app, state, payload)),
        _ => None,
    }
}

fn handle_ffmpeg_edit(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let file_path = payload_string(payload, "filePath").unwrap_or_default();
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
    let intent_summary =
        payload_string(payload, "intentSummary").unwrap_or_else(|| "AI video edit".to_string());
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
    let (output_path, artifacts) =
        execute_ffmpeg_edit_recipe(app, state, &session_id, &full_path, &assets, &operations)?;
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
}
