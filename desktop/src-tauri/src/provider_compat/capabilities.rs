use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderFamily {
    OpenAiCompat,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCapabilities {
    pub supports_streaming: bool,
    pub supports_tool_choice_required: bool,
    pub supports_tool_choice_none: bool,
    pub supports_thinking: bool,
    pub supports_reasoning_effort: bool,
    pub requires_disable_thinking_for_forced_tool_choice: bool,
    pub supports_usage_trailer: bool,
    pub supports_parallel_tool_calls: bool,
    pub supports_text_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderProfile {
    pub key: String,
    pub provider_family: ProviderFamily,
    pub capabilities: ProviderCapabilities,
}

impl ProviderProfile {
    pub(crate) fn should_disable_thinking(
        &self,
        runtime_mode: &str,
        forcing_required_tool_choice: bool,
    ) -> bool {
        if !self.capabilities.supports_thinking {
            return true;
        }
        if runtime_mode == "wander"
            && self
                .capabilities
                .requires_disable_thinking_for_forced_tool_choice
        {
            return true;
        }
        forcing_required_tool_choice
            && self
                .capabilities
                .requires_disable_thinking_for_forced_tool_choice
    }
}
