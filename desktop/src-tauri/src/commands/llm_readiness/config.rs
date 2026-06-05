use serde_json::{json, Value};

use crate::payload_string;

const OFFICIAL_SOURCE_ID: &str = "redbox_official_auto";
const OFFICIAL_PRESET_ID: &str = "redbox-official";

fn trim_json_string(value: &Value, key: &str) -> String {
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

fn source_id(source: &Value) -> String {
    trim_json_string(source, "id")
}

fn source_base_url(source: &Value) -> String {
    trim_json_string(source, "baseURL")
}

fn source_api_key(source: &Value) -> String {
    trim_json_string(source, "apiKey")
}

fn source_preset_id(source: &Value) -> String {
    trim_json_string(source, "presetId")
}

fn source_is_official(source: &Value) -> bool {
    source_id(source).eq_ignore_ascii_case(OFFICIAL_SOURCE_ID)
        || source_preset_id(source).eq_ignore_ascii_case(OFFICIAL_PRESET_ID)
}

fn settings_sources(settings: &Value) -> Vec<Value> {
    payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn settings_routes(settings: &Value) -> Value {
    payload_string(settings, "ai_model_routes_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

pub(crate) fn resolve_llm_readiness_from_settings(settings: &Value) -> Value {
    crate::ai_model_manager::AiModelManager::readiness_value(settings)
}

pub(crate) fn fallback_default_model(protocol: &str, preferred_model: &str) -> String {
    let preferred_model = preferred_model.trim();
    if !preferred_model.is_empty() {
        return preferred_model.to_string();
    }
    match protocol {
        "anthropic" => "claude-3-5-sonnet-latest",
        "gemini" => "gemini-1.5-pro",
        _ => "gpt-4o",
    }
    .to_string()
}

fn route_config(source_id: &str, model: &str) -> Value {
    json!({ "mode": "custom", "sourceId": source_id, "model": model })
}

pub(crate) fn merge_custom_source_settings(
    settings: &mut Value,
    new_source_id: &str,
    source_name: &str,
    preset_id: &str,
    base_url: &str,
    api_key: &str,
    protocol: &str,
    model: &str,
) -> Result<Value, String> {
    let mut sources = settings_sources(settings);
    let source = json!({
        "id": new_source_id,
        "name": source_name,
        "presetId": preset_id,
        "baseURL": base_url,
        "apiKey": api_key,
        "models": [model],
        "modelsMeta": [{ "id": model, "capabilities": ["chat"] }],
        "model": model,
        "protocol": protocol,
    });
    if let Some(existing) = sources
        .iter_mut()
        .find(|item| source_id(item).as_str() == new_source_id)
    {
        *existing = source.clone();
    } else if let Some(existing) = sources.iter_mut().find(|item| {
        !source_is_official(item)
            && normalize_base_url(&source_base_url(item)) == normalize_base_url(base_url)
            && source_api_key(item) == api_key
    }) {
        *existing = source.clone();
    } else {
        sources.push(source.clone());
    }

    let mut routes = settings_routes(settings);
    let object = routes
        .as_object_mut()
        .ok_or_else(|| "AI route settings are invalid".to_string())?;
    for scope in ["chat", "wander", "team", "knowledge", "redclaw"] {
        object.insert(scope.to_string(), route_config(new_source_id, model));
    }

    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "ai_sources_json".to_string(),
            json!(serde_json::to_string(&sources).map_err(|error| error.to_string())?),
        );
        object.insert("default_ai_source_id".to_string(), json!(new_source_id));
        object.insert("api_endpoint".to_string(), json!(base_url));
        object.insert("api_key".to_string(), json!(api_key));
        object.insert("model_name".to_string(), json!(model));
        object.insert("model_name_wander".to_string(), json!(model));
        object.insert("model_name_chatroom".to_string(), json!(model));
        object.insert("model_name_knowledge".to_string(), json!(model));
        object.insert("model_name_redclaw".to_string(), json!(model));
        object.insert(
            "ai_model_routes_json".to_string(),
            json!(serde_json::to_string(&routes).map_err(|error| error.to_string())?),
        );
    }
    Ok(source)
}
