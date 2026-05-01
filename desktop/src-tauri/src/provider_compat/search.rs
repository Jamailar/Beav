use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeWebSearchSupport {
    None,
    OpenAiChatCompletions,
    OpenAiResponses,
}

impl Default for NativeWebSearchSupport {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WebSearchMode {
    Disabled,
    Auto,
    Native,
}

impl Default for WebSearchMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WebSearchRequestPolicy {
    pub requested: bool,
    pub native_support: NativeWebSearchSupport,
    pub required_transport: Option<&'static str>,
    pub reason: &'static str,
}

impl WebSearchMode {
    pub(crate) fn from_config(settings: &Value, model_config: &Value) -> Self {
        parse_web_search_mode(model_config.get("webSearchMode"))
            .or_else(|| parse_web_search_mode(model_config.get("web_search_mode")))
            .or_else(|| parse_web_search_mode(model_config.get("nativeWebSearch")))
            .or_else(|| parse_web_search_mode(model_config.get("webSearch")))
            .or_else(|| parse_web_search_mode(settings.get("webSearchMode")))
            .or_else(|| parse_web_search_mode(settings.get("web_search_mode")))
            .or_else(|| parse_web_search_mode(settings.get("nativeWebSearch")))
            .or_else(|| parse_web_search_mode(settings.get("webSearch")))
            .unwrap_or_default()
    }
}

pub(crate) fn resolve_web_search_policy(
    mode: WebSearchMode,
    native_support: NativeWebSearchSupport,
) -> WebSearchRequestPolicy {
    match (mode, native_support) {
        (WebSearchMode::Disabled, support) => WebSearchRequestPolicy {
            requested: false,
            native_support: support,
            required_transport: None,
            reason: "disabled",
        },
        (WebSearchMode::Auto | WebSearchMode::Native, NativeWebSearchSupport::None) => {
            WebSearchRequestPolicy {
                requested: false,
                native_support,
                required_transport: None,
                reason: "provider_has_no_native_web_search",
            }
        }
        (
            WebSearchMode::Auto | WebSearchMode::Native,
            NativeWebSearchSupport::OpenAiChatCompletions,
        ) => WebSearchRequestPolicy {
            requested: true,
            native_support,
            required_transport: None,
            reason: "native_web_search_uses_chat_completions_options",
        },
        (WebSearchMode::Auto | WebSearchMode::Native, NativeWebSearchSupport::OpenAiResponses) => {
            WebSearchRequestPolicy {
                requested: true,
                native_support,
                required_transport: Some("openai_responses"),
                reason: "native_web_search_requires_openai_responses_transport",
            }
        }
    }
}

fn parse_web_search_mode(value: Option<&Value>) -> Option<WebSearchMode> {
    match value? {
        Value::Bool(false) => Some(WebSearchMode::Disabled),
        Value::Bool(true) => Some(WebSearchMode::Auto),
        Value::String(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "disabled" | "disable" | "off" | "false" | "none" | "no" => {
                    Some(WebSearchMode::Disabled)
                }
                "auto" | "default" | "" => Some(WebSearchMode::Auto),
                "native" | "on" | "true" | "enabled" | "enable" => Some(WebSearchMode::Native),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_web_search_policy, NativeWebSearchSupport, WebSearchMode, WebSearchRequestPolicy,
    };
    use serde_json::json;

    #[test]
    fn web_search_mode_reads_model_config_before_settings() {
        let mode = WebSearchMode::from_config(
            &json!({ "webSearchMode": "disabled" }),
            &json!({ "nativeWebSearch": "native" }),
        );
        assert_eq!(mode, WebSearchMode::Native);
    }

    #[test]
    fn web_search_mode_defaults_to_auto() {
        assert_eq!(
            WebSearchMode::from_config(&json!({}), &json!({})),
            WebSearchMode::Auto
        );
        assert_eq!(
            WebSearchMode::from_config(&json!({ "webSearch": true }), &json!({})),
            WebSearchMode::Auto
        );
    }

    #[test]
    fn web_search_policy_marks_responses_transport_requirement() {
        assert_eq!(
            resolve_web_search_policy(WebSearchMode::Auto, NativeWebSearchSupport::OpenAiResponses,),
            WebSearchRequestPolicy {
                requested: true,
                native_support: NativeWebSearchSupport::OpenAiResponses,
                required_transport: Some("openai_responses"),
                reason: "native_web_search_requires_openai_responses_transport",
            }
        );
    }

    #[test]
    fn web_search_policy_enables_current_chat_completions_transport() {
        assert_eq!(
            resolve_web_search_policy(
                WebSearchMode::Native,
                NativeWebSearchSupport::OpenAiChatCompletions,
            ),
            WebSearchRequestPolicy {
                requested: true,
                native_support: NativeWebSearchSupport::OpenAiChatCompletions,
                required_transport: None,
                reason: "native_web_search_uses_chat_completions_options",
            }
        );
    }
}
