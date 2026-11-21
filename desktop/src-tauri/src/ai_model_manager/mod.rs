mod credentials;
pub(crate) mod defaults;
pub(crate) mod legacy_config;
pub(crate) mod legacy_projection;
mod official_sync;
mod readiness;
mod routes;
pub(crate) mod store;
mod types;

use serde_json::{json, Value};
use std::path::Path;

use crate::payload_string;
use crate::runtime::ResolvedChatConfig;

pub(crate) use routes::{scope_for_runtime_mode, scope_for_tool_action};
pub(crate) use types::{
    AiModelManagerSnapshot, AiModelRoute, AiModelScope, AiProviderSource, AiReadiness,
    AiResolvedRoute,
};

use credentials::{
    is_local_base_url, source_api_key, source_base_url, source_id, source_is_official,
    source_model, source_name, source_preset_id, source_protocol, source_wire_api,
};

pub(crate) struct AiModelManager;

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

fn route_source_id(route: &Value) -> String {
    route
        .get("sourceId")
        .or_else(|| route.get("source_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn route_model(route: &Value) -> String {
    route
        .get("model")
        .or_else(|| route.get("modelName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

impl AiModelManager {
    pub(crate) fn snapshot(settings: &Value) -> AiModelManagerSnapshot {
        let sources = parse_json_array_setting(settings, "ai_sources_json");
        let routes_value = parse_json_object_setting(settings, "ai_model_routes_json");
        let providers = sources
            .iter()
            .map(|source| AiProviderSource {
                id: source_id(source),
                name: source_name(source),
                preset_id: source_preset_id(source),
                base_url: source_base_url(source),
                protocol: source_protocol(source),
                wire_api: source_wire_api(source),
                model: source_model(source),
                api_key_present: !source_api_key(source).is_empty(),
                is_official: source_is_official(source),
                is_local: is_local_base_url(&source_base_url(source)),
            })
            .collect::<Vec<_>>();
        let routes = AiModelScope::ALL
            .iter()
            .filter_map(|scope| {
                let route = routes_value.get(scope.as_str())?;
                Some(AiModelRoute {
                    scope: scope.as_str().to_string(),
                    mode: route
                        .get("mode")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    source_id: route_source_id(route),
                    model: route_model(route),
                })
            })
            .collect::<Vec<_>>();
        let readiness = Self::readiness(settings);
        AiModelManagerSnapshot {
            providers,
            routes,
            readiness,
            updated_at: crate::now_iso(),
        }
    }

    pub(crate) fn resolve(
        settings: &Value,
        scope: AiModelScope,
        request_override: Option<&Value>,
    ) -> Option<AiResolvedRoute> {
        let resolved = crate::provider_runtime::resolve_provider_request(
            settings,
            crate::provider_runtime::CapabilityScope::from_route_scope(scope.as_str()),
            request_override,
        )?;
        Some(AiResolvedRoute {
            scope: resolved.scope.as_str().to_string(),
            mode: resolved.mode.as_str().to_string(),
            source_id: resolved.source_id,
            source_name: resolved.source_name,
            preset_id: resolved.preset_id,
            provider_key: resolved.provider_key,
            adapter_key: resolved.adapter_key,
            base_url: resolved.base_url,
            api_key: resolved.api_key,
            model_name: resolved.model,
            protocol: resolved.protocol,
            wire_api: resolved.wire_api,
            reasoning_effort: resolved.reasoning_effort,
            provider_template: resolved.provider_template,
            provider: resolved.provider,
            is_official: resolved.is_official,
            is_local: resolved.is_local,
            source: resolved.source,
        })
    }

    pub(crate) fn resolve_for_runtime(
        settings: &Value,
        runtime_mode: Option<&str>,
        request_override: Option<&Value>,
    ) -> Option<AiResolvedRoute> {
        Self::resolve(
            settings,
            scope_for_runtime_mode(runtime_mode),
            request_override,
        )
    }

    pub(crate) fn resolve_for_tool(
        settings: &Value,
        action: &str,
        payload: Option<&Value>,
    ) -> Option<AiResolvedRoute> {
        Self::resolve(settings, scope_for_tool_action(action), payload)
    }

    pub(crate) fn readiness(settings: &Value) -> AiReadiness {
        readiness::readiness_from_resolved(
            settings,
            Self::resolve(settings, AiModelScope::Chat, None),
        )
    }

    pub(crate) fn readiness_value(settings: &Value) -> Value {
        readiness::readiness_to_value(Self::readiness(settings))
    }

    pub(crate) fn resolve_chat_config(
        settings: &Value,
        model_config: Option<&Value>,
    ) -> Option<ResolvedChatConfig> {
        let runtime_mode = model_config.and_then(|value| {
            value
                .get("runtimeMode")
                .or_else(|| value.get("runtime_mode"))
                .and_then(Value::as_str)
        });
        let resolved = Self::resolve_for_runtime(settings, runtime_mode, model_config)?;
        if resolved.base_url.trim().is_empty() || resolved.model_name.trim().is_empty() {
            return None;
        }
        Some(ResolvedChatConfig {
            protocol: resolved.protocol,
            wire_api: resolved.wire_api,
            base_url: resolved.base_url,
            api_key: resolved.api_key,
            model_name: resolved.model_name,
            reasoning_effort: resolved.reasoning_effort,
        })
    }

    pub(crate) fn apply_settings_patch(
        store_path: &Path,
        settings: &mut Value,
    ) -> Result<(), String> {
        legacy_projection::sync_projection_file(store_path, settings)
    }
}

pub(crate) fn resolved_value_for_debug(route: &AiResolvedRoute) -> Value {
    json!({
        "scope": route.scope,
        "mode": route.mode,
        "sourceId": route.source_id,
        "sourceName": route.source_name,
        "presetId": route.preset_id,
        "providerKey": route.provider_key,
        "adapterKey": route.adapter_key,
        "baseURL": route.base_url,
        "modelName": route.model_name,
        "protocol": route.protocol,
        "wireApi": route.wire_api.as_str(),
        "apiKeyPresent": route.api_key.as_deref().map(|key| !key.trim().is_empty()).unwrap_or(false),
        "provider": route.provider,
        "providerTemplate": route.provider_template,
        "isOfficial": route.is_official,
        "isLocal": route.is_local,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::ProviderWireApi;

    fn routed_settings(route: Value) -> Value {
        json!({
            "api_endpoint": "https://custom.example/v1",
            "api_key": "sk-root",
            "model_name": "custom-default",
            "default_ai_source_id": "custom-source",
            "ai_sources_json": serde_json::to_string(&vec![
                json!({
                    "id": "redbox_official_auto",
                    "presetId": "redbox-official",
                    "baseURL": "https://api.ziz.hk/redbox/v1",
                    "apiKey": "",
                    "model": "official-model",
                    "protocol": "openai"
                }),
                json!({
                    "id": "custom-source",
                    "presetId": "openai",
                    "baseURL": "https://custom.example/v1",
                    "apiKey": "sk-custom",
                    "model": "custom-model",
                    "protocol": "openai"
                })
            ]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "redclaw": route
            })).unwrap()
        })
    }

    #[test]
    fn resolves_official_route_by_mode() {
        let settings = routed_settings(json!({
            "mode": "official",
            "sourceId": "custom-source",
            "model": "official-route-model"
        }));
        let route = AiModelManager::resolve(&settings, AiModelScope::Redclaw, None).unwrap();
        assert_eq!(route.base_url, "https://api.ziz.hk/redbox/v1");
        assert_eq!(route.model_name, "official-route-model");
        assert!(route.is_official);
    }

    #[test]
    fn resolves_custom_route_by_explicit_source() {
        let settings = routed_settings(json!({
            "mode": "custom",
            "sourceId": "custom-source",
            "model": "custom-route-model"
        }));
        let route = AiModelManager::resolve(&settings, AiModelScope::Redclaw, None).unwrap();
        assert_eq!(route.base_url, "https://custom.example/v1");
        assert_eq!(route.api_key.as_deref(), Some("sk-custom"));
        assert_eq!(route.model_name, "custom-route-model");
    }

    #[test]
    fn snapshot_redacts_provider_secrets() {
        let settings = routed_settings(json!({
            "mode": "custom",
            "sourceId": "custom-source",
            "model": "custom-route-model"
        }));
        let route = AiModelManager::resolve(&settings, AiModelScope::Redclaw, None).unwrap();
        assert!(route.source.get("apiKey").is_none());
        assert_eq!(
            route.source.get("credentialRef").and_then(Value::as_str),
            Some("settings:custom-source")
        );
    }

    #[test]
    fn specialized_scopes_do_not_fallback_to_provider_chat_model() {
        let settings = json!({
            "api_endpoint": "https://custom.example/v1",
            "api_key": "sk-root",
            "model_name": "chat-default",
            "default_ai_source_id": "custom-source",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "baseURL": "https://custom.example/v1",
                "apiKey": "sk-custom",
                "model": "provider-chat-model",
                "protocol": "openai"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({})).unwrap()
        });

        for scope in [
            AiModelScope::Transcription,
            AiModelScope::Embedding,
            AiModelScope::Image,
            AiModelScope::Video,
            AiModelScope::VisualIndex,
            AiModelScope::VideoAnalysis,
            AiModelScope::VoiceTts,
            AiModelScope::VoiceClone,
        ] {
            let route = AiModelManager::resolve(&settings, scope, None).unwrap();
            assert_eq!(route.model_name, "", "scope {:?}", scope);
        }
    }

    #[test]
    fn chat_scopes_can_still_fallback_to_provider_default_model() {
        let settings = json!({
            "api_endpoint": "https://custom.example/v1",
            "default_ai_source_id": "custom-source",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "baseURL": "https://custom.example/v1",
                "model": "provider-chat-model",
                "protocol": "openai"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({})).unwrap()
        });

        let route = AiModelManager::resolve(&settings, AiModelScope::Chat, None).unwrap();
        assert_eq!(route.model_name, "provider-chat-model");
    }

    #[test]
    fn chat_route_source_wins_over_legacy_default_source() {
        let settings = json!({
            "api_endpoint": "https://api.ziz.hk/redbox/v1",
            "default_ai_source_id": "redbox_official_auto",
            "ai_sources_json": serde_json::to_string(&vec![
                json!({
                    "id": "redbox_official_auto",
                    "presetId": "redbox-official",
                    "baseURL": "https://api.ziz.hk/redbox/v1",
                    "model": "official-model",
                    "protocol": "openai"
                }),
                json!({
                    "id": "custom-source",
                    "baseURL": "https://custom.example/v1",
                    "apiKey": "sk-custom",
                    "model": "custom-source-model",
                    "protocol": "openai"
                })
            ]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "chat": {
                    "mode": "custom",
                    "sourceId": "custom-source",
                    "model": "custom-chat-model"
                }
            })).unwrap()
        });

        let route = AiModelManager::resolve(&settings, AiModelScope::Chat, None).unwrap();

        assert_eq!(route.source_id, "custom-source");
        assert_eq!(route.base_url, "https://custom.example/v1");
        assert_eq!(route.api_key.as_deref(), Some("sk-custom"));
        assert_eq!(route.model_name, "custom-chat-model");
        assert!(!route.is_official);
    }

    #[test]
    fn official_image_route_rejects_stale_custom_model() {
        let settings = json!({
            "default_ai_source_id": "redbox_official_auto",
            "image_model": "gemini-3-pro-image-preview",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "redbox_official_auto",
                "presetId": "redbox-official",
                "baseURL": "https://api.ziz.hk/redbox/v1",
                "apiKey": "",
                "model": "qwen3.5-plus",
                "models": ["qwen3.5-plus", "gpt-image-2"],
                "modelsMeta": [
                    { "id": "qwen3.5-plus", "capabilities": ["chat"] },
                    { "id": "gpt-image-2", "capabilities": ["image"] }
                ],
                "protocol": "openai"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({
                "image": {
                    "mode": "official",
                    "sourceId": "redbox_official_auto",
                    "model": "gemini-3-pro-image-preview"
                }
            })).unwrap()
        });

        let route = AiModelManager::resolve(&settings, AiModelScope::Image, None).unwrap();

        assert!(route.is_official);
        assert_eq!(route.model_name, "gpt-image-2");
    }

    #[test]
    fn resolve_chat_config_tracks_explicit_wire_api() {
        let settings = json!({
            "api_endpoint": "https://custom.example/v1",
            "default_ai_source_id": "custom-source",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "baseURL": "https://api.openai.com/v1",
                "model": "gpt-5",
                "protocol": "openai",
                "wireApi": "chatCompat"
            })]).unwrap(),
            "ai_model_routes_json": serde_json::to_string(&json!({})).unwrap()
        });

        let config = AiModelManager::resolve_chat_config(
            &settings,
            Some(&json!({ "wireApi": "responses" })),
        )
        .unwrap();

        assert_eq!(config.wire_api, ProviderWireApi::Responses);
    }

    #[test]
    fn resolve_chat_config_defaults_wire_api_by_endpoint() {
        let official = json!({
            "api_endpoint": "https://api.openai.com/v1",
            "api_key": "sk-test",
            "model_name": "gpt-5"
        });
        let compat = json!({
            "api_endpoint": "https://gateway.example.com/v1",
            "api_key": "sk-test",
            "model_name": "gpt-5"
        });

        assert_eq!(
            AiModelManager::resolve_chat_config(&official, None)
                .unwrap()
                .wire_api,
            ProviderWireApi::Responses
        );
        assert_eq!(
            AiModelManager::resolve_chat_config(&compat, None)
                .unwrap()
                .wire_api,
            ProviderWireApi::ChatCompat
        );
    }

    #[test]
    fn maps_all_runtime_scopes() {
        assert_eq!(
            scope_for_runtime_mode(Some("visualIndex")),
            AiModelScope::VisualIndex
        );
        assert_eq!(
            scope_for_runtime_mode(Some("videoAnalysis")),
            AiModelScope::VideoAnalysis
        );
        assert_eq!(
            scope_for_runtime_mode(Some("voiceTts")),
            AiModelScope::VoiceTts
        );
        assert_eq!(scope_for_runtime_mode(Some("unknown")), AiModelScope::Chat);
    }
}
