use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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

impl RuntimeErrorLayer {
    pub fn as_key(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimit => "rate_limit",
            Self::Transport => "transport",
            Self::Protocol => "protocol",
            Self::Recovery => "recovery",
            Self::Tool => "tool",
            Self::Persistence => "persistence",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeErrorCategory {
    Auth,
    RateLimit,
    PartialBody,
    Http2Framing,
    Timeout,
    Transport,
    InvalidRequest,
    ProtocolMismatch,
    RecoveryIncomplete,
    ToolExecution,
    Persistence,
    Unknown,
}

impl RuntimeErrorCategory {
    pub fn as_key(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimit => "rate_limit",
            Self::PartialBody => "partial_body",
            Self::Http2Framing => "http2_framing",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::InvalidRequest => "invalid_request",
            Self::ProtocolMismatch => "protocol_mismatch",
            Self::RecoveryIncomplete => "recovery_incomplete",
            Self::ToolExecution => "tool_execution",
            Self::Persistence => "persistence",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeErrorEnvelope {
    pub code: String,
    pub category: RuntimeErrorCategory,
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
                items[1]
                    .trim_matches(|ch: char| !ch.is_ascii_digit())
                    .parse::<u16>()
                    .ok()
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
    let (category, layer, retryable, title) = if is_balance_insufficient_error(&lower)
        || normalized.contains("余额不足")
        || normalized.contains("额度不足")
    {
        (
            RuntimeErrorCategory::Auth,
            RuntimeErrorLayer::Auth,
            false,
            "余额不足，请及时充值".to_string(),
        )
    } else if normalized.contains("登录失效")
        || normalized.contains("登陆失效")
        || normalized.contains("重新登录")
        || normalized.contains("重新登陆")
        || lower.contains("invalid access token")
        || lower.contains("invalid api key")
        || lower.contains("api_key_required")
        || http_status == Some(401)
    {
        (
            RuntimeErrorCategory::Auth,
            RuntimeErrorLayer::Auth,
            false,
            "登陆失效，请重新登陆".to_string(),
        )
    } else if http_status == Some(403) {
        (
            RuntimeErrorCategory::Auth,
            RuntimeErrorLayer::Auth,
            false,
            "API 权限受限，请检查密钥、额度或模型权限".to_string(),
        )
    } else if http_status == Some(429)
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        (
            RuntimeErrorCategory::RateLimit,
            RuntimeErrorLayer::RateLimit,
            true,
            "请求频率受限".to_string(),
        )
    } else if lower.contains("required execution steps")
        || lower.contains("required tool execution")
        || lower.contains("empty fallback response")
        || lower.contains("interactive fallback returned")
        || lower.contains("json fallback returned")
    {
        (
            RuntimeErrorCategory::RecoveryIncomplete,
            RuntimeErrorLayer::Recovery,
            false,
            "执行恢复失败".to_string(),
        )
    } else if lower.contains("tool ") && (lower.contains(" failed") || lower.contains("error")) {
        (
            RuntimeErrorCategory::ToolExecution,
            RuntimeErrorLayer::Tool,
            false,
            "工具执行失败".to_string(),
        )
    } else if lower.contains("curl: (18)")
        || lower.contains("partial file")
        || lower.contains("unexpected eof")
        || lower.contains("error decoding response body")
    {
        (
            RuntimeErrorCategory::PartialBody,
            RuntimeErrorLayer::Transport,
            true,
            "流式响应中断".to_string(),
        )
    } else if lower.contains("curl: (16)") || lower.contains("http2 framing") {
        (
            RuntimeErrorCategory::Http2Framing,
            RuntimeErrorLayer::Transport,
            true,
            "网络传输异常".to_string(),
        )
    } else if lower.contains("timeout") {
        (
            RuntimeErrorCategory::Timeout,
            RuntimeErrorLayer::Transport,
            true,
            "请求超时".to_string(),
        )
    } else if lower.contains("network")
        || lower.contains("broken pipe")
        || lower.contains("connection reset")
        || lower.contains("empty reply")
    {
        (
            RuntimeErrorCategory::Transport,
            RuntimeErrorLayer::Transport,
            true,
            "网络传输异常".to_string(),
        )
    } else if lower.contains("does not support this tool_choice")
        || lower.contains("tool_choice parameter")
        || lower.contains("reasoning_content")
        || (lower.contains("tool_choice") && lower.contains("unsupported"))
    {
        (
            RuntimeErrorCategory::ProtocolMismatch,
            RuntimeErrorLayer::Protocol,
            false,
            "模型协议不兼容".to_string(),
        )
    } else if lower.contains("invalid json") || lower.contains("unsupported runtime protocol") {
        (
            RuntimeErrorCategory::ProtocolMismatch,
            RuntimeErrorLayer::Protocol,
            true,
            "模型协议不兼容".to_string(),
        )
    } else if lower.contains("invalidparameter") || lower.contains("invalid_request_error") {
        (
            RuntimeErrorCategory::InvalidRequest,
            RuntimeErrorLayer::Protocol,
            true,
            "请求参数不兼容".to_string(),
        )
    } else if lower.contains("workspace")
        || lower.contains("filepath is required")
        || lower.contains("path is required")
    {
        (
            RuntimeErrorCategory::Persistence,
            RuntimeErrorLayer::Persistence,
            false,
            "工作区数据异常".to_string(),
        )
    } else {
        (
            RuntimeErrorCategory::Unknown,
            RuntimeErrorLayer::Unknown,
            false,
            "执行异常".to_string(),
        )
    };
    RuntimeErrorEnvelope {
        code: category.as_key().to_string(),
        category,
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

fn is_balance_insufficient_error(lower: &str) -> bool {
    lower.contains("insufficient_quota")
        || lower.contains("insufficient quota")
        || lower.contains("insufficient balance")
        || lower.contains("balance is insufficient")
        || lower.contains("not enough balance")
        || lower.contains("exceeded your current quota")
        || (lower.contains("quota") && lower.contains("billing"))
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
        "hint": if envelope.retryable { "可稍后重试。" } else { "" },
        "category": envelope.category.as_key(),
        "layer": envelope.layer.as_key(),
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
    use super::{RuntimeErrorCategory, RuntimeErrorLayer, runtime_error_envelope_from_error};
    use crate::provider_compat::provider_profile_from_config;
    use crate::runtime::ResolvedChatConfig;

    fn openai_profile() -> crate::provider_compat::ProviderProfile {
        provider_profile_from_config(&ResolvedChatConfig {
            protocol: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: None,
            model_name: "gpt-5".to_string(),
            reasoning_effort: None,
        })
    }

    #[test]
    fn runtime_error_envelope_marks_protocol_errors() {
        let envelope = runtime_error_envelope_from_error(
            "The tool_choice parameter does not support being set to required or object in thinking mode",
            Some(&openai_profile()),
            Some("qwen3.5-plus"),
        );
        assert_eq!(envelope.layer, RuntimeErrorLayer::Protocol);
        assert_eq!(envelope.category, RuntimeErrorCategory::ProtocolMismatch);
        assert_eq!(envelope.code, "protocol_mismatch");
        assert!(!envelope.retryable);
    }

    #[test]
    fn runtime_error_envelope_marks_unsupported_tool_choice_non_retryable() {
        let envelope = runtime_error_envelope_from_error(
            "AI upstream error (400): {\"error\":{\"message\":\"deepseek-reasoner does not support this tool_choice\",\"type\":\"invalid_request_error\"}}",
            Some(&openai_profile()),
            Some("deepseek-reasoner"),
        );
        assert_eq!(envelope.layer, RuntimeErrorLayer::Protocol);
        assert_eq!(envelope.category, RuntimeErrorCategory::ProtocolMismatch);
        assert_eq!(envelope.title, "模型协议不兼容");
        assert!(!envelope.retryable);
    }

    #[test]
    fn runtime_error_envelope_marks_reasoning_content_protocol_error_non_retryable() {
        let envelope = runtime_error_envelope_from_error(
            "AI upstream error (400): {\"error\":{\"message\":\"The `reasoning_content` in the thinking mode must be passed back to the API.\",\"type\":\"invalid_request_error\"}}",
            Some(&openai_profile()),
            Some("deepseek-chat"),
        );
        assert_eq!(envelope.layer, RuntimeErrorLayer::Protocol);
        assert_eq!(envelope.category, RuntimeErrorCategory::ProtocolMismatch);
        assert_eq!(envelope.title, "模型协议不兼容");
        assert!(!envelope.retryable);
    }

    #[test]
    fn runtime_error_envelope_preserves_balance_insufficient_status() {
        let envelope = runtime_error_envelope_from_error(
            "AI request failed: HTTP 403 [code=insufficient_quota] Your account is not active",
            Some(&openai_profile()),
            Some("gpt-5"),
        );
        assert_eq!(envelope.http_status, Some(403));
        assert_eq!(envelope.layer, RuntimeErrorLayer::Auth);
        assert_eq!(envelope.category, RuntimeErrorCategory::Auth);
        assert_eq!(envelope.title, "余额不足，请及时充值");
        assert!(!envelope.retryable);
    }

    #[test]
    fn runtime_error_envelope_preserves_expired_key_status() {
        let envelope = runtime_error_envelope_from_error(
            "AI request failed: HTTP 401 [code=invalid_api_key] Invalid API key",
            Some(&openai_profile()),
            Some("gpt-5"),
        );
        assert_eq!(envelope.http_status, Some(401));
        assert_eq!(envelope.layer, RuntimeErrorLayer::Auth);
        assert_eq!(envelope.category, RuntimeErrorCategory::Auth);
        assert_eq!(envelope.title, "登陆失效，请重新登陆");
        assert!(!envelope.retryable);
    }

    #[test]
    fn runtime_error_envelope_preserves_rate_limit_status() {
        let envelope = runtime_error_envelope_from_error(
            "AI request failed: HTTP 429 [code=rate_limit_exceeded] Too many requests",
            Some(&openai_profile()),
            Some("gpt-5"),
        );
        assert_eq!(envelope.http_status, Some(429));
        assert_eq!(envelope.layer, RuntimeErrorLayer::RateLimit);
        assert_eq!(envelope.category, RuntimeErrorCategory::RateLimit);
        assert_eq!(envelope.title, "请求频率受限");
        assert!(envelope.retryable);
    }

    #[test]
    fn runtime_error_envelope_marks_json_fallback_recovery_failures() {
        let envelope = runtime_error_envelope_from_error(
            "interactive json fallback returned tool calls",
            Some(&openai_profile()),
            Some("qwen3.5-plus"),
        );
        assert_eq!(envelope.layer, RuntimeErrorLayer::Recovery);
        assert_eq!(envelope.category, RuntimeErrorCategory::RecoveryIncomplete);
        assert_eq!(envelope.title, "执行恢复失败");
        assert!(!envelope.retryable);
    }
}
