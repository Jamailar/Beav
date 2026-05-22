use serde_json::{json, Value};

use crate::{official_ai_api_key_from_settings, payload_string};

pub(crate) const OFFICIAL_SOURCE_ID: &str = "redbox_official_auto";
pub(crate) const OFFICIAL_PRESET_ID: &str = "redbox-official";

pub(crate) fn trim_json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .or_else(|| value.get(to_snake_key(key).as_str()))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn to_snake_key(key: &str) -> String {
    let mut output = String::new();
    for character in key.chars() {
        if character.is_ascii_uppercase() {
            output.push('_');
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

pub(crate) fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

pub(crate) fn is_local_base_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.contains("127.0.0.1")
        || normalized.contains("localhost")
        || normalized.contains("0.0.0.0")
        || normalized.contains("[::1]")
        || normalized.contains("::1")
}

pub(crate) fn source_id(source: &Value) -> String {
    trim_json_string(source, "id")
}

pub(crate) fn source_name(source: &Value) -> String {
    trim_json_string(source, "name")
}

pub(crate) fn source_base_url(source: &Value) -> String {
    trim_json_string(source, "baseURL")
}

pub(crate) fn source_api_key(source: &Value) -> String {
    trim_json_string(source, "apiKey")
}

pub(crate) fn source_model(source: &Value) -> String {
    trim_json_string(source, "model")
}

pub(crate) fn source_protocol(source: &Value) -> String {
    trim_json_string(source, "protocol")
}

pub(crate) fn source_preset_id(source: &Value) -> String {
    trim_json_string(source, "presetId")
}

pub(crate) fn source_is_official(source: &Value) -> bool {
    source_id(source).eq_ignore_ascii_case(OFFICIAL_SOURCE_ID)
        || source_preset_id(source).eq_ignore_ascii_case(OFFICIAL_PRESET_ID)
}

pub(crate) fn source_without_secrets(source: &Value) -> Value {
    let mut next = source.clone();
    if let Some(object) = next.as_object_mut() {
        object.remove("apiKey");
        object.remove("api_key");
        object.remove("key");
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !id.is_empty() && !object.contains_key("credentialRef") {
            object.insert("credentialRef".to_string(), json!(format!("settings:{id}")));
        }
    }
    next
}

pub(crate) fn official_plaintext_key(settings: &Value) -> Option<String> {
    official_ai_api_key_from_settings(settings)
        .or_else(|| {
            payload_string(settings, "redbox_auth_session_json")
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|session| {
                    payload_string(&session, "apiKey")
                        .or_else(|| payload_string(&session, "api_key"))
                })
        })
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn official_logged_in(settings: &Value) -> bool {
    payload_string(settings, "redbox_auth_session_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|session| {
            payload_string(&session, "accessToken")
                .or_else(|| payload_string(&session, "access_token"))
                .or_else(|| payload_string(&session, "refreshToken"))
                .or_else(|| payload_string(&session, "refresh_token"))
        })
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}
