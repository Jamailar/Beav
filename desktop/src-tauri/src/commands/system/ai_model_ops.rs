use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::State;

pub(super) fn snapshot(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings = settings_store::settings_snapshot(&store);
        let projected = crate::auth::project_settings_for_runtime(&settings, &runtime);
        serde_json::to_value(crate::ai_model_manager::AiModelManager::snapshot(
            &projected,
        ))
        .map_err(|error| error.to_string())
    })
}

pub(super) fn resolve(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let runtime_mode =
        payload_string(payload, "runtimeMode").or_else(|| payload_string(payload, "runtime_mode"));
    let scope = payload_string(payload, "scope");
    let action = payload_string(payload, "action");
    with_store(state, |store| {
        let runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings = settings_store::settings_snapshot(&store);
        let projected = crate::auth::project_settings_for_runtime(&settings, &runtime);
        let resolved = if let Some(action) = action.as_deref() {
            crate::ai_model_manager::AiModelManager::resolve_for_tool(
                &projected,
                action,
                Some(payload),
            )
        } else {
            let scope = scope
                .as_deref()
                .map(crate::ai_model_manager::AiModelScope::from_route_scope)
                .unwrap_or_else(|| {
                    crate::ai_model_manager::scope_for_runtime_mode(runtime_mode.as_deref())
                });
            crate::ai_model_manager::AiModelManager::resolve(&projected, scope, Some(payload))
        };
        Ok(resolved
            .as_ref()
            .map(crate::ai_model_manager::resolved_value_for_debug)
            .unwrap_or_else(|| json!({ "success": false, "error": "unresolved" })))
    })
}

pub(super) fn fetch_models(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let projected_settings = with_store(state, |store| {
        let runtime = state
            .auth_runtime
            .lock()
            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
        let settings = settings_store::settings_snapshot(&store);
        Ok(crate::auth::project_settings_for_runtime(
            &settings, &runtime,
        ))
    })?;

    let input = match build_fetch_models_input(&projected_settings, payload) {
        Ok(input) => input,
        Err(error) => {
            return Ok(json!({
                "success": false,
                "models": [],
                "attemptedUrls": [],
                "resolvedUrl": null,
                "error": error,
            }));
        }
    };
    match crate::provider_runtime::fetch_models_blocking(input) {
        Ok(report) => serde_json::to_value(report).map_err(|error| error.to_string()),
        Err(error) => Ok(json!({
            "success": false,
            "models": [],
            "attemptedUrls": [],
            "resolvedUrl": null,
            "error": error,
        })),
    }
}

fn build_fetch_models_input(
    settings: &Value,
    payload: &Value,
) -> Result<crate::provider_runtime::FetchModelsInput, String> {
    let scope = payload_string(payload, "scope")
        .map(|value| crate::provider_runtime::CapabilityScope::from_route_scope(&value))
        .unwrap_or(crate::provider_runtime::CapabilityScope::Chat);
    let source_id = payload_string(payload, "sourceId")
        .or_else(|| payload_string(payload, "source_id"))
        .unwrap_or_default();
    let sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let source = sources
        .iter()
        .find(|source| source_string(source, "id") == source_id)
        .cloned();
    let resolved =
        crate::provider_runtime::resolve_provider_request(settings, scope, Some(payload));
    let base_url = payload_string(payload, "baseURL")
        .or_else(|| payload_string(payload, "baseUrl"))
        .or_else(|| payload_string(payload, "base_url"))
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "baseURL"))
        })
        .or_else(|| resolved.as_ref().map(|route| route.base_url.clone()))
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Base URL is required to fetch models".to_string())?;
    let api_key = payload_string(payload, "apiKey")
        .or_else(|| payload_string(payload, "api_key"))
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "apiKey"))
        })
        .or_else(|| resolved.as_ref().and_then(|route| route.api_key.clone()))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "API Key is required to fetch models".to_string())?;
    let preset_id = payload_string(payload, "presetId")
        .or_else(|| payload_string(payload, "preset_id"))
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "presetId"))
        })
        .or_else(|| resolved.as_ref().map(|route| route.preset_id.clone()))
        .unwrap_or_default();
    let protocol = payload_string(payload, "protocol")
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "protocol"))
        })
        .or_else(|| resolved.as_ref().map(|route| route.protocol.clone()))
        .unwrap_or_else(|| crate::infer_protocol(&base_url, Some(&preset_id), None));
    let provider_key = payload_string(payload, "providerKey")
        .or_else(|| payload_string(payload, "provider_key"))
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "providerKey"))
        })
        .or_else(|| resolved.as_ref().map(|route| route.provider_key.clone()))
        .unwrap_or_else(|| {
            crate::provider_runtime::provider_key_from_parts(None, &preset_id, &protocol, &base_url)
        });
    let catalog =
        crate::provider_runtime::catalog_entry_for(&provider_key, &preset_id, &protocol, &base_url);
    let models_url_override = payload_string(payload, "modelsUrl")
        .or_else(|| payload_string(payload, "models_url"))
        .or_else(|| payload_string(payload, "modelListOverrideUrl"))
        .or_else(|| payload_string(payload, "model_list_override_url"))
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "modelsUrl"))
        })
        .filter(|value| !value.trim().is_empty());
    let user_agent = payload_string(payload, "userAgent")
        .or_else(|| payload_string(payload, "user_agent"))
        .or_else(|| {
            source
                .as_ref()
                .map(|source| source_string(source, "userAgent"))
        })
        .filter(|value| !value.trim().is_empty());
    let is_full_url = payload
        .get("isFullUrl")
        .or_else(|| payload.get("is_full_url"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(crate::provider_runtime::FetchModelsInput {
        base_url,
        api_key,
        is_full_url,
        models_url_override,
        user_agent,
        auth_strategy: catalog.auth_strategy,
        endpoint_policy: catalog.endpoint_policy,
    })
}

fn source_string(source: &Value, key: &str) -> String {
    source
        .get(key)
        .or_else(|| source.get(to_snake_key(key).as_str()))
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
