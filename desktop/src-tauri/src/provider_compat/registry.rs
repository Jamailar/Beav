use crate::runtime::ResolvedChatConfig;

use super::{
    ProviderCapabilities, ProviderFamily, ProviderProfile, ProviderThinkingDisableParameter,
};

fn openai_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        supports_streaming: true,
        supports_tool_choice_auto: true,
        supports_tool_choice_required: true,
        supports_tool_choice_none: true,
        supports_thinking: true,
        supports_reasoning_effort: true,
        requires_disable_thinking_for_forced_tool_choice: false,
        supports_usage_trailer: true,
        supports_parallel_tool_calls: true,
        supports_text_fallback: true,
        thinking_disable_parameter: ProviderThinkingDisableParameter::EnableThinkingFalse,
    }
}

fn qwen_compat_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        requires_disable_thinking_for_forced_tool_choice: true,
        ..openai_capabilities()
    }
}

fn model_capability_overrides(
    model_name: &str,
    capabilities: ProviderCapabilities,
) -> ProviderCapabilities {
    let model_key = model_name.trim().to_ascii_lowercase();
    if model_key.contains("deepseek") {
        return ProviderCapabilities {
            supports_tool_choice_auto: false,
            supports_tool_choice_required: false,
            supports_tool_choice_none: false,
            supports_thinking: false,
            supports_reasoning_effort: false,
            thinking_disable_parameter: ProviderThinkingDisableParameter::ThinkingTypeDisabled,
            ..capabilities
        };
    }
    capabilities
}

fn minimax_capabilities() -> ProviderCapabilities {
    openai_capabilities()
}

fn anthropic_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        supports_streaming: true,
        supports_tool_choice_auto: false,
        supports_tool_choice_required: false,
        supports_tool_choice_none: false,
        supports_thinking: true,
        supports_reasoning_effort: false,
        requires_disable_thinking_for_forced_tool_choice: false,
        supports_usage_trailer: false,
        supports_parallel_tool_calls: true,
        supports_text_fallback: false,
        thinking_disable_parameter: ProviderThinkingDisableParameter::EnableThinkingFalse,
    }
}

fn gemini_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        supports_streaming: true,
        supports_tool_choice_auto: false,
        supports_tool_choice_required: false,
        supports_tool_choice_none: false,
        supports_thinking: true,
        supports_reasoning_effort: false,
        requires_disable_thinking_for_forced_tool_choice: false,
        supports_usage_trailer: false,
        supports_parallel_tool_calls: true,
        supports_text_fallback: false,
        thinking_disable_parameter: ProviderThinkingDisableParameter::EnableThinkingFalse,
    }
}

fn normalized_provider_key(protocol: &str, base_url: &str, model_name: &str) -> String {
    let protocol_key = protocol.trim().to_ascii_lowercase();
    let host_key = base_url
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .replace("https://", "")
        .replace("http://", "");
    let model_key = model_name.trim().to_ascii_lowercase();
    format!("{protocol_key}:{host_key}:{model_key}")
}

pub(crate) fn provider_profile_from_parts(
    protocol: &str,
    base_url: &str,
    model_name: &str,
) -> ProviderProfile {
    let normalized_protocol = protocol.trim().to_ascii_lowercase();
    let lower_hint = format!("{model_name} {base_url}").to_ascii_lowercase();
    match normalized_protocol.as_str() {
        "anthropic" => ProviderProfile {
            key: normalized_provider_key(protocol, base_url, model_name),
            provider_family: ProviderFamily::Anthropic,
            capabilities: anthropic_capabilities(),
        },
        "gemini" => ProviderProfile {
            key: normalized_provider_key(protocol, base_url, model_name),
            provider_family: ProviderFamily::Gemini,
            capabilities: gemini_capabilities(),
        },
        _ => {
            let provider_family = if lower_hint.contains("minimax")
                || lower_hint.contains("minimaxi.com")
                || lower_hint.contains("minimax.io")
            {
                ProviderFamily::MiniMax
            } else {
                ProviderFamily::OpenAiCompat
            };
            let base_capabilities = if provider_family == ProviderFamily::MiniMax {
                minimax_capabilities()
            } else if lower_hint.contains("qwen") || lower_hint.contains("dashscope") {
                qwen_compat_capabilities()
            } else {
                openai_capabilities()
            };
            let capabilities = model_capability_overrides(model_name, base_capabilities);
            ProviderProfile {
                key: normalized_provider_key(protocol, base_url, model_name),
                provider_family,
                capabilities,
            }
        }
    }
}

pub(crate) fn provider_profile_from_config(config: &ResolvedChatConfig) -> ProviderProfile {
    provider_profile_from_parts(&config.protocol, &config.base_url, &config.model_name)
}

#[cfg(test)]
mod tests {
    use super::provider_profile_from_parts;
    use crate::provider_compat::{
        InteractiveToolChoice, ProviderFamily, ProviderThinkingDisableParameter,
    };
    use serde_json::json;

    #[test]
    fn qwen_profiles_disable_thinking_for_required_tool_choice() {
        let profile =
            provider_profile_from_parts("openai", "https://api.ziz.hk/redbox/v1", "qwen3.5-plus");
        assert_eq!(profile.provider_family, ProviderFamily::OpenAiCompat);
        assert!(
            profile
                .capabilities
                .requires_disable_thinking_for_forced_tool_choice
        );
        assert!(profile.should_disable_thinking("redclaw", true));
    }

    #[test]
    fn default_openai_profiles_keep_thinking_enabled() {
        let profile = provider_profile_from_parts("openai", "https://api.openai.com/v1", "gpt-5");
        assert!(!profile.should_disable_thinking("chat", false));
        assert!(profile.should_disable_thinking("redclaw", false));
        assert!(profile.capabilities.supports_tool_choice_required);
    }

    #[test]
    fn deepseek_models_disable_tool_choice_by_model_name() {
        let profile = provider_profile_from_parts(
            "openai",
            "https://gateway.example.com/v1",
            "provider-prefix/deepseek-chat",
        );
        assert_eq!(profile.provider_family, ProviderFamily::OpenAiCompat);
        assert!(!profile.capabilities.supports_tool_choice_auto);
        assert!(!profile.capabilities.supports_tool_choice_required);
        assert!(!profile.capabilities.supports_tool_choice_none);
        assert!(!profile.capabilities.supports_thinking);
        assert!(!profile.capabilities.supports_reasoning_effort);
        assert_eq!(
            profile.capabilities.thinking_disable_parameter,
            ProviderThinkingDisableParameter::ThinkingTypeDisabled
        );
        assert!(profile.should_disable_thinking("chat", false));
        assert_eq!(
            profile.api_tool_choice_value(InteractiveToolChoice::Auto),
            None
        );
        assert_eq!(
            profile.api_tool_choice_value(InteractiveToolChoice::Required),
            None
        );
        assert_eq!(
            profile.api_tool_choice_value(InteractiveToolChoice::None),
            None
        );
    }

    #[test]
    fn minimax_profiles_are_detected_and_enable_provider_specific_policies() {
        let profile =
            provider_profile_from_parts("openai", "https://api.minimaxi.com/v1", "MiniMax-M2.7");
        assert_eq!(profile.provider_family, ProviderFamily::MiniMax);
        assert!(profile.prefers_http11_transport());
        assert!(profile.prefers_curl_json_transport());
        assert!(profile.supports_reasoning_split());
    }

    #[test]
    fn text_fallback_stays_disabled_after_tool_calls_or_in_wander() {
        let profile = provider_profile_from_parts("openai", "https://api.openai.com/v1", "gpt-5");
        assert!(
            profile
                .turn_policy("chatroom", InteractiveToolChoice::Auto, false)
                .allow_text_fallback
        );
        assert!(
            !profile
                .turn_policy("chatroom", InteractiveToolChoice::Auto, true)
                .allow_text_fallback
        );
        assert!(
            !profile
                .turn_policy("wander", InteractiveToolChoice::Auto, false)
                .allow_text_fallback
        );
    }

    #[test]
    fn qwen_required_tool_choice_turn_policy_disables_thinking() {
        let profile =
            provider_profile_from_parts("openai", "https://api.ziz.hk/redbox/v1", "qwen3.5-plus");
        let policy = profile.turn_policy("redclaw", InteractiveToolChoice::Required, false);
        assert!(policy.disable_thinking);
    }

    #[test]
    fn deepseek_uses_thinking_object_disable_parameter() {
        let profile = provider_profile_from_parts(
            "openai",
            "https://api.ziz.hk/redbox/v1",
            "deepseek-v4-pro",
        );
        let mut body = json!({ "model": "deepseek-v4-pro" });
        profile.apply_disable_thinking_parameter(&mut body);
        assert_eq!(body.get("enable_thinking"), None);
        assert_eq!(body["thinking"], json!({ "type": "disabled" }));
    }

    #[test]
    fn agent_runtimes_disable_internal_thinking_by_default() {
        let profile = provider_profile_from_parts("openai", "https://api.openai.com/v1", "gpt-5");
        for runtime_mode in ["chatroom", "image-generation", "redclaw", "wander"] {
            assert!(
                profile
                    .turn_policy(runtime_mode, InteractiveToolChoice::Auto, false)
                    .disable_thinking,
                "{runtime_mode} should disable provider thinking"
            );
        }
        assert!(
            !profile
                .turn_policy("chat", InteractiveToolChoice::Auto, false)
                .disable_thinking
        );
    }
}
