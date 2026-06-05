use serde_json::{json, Value};

pub(super) fn value_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn value_i64(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key).and_then(Value::as_i64)
}

pub(super) fn value_string_array(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn value_vec(payload: &Value, key: &str) -> Option<Vec<Value>> {
    payload.get(key).and_then(Value::as_array).cloned()
}

pub(super) fn value_object(payload: &Value, key: &str) -> Option<Value> {
    payload.get(key).filter(|value| value.is_object()).cloned()
}

pub(super) fn value_array(payload: &Value, key: &str) -> Vec<Value> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn value_string_array_or_default(
    payload: &Value,
    key: &str,
    fallback: &[&str],
) -> Vec<Value> {
    let values = value_string_array(payload, key);
    if values.is_empty() {
        fallback.iter().map(|value| json!(value)).collect()
    } else {
        values.into_iter().map(Value::String).collect()
    }
}

pub(super) fn merge_object_defaults(defaults: Value, overlay: Option<Value>) -> Value {
    let mut object = defaults.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(overlay)) = overlay {
        for (key, value) in overlay {
            object.insert(key, value);
        }
    }
    Value::Object(object)
}
