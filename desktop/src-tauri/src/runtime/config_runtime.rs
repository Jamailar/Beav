use std::path::Path;

#[cfg(test)]
use serde_json::json;
use serde_json::Value;

use crate::runtime::{ProviderWireApi, ResolvedChatConfig};
use crate::{ai_model_manager::AiModelManager, payload_string};

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
        "wire_api",
        "wireApi",
    ] {
        parts.push(payload_string(settings, key).unwrap_or_default());
    }
    parts.join("::")
}

fn legacy_scoped_model_name(settings: &Value, runtime_mode: Option<&str>) -> Option<String> {
    let key = match crate::ai_model_manager::scope_for_runtime_mode(runtime_mode).as_str() {
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
        "video-editor" | "video_editor" | "video-draft" | "audio-editor" | "audio_editor"
        | "audio-draft" => "team",
        "diagnostics" | "debug" | "debugger" => "diagnostics",
        "knowledge" | "note" | "video" | "youtube" | "document" | "link-article"
        | "wechat-article" | "zhihu-answer" | "zhihu-article" | "xiaohongshu_note"
        | "xiaohongshu_video" | "youtube_video" | "xhs-note" | "xhs-video" | "xhs-blogger"
        | "xhs-comments" | "douyin-video" | "douyin-profile" | "redbook-note" | "youtube-video"
        | "youtube-channel" | "bilibili-video" | "bilibili-profile" | "bilibili-search"
        | "bilibili-page" | "kuaishou-video" | "kuaishou-page" | "tiktok-video"
        | "tiktok-profile" | "tiktok-page" | "reddit-post" | "reddit-page" | "x-post"
        | "x-page" | "instagram-post" | "instagram-page" | "document-source" | "copied-file"
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
    let resolved = AiModelManager::resolve_chat_config(settings, model_config);
    if resolved.is_some() {
        resolved
    } else {
        let runtime_mode = model_config.and_then(|value| {
            value
                .get("runtimeMode")
                .or_else(|| value.get("runtime_mode"))
                .and_then(Value::as_str)
        });
        let model_name = legacy_scoped_model_name(settings, runtime_mode)
            .or_else(|| payload_string(settings, "model_name"))
            .unwrap_or_default();
        let base_url = payload_string(settings, "api_endpoint").unwrap_or_default();
        if base_url.trim().is_empty() || model_name.trim().is_empty() {
            return None;
        }
        let protocol = infer_protocol(&base_url, None, None);
        Some(ResolvedChatConfig {
            protocol: protocol.clone(),
            wire_api: ProviderWireApi::from_config(
                payload_string(settings, "wire_api")
                    .or_else(|| payload_string(settings, "wireApi"))
                    .as_deref(),
            )
            .unwrap_or_else(|| ProviderWireApi::infer_for_endpoint(&protocol, &base_url)),
            base_url,
            api_key: payload_string(settings, "api_key"),
            model_name,
            reasoning_effort: normalize_reasoning_effort(
                payload_string(settings, "reasoning_effort")
                    .or_else(|| payload_string(settings, "reasoningEffort"))
                    .as_deref(),
            ),
        })
    }
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
