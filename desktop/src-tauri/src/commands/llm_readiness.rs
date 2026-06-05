use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

mod config;

use crate::store::settings as settings_store;
use crate::{
    auth, infer_protocol, now_iso, now_ms, payload_string, refresh_runtime_warm_state, with_store,
    with_store_mut, AppState,
};
use config::{
    fallback_default_model, is_local_base_url, merge_custom_source_settings, normalize_base_url,
    resolve_llm_readiness_from_settings,
};

const DEFAULT_CUSTOM_PRESET_ID: &str = "custom";
const LLM_READINESS_CHANGED_EVENT: &str = "llm-readiness:state-changed";

fn get_readiness_state(state: &State<'_, AppState>) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
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

    let mut settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
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
        settings_store::replace_settings(store, settings);
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
