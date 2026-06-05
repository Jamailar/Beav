use super::timeline_model::DEFAULT_TIMELINE_CLIP_MS;
use super::*;

#[path = "editor_project_model/subtitles.rs"]
mod subtitles;

pub(super) fn ensure_editor_track(
    project: &mut Value,
    track_id: &str,
    kind: &str,
) -> Result<(), String> {
    if project
        .get("tracks")
        .and_then(Value::as_array)
        .map(|tracks| {
            tracks.iter().any(|track| {
                track
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == track_id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
    {
        return Ok(());
    }
    let order = editor_project_tracks_mut(project)?.len();
    editor_project_tracks_mut(project)?.push(json!({
        "id": track_id,
        "kind": kind,
        "name": track_id,
        "order": order,
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

pub(super) fn editor_default_subtitle_style(
    source_item_id: &str,
    subtitle_file: &str,
    style_patch: Option<&Value>,
) -> Value {
    subtitles::editor_default_subtitle_style(source_item_id, subtitle_file, style_patch)
}

pub(super) fn upsert_editor_project_last_subtitle_transcription(
    project: &mut Value,
    source_item_id: &str,
    subtitle_file: &str,
    segment_count: usize,
) -> Result<(), String> {
    subtitles::upsert_editor_project_last_subtitle_transcription(
        project,
        source_item_id,
        subtitle_file,
        segment_count,
    )
}

pub(super) fn editor_project_items_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    project
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Editor project items missing".to_string())
}

pub(super) fn editor_project_tracks_mut(project: &mut Value) -> Result<&mut Vec<Value>, String> {
    project
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Editor project tracks missing".to_string())
}

pub(super) fn ensure_motion_track(project: &mut Value) -> Result<(), String> {
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

pub(super) fn editor_project_animation_layers_mut(
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

pub(super) fn default_motion_item_from_media(
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

pub(super) fn normalize_motion_item(raw: &Value, fallback: &Value) -> Value {
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
pub(super) fn sync_project_motion_items_from_remotion_scene(
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

pub(super) fn normalize_editor_project_timeline(project: &mut Value) -> Result<(), String> {
    let tracks = project
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut ordered_tracks = tracks;
    ordered_tracks.sort_by_key(|track| {
        track
            .get("order")
            .and_then(|value| value.as_i64())
            .unwrap_or(0)
    });
    let main_video_track_id = ordered_tracks
        .iter()
        .find(|track| track.get("kind").and_then(|value| value.as_str()) == Some("video"))
        .and_then(|track| track.get("id").and_then(|value| value.as_str()))
        .map(ToString::to_string);
    let motion_track_ids = ordered_tracks
        .iter()
        .filter(|track| track.get("kind").and_then(Value::as_str) == Some("motion"))
        .filter_map(|track| {
            track
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    if !motion_track_ids.is_empty() {
        let layers = editor_project_animation_layers_mut(project)?;
        let original_order = layers
            .iter()
            .enumerate()
            .filter_map(|(index, layer)| {
                layer
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_string(), index))
            })
            .collect::<BTreeMap<_, _>>();
        let mut rebuilt_layers = Vec::new();
        for track_id in &motion_track_ids {
            let mut track_layers = layers
                .iter()
                .filter(|layer| {
                    layer.get("trackId").and_then(Value::as_str) == Some(track_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            track_layers.sort_by(|left, right| {
                let left_from = left.get("fromMs").and_then(Value::as_i64).unwrap_or(0);
                let right_from = right.get("fromMs").and_then(Value::as_i64).unwrap_or(0);
                if left_from != right_from {
                    return left_from.cmp(&right_from);
                }
                let left_id = left.get("id").and_then(Value::as_str).unwrap_or("");
                let right_id = right.get("id").and_then(Value::as_str).unwrap_or("");
                original_order
                    .get(left_id)
                    .unwrap_or(&0usize)
                    .cmp(original_order.get(right_id).unwrap_or(&0usize))
            });
            let mut cursor = 0_i64;
            for (z_index, mut layer) in track_layers.into_iter().enumerate() {
                let from_ms = layer
                    .get("fromMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(cursor);
                let duration_ms = layer
                    .get("durationMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(300);
                if let Some(object) = layer.as_object_mut() {
                    object.insert("trackId".to_string(), json!(track_id));
                    object.insert("fromMs".to_string(), json!(from_ms));
                    object.insert("durationMs".to_string(), json!(duration_ms));
                    object.insert("zIndex".to_string(), json!(z_index));
                }
                cursor = from_ms + duration_ms;
                rebuilt_layers.push(layer);
            }
        }
        let known_motion_tracks = motion_track_ids.iter().cloned().collect::<BTreeSet<_>>();
        rebuilt_layers.extend(
            layers
                .iter()
                .filter(|layer| {
                    layer
                        .get("trackId")
                        .and_then(Value::as_str)
                        .map(|track_id| !known_motion_tracks.contains(track_id))
                        .unwrap_or(true)
                })
                .cloned(),
        );
        *layers = rebuilt_layers;
    }
    let projected_motion_items = projected_motion_items_from_animation_layers(project);
    let items = editor_project_items_mut(project)?;
    items.retain(|item| item.get("type").and_then(Value::as_str) != Some("motion"));
    items.extend(projected_motion_items);
    let items = editor_project_items_mut(project)?;
    let original_order = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|id| (id.to_string(), index))
        })
        .collect::<BTreeMap<_, _>>();
    let mut rebuilt = Vec::new();
    for track in &ordered_tracks {
        let Some(track_id) = track.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let mut track_items = items
            .iter()
            .filter(|item| item.get("trackId").and_then(|value| value.as_str()) == Some(track_id))
            .cloned()
            .collect::<Vec<_>>();
        track_items.sort_by(|left, right| {
            let left_from = left
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let right_from = right
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            if left_from != right_from {
                return left_from.cmp(&right_from);
            }
            let left_id = left
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let right_id = right
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            original_order
                .get(left_id)
                .unwrap_or(&0usize)
                .cmp(original_order.get(right_id).unwrap_or(&0usize))
        });
        let mut cursor = 0_i64;
        for mut item in track_items {
            let from_ms = item
                .get("fromMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let duration_ms = item
                .get("durationMs")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let next_from_ms = if main_video_track_id.as_deref() == Some(track_id) {
                cursor
            } else {
                from_ms.max(cursor)
            };
            if let Some(object) = item.as_object_mut() {
                object.insert("fromMs".to_string(), json!(next_from_ms));
            }
            cursor = next_from_ms + duration_ms.max(0);
            rebuilt.push(item);
        }
    }
    let known_track_ids = ordered_tracks
        .iter()
        .filter_map(|track| {
            track
                .get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .collect::<BTreeSet<_>>();
    let remainder = items
        .iter()
        .filter(|item| {
            item.get("trackId")
                .and_then(|value| value.as_str())
                .map(|track_id| !known_track_ids.contains(track_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    rebuilt.extend(remainder);
    *items = rebuilt;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_motion_track_appends_after_existing_tracks() {
        let mut project = json!({
            "tracks": [{ "id": "V1", "kind": "video", "order": 3 }],
            "items": []
        });

        ensure_motion_track(&mut project).unwrap();

        assert_eq!(
            project.pointer("/tracks/1/id").and_then(Value::as_str),
            Some("M1")
        );
        assert_eq!(
            project.pointer("/tracks/1/order").and_then(Value::as_i64),
            Some(4)
        );
    }
}
