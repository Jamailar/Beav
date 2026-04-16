use std::path::Path;

use serde_json::{json, Value};

use crate::payload_string;
use crate::runtime::ResolvedChatConfig;

pub fn runtime_warm_settings_fingerprint(settings: &Value, workspace_root: &Path) -> String {
    let mut parts = Vec::new();
    parts.push(workspace_root.display().to_string());
    for key in [
        "api_endpoint",
        "api_key",
        "model_name",
        "model_name_wander",
        "default_ai_source_id",
        "ai_sources_json",
        "redbox_auth_session_json",
    ] {
        parts.push(payload_string(settings, key).unwrap_or_default());
    }
    parts.join("::")
}

pub fn session_title_from_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "New Chat".to_string();
    }
    trimmed.chars().take(24).collect()
}

pub fn resolve_runtime_mode_from_context_type(value: Option<&str>) -> &'static str {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    match normalized.as_str() {
        "wander" => "wander",
        "redclaw" => "redclaw",
        "video-editor" | "video_editor" | "video-draft" | "redvideo" => "video-editor",
        "audio-editor" | "audio_editor" | "audio-draft" | "redaudio" => "audio-editor",
        "diagnostics" | "debug" | "debugger" => "diagnostics",
        "knowledge" | "note" | "video" | "youtube" | "document" | "link-article"
        | "wechat-article" => "knowledge",
        "advisor-discussion" => "advisor-discussion",
        "background-maintenance" => "background-maintenance",
        _ => "chatroom",
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
    if lower.contains("anthropic") {
        return "anthropic".to_string();
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
    let base_url = model_config
        .get("baseURL")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "api_endpoint"))
        .unwrap_or_default();
    let model_name = model_config
        .get("modelName")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "model_name"))
        .unwrap_or_default();
    if base_url.trim().is_empty() || model_name.trim().is_empty() {
        return None;
    }
    let api_key = model_config
        .get("apiKey")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "api_key"));
    let protocol = model_config
        .get("protocol")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| infer_protocol(&base_url, None, None));
    Some(ResolvedChatConfig {
        protocol,
        base_url,
        api_key,
        model_name,
    })
}

pub fn next_memory_maintenance_at_ms(response: &str, now_ms: i64) -> i64 {
    if response.chars().count() > 1200 {
        now_ms + 5 * 60 * 1000
    } else {
        now_ms + 20 * 60 * 1000
    }
}
