use super::*;

pub(super) fn handle_timeline_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if let Some(result) = timeline_tracks::handle_timeline_track_channel(state, channel, payload) {
        return Some(result);
    }
    if let Some(result) =
        timeline_insertions::handle_timeline_insertion_channel(app, state, channel, payload)
    {
        return Some(result);
    }
    match channel {
        "manuscripts:update-package-clip" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            if file_path.is_empty() || clip_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and clipId are required" }),
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
            let mut clip_to_move: Option<Value> = None;
            let mut current_track_index = 0usize;
            for (track_index, track) in tracks.iter_mut().enumerate() {
                let track_name = track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
                    continue;
                };
                if let Some(index) = children
                    .iter()
                    .position(|clip| timeline_clip_identity(clip, &track_name, 0) == clip_id)
                {
                    clip_to_move = Some(children.remove(index));
                    current_track_index = track_index;
                    break;
                }
            }
            let Some(mut clip) = clip_to_move else {
                return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
            };
            let target_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                tracks[current_track_index]
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("V1")
                    .to_string()
            });
            let target_track = ensure_timeline_track(
                &mut timeline,
                &target_track_name,
                if target_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                },
            );
            let target_children = target_track
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline target children missing".to_string())?;
            let desired_order = payload_field(&payload, "order")
                .and_then(|value| value.as_i64())
                .unwrap_or(target_children.len() as i64)
                .clamp(0, target_children.len() as i64) as usize;
            if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut) {
                metadata.insert("clipId".to_string(), json!(clip_id));
                if let Some(duration_ms) = payload_field(&payload, "durationMs") {
                    metadata.insert("durationMs".to_string(), duration_ms.clone());
                }
                if let Some(trim_in_ms) = payload_field(&payload, "trimInMs") {
                    metadata.insert("trimInMs".to_string(), trim_in_ms.clone());
                }
                if let Some(trim_out_ms) = payload_field(&payload, "trimOutMs") {
                    metadata.insert("trimOutMs".to_string(), trim_out_ms.clone());
                }
                if let Some(enabled) = payload_field(&payload, "enabled") {
                    metadata.insert("enabled".to_string(), enabled.clone());
                }
                if let Some(asset_kind) = payload_field(&payload, "assetKind") {
                    metadata.insert("assetKind".to_string(), asset_kind.clone());
                }
                if let Some(subtitle_style) = payload_field(&payload, "subtitleStyle") {
                    metadata.insert("subtitleStyle".to_string(), subtitle_style.clone());
                }
                if let Some(text_style) = payload_field(&payload, "textStyle") {
                    metadata.insert("textStyle".to_string(), text_style.clone());
                }
                if let Some(transition_style) = payload_field(&payload, "transitionStyle") {
                    metadata.insert("transitionStyle".to_string(), transition_style.clone());
                }
            }
            if let Some(name) = payload_string(&payload, "name") {
                if let Some(object) = clip.as_object_mut() {
                    object.insert("name".to_string(), json!(name));
                }
            }
            target_children.insert(desired_order, clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:delete-package-clip" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
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
            let mut removed = false;
            for track in tracks.iter_mut() {
                let track_name = track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) {
                    let before = children.len();
                    children.retain(|clip| timeline_clip_identity(clip, &track_name, 0) != clip_id);
                    if before != children.len() {
                        removed = true;
                    }
                }
            }
            if !removed {
                return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
            }
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        "manuscripts:split-package-clip" => Some((|| -> Result<Value, String> {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            let split_ratio = payload_field(&payload, "splitRatio")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.5)
                .clamp(0.1, 0.9);
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
            let mut split_done = false;
            for track in tracks.iter_mut() {
                let track_name = track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
                    continue;
                };
                let mut next_children = Vec::new();
                for clip in children.iter() {
                    let mut clip_value = clip.clone();
                    next_children.push(clip_value.clone());
                    if timeline_clip_identity(clip, &track_name, 0) != clip_id {
                        continue;
                    }
                    let min_duration =
                        min_clip_duration_ms_for_asset_kind(&timeline_clip_asset_kind(clip));
                    let current_duration = timeline_clip_duration_ms(clip);
                    let first_duration = ((current_duration as f64) * split_ratio).round() as i64;
                    let first_duration = first_duration.max(min_duration);
                    let second_duration = (current_duration - first_duration).max(min_duration);
                    if let Some(obj) = clip_value
                        .get_mut("metadata")
                        .and_then(Value::as_object_mut)
                    {
                        obj.insert("clipId".to_string(), json!(clip_id.clone()));
                        obj.insert("durationMs".to_string(), json!(first_duration));
                    }
                    if let Some(last) = next_children.last_mut() {
                        *last = clip_value.clone();
                    }
                    let mut new_clip = clip.clone();
                    if let Some(obj) = new_clip.get_mut("metadata").and_then(Value::as_object_mut) {
                        let trim_in = obj.get("trimInMs").and_then(|v| v.as_i64()).unwrap_or(0);
                        obj.insert("clipId".to_string(), json!(create_timeline_clip_id()));
                        obj.insert("durationMs".to_string(), json!(second_duration));
                        obj.insert("trimInMs".to_string(), json!(trim_in + first_duration));
                    }
                    next_children.push(new_clip);
                    split_done = true;
                }
                *children = next_children;
                if split_done {
                    break;
                }
            }
            if !split_done {
                return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
            }
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        })()),
        _ => None,
    }
}
