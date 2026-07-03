use serde_json::{json, Value};

use crate::runtime::ProviderWireApi;
use crate::{
    infer_protocol, official_ai_api_key_from_settings, official_base_url_from_settings,
    payload_string,
};

use super::catalog::{adapter_key_for, catalog_entry_for, provider_key_from_parts};
use super::{CapabilityScope, ResolvedProviderRequest, RouteMode};

pub(crate) fn resolve_provider_request(
    settings: &Value,
    scope: CapabilityScope,
    request_override: Option<&Value>,
) -> Option<ResolvedProviderRequest> {
    let sources = parse_json_array_setting(settings, "ai_sources_json");
    let routes = parse_json_object_setting(settings, "ai_model_routes_json");
    let route = routes
        .get(scope.as_str())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if route_mode(&route) == Some(RouteMode::Disabled) {
        return None;
    }

    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
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
        route_source_id(&route).eq_ignore_ascii_case(OFFICIAL_SOURCE_ID)
            || preset_id.eq_ignore_ascii_case(OFFICIAL_PRESET_ID)
            || urls_match(&base_url, &official_base_url_from_settings(settings))
    });
    let configured_api_key = override_string(request_override, &["apiKey", "api_key"])
        .or_else(|| (!source_key.is_empty()).then_some(source_key))
        .or_else(|| scoped_api_key(scope, settings))
        .or_else(|| payload_string(settings, "api_key"));
    let api_key = if is_official {
        official_plaintext_key(settings).or(configured_api_key)
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
            scope
                .allows_source_model_fallback()
                .then(|| source.as_ref().map(source_model))
                .flatten()
        })
        .unwrap_or_default();
    let model_name = sanitize_model_for_source_scope(scope, source.as_ref(), &model_name);

    let source_protocol_value = source.as_ref().map(source_protocol).unwrap_or_default();
    let protocol = override_string(request_override, &["protocol"])
        .or_else(|| {
            route
                .get("protocol")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| (!source_protocol_value.is_empty()).then_some(source_protocol_value))
        .unwrap_or_else(|| infer_protocol(&base_url, Some(&preset_id), None));
    let source_wire_api_value = source.as_ref().map(source_wire_api).unwrap_or_default();
    let wire_api = override_string(request_override, &["wireApi", "wire_api"])
        .or_else(|| route_string(&route, &["wireApi", "wire_api"]))
        .or_else(|| (!source_wire_api_value.is_empty()).then_some(source_wire_api_value))
        .or_else(|| payload_string(settings, "wire_api"))
        .or_else(|| payload_string(settings, "wireApi"))
        .as_deref()
        .and_then(|value| ProviderWireApi::from_config(Some(value)))
        .unwrap_or_else(|| ProviderWireApi::infer_for_endpoint(&protocol, &base_url));
    let reasoning_effort = normalize_reasoning_effort(
        override_string(request_override, &["reasoningEffort", "reasoning_effort"])
            .or_else(|| route_string(&route, &["reasoningEffort", "reasoning_effort"]))
            .or_else(|| payload_string(settings, "reasoning_effort"))
            .or_else(|| payload_string(settings, "reasoningEffort"))
            .as_deref(),
    );
    let mode = route_mode(&route).unwrap_or_else(|| {
        if is_official {
            RouteMode::Official
        } else if is_local_base_url(&base_url) {
            RouteMode::Local
        } else {
            RouteMode::Custom
        }
    });
    let provider_template =
        override_string(request_override, &["providerTemplate", "provider_template"])
            .or_else(|| payload_string(settings, "image_provider_template"));
    let provider = override_string(request_override, &["provider"])
        .or_else(|| payload_string(settings, "image_provider"));
    let source_provider_key = source.as_ref().and_then(|source| {
        route_string(source, &["providerKey", "provider_key"])
            .or_else(|| route_string(source, &["provider"]))
    });
    let provider_key = provider_key_from_parts(
        source_provider_key.as_deref(),
        &preset_id,
        &protocol,
        &base_url,
    );
    let catalog = catalog_entry_for(&provider_key, &preset_id, &protocol, &base_url);
    let adapter_key = adapter_key_for(scope, wire_api, provider_template.as_deref());

    Some(ResolvedProviderRequest {
        scope,
        mode,
        source_id: source_id_value,
        source_name: source_name_value,
        provider_key,
        preset_id,
        base_url: base_url.clone(),
        api_key,
        model: model_name,
        protocol,
        wire_api,
        reasoning_effort,
        adapter_key,
        endpoint_policy: catalog.endpoint_policy,
        auth_strategy: catalog.auth_strategy,
        quirks: catalog.quirks,
        provider_template,
        provider,
        is_official,
        is_local: is_local_base_url(&base_url),
        source: source
            .as_ref()
            .map(source_without_secrets)
            .unwrap_or(Value::Null),
    })
}

const OFFICIAL_SOURCE_ID: &str = "redbox_official_auto";
const OFFICIAL_PRESET_ID: &str = "redbox-official";

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

fn route_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

fn override_string(value: Option<&Value>, keys: &[&str]) -> Option<String> {
    route_string(value?, keys)
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

fn source_name(source: &Value) -> String {
    trim_json_string(source, "name")
}

fn source_base_url(source: &Value) -> String {
    trim_json_string(source, "baseURL")
}

fn source_api_key(source: &Value) -> String {
    trim_json_string(source, "apiKey")
}

fn source_model(source: &Value) -> String {
    trim_json_string(source, "model")
}

fn source_protocol(source: &Value) -> String {
    trim_json_string(source, "protocol")
}

fn source_wire_api(source: &Value) -> String {
    trim_json_string(source, "wireApi")
}

fn source_preset_id(source: &Value) -> String {
    trim_json_string(source, "presetId")
}

fn source_is_official(source: &Value) -> bool {
    source_id(source).eq_ignore_ascii_case(OFFICIAL_SOURCE_ID)
        || source_preset_id(source).eq_ignore_ascii_case(OFFICIAL_PRESET_ID)
}

fn source_without_secrets(source: &Value) -> Value {
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

fn route_source_id(route: &Value) -> String {
    route_string(route, &["sourceId", "source_id"]).unwrap_or_default()
}

fn route_model(route: &Value) -> String {
    route_string(route, &["model", "modelName", "model_name"]).unwrap_or_default()
}

fn route_mode(route: &Value) -> Option<RouteMode> {
    RouteMode::from_config(route.get("mode").and_then(Value::as_str))
}

fn route_source<'a>(
    sources: &'a [Value],
    route: &Value,
    default_source_id: &str,
) -> Option<&'a Value> {
    let mode = route_mode(route);
    if mode == Some(RouteMode::Official) {
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
    if mode == Some(RouteMode::Custom) {
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

fn scoped_endpoint_key(scope: CapabilityScope) -> Option<&'static str> {
    match scope {
        CapabilityScope::Transcription => Some("transcription_endpoint"),
        CapabilityScope::Embedding => Some("embedding_endpoint"),
        CapabilityScope::Image => Some("image_endpoint"),
        CapabilityScope::Video => Some("video_endpoint"),
        CapabilityScope::VisualIndex => Some("visual_index_endpoint"),
        CapabilityScope::VideoAnalysis => Some("video_analysis_endpoint"),
        CapabilityScope::VoiceTts | CapabilityScope::VoiceClone => Some("voice_endpoint"),
        _ => None,
    }
}

fn scoped_endpoint(scope: CapabilityScope, settings: &Value) -> Option<String> {
    scoped_endpoint_key(scope)
        .and_then(|key| payload_string(settings, key))
        .or_else(|| {
            if matches!(
                scope,
                CapabilityScope::VoiceTts | CapabilityScope::VoiceClone
            ) {
                payload_string(settings, "tts_endpoint")
            } else {
                None
            }
        })
        .or_else(|| payload_string(settings, "api_endpoint"))
}

fn scoped_api_key(scope: CapabilityScope, settings: &Value) -> Option<String> {
    match scope {
        CapabilityScope::Transcription => payload_string(settings, "transcription_key"),
        CapabilityScope::Embedding => payload_string(settings, "embedding_key"),
        CapabilityScope::Image => payload_string(settings, "image_api_key"),
        CapabilityScope::Video => payload_string(settings, "video_api_key"),
        CapabilityScope::VisualIndex => payload_string(settings, "visual_index_api_key"),
        CapabilityScope::VideoAnalysis => payload_string(settings, "video_analysis_api_key"),
        CapabilityScope::VoiceTts | CapabilityScope::VoiceClone => {
            payload_string(settings, "voice_api_key")
                .or_else(|| payload_string(settings, "tts_api_key"))
        }
        _ => None,
    }
}

fn scoped_model(scope: CapabilityScope, settings: &Value) -> Option<String> {
    payload_string(settings, scope.legacy_model_key()).or_else(|| {
        if scope == CapabilityScope::VoiceTts {
            payload_string(settings, "tts_model")
        } else {
            None
        }
    })
}

fn official_plaintext_key(settings: &Value) -> Option<String> {
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

fn model_id_from_value(value: &Value) -> String {
    if let Some(id) = value.as_str() {
        return id.trim().to_string();
    }
    value
        .get("id")
        .or_else(|| value.get("model"))
        .or_else(|| value.get("modelName"))
        .or_else(|| value.get("model_name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn source_models_with_capability(source: &Value, capability: &str) -> Vec<String> {
    let mut models = Vec::<String>::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut add_model = |model: &Value| {
        let id = model_id_from_value(model);
        if id.is_empty() || !seen.insert(id.clone()) {
            return;
        }
        let metadata = if model.is_object() {
            model.clone()
        } else {
            json!({ "id": id })
        };
        if crate::official_support::official_model_capabilities(&metadata)
            .iter()
            .any(|item| item == capability)
        {
            models.push(id);
        }
    };

    if let Some(items) = source.get("modelsMeta").and_then(Value::as_array) {
        for item in items {
            add_model(item);
        }
    }
    if let Some(items) = source.get("models").and_then(Value::as_array) {
        for item in items {
            add_model(item);
        }
    }
    if let Some(model) = source.get("model") {
        add_model(model);
    }
    models
}

fn sanitize_model_for_source_scope(
    scope: CapabilityScope,
    source: Option<&Value>,
    model_name: &str,
) -> String {
    let normalized_model = model_name.trim();
    if scope != CapabilityScope::Image {
        return normalized_model.to_string();
    }
    let Some(source) = source else {
        return normalized_model.to_string();
    };
    if !source_is_official(source) {
        return normalized_model.to_string();
    }

    let image_models = source_models_with_capability(source, "image");
    if image_models.is_empty() {
        return normalized_model.to_string();
    }
    if image_models.iter().any(|item| item == normalized_model) {
        return normalized_model.to_string();
    }
    image_models[0].clone()
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

        let route = resolve_provider_request(&settings, CapabilityScope::Chat, None).unwrap();

        assert_eq!(route.source_id, "custom-source");
        assert_eq!(route.base_url, "https://custom.example/v1");
        assert_eq!(route.api_key.as_deref(), Some("sk-custom"));
        assert_eq!(route.model, "custom-chat-model");
        assert!(!route.is_official);
    }

    #[test]
    fn disabled_route_returns_none() {
        let settings = routed_settings(json!({
            "mode": "disabled",
            "sourceId": "custom-source",
            "model": "custom-route-model"
        }));
        assert!(resolve_provider_request(&settings, CapabilityScope::Redclaw, None).is_none());
    }

    #[test]
    fn request_override_wins_over_route_source() {
        let settings = routed_settings(json!({
            "mode": "official",
            "sourceId": "redbox_official_auto",
            "model": "official-route-model"
        }));
        let route = resolve_provider_request(
            &settings,
            CapabilityScope::Redclaw,
            Some(&json!({
                "sourceId": "custom-source",
                "model": "override-model",
                "baseURL": "https://override.example/v1",
                "apiKey": "sk-override"
            })),
        )
        .unwrap();
        assert_eq!(route.source_id, "custom-source");
        assert_eq!(route.base_url, "https://override.example/v1");
        assert_eq!(route.api_key.as_deref(), Some("sk-override"));
        assert_eq!(route.model, "override-model");
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
            CapabilityScope::Transcription,
            CapabilityScope::Embedding,
            CapabilityScope::Image,
            CapabilityScope::Video,
            CapabilityScope::VisualIndex,
            CapabilityScope::VideoAnalysis,
            CapabilityScope::VoiceTts,
            CapabilityScope::VoiceClone,
        ] {
            let route = resolve_provider_request(&settings, scope, None).unwrap();
            assert_eq!(route.model, "", "scope {:?}", scope);
        }
    }
}
