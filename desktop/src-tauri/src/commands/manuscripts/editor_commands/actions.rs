use super::*;

pub(super) fn collect_string_array(command: &Value, key: &str) -> Vec<String> {
    command
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToString::to_string))
        .collect()
}

pub(super) fn delete_item_ids(command: &Value) -> Vec<String> {
    if command.get("itemIds").and_then(Value::as_array).is_some() {
        return collect_string_array(command, "itemIds");
    }
    command
        .get("itemId")
        .and_then(Value::as_str)
        .map(|item_id| vec![item_id.to_string()])
        .unwrap_or_default()
}

pub(super) fn default_track_ui() -> Value {
    json!({
        "hidden": false,
        "locked": false,
        "muted": false,
        "solo": false,
        "collapsed": false,
        "volume": 1.0
    })
}

pub(super) fn merge_object_patch(target: &mut Value, patch: &Value) {
    let (Some(target), Some(source)) = (target.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (key, value) in source {
        target.insert(key.to_string(), value.clone());
    }
}

pub(super) fn next_track_id(project: &Value, kind: &str) -> String {
    let prefix = track_prefix(kind);
    let max_index = project
        .get("tracks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|track| {
            let id = track.get("id").and_then(Value::as_str).unwrap_or("");
            id.strip_prefix(prefix)?.parse::<i64>().ok()
        })
        .max()
        .unwrap_or(0);
    format!("{prefix}{}", max_index + 1)
}

pub(super) fn renumber_tracks(tracks: &mut [Value]) {
    for (order, track) in tracks.iter_mut().enumerate() {
        if let Some(object) = track.as_object_mut() {
            object.insert("order".to_string(), json!(order));
        }
    }
}

fn track_prefix(kind: &str) -> &'static str {
    match kind {
        "audio" => "A",
        "subtitle" => "S",
        "text" => "T",
        "motion" => "M",
        _ => "V",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_item_ids_supports_single_and_batch_commands() {
        assert_eq!(
            delete_item_ids(&json!({"itemId": "item-1"})),
            vec!["item-1".to_string()]
        );
        assert_eq!(
            delete_item_ids(&json!({"itemIds": ["a", 1, "b"]})),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn next_track_id_uses_kind_prefix_and_existing_max_index() {
        let project = json!({
            "tracks": [
                {"id": "V1"},
                {"id": "V9"},
                {"id": "A3"},
                {"id": "video-legacy"}
            ]
        });

        assert_eq!(next_track_id(&project, "video"), "V10");
        assert_eq!(next_track_id(&project, "audio"), "A4");
        assert_eq!(next_track_id(&project, "motion"), "M1");
    }

    #[test]
    fn merge_object_patch_ignores_non_object_inputs() {
        let mut target = json!({"a": 1});
        merge_object_patch(&mut target, &json!({"b": 2}));
        assert_eq!(target, json!({"a": 1, "b": 2}));

        merge_object_patch(&mut target, &json!(null));
        assert_eq!(target, json!({"a": 1, "b": 2}));
    }
}
