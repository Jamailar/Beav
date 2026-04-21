use crate::runtime::ResolvedChatConfig;

use super::{ProviderCapabilities, ProviderFamily, ProviderProfile};

fn openai_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        supports_streaming: true,
        supports_tool_choice_required: true,
        supports_tool_choice_none: true,
        supports_thinking: true,
        supports_reasoning_effort: true,
        requires_disable_thinking_for_forced_tool_choice: false,
        supports_usage_trailer: true,
        supports_parallel_tool_calls: true,
        supports_text_fallback: true,
    }
}

fn qwen_compat_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        requires_disable_thinking_for_forced_tool_choice: true,
        ..openai_capabilities()
    }
}

fn anthropic_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        supports_streaming: true,
        supports_tool_choice_required: false,
        supports_tool_choice_none: false,
        supports_thinking: true,
        supports_reasoning_effort: false,
        requires_disable_thinking_for_forced_tool_choice: false,
        supports_usage_trailer: false,
        supports_parallel_tool_calls: true,
        supports_text_fallback: false,
    }
}

fn gemini_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        supports_streaming: true,
        supports_tool_choice_required: false,
        supports_tool_choice_none: false,
        supports_thinking: true,
        supports_reasoning_effort: false,
        requires_disable_thinking_for_forced_tool_choice: false,
        supports_usage_trailer: false,
        supports_parallel_tool_calls: true,
        supports_text_fallback: false,
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
            let capabilities = if lower_hint.contains("qwen") || lower_hint.contains("dashscope") {
                qwen_compat_capabilities()
            } else {
                openai_capabilities()
            };
            ProviderProfile {
                key: normalized_provider_key(protocol, base_url, model_name),
                provider_family: ProviderFamily::OpenAiCompat,
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
    use crate::provider_compat::ProviderFamily;

    #[test]
    fn qwen_profiles_disable_thinking_for_required_tool_choice() {
        let profile = provider_profile_from_parts(
            "openai",
            "https://api.ziz.hk/redbox/v1",
            "qwen3.5-plus",
        );
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
        assert!(!profile.should_disable_thinking("chat", true));
        assert!(profile.capabilities.supports_tool_choice_required);
    }
}
