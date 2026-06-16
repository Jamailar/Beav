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

use crate::runtime::{ProviderWireApi, ResolvedChatConfig};
use crate::{
    infer_protocol, official_ai_api_key_from_settings, official_base_url_from_settings,
    payload_string,
};

pub(crate) use routes::{scope_for_runtime_mode, scope_for_tool_action};
pub(crate) use types::{
    AiModelManagerSnapshot, AiModelRoute, AiModelScope, AiProviderSource, AiReadiness,
    AiResolvedRoute,
};

use credentials::{
    is_local_base_url, normalize_base_url, official_plaintext_key, source_api_key, source_base_url,
    source_id, source_is_official, source_model, source_name, source_preset_id, source_protocol,
    source_wire_api, source_without_secrets,
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

fn override_string(value: Option<&Value>, keys: &[&str]) -> Option<String> {
    let value = value?;
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

fn scoped_endpoint_key(scope: AiModelScope) -> Option<&'static str> {
    match scope {
        AiModelScope::Transcription => Some("transcription_endpoint"),
        AiModelScope::Embedding => Some("embedding_endpoint"),
        AiModelScope::Image => Some("image_endpoint"),
        AiModelScope::Video => Some("video_endpoint"),
        AiModelScope::VisualIndex => Some("visual_index_endpoint"),
        AiModelScope::VideoAnalysis => Some("video_analysis_endpoint"),
        AiModelScope::VoiceTts | AiModelScope::VoiceClone => Some("voice_endpoint"),
        _ => None,
    }
}

fn scoped_api_key(scope: AiModelScope, settings: &Value) -> Option<String> {
    match scope {
        AiModelScope::Transcription => payload_string(settings, "transcription_key"),
        AiModelScope::Embedding => payload_string(settings, "embedding_key"),
        AiModelScope::Image => payload_string(settings, "image_api_key"),
        AiModelScope::Video => payload_string(settings, "video_api_key"),
        AiModelScope::VisualIndex => payload_string(settings, "visual_index_api_key"),
        AiModelScope::VideoAnalysis => payload_string(settings, "video_analysis_api_key"),
        AiModelScope::VoiceTts | AiModelScope::VoiceClone => {
            payload_string(settings, "voice_api_key")
                .or_else(|| payload_string(settings, "tts_api_key"))
        }
        _ => None,
    }
}

fn scoped_endpoint(scope: AiModelScope, settings: &Value) -> Option<String> {
    scoped_endpoint_key(scope)
        .and_then(|key| payload_string(settings, key))
        .or_else(|| {
            if matches!(scope, AiModelScope::VoiceTts | AiModelScope::VoiceClone) {
                payload_string(settings, "tts_endpoint")
            } else {
                None
            }
        })
        .or_else(|| payload_string(settings, "api_endpoint"))
}

fn scoped_model(scope: AiModelScope, settings: &Value) -> Option<String> {
    payload_string(settings, scope.legacy_model_key()).or_else(|| {
        if scope == AiModelScope::VoiceTts {
            payload_string(settings, "tts_model")
        } else {
            None
        }
    })
}

fn scope_allows_source_model_fallback(scope: AiModelScope) -> bool {
    matches!(
        scope,
        AiModelScope::Chat
            | AiModelScope::Wander
            | AiModelScope::Team
            | AiModelScope::Knowledge
            | AiModelScope::Redclaw
    )
}

fn route_source<'a>(
    sources: &'a [Value],
    route: &Value,
    default_source_id: &str,
) -> Option<&'a Value> {
    let mode = route
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if mode == "official" {
        return sources.iter().find(|source| source_is_official(source));
    }
    let explicit_source_id = route_source_id(route);
    if !explicit_source_id.is_empty() {
        if let Some(source) = sources
            .iter()
            .find(|source| source_id(source) == explicit_source_id)
        {
            return Some(source);
        }
    }
    if mode == "custom" {
        if let Some(source) = sources.iter().find(|source| !source_is_official(source)) {
            return Some(source);
        }
    }
    if !default_source_id.trim().is_empty() {
        if let Some(source) = sources
            .iter()
            .find(|source| source_id(source) == default_source_id.trim())
        {
            return Some(source);
        }
    }
    sources.first()
}

fn normalize_reasoning_effort(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "minimal" | "low" | "medium" | "high" => Some(normalized),
        _ => None,
    }
}

fn urls_match(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim().trim_end_matches('/').to_ascii_lowercase();
    !left.trim().is_empty() && normalize(left) == normalize(right)
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
        let sources = parse_json_array_setting(settings, "ai_sources_json");
        let routes = parse_json_object_setting(settings, "ai_model_routes_json");
        let route = routes
            .get(scope.as_str())
            .cloned()
            .unwrap_or_else(|| json!({}));
        if route
            .get("mode")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|mode| mode == "disabled")
        {
            return None;
        }
        let default_source_id =
            payload_string(settings, "default_ai_source_id").unwrap_or_default();
        let override_source_id = override_string(request_override, &["sourceId", "source_id"]);
        let source = override_source_id
            .as_deref()
            .and_then(|source_id_value| {
                sources
                    .iter()
                    .find(|source| source_id(source) == source_id_value)
            })
            .or_else(|| route_source(&sources, &route, &default_source_id))
            .cloned();
        let source_id_value = override_source_id
            .or_else(|| source.as_ref().map(source_id))
            .unwrap_or_default();
        let source_name_value = source.as_ref().map(source_name).unwrap_or_default();
        let preset_id = override_string(request_override, &["presetId", "preset_id"])
            .or_else(|| source.as_ref().map(source_preset_id))
            .unwrap_or_default();
        let source_base_url_value = source.as_ref().map(source_base_url).unwrap_or_default();
        let base_url = override_string(request_override, &["baseURL", "baseUrl", "base_url"])
            .or_else(|| (!source_base_url_value.is_empty()).then_some(source_base_url_value))
            .or_else(|| scoped_endpoint(scope, settings))
            .unwrap_or_default();
        let base_url = normalize_base_url(&base_url);
        let source_key = source.as_ref().map(source_api_key).unwrap_or_default();
        let is_official = source.as_ref().map(source_is_official).unwrap_or_else(|| {
            route_source_id(&route).eq_ignore_ascii_case(credentials::OFFICIAL_SOURCE_ID)
                || preset_id.eq_ignore_ascii_case(credentials::OFFICIAL_PRESET_ID)
                || urls_match(&base_url, &official_base_url_from_settings(settings))
        });
        let configured_api_key = override_string(request_override, &["apiKey", "api_key"])
            .or_else(|| (!source_key.is_empty()).then_some(source_key))
            .or_else(|| scoped_api_key(scope, settings))
            .or_else(|| payload_string(settings, "api_key"));
        let api_key = if is_official {
            official_ai_api_key_from_settings(settings)
                .or_else(|| official_plaintext_key(settings))
                .or(configured_api_key)
        } else {
            configured_api_key
        }
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
        let model_name = override_string(request_override, &["modelName", "model_name", "model"])
            .or_else(|| {
                let route_model = route_model(&route);
                (!route_model.is_empty()).then_some(route_model)
            })
            .or_else(|| scoped_model(scope, settings))
            .or_else(|| {
                scope_allows_source_model_fallback(scope)
                    .then(|| source.as_ref().map(source_model))
                    .flatten()
            })
            .unwrap_or_default();
        let source_protocol_value = source.as_ref().map(source_protocol).unwrap_or_default();
        let protocol = override_string(request_override, &["protocol"])
            .or_else(|| (!source_protocol_value.is_empty()).then_some(source_protocol_value))
            .unwrap_or_else(|| infer_protocol(&base_url, Some(&preset_id), None));
        let source_wire_api_value = source.as_ref().map(source_wire_api).unwrap_or_default();
        let wire_api = override_string(request_override, &["wireApi", "wire_api"])
            .or_else(|| (!source_wire_api_value.is_empty()).then_some(source_wire_api_value))
            .or_else(|| {
                route
                    .get("wireApi")
                    .or_else(|| route.get("wire_api"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .or_else(|| payload_string(settings, "wire_api"))
            .or_else(|| payload_string(settings, "wireApi"))
            .as_deref()
            .and_then(|value| ProviderWireApi::from_config(Some(value)))
            .unwrap_or_else(|| ProviderWireApi::infer(&protocol));
        let reasoning_effort = normalize_reasoning_effort(
            override_string(request_override, &["reasoningEffort", "reasoning_effort"])
                .or_else(|| payload_string(settings, "reasoning_effort"))
                .or_else(|| payload_string(settings, "reasoningEffort"))
                .as_deref(),
        );
        let mode = route
            .get("mode")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                if is_official {
                    "official".to_string()
                } else if is_local_base_url(&base_url) {
                    "local".to_string()
                } else {
                    "custom".to_string()
                }
            });

        Some(AiResolvedRoute {
            scope: scope.as_str().to_string(),
            mode,
            source_id: source_id_value,
            source_name: source_name_value,
            preset_id,
            base_url,
            api_key,
            model_name,
            protocol,
            wire_api,
            reasoning_effort,
            provider_template: override_string(
                request_override,
                &["providerTemplate", "provider_template"],
            )
            .or_else(|| payload_string(settings, "image_provider_template")),
            provider: override_string(request_override, &["provider"])
                .or_else(|| payload_string(settings, "image_provider")),
            is_official,
            is_local: false,
            source: source
                .as_ref()
                .map(source_without_secrets)
                .unwrap_or(Value::Null),
        })
        .map(|mut route| {
            route.is_local = is_local_base_url(&route.base_url);
            route
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
