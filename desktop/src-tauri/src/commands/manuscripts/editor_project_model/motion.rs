use super::super::timeline_model::DEFAULT_TIMELINE_CLIP_MS;
use super::*;

pub(in crate::commands::manuscripts) fn ensure_motion_track(
    project: &mut Value,
) -> Result<(), String> {
    let tracks = editor_project_tracks_mut(project)?;
    if tracks.iter().any(|track| {
        track
            .get("id")
            .and_then(|value| value.as_str())
            .map(|value| value == "M1")
            .unwrap_or(false)
    }) {
        return Ok(());
    }
    let next_order = tracks
        .iter()
        .filter_map(|track| track.get("order").and_then(|value| value.as_i64()))
        .max()
        .unwrap_or(-1)
        + 1;
    tracks.push(json!({
        "id": "M1",
        "kind": "motion",
        "name": "M1",
        "order": next_order,
        "ui": {
            "hidden": false,
            "locked": false,
            "muted": false,
            "solo": false,
            "collapsed": false,
            "volume": 1.0
        }
    }));
    Ok(())
}

pub(in crate::commands::manuscripts) fn editor_project_animation_layers_mut(
    project: &mut Value,
) -> Result<&mut Vec<Value>, String> {
    let object = project
        .as_object_mut()
        .ok_or_else(|| "Editor project must be an object".to_string())?;
    let layers = object
        .entry("animationLayers".to_string())
        .or_insert_with(|| json!([]));
    if !layers.is_array() {
        *layers = json!([]);
    }
    layers
        .as_array_mut()
        .ok_or_else(|| "Editor project animationLayers missing".to_string())
}

pub(in crate::commands::manuscripts) fn default_motion_item_from_media(
    media_item: &Value,
    _project: &Value,
    index: usize,
) -> Value {
    let item_id = media_item
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("item");
    let from_ms = media_item
        .get("fromMs")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let duration_ms = media_item
        .get("durationMs")
        .and_then(|value| value.as_i64())
        .unwrap_or(DEFAULT_TIMELINE_CLIP_MS)
        .max(500);
    let template_id = match index % 5 {
        0 => "slow-zoom-in",
        1 => "pan-left",
        2 => "pan-right",
        3 => "slide-up",
        _ => "slow-zoom-out",
    };
    json!({
        "id": format!("motion:{item_id}"),
        "type": "motion",
        "trackId": "M1",
        "bindItemId": item_id,
        "fromMs": from_ms,
        "durationMs": duration_ms,
        "templateId": template_id,
        "props": {
            "overlayTitle": Value::Null,
            "overlayBody": Value::Null,
            "overlays": []
        },
        "enabled": true
    })
}

pub(in crate::commands::manuscripts) fn normalize_motion_item(
    raw: &Value,
    fallback: &Value,
) -> Value {
    json!({
        "id": raw.get("id").cloned().unwrap_or_else(|| fallback.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item")))),
        "type": "motion",
        "trackId": "M1",
        "bindItemId": raw.get("bindItemId").cloned().or_else(|| fallback.get("bindItemId").cloned()).unwrap_or(Value::Null),
        "fromMs": raw.get("fromMs").cloned().or_else(|| fallback.get("fromMs").cloned()).unwrap_or(json!(0)),
        "durationMs": raw.get("durationMs").cloned().or_else(|| fallback.get("durationMs").cloned()).unwrap_or(json!(2000)),
        "templateId": raw.get("templateId").cloned().or_else(|| fallback.get("templateId").cloned()).unwrap_or(json!("static")),
        "props": raw.get("props").cloned().or_else(|| fallback.get("props").cloned()).unwrap_or_else(|| json!({})),
        "enabled": raw.get("enabled").cloned().or_else(|| fallback.get("enabled").cloned()).unwrap_or(json!(true))
    })
}

#[allow(dead_code)]
pub(in crate::commands::manuscripts) fn sync_project_motion_items_from_remotion_scene(
    project: &mut Value,
    composition: &Value,
) -> Result<(), String> {
    ensure_motion_track(project)?;
    let fps = composition
        .get("fps")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let scenes = composition
        .get("scenes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let animation_layers = animation_layers_from_remotion_scene(composition, fps);
    let media_lookup = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            Some((id, item))
        })
        .collect::<BTreeMap<_, _>>();

    editor_project_animation_layers_mut(project)?.clear();
    editor_project_animation_layers_mut(project)?.extend(animation_layers.clone());

    editor_project_items_mut(project)?
        .retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));

    let motion_items = scenes
        .iter()
        .map(|scene| {
            let bind_item_id = scene
                .get("clipId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let fallback_media = media_lookup.get(&bind_item_id);
            let from_ms = fallback_media
                .and_then(|item| item.get("fromMs").and_then(Value::as_i64))
                .unwrap_or_else(|| {
                    ((scene
                        .get("startFrame")
                        .and_then(Value::as_i64)
                        .unwrap_or(0) as f64
                        / fps as f64)
                        * 1000.0)
                        .round() as i64
                })
                .max(0);
            let duration_ms = ((scene
                .get("durationInFrames")
                .and_then(Value::as_i64)
                .unwrap_or(1) as f64
                / fps as f64)
                * 1000.0)
                .round() as i64;
            json!({
                "id": scene.get("id").cloned().unwrap_or_else(|| json!(make_id("motion-item"))),
                "type": "motion",
                "trackId": "M1",
                "bindItemId": if bind_item_id.is_empty() { Value::Null } else { json!(bind_item_id) },
                "fromMs": from_ms,
                "durationMs": duration_ms.max(300),
                "templateId": scene.get("motionPreset").cloned().unwrap_or_else(|| json!("static")),
                "props": {
                    "overlayTitle": scene.get("overlayTitle").cloned().unwrap_or(Value::Null),
                    "overlayBody": scene.get("overlayBody").cloned().unwrap_or(Value::Null),
                    "overlays": scene.get("overlays").cloned().unwrap_or_else(|| json!([])),
                    "entities": scene.get("entities").cloned().unwrap_or_else(|| json!([]))
                },
                "enabled": true
            })
        })
        .collect::<Vec<_>>();

    editor_project_items_mut(project)?.extend(motion_items);
    Ok(())
}
