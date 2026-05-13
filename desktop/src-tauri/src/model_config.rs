use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::runtime::{infer_protocol, resolve_chat_config};
use crate::{now_iso, payload_string};

const MODEL_CONFIG_FILE: &str = "model-config.json";
const MODEL_CONFIG_VERSION: u64 = 1;

const ROUTE_SCOPES: &[&str] = &[
    "chat",
    "wander",
    "team",
    "knowledge",
    "redclaw",
    "transcription",
    "embedding",
    "image",
    "video",
    "visualIndex",
    "videoAnalysis",
    "voiceTts",
    "voiceClone",
];

pub(crate) fn model_config_path(store_path: &Path) -> PathBuf {
    store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(MODEL_CONFIG_FILE)
}

fn parse_json_array_setting(settings: &Value, key: &str) -> Vec<Value> {
    payload_string(settings, key)
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn parse_json_object_setting(settings: &Value, key: &str) -> Value {
    payload_string(settings, key)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn value_string(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn provider_id(provider: &Value) -> String {
    value_string(provider, &["id"])
}

fn provider_key(provider: &Value) -> String {
    value_string(provider, &["apiKey", "key", "api_key"])
}

fn provider_without_secrets(provider: &Value) -> Value {
    let mut next = provider.clone();
    if let Some(object) = next.as_object_mut() {
        object.remove("apiKey");
        object.remove("key");
        object.remove("api_key");
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

fn merge_provider_secrets(providers: &[Value], existing_settings: &Value) -> Vec<Value> {
    let existing_sources = parse_json_array_setting(existing_settings, "ai_sources_json");
    let existing_keys: HashMap<String, String> = existing_sources
        .iter()
        .filter_map(|source| {
            let id = provider_id(source);
            let key = provider_key(source);
            (!id.is_empty() && !key.is_empty()).then_some((id, key))
        })
        .collect();

    providers
        .iter()
        .map(|provider| {
            let mut next = provider.clone();
            let id = provider_id(&next);
            if let (Some(object), Some(key)) = (next.as_object_mut(), existing_keys.get(&id)) {
                object.insert("apiKey".to_string(), json!(key));
            }
            next
        })
        .collect()
}

fn route_model(routes: &Value, key: &str) -> Option<String> {
    routes
        .get(key)
        .and_then(|route| route.get("model").or_else(|| route.get("modelName")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn route_source_id(routes: &Value, key: &str) -> Option<String> {
    routes
        .get(key)
        .and_then(|route| route.get("sourceId").or_else(|| route.get("source_id")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn source_by_id<'a>(sources: &'a [Value], id: &str) -> Option<&'a Value> {
    sources.iter().find(|source| provider_id(source) == id)
}

fn default_route(default_source_id: &str, model: &str) -> Value {
    json!({
        "mode": if default_source_id.is_empty() { "inherit" } else { "custom" },
        "sourceId": default_source_id,
        "model": model,
    })
}

fn default_routes(settings: &Value, default_source_id: &str) -> Value {
    let existing = parse_json_object_setting(settings, "ai_model_routes_json");
    if existing
        .as_object()
        .map(|object| !object.is_empty())
        .unwrap_or(false)
    {
        return existing;
    }

    let default_model = payload_string(settings, "model_name").unwrap_or_default();
    let mut routes = serde_json::Map::new();
    routes.insert(
        "chat".to_string(),
        default_route(default_source_id, &default_model),
    );
    routes.insert(
        "wander".to_string(),
        default_route(
            default_source_id,
            &payload_string(settings, "model_name_wander").unwrap_or_else(|| default_model.clone()),
        ),
    );
    routes.insert(
        "team".to_string(),
        default_route(
            default_source_id,
            &payload_string(settings, "model_name_chatroom")
                .unwrap_or_else(|| default_model.clone()),
        ),
    );
    routes.insert(
        "knowledge".to_string(),
        default_route(
            default_source_id,
            &payload_string(settings, "model_name_knowledge")
                .unwrap_or_else(|| default_model.clone()),
        ),
    );
    routes.insert(
        "redclaw".to_string(),
        default_route(
            default_source_id,
            &payload_string(settings, "model_name_redclaw").unwrap_or(default_model),
        ),
    );
    for (scope, setting_key) in [
        ("transcription", "transcription_model"),
        ("embedding", "embedding_model"),
        ("image", "image_model"),
        ("video", "video_model"),
        ("visualIndex", "visual_index_model"),
        ("videoAnalysis", "video_analysis_model"),
        ("voiceTts", "voice_tts_model"),
        ("voiceClone", "voice_clone_model"),
    ] {
        if let Some(model) = payload_string(settings, setting_key) {
            routes.insert(scope.to_string(), default_route(default_source_id, &model));
        }
    }
    Value::Object(routes)
}

pub(crate) fn settings_to_model_config(settings: &Value) -> Value {
    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let mut providers = parse_json_array_setting(settings, "ai_sources_json");
    if providers.is_empty() {
        let base_url = payload_string(settings, "api_endpoint").unwrap_or_default();
        let model = payload_string(settings, "model_name").unwrap_or_default();
        if !base_url.is_empty() || !model.is_empty() {
            let protocol = infer_protocol(&base_url, None, None);
            providers.push(json!({
                "id": if default_source_id.is_empty() { "default" } else { default_source_id.as_str() },
                "name": "Default",
                "presetId": "custom",
                "baseURL": base_url,
                "protocol": protocol,
                "model": model,
            }));
        }
    }

    json!({
        "version": MODEL_CONFIG_VERSION,
        "updatedAt": now_iso(),
        "defaults": {
            "sourceId": default_source_id,
        },
        "providers": providers.iter().map(provider_without_secrets).collect::<Vec<_>>(),
        "routes": default_routes(settings, &default_source_id),
        "modelOverrides": {},
    })
}

fn write_json_if_changed(path: &Path, value: &Value) -> Result<(), String> {
    let next = serde_json::to_string_pretty(value).map_err(|error| error.to_string())? + "\n";
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == next {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, next).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

pub(crate) fn sync_model_config_file(store_path: &Path, settings: &Value) -> Result<(), String> {
    write_json_if_changed(
        &model_config_path(store_path),
        &settings_to_model_config(settings),
    )
}

pub(crate) fn read_model_config_file(store_path: &Path, settings: &Value) -> Result<Value, String> {
    let path = model_config_path(store_path);
    if !path.exists() {
        let config = settings_to_model_config(settings);
        write_json_if_changed(&path, &config)?;
        return Ok(config);
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let config = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    validate_model_config(&config)?;
    Ok(config)
}

fn validate_model_config(config: &Value) -> Result<(), String> {
    if !config.is_object() {
        return Err("model-config.json must be a JSON object".to_string());
    }
    if !config
        .get("providers")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        return Err("model-config.json providers must be an array".to_string());
    }
    if !config.get("routes").map(Value::is_object).unwrap_or(false) {
        return Err("model-config.json routes must be an object".to_string());
    }
    Ok(())
}

pub(crate) fn apply_model_config_to_settings(config: &Value, settings: &mut Value) {
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let providers = merge_provider_secrets(&providers, settings);
    let routes = config.get("routes").cloned().unwrap_or_else(|| json!({}));
    let default_source_id = config
        .get("defaults")
        .and_then(|value| value.get("sourceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| route_source_id(&routes, "chat"))
        .or_else(|| providers.first().map(provider_id))
        .unwrap_or_default();

    let Some(object) = settings.as_object_mut() else {
        return;
    };
    object.insert(
        "ai_sources_json".to_string(),
        json!(serde_json::to_string(&providers).unwrap_or_else(|_| "[]".to_string())),
    );
    object.insert(
        "ai_model_routes_json".to_string(),
        json!(serde_json::to_string(&routes).unwrap_or_else(|_| "{}".to_string())),
    );
    object.insert(
        "default_ai_source_id".to_string(),
        json!(default_source_id.clone()),
    );

    if let Some(source) = source_by_id(&providers, &default_source_id).or_else(|| providers.first())
    {
        let base_url = value_string(source, &["baseURL", "baseUrl"]);
        let api_key = provider_key(source);
        let model = route_model(&routes, "chat")
            .unwrap_or_else(|| value_string(source, &["model", "modelName"]));
        object.insert("api_endpoint".to_string(), json!(base_url));
        object.insert("api_key".to_string(), json!(api_key));
        object.insert("model_name".to_string(), json!(model));
    }

    for (setting_key, route_key) in [
        ("model_name_wander", "wander"),
        ("model_name_chatroom", "team"),
        ("model_name_knowledge", "knowledge"),
        ("model_name_redclaw", "redclaw"),
        ("transcription_model", "transcription"),
        ("embedding_model", "embedding"),
        ("image_model", "image"),
        ("video_model", "video"),
        ("visual_index_model", "visualIndex"),
        ("video_analysis_model", "videoAnalysis"),
        ("voice_tts_model", "voiceTts"),
        ("voice_clone_model", "voiceClone"),
    ] {
        if let Some(model) = route_model(&routes, route_key) {
            object.insert(setting_key.to_string(), json!(model));
        }
    }
}

pub(crate) fn load_model_config_into_settings(
    store_path: &Path,
    settings: &mut Value,
) -> Result<(), String> {
    let config = read_model_config_file(store_path, settings)?;
    apply_model_config_to_settings(&config, settings);
    Ok(())
}

fn route_scope_from_runtime_mode(runtime_mode: &str) -> &str {
    match runtime_mode.trim() {
        "wander" => "wander",
        "knowledge" => "knowledge",
        "redclaw" => "redclaw",
        "team" | "chatroom" | "advisor-discussion" => "team",
        "transcription" | "embedding" | "image" | "video" | "visualIndex" | "videoAnalysis"
        | "voiceTts" | "voiceClone" => runtime_mode.trim(),
        _ => "chat",
    }
}

pub(crate) fn effective_model_config_value(settings: &Value, runtime_mode: Option<&str>) -> Value {
    let runtime_mode = runtime_mode.unwrap_or("chat");
    let scope = route_scope_from_runtime_mode(runtime_mode);
    let sources = parse_json_array_setting(settings, "ai_sources_json");
    let routes = parse_json_object_setting(settings, "ai_model_routes_json");
    let route = routes.get(scope).cloned().unwrap_or_else(|| json!({}));
    let source_id = route_source_id(&routes, scope)
        .or_else(|| payload_string(settings, "default_ai_source_id"))
        .unwrap_or_default();
    let source = source_by_id(&sources, &source_id).or_else(|| sources.first());
    let source_base_url = source
        .map(|item| value_string(item, &["baseURL", "baseUrl"]))
        .unwrap_or_default();
    let source_model = source
        .map(|item| value_string(item, &["model", "modelName"]))
        .unwrap_or_default();
    let source_protocol = source
        .map(|item| value_string(item, &["protocol"]))
        .unwrap_or_default();
    let model_name = route_model(&routes, scope).unwrap_or(source_model);
    let protocol = if source_protocol.is_empty() {
        infer_protocol(&source_base_url, None, None)
    } else {
        source_protocol
    };
    let key_present = source
        .map(|item| !provider_key(item).is_empty())
        .unwrap_or_else(|| {
            payload_string(settings, "api_key")
                .map(|key| !key.is_empty())
                .unwrap_or(false)
        });

    let resolved_chat = resolve_chat_config(
        settings,
        Some(&json!({
            "runtimeMode": scope,
            "baseURL": source_base_url,
            "modelName": model_name,
            "protocol": protocol,
        })),
    );

    json!({
        "runtimeMode": runtime_mode,
        "scope": scope,
        "provider": source.map(provider_without_secrets).unwrap_or(Value::Null),
        "sourceId": source_id,
        "baseURL": resolved_chat.as_ref().map(|item| item.base_url.clone()).unwrap_or(source_base_url),
        "protocol": resolved_chat.as_ref().map(|item| item.protocol.clone()).unwrap_or(protocol),
        "modelName": resolved_chat.as_ref().map(|item| item.model_name.clone()).unwrap_or(model_name),
        "reasoningEffort": resolved_chat.as_ref().and_then(|item| item.reasoning_effort.clone()),
        "apiKeyPresent": resolved_chat.as_ref().and_then(|item| item.api_key.as_ref()).map(|key| !key.trim().is_empty()).unwrap_or(key_present),
        "source": if route.is_object() { "route" } else { "default" },
    })
}

pub(crate) fn model_config_diagnostics_value(store_path: &Path, settings: &Value) -> Value {
    let path = model_config_path(store_path);
    let config = read_model_config_file(store_path, settings).unwrap_or_else(|error| {
        json!({
            "version": MODEL_CONFIG_VERSION,
            "error": error,
            "providers": [],
            "routes": {},
        })
    });
    let routes = config
        .get("routes")
        .and_then(Value::as_object)
        .map(|object| {
            ROUTE_SCOPES
                .iter()
                .filter_map(|scope| {
                    object.get(*scope).map(|route| {
                        json!({
                            "scope": scope,
                            "mode": route.get("mode").cloned().unwrap_or(Value::Null),
                            "sourceId": route.get("sourceId").or_else(|| route.get("source_id")).cloned().unwrap_or(Value::Null),
                            "model": route.get("model").or_else(|| route.get("modelName")).cloned().unwrap_or(Value::Null),
                        })
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "path": path.display().to_string(),
        "config": config,
        "routes": routes,
        "effective": ROUTE_SCOPES
            .iter()
            .map(|scope| effective_model_config_value(settings, Some(scope)))
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_to_model_config_strips_provider_secrets() {
        let settings = json!({
            "default_ai_source_id": "source-1",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "name": "Custom",
                "baseURL": "https://example.test/v1",
                "apiKey": "sk-secret",
                "model": "model-a",
                "protocol": "openai"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": { "mode": "custom", "sourceId": "source-1", "model": "model-a" }
            })).unwrap()
        });

        let config = settings_to_model_config(&settings);
        let provider = &config["providers"][0];

        assert_eq!(provider["id"], json!("source-1"));
        assert!(provider.get("apiKey").is_none());
        assert_eq!(provider["credentialRef"], json!("settings:source-1"));
    }

    #[test]
    fn apply_model_config_preserves_existing_provider_secret() {
        let mut settings = json!({
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "apiKey": "sk-secret"
            })]).unwrap()
        });
        let config = json!({
            "version": 1,
            "defaults": { "sourceId": "source-1" },
            "providers": [{
                "id": "source-1",
                "name": "Custom",
                "baseURL": "https://example.test/v1",
                "protocol": "openai",
                "model": "model-a"
            }],
            "routes": {
                "chat": { "mode": "custom", "sourceId": "source-1", "model": "model-b" }
            }
        });

        apply_model_config_to_settings(&config, &mut settings);

        assert_eq!(settings["api_endpoint"], json!("https://example.test/v1"));
        assert_eq!(settings["model_name"], json!("model-b"));
        assert_eq!(settings["api_key"], json!("sk-secret"));
        let sources = parse_json_array_setting(&settings, "ai_sources_json");
        assert_eq!(sources[0]["apiKey"], json!("sk-secret"));
    }

    #[test]
    fn effective_model_config_returns_redacted_route_result() {
        let settings = json!({
            "default_ai_source_id": "source-1",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "source-1",
                "name": "Custom",
                "baseURL": "https://example.test/v1",
                "apiKey": "sk-secret",
                "protocol": "openai",
                "model": "model-a"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": { "mode": "custom", "sourceId": "source-1", "model": "model-b" }
            })).unwrap()
        });

        let value = effective_model_config_value(&settings, Some("chat"));

        assert_eq!(value["modelName"], json!("model-b"));
        assert_eq!(value["baseURL"], json!("https://example.test/v1"));
        assert_eq!(value["apiKeyPresent"], json!(true));
        assert!(value["provider"].get("apiKey").is_none());
    }
}
