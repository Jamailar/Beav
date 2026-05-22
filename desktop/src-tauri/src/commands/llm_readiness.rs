use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::{
    auth, infer_protocol, now_iso, now_ms, payload_string, refresh_runtime_warm_state, with_store,
    with_store_mut, AppState,
};

const OFFICIAL_SOURCE_ID: &str = "redbox_official_auto";
const OFFICIAL_PRESET_ID: &str = "redbox-official";
const DEFAULT_CUSTOM_PRESET_ID: &str = "custom";
const LLM_READINESS_CHANGED_EVENT: &str = "llm-readiness:state-changed";

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

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn is_local_base_url(value: &str) -> bool {
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

fn fallback_default_model(protocol: &str, preferred_model: &str) -> String {
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

fn merge_custom_source_settings(
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

fn get_readiness_state(state: &State<'_, AppState>) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let runtime = state
        .auth_runtime
        .lock()
        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
    let projected = auth::project_settings_for_runtime(&settings, &runtime);
    Ok(resolve_llm_readiness_from_settings(&projected))
}

fn configure_custom_source(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let base_url = normalize_base_url(&payload_string(payload, "baseURL").unwrap_or_default());
    let api_key = payload_string(payload, "apiKey").unwrap_or_default();
    let preset_id =
        payload_string(payload, "presetId").unwrap_or_else(|| DEFAULT_CUSTOM_PRESET_ID.to_string());
    let explicit_protocol = payload_string(payload, "protocol");
    let preferred_model = payload_string(payload, "preferredModel").unwrap_or_default();
    if base_url.is_empty() {
        return Ok(json!({ "success": false, "error": "请先填写 API Base URL" }));
    }
    if api_key.trim().is_empty() && !is_local_base_url(&base_url) {
        return Ok(json!({ "success": false, "error": "请先填写 API Key" }));
    }
    let protocol = infer_protocol(&base_url, Some(&preset_id), explicit_protocol.as_deref());
    let model = fallback_default_model(&protocol, &preferred_model);
    let source_id = format!("ai-source-{}", now_ms());
    let source_name = payload_string(payload, "name").unwrap_or_else(|| {
        if is_local_base_url(&base_url) {
            "Local LLM".to_string()
        } else {
            "Custom API".to_string()
        }
    });

    let mut settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let source = merge_custom_source_settings(
        &mut settings,
        &source_id,
        &source_name,
        &preset_id,
        &base_url,
        api_key.trim(),
        &protocol,
        &model,
    )?;
    crate::ai_model_manager::AiModelManager::apply_settings_patch(
        &state.store_path,
        &mut settings,
    )?;
    with_store_mut(state, |store| {
        store.settings = settings.clone();
        Ok(())
    })?;
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
    let readiness = get_readiness_state(state)?;
    let _ = app.emit(
        "settings:updated",
        json!({ "updatedAt": now_iso(), "source": "llm-readiness-custom-source" }),
    );
    let _ = app.emit(LLM_READINESS_CHANGED_EVENT, readiness.clone());
    Ok(json!({
        "success": true,
        "source": {
            "id": source_id,
            "name": source_name,
            "presetId": preset_id,
            "baseURL": base_url,
            "model": model,
            "protocol": protocol,
        },
        "models": [{ "id": model, "capabilities": ["chat"] }],
        "readiness": readiness,
        "savedSource": source,
    }))
}

pub fn handle_llm_readiness_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "llm-readiness:get-state"
            | "llm-readiness:refresh"
            | "llm-readiness:configure-custom-source"
    ) {
        return None;
    }
    Some(match channel {
        "llm-readiness:get-state" | "llm-readiness:refresh" => {
            get_readiness_state(state).map(|snapshot| {
                let _ = app.emit(LLM_READINESS_CHANGED_EVENT, snapshot.clone());
                snapshot
            })
        }
        "llm-readiness:configure-custom-source" => configure_custom_source(app, state, payload),
        _ => unreachable!(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_source_ready() {
        let settings = json!({
            "default_ai_source_id": "source-1",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "name": "Custom",
                "baseURL": "https://api.openai.com/v1",
                "apiKey": "sk-test",
                "model": "gpt-4.1",
                "protocol": "openai"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": { "mode": "custom", "sourceId": "source-1", "model": "gpt-4.1" }
            })).unwrap()
        });
        let snapshot = resolve_llm_readiness_from_settings(&settings);
        assert_eq!(snapshot.get("ready").and_then(Value::as_bool), Some(true));
        assert_eq!(snapshot.get("mode").and_then(Value::as_str), Some("custom"));
    }

    #[test]
    fn remote_source_requires_key() {
        let settings = json!({
            "default_ai_source_id": "source-1",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "name": "Custom",
                "baseURL": "https://api.openai.com/v1",
                "apiKey": "",
                "model": "gpt-4.1",
                "protocol": "openai"
            })]).unwrap()
        });
        let snapshot = resolve_llm_readiness_from_settings(&settings);
        assert_eq!(snapshot.get("ready").and_then(Value::as_bool), Some(false));
        assert_eq!(
            snapshot.get("reason").and_then(Value::as_str),
            Some("missing_api_key")
        );
    }

    #[test]
    fn local_source_allows_empty_key() {
        let settings = json!({
            "default_ai_source_id": "source-1",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "name": "Ollama",
                "baseURL": "http://127.0.0.1:11434/v1",
                "apiKey": "",
                "model": "llama3",
                "protocol": "openai"
            })]).unwrap()
        });
        let snapshot = resolve_llm_readiness_from_settings(&settings);
        assert_eq!(snapshot.get("ready").and_then(Value::as_bool), Some(true));
        assert_eq!(snapshot.get("mode").and_then(Value::as_str), Some("local"));
    }
}
