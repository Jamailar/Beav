use super::*;

pub(super) fn generate_motion_items_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    selected_item_ids: &[String],
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let media_items = project
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("type").and_then(|value| value.as_str()) == Some("media"))
        .filter(|item| {
            if selected_item_ids.is_empty() {
                return true;
            }
            item.get("id")
                .and_then(|value| value.as_str())
                .map(|value| selected_item_ids.iter().any(|selected| selected == value))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if media_items.is_empty() {
        return Err("当前工程没有可生成动画的媒体片段".to_string());
    }

    let fallback_items = media_items
        .iter()
        .enumerate()
        .map(|(index, item)| default_motion_item_from_media(item, project, index))
        .collect::<Vec<_>>();
    let user_prompt = format!(
        "请基于当前脚本和媒体片段，生成 motion item 列表。\n\
只输出 JSON，不要输出解释。\n\
结构：{{\"brief\":string,\"items\":[{{\"bindItemId\":string,\"fromMs\":number,\"durationMs\":number,\"templateId\":\"static|slow-zoom-in|slow-zoom-out|pan-left|pan-right|slide-up|slide-down\",\"props\":{{\"overlayTitle\":string|null,\"overlayBody\":string|null,\"overlays\":[{{\"id\":string,\"text\":string,\"startFrame\":number,\"durationInFrames\":number,\"position\":\"top|center|bottom\",\"animation\":\"fade-up|fade-in|slide-left|pop\",\"fontSize\":number}}]}}}}]}}\n\
要求：\n\
1. 每个 item 必须绑定现有 bindItemId。\n\
2. fromMs / durationMs 要落在绑定片段范围内或与其基本一致。\n\
3. 模板只允许 static, slow-zoom-in, slow-zoom-out, pan-left, pan-right, slide-up, slide-down。\n\
4. 适合短视频节奏，前段更强，后段更稳。\n\
5. 默认不要生成 overlayTitle、overlayBody 或 overlays；除非脚本明确要求屏幕文字、标题或字幕。\n\
\n\
脚本：{}\n\
目标片段：{}",
        instructions,
        serde_json::to_string(&media_items).map_err(|error| error.to_string())?
    );
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是当前品牌 AI 的短视频动画导演。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let normalized_items = parsed
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    normalize_motion_item(
                        item,
                        fallback_items.get(index).unwrap_or(&fallback_items[0]),
                    )
                })
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or(fallback_items);
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((normalized_items, brief))
}

fn normalize_editor_ai_command(raw: &Value) -> Option<Value> {
    let command_type = raw.get("type").and_then(|value| value.as_str())?;
    match command_type {
        "upsert_assets" => Some(json!({
            "type": "upsert_assets",
            "assets": raw.get("assets").cloned().unwrap_or_else(|| json!([]))
        })),
        "add_track" => Some(json!({
            "type": "add_track",
            "kind": raw.get("kind").cloned().unwrap_or(json!("video")),
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null)
        })),
        "delete_tracks" => Some(json!({
            "type": "delete_tracks",
            "trackIds": raw.get("trackIds").cloned().unwrap_or_else(|| json!([]))
        })),
        "update_item" => Some(json!({
            "type": "update_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "delete_item" => Some(json!({
            "type": "delete_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null)
        })),
        "split_item" => Some(json!({
            "type": "split_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "splitMs": raw.get("splitMs").cloned().unwrap_or(json!(0))
        })),
        "move_items" => Some(json!({
            "type": "move_items",
            "itemIds": raw.get("itemIds").cloned().unwrap_or_else(|| json!([])),
            "deltaMs": raw.get("deltaMs").cloned().unwrap_or(json!(0)),
            "targetTrackId": raw.get("targetTrackId").cloned().unwrap_or(Value::Null)
        })),
        "retime_item" => Some(json!({
            "type": "retime_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "fromMs": raw.get("fromMs").cloned().unwrap_or(Value::Null),
            "durationMs": raw.get("durationMs").cloned().unwrap_or(Value::Null)
        })),
        "set_track_ui" => Some(json!({
            "type": "set_track_ui",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "reorder_tracks" => Some(json!({
            "type": "reorder_tracks",
            "trackId": raw.get("trackId").cloned().unwrap_or(Value::Null),
            "direction": raw.get("direction").cloned().unwrap_or(json!("up"))
        })),
        "update_stage_item" => Some(json!({
            "type": "update_stage_item",
            "itemId": raw.get("itemId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or(Value::Null),
            "visible": raw.get("visible").cloned().unwrap_or(Value::Null),
            "locked": raw.get("locked").cloned().unwrap_or(Value::Null),
            "groupId": raw.get("groupId").cloned().unwrap_or(Value::Null)
        })),
        "animation_layer_create" => Some(json!({
            "type": "animation_layer_create",
            "layer": raw.get("layer").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_update" => Some(json!({
            "type": "animation_layer_update",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null),
            "patch": raw.get("patch").cloned().unwrap_or_else(|| json!({}))
        })),
        "animation_layer_delete" => Some(json!({
            "type": "animation_layer_delete",
            "layerId": raw.get("layerId").cloned().unwrap_or(Value::Null)
        })),
        _ => None,
    }
}

pub(super) fn generate_editor_commands_for_project(
    state: &State<'_, AppState>,
    project: &Value,
    instructions: &str,
    model_config: Option<&Value>,
) -> Result<(Vec<Value>, String), String> {
    let user_prompt = format!(
        "把用户的编辑要求转换成结构化命令 JSON。\n\
只输出 JSON，不要输出解释。\n\
允许命令：add_track, delete_tracks, update_item, delete_item, split_item, move_items, retime_item, set_track_ui, reorder_tracks, update_stage_item。\n\
输出结构：{{\"brief\":string,\"commands\":[...]}}\n\
规则：\n\
1. 只能引用现有 itemId / trackId。\n\
2. 不要生成 motion item；motion 相关生成单独走 generate-motion-items。\n\
3. patch 只包含必要字段。\n\
4. 如果用户指令模糊，给出最保守的命令。\n\
\n\
当前工程 JSON：{}\n\
用户要求：{}",
        serde_json::to_string(project).map_err(|error| error.to_string())?,
        instructions
    );
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        model_config,
        "你是当前品牌 AI 的视频编辑命令规划器。只输出严格 JSON。",
        &user_prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
    let commands = parsed
        .get("commands")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_editor_ai_command)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let brief = parsed
        .get("brief")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw);
    Ok((commands, brief))
}

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
                let prefix = match kind {
                    "audio" => "A",
                    "subtitle" => "S",
                    "text" => "T",
                    "motion" => "M",
                    _ => "V",
                };
                let track_id = command
                    .get("trackId")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        let tracks = project
                            .get("tracks")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let max_index = tracks
                            .iter()
                            .filter_map(|track| {
                                let id = track
                                    .get("id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if !id.starts_with(prefix) {
                                    return None;
                                }
                                id[1..].parse::<i64>().ok()
                            })
                            .max()
                            .unwrap_or(0);
                        format!("{prefix}{}", max_index + 1)
                    });
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
            }
            "delete_tracks" => {
                let track_ids = command
                    .get("trackIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
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
                for (order, track) in editor_project_tracks_mut(project)?.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
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
                    if let (Some(target), Some(source)) = (item.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            "delete_item" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![command.get("itemId").cloned().unwrap_or(Value::Null)]);
                let normalized = item_ids
                    .iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                editor_project_items_mut(project)?.retain(|item| {
                    let item_id = item
                        .get("id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    !normalized.iter().any(|value| value == item_id)
                });
            }
            "delete_items" => {
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
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
                let item_ids = command
                    .get("itemIds")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
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
                    if let (Some(target), Some(source)) =
                        (next_ui.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
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
                for (order, track) in tracks.iter_mut().enumerate() {
                    if let Some(object) = track.as_object_mut() {
                        object.insert("order".to_string(), json!(order));
                    }
                }
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
                    if let (Some(target), Some(source)) =
                        (entry.as_object_mut(), Some(transform_patch))
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
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
                    if let (Some(target), Some(source)) = (layer.as_object_mut(), patch.as_object())
                    {
                        for (key, value) in source {
                            target.insert(key.to_string(), value.clone());
                        }
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_editor_ai_command_drops_unknown_commands() {
        assert!(normalize_editor_ai_command(&json!({ "type": "unknown" })).is_none());
        assert_eq!(
            normalize_editor_ai_command(&json!({ "type": "add_track", "kind": "audio" }))
                .and_then(|command| command.get("kind").cloned()),
            Some(json!("audio"))
        );
    }
}
