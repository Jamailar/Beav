use std::path::Path;

use serde_json::{json, Value};

use crate::runtime::ResolvedChatConfig;
use crate::{official_ai_api_key_from_settings, official_base_url_from_settings, payload_string};

fn normalize_reasoning_effort(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "minimal" | "low" | "medium" | "high" => Some(normalized),
        _ => None,
    }
}

pub fn runtime_warm_settings_fingerprint(settings: &Value, workspace_root: &Path) -> String {
    let mut parts = Vec::new();
    parts.push(workspace_root.display().to_string());
    for key in [
        "api_endpoint",
        "api_key",
        "model_name",
        "model_name_wander",
        "ai_model_routes_json",
        "default_ai_source_id",
        "ai_sources_json",
        "redbox_auth_session_json",
        "reasoning_effort",
        "reasoningEffort",
    ] {
        parts.push(payload_string(settings, key).unwrap_or_default());
    }
    parts.join("::")
}

fn runtime_mode_route_scope(runtime_mode: &str) -> &'static str {
    match runtime_mode.trim().to_ascii_lowercase().as_str() {
        "wander" => "wander",
        "knowledge" => "knowledge",
        "redclaw" => "redclaw",
        "team" | "chatroom" | "advisor-discussion" => "team",
        "chat" | "default" => "chat",
        _ => "chat",
    }
}

fn source_string(source: &Value, key: &str, fallback_key: &str) -> String {
    source
        .get(key)
        .or_else(|| source.get(fallback_key))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn source_matches_id(source: &Value, source_id: &str) -> bool {
    source
        .get("id")
        .and_then(Value::as_str)
        .map(|value| value.trim() == source_id)
        .unwrap_or(false)
}

fn source_is_official(source: &Value) -> bool {
    let source_id = source_string(source, "id", "id").to_ascii_lowercase();
    let preset_id = source_string(source, "presetId", "preset_id").to_ascii_lowercase();
    source_id == "redbox_official_auto" || preset_id == "redbox-official"
}

fn config_is_official(value: &Value) -> bool {
    let source_id = source_string(value, "sourceId", "source_id").to_ascii_lowercase();
    let preset_id = source_string(value, "presetId", "preset_id").to_ascii_lowercase();
    source_id == "redbox_official_auto" || preset_id == "redbox-official"
}

fn urls_match(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim().trim_end_matches('/').to_ascii_lowercase();
    !left.trim().is_empty() && normalize(left) == normalize(right)
}

fn source_model(source: &Value) -> String {
    source_string(source, "model", "modelName")
}

fn route_source<'a>(
    sources: &'a [Value],
    route: &Value,
    mode: &str,
    default_source_id: &str,
) -> Option<&'a Value> {
    if mode == "official" {
        return sources.iter().find(|source| source_is_official(source));
    }

    let explicit_source_id = route
        .get("sourceId")
        .or_else(|| route.get("source_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if !explicit_source_id.is_empty() {
        if let Some(source) = sources
            .iter()
            .find(|source| source_matches_id(source, explicit_source_id))
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
            .find(|source| source_matches_id(source, default_source_id.trim()))
        {
            return Some(source);
        }
    }

    sources.first()
}

fn resolve_model_route_config(settings: &Value, runtime_mode: Option<&str>) -> Option<Value> {
    let runtime_mode = runtime_mode?;
    let scope = runtime_mode_route_scope(runtime_mode);
    let routes = payload_string(settings, "ai_model_routes_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())?;
    let route = routes.get(scope)?;
    let mode = route
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if mode.is_empty() || mode == "inherit" || mode == "disabled" {
        return None;
    }

    let sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let source = route_source(&sources, route, mode, &default_source_id)?;
    let base_url = source_string(source, "baseURL", "baseUrl");
    let api_key = source_string(source, "apiKey", "key");
    let model_name = route
        .get("model")
        .or_else(|| route.get("modelName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| source_model(source));
    let protocol = source_string(source, "protocol", "protocol");
    if base_url.is_empty() || model_name.is_empty() {
        return None;
    }

    Some(json!({
        "sourceId": source.get("id").cloned().unwrap_or(Value::Null),
        "presetId": source.get("presetId").or_else(|| source.get("preset_id")).cloned().unwrap_or(Value::Null),
        "baseURL": base_url,
        "apiKey": api_key,
        "modelName": model_name,
        "protocol": protocol
    }))
}

fn legacy_scoped_model_name(settings: &Value, runtime_mode: Option<&str>) -> Option<String> {
    let key = match runtime_mode_route_scope(runtime_mode?) {
        "wander" => "model_name_wander",
        "team" => "model_name_chatroom",
        "knowledge" => "model_name_knowledge",
        "redclaw" => "model_name_redclaw",
        _ => return None,
    };
    payload_string(settings, key).filter(|value| !value.trim().is_empty())
}

pub fn session_title_from_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "New Chat".to_string();
    }
    trimmed.chars().take(15).collect()
}

pub fn resolve_runtime_mode_from_context_type(value: Option<&str>) -> &'static str {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    match normalized.as_str() {
        "wander" => "wander",
        "redclaw" => "redclaw",
        "generation-agent" | "image-generation" | "image_generation" => "image-generation",
        "video-editor" | "video_editor" | "video-draft" => "video-editor",
        "audio-editor" | "audio_editor" | "audio-draft" => "audio-editor",
        "diagnostics" | "debug" | "debugger" => "diagnostics",
        "knowledge" | "note" | "video" | "youtube" | "document" | "link-article"
        | "wechat-article" | "xiaohongshu_note" | "xiaohongshu_video" | "youtube_video"
        | "xhs-note" | "xhs-video" | "xhs-blogger" | "xhs-comments" | "douyin-video"
        | "redbook-note" | "youtube-video" | "bilibili-video" | "bilibili-profile"
        | "bilibili-search" | "bilibili-page" | "kuaishou-video" | "kuaishou-page"
        | "tiktok-video" | "tiktok-page" | "reddit-post" | "reddit-page" | "x-post" | "x-page"
        | "instagram-post" | "instagram-page" | "document-source" | "copied-file"
        | "tracked-folder" | "obsidian-vault" => "knowledge",
        "advisor-discussion" => "advisor-discussion",
        "background-maintenance" => "background-maintenance",
        "chatroom" | "chat" | "default" | "team" => "team",
        _ => "team",
    }
}

pub fn infer_protocol(base_url: &str, preset_id: Option<&str>, explicit: Option<&str>) -> String {
    if let Some(protocol) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return protocol.to_string();
    }
    if let Some(preset) = preset_id.map(str::trim).filter(|value| !value.is_empty()) {
        if preset.contains("anthropic") {
            return "anthropic".to_string();
        }
        if preset.contains("gemini") {
            return "gemini".to_string();
        }
    }
    let lower = base_url.to_lowercase();
    if lower.contains("/anthropic") || lower.contains("anthropic.com") {
        return "anthropic".to_string();
    }
    if lower.contains("/openai") || lower.contains("/compatible-mode") {
        return "openai".to_string();
    }
    if lower.contains("gemini")
        || lower.contains("googleapis.com")
        || lower.contains("generativelanguage")
    {
        return "gemini".to_string();
    }
    "openai".to_string()
}

pub fn resolve_chat_config(
    settings: &Value,
    model_config: Option<&Value>,
) -> Option<ResolvedChatConfig> {
    let model_config = model_config.cloned().unwrap_or_else(|| json!({}));
    let runtime_mode = model_config
        .get("runtimeMode")
        .or_else(|| model_config.get("runtime_mode"))
        .and_then(Value::as_str);
    let route_config =
        resolve_model_route_config(settings, runtime_mode).unwrap_or_else(|| json!({}));
    let base_url = model_config
        .get("baseURL")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            route_config
                .get("baseURL")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| payload_string(settings, "api_endpoint"))
        .unwrap_or_default();
    let model_name = model_config
        .get("modelName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            route_config
                .get("modelName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .or_else(|| legacy_scoped_model_name(settings, runtime_mode))
        .or_else(|| payload_string(settings, "model_name"))
        .unwrap_or_default();
    if base_url.trim().is_empty() || model_name.trim().is_empty() {
        return None;
    }
    let is_official_config = config_is_official(&model_config)
        || config_is_official(&route_config)
        || urls_match(&base_url, &official_base_url_from_settings(settings));
    let configured_api_key = || {
        model_config
            .get("apiKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                route_config
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .or_else(|| payload_string(settings, "api_key"))
    };
    let api_key = if is_official_config {
        official_ai_api_key_from_settings(settings).or_else(configured_api_key)
    } else {
        configured_api_key()
    };
    let protocol = model_config
        .get("protocol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            route_config
                .get("protocol")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| infer_protocol(&base_url, None, None));
    let reasoning_effort_value = model_config
        .get("reasoningEffort")
        .or_else(|| model_config.get("reasoning_effort"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "reasoning_effort"))
        .or_else(|| payload_string(settings, "reasoningEffort"));
    let reasoning_effort = normalize_reasoning_effort(reasoning_effort_value.as_deref());
    Some(ResolvedChatConfig {
        protocol,
        base_url,
        api_key,
        model_name,
        reasoning_effort,
    })
}

pub fn next_memory_maintenance_at_ms(response: &str, now_ms: i64) -> i64 {
    if response.chars().count() > 1200 {
        now_ms + 5 * 60 * 1000
    } else {
        now_ms + 20 * 60 * 1000
    }
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
    fn official_route_ignores_conflicting_custom_source_id() {
        let settings = routed_settings(json!({
            "mode": "official",
            "sourceId": "custom-source",
            "model": "official-route-model"
        }));

        let config = resolve_chat_config(
            &settings,
            Some(&json!({
                "runtimeMode": "redclaw"
            })),
        )
        .expect("official route should resolve");

        assert_eq!(config.base_url, "https://api.ziz.hk/redbox/v1");
        assert_eq!(config.model_name, "official-route-model");
    }

    #[test]
    fn custom_route_uses_explicit_custom_source_id() {
        let settings = routed_settings(json!({
            "mode": "custom",
            "sourceId": "custom-source",
            "model": "custom-route-model"
        }));

        let config = resolve_chat_config(
            &settings,
            Some(&json!({
                "runtimeMode": "redclaw"
            })),
        )
        .expect("custom route should resolve");

        assert_eq!(config.base_url, "https://custom.example/v1");
        assert_eq!(config.api_key.as_deref(), Some("sk-custom"));
        assert_eq!(config.model_name, "custom-route-model");
    }
}
