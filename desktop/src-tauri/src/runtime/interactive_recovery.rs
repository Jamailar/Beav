use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::provider_compat::ProviderProfile;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeErrorLayer {
    Auth,
    RateLimit,
    Transport,
    Protocol,
    Recovery,
    Tool,
    Persistence,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorEnvelope {
    pub code: String,
    pub layer: RuntimeErrorLayer,
    pub retryable: bool,
    pub title: String,
    pub detail: String,
    pub provider_key: Option<String>,
    pub model_name: Option<String>,
    pub transport_mode: Option<String>,
    pub http_status: Option<u16>,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InteractiveRecoveryPlan {
    pub retry_interactive: bool,
    pub allow_text_fallback: bool,
}

pub fn runtime_error_envelope_from_error(
    error: &str,
    provider_profile: Option<&ProviderProfile>,
    model_name: Option<&str>,
) -> RuntimeErrorEnvelope {
    let normalized = error.trim();
    let lower = normalized.to_ascii_lowercase();
    let http_status = normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|items| {
            if items[0].eq_ignore_ascii_case("http") {
                items[1].parse::<u16>().ok()
            } else {
                None
            }
        });
    let transport_mode = if lower.contains("http1.1") {
        Some("http1.1".to_string())
    } else if lower.contains("transport=default") || lower.contains("transport retry") {
        Some("default".to_string())
    } else {
        None
    };
    let (layer, retryable, title, code) = if normalized.contains("登录失效")
        || normalized.contains("重新登录")
        || lower.contains("invalid access token")
        || http_status == Some(401)
    {
        (
            RuntimeErrorLayer::Auth,
            false,
            "登录失效，请重新登录".to_string(),
            "401".to_string(),
        )
    } else if http_status == Some(429)
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        (
            RuntimeErrorLayer::RateLimit,
            true,
            "请求频率受限".to_string(),
            "429".to_string(),
        )
    } else if lower.contains("required execution steps")
        || lower.contains("required tool execution")
        || lower.contains("empty fallback response")
        || lower.contains("interactive fallback returned")
    {
        (
            RuntimeErrorLayer::Recovery,
            false,
            "执行恢复失败".to_string(),
            "recovery".to_string(),
        )
    } else if lower.contains("tool ")
        && (lower.contains(" failed") || lower.contains("error"))
    {
        (
            RuntimeErrorLayer::Tool,
            false,
            "工具执行失败".to_string(),
            "tool".to_string(),
        )
    } else if lower.contains("curl: (18)")
        || lower.contains("partial file")
        || lower.contains("unexpected eof")
        || lower.contains("error decoding response body")
        || lower.contains("curl: (16)")
        || lower.contains("http2 framing")
        || lower.contains("network")
        || lower.contains("broken pipe")
        || lower.contains("connection reset")
        || lower.contains("empty reply")
        || lower.contains("timeout")
    {
        (
            RuntimeErrorLayer::Transport,
            true,
            "网络传输异常".to_string(),
            if lower.contains("curl: (18)") || lower.contains("partial file") {
                "partial_body".to_string()
            } else if lower.contains("curl: (16)") || lower.contains("http2 framing") {
                "http2_framing".to_string()
            } else if lower.contains("timeout") {
                "timeout".to_string()
            } else {
                "transport".to_string()
            },
        )
    } else if lower.contains("invalid json")
        || lower.contains("invalidparameter")
        || lower.contains("invalid_request_error")
        || lower.contains("unsupported runtime protocol")
        || lower.contains("tool_choice parameter")
    {
        (
            RuntimeErrorLayer::Protocol,
            true,
            "模型协议不兼容".to_string(),
            "protocol".to_string(),
        )
    } else if lower.contains("workspace")
        || lower.contains("filepath is required")
        || lower.contains("path is required")
    {
        (
            RuntimeErrorLayer::Persistence,
            false,
            "工作区数据异常".to_string(),
            "persistence".to_string(),
        )
    } else {
        (
            RuntimeErrorLayer::Unknown,
            false,
            "执行异常".to_string(),
            String::new(),
        )
    };
    RuntimeErrorEnvelope {
        code,
        layer,
        retryable,
        title,
        detail: normalized.to_string(),
        provider_key: provider_profile.map(|profile| profile.key.clone()),
        model_name: model_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        transport_mode,
        http_status,
        raw: if normalized.is_empty() {
            None
        } else {
            Some(normalized.to_string())
        },
    }
}

pub fn interactive_recovery_plan(
    runtime_mode: &str,
    provider_profile: &ProviderProfile,
    error: &str,
) -> InteractiveRecoveryPlan {
    let envelope =
        runtime_error_envelope_from_error(error, Some(provider_profile), None);
    let retry_interactive = envelope.retryable
        && matches!(
            envelope.layer,
            RuntimeErrorLayer::Transport | RuntimeErrorLayer::Protocol
        );
    let allow_text_fallback = retry_interactive
        && runtime_mode != "wander"
        && provider_profile.capabilities.supports_text_fallback
        && !matches!(
            envelope.layer,
            RuntimeErrorLayer::Auth
                | RuntimeErrorLayer::RateLimit
                | RuntimeErrorLayer::Recovery
                | RuntimeErrorLayer::Tool
                | RuntimeErrorLayer::Persistence
        );
    InteractiveRecoveryPlan {
        retry_interactive,
        allow_text_fallback,
    }
}

pub fn runtime_error_payload(
    error: &str,
    provider_profile: Option<&ProviderProfile>,
    model_name: Option<&str>,
    session_id: Option<String>,
) -> Value {
    let envelope = runtime_error_envelope_from_error(error, provider_profile, model_name);
    json!({
        "message": envelope.title,
        "title": envelope.title,
        "raw": envelope.raw.clone().unwrap_or_default(),
        "detail": envelope.detail,
        "hint": if envelope.retryable { "可稍后重试，系统会优先走交互恢复而不是直接结束。" } else { "" },
        "category": format!("{:?}", envelope.layer).to_ascii_lowercase(),
        "layer": format!("{:?}", envelope.layer).to_ascii_lowercase(),
        "retryable": envelope.retryable,
        "statusCode": envelope.http_status.unwrap_or_default(),
        "httpStatus": envelope.http_status,
        "errorCode": envelope.code,
        "providerKey": envelope.provider_key,
        "modelName": envelope.model_name,
        "transportMode": envelope.transport_mode,
        "sessionId": session_id,
    })
}

#[cfg(test)]
mod tests {
    use super::{interactive_recovery_plan, runtime_error_envelope_from_error, RuntimeErrorLayer};
    use crate::provider_compat::provider_profile_from_config;
    use crate::runtime::ResolvedChatConfig;

    fn openai_profile() -> crate::provider_compat::ProviderProfile {
        provider_profile_from_config(&ResolvedChatConfig {
            protocol: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: None,
            model_name: "gpt-5".to_string(),
        })
    }

    #[test]
    fn transport_errors_are_retryable_in_recovery_plan() {
        let profile = openai_profile();
        let plan = interactive_recovery_plan(
            "redclaw",
            &profile,
            "curl: (18) Transferred a partial file",
        );
        assert!(plan.retry_interactive);
        assert!(plan.allow_text_fallback);
    }

    #[test]
    fn execution_contract_failures_do_not_fallback_to_text() {
        let profile = openai_profile();
        let plan = interactive_recovery_plan(
            "wander",
            &profile,
            "interactive runtime ended before completing required execution steps: 读取素材真实文件",
        );
        assert!(!plan.retry_interactive);
        assert!(!plan.allow_text_fallback);
    }

    #[test]
    fn runtime_error_envelope_marks_protocol_errors() {
        let envelope = runtime_error_envelope_from_error(
            "AI request failed: HTTP 502 AI upstream error (400): tool_choice parameter does not support being set to required",
            None,
            Some("qwen3.5-plus"),
        );
        assert_eq!(envelope.layer, RuntimeErrorLayer::Protocol);
        assert!(envelope.retryable);
    }
}
