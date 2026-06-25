use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;
use tauri::State;

use crate::ai_model_manager::{resolved_value_for_debug, AiModelManager, AiModelScope};
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::AppState;

fn redact_sensitive_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut next = Map::new();
            for (key, value) in object {
                let normalized = key.trim().to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "apikey" | "api_key" | "key" | "token" | "access_token" | "refresh_token"
                ) || normalized.contains("secret")
                    || normalized.contains("password")
                {
                    next.insert(key, json!("[redacted]"));
                } else {
                    next.insert(key, redact_sensitive_value(value));
                }
            }
            Value::Object(next)
        }
        Value::Array(items) => {
            Value::Array(items.into_iter().map(redact_sensitive_value).collect())
        }
        other => other,
    }
}

fn read_model_config_file_value(config_path: &Path) -> Value {
    if !config_path.exists() {
        return json!({
            "exists": false,
            "readable": false,
            "value": Value::Null,
            "error": Value::Null,
        });
    }
    match fs::read_to_string(config_path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value) => json!({
                "exists": true,
                "readable": true,
                "value": redact_sensitive_value(value),
                "error": Value::Null,
            }),
            Err(error) => json!({
                "exists": true,
                "readable": false,
                "value": Value::Null,
                "error": format!("invalid json: {error}"),
            }),
        },
        Err(error) => json!({
            "exists": true,
            "readable": false,
            "value": Value::Null,
            "error": error.to_string(),
        }),
    }
}

pub(crate) fn model_config_diagnostics_value(store_path: &Path, settings: &Value) -> Value {
    let config_path = crate::ai_model_manager::legacy_config::model_config_path(store_path);
    let snapshot = AiModelManager::snapshot(settings);
    let resolved_routes = AiModelScope::ALL
        .iter()
        .filter_map(|scope| {
            AiModelManager::resolve(settings, *scope, None)
                .map(|route| resolved_value_for_debug(&route))
        })
        .collect::<Vec<_>>();
    let file = read_model_config_file_value(&config_path);

    json!({
        "success": true,
        "updatedAt": crate::now_iso(),
        "configPath": config_path.display().to_string(),
        "modelConfigFile": file,
        "settings": {
            "defaultSourceId": settings
                .get("default_ai_source_id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "routesJsonPresent": settings
                .get("ai_model_routes_json")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
            "sourcesJsonPresent": settings
                .get("ai_sources_json")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
        },
        "snapshot": snapshot,
        "resolvedRoutes": resolved_routes,
    })
}

pub(crate) fn runtime_model_config_value(
    state: &State<'_, AppState>,
    _payload: &Value,
) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    Ok(model_config_diagnostics_value(&state.store_path, &settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diagnostics_redacts_file_secrets_and_reports_resolved_routes() {
        let temp_root = std::env::temp_dir().join(format!(
            "redbox-model-config-diagnostics-{}",
            std::process::id()
        ));
        let store_path = temp_root.join("redbox-state.json");
        fs::create_dir_all(&temp_root).unwrap();
        fs::write(
            temp_root.join("model-config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "providers": [{
                    "id": "source-1",
                    "apiKey": "sk-secret",
                    "model": "model-a"
                }],
                "routes": {
                    "chat": { "mode": "custom", "sourceId": "source-1", "model": "model-b" }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let settings = json!({
            "api_endpoint": "https://example.test/v1",
            "api_key": "sk-root",
            "model_name": "model-a",
            "default_ai_source_id": "source-1",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "baseURL": "https://example.test/v1",
                "apiKey": "sk-source",
                "model": "model-a",
                "protocol": "openai"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": { "mode": "custom", "sourceId": "source-1", "model": "model-b" }
            })).unwrap()
        });

        let value = model_config_diagnostics_value(&store_path, &settings);

        assert_eq!(value["success"], json!(true));
        assert_eq!(value["modelConfigFile"]["exists"], json!(true));
        assert_eq!(
            value["modelConfigFile"]["value"]["providers"][0]["apiKey"],
            json!("[redacted]")
        );
        assert_eq!(
            value["snapshot"]["providers"][0]["apiKeyPresent"],
            json!(true)
        );
        assert!(value["snapshot"]["providers"][0].get("apiKey").is_none());
        assert_eq!(value["resolvedRoutes"][0]["scope"], json!("chat"));
        assert_eq!(value["resolvedRoutes"][0]["modelName"], json!("model-b"));

        let _ = fs::remove_dir_all(temp_root);
    }
}
