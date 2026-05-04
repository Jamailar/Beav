use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{InteractiveToolChoice, ProviderTurnPolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderFamily {
    OpenAiCompat,
    MiniMax,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderThinkingDisableParameter {
    None,
    EnableThinkingFalse,
    ThinkingTypeDisabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCapabilities {
    pub supports_streaming: bool,
    pub supports_tool_choice_auto: bool,
    pub supports_tool_choice_required: bool,
    pub supports_tool_choice_none: bool,
    pub supports_thinking: bool,
    pub supports_reasoning_effort: bool,
    pub requires_disable_thinking_for_forced_tool_choice: bool,
    pub supports_usage_trailer: bool,
    pub supports_parallel_tool_calls: bool,
    pub supports_text_fallback: bool,
    pub thinking_disable_parameter: ProviderThinkingDisableParameter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderProfile {
    pub key: String,
    pub provider_family: ProviderFamily,
    pub capabilities: ProviderCapabilities,
}

impl ProviderProfile {
    pub(crate) fn is_minimax(&self) -> bool {
        matches!(self.provider_family, ProviderFamily::MiniMax)
    }

    pub(crate) fn prefers_http11_transport(&self) -> bool {
        self.is_minimax()
    }

    pub(crate) fn prefers_identity_encoding_for_streaming(&self) -> bool {
        self.is_minimax()
    }

    pub(crate) fn prefers_curl_json_transport(&self) -> bool {
        self.is_minimax()
    }

    pub(crate) fn supports_reasoning_split(&self) -> bool {
        self.is_minimax() && self.capabilities.supports_thinking
    }

    pub(crate) fn should_disable_thinking(
        &self,
        runtime_mode: &str,
        forcing_required_tool_choice: bool,
    ) -> bool {
        if matches!(
            runtime_mode,
            "team" | "chatroom" | "image-generation" | "redclaw" | "wander"
        ) {
            return true;
        }
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

    pub(crate) fn turn_policy(
        &self,
        runtime_mode: &str,
        tool_choice: InteractiveToolChoice,
        saw_tool_call: bool,
    ) -> ProviderTurnPolicy {
        ProviderTurnPolicy {
            disable_thinking: self
                .should_disable_thinking(runtime_mode, tool_choice.requires_tool_choice()),
            allow_text_fallback: !saw_tool_call
                && runtime_mode != "wander"
                && self.capabilities.supports_text_fallback,
        }
    }

    pub(crate) fn api_tool_choice_value(
        &self,
        tool_choice: InteractiveToolChoice,
    ) -> Option<&'static str> {
        let supported = match tool_choice {
            InteractiveToolChoice::Auto => self.capabilities.supports_tool_choice_auto,
            InteractiveToolChoice::Required => self.capabilities.supports_tool_choice_required,
            InteractiveToolChoice::None => self.capabilities.supports_tool_choice_none,
        };
        supported.then_some(tool_choice.as_api_value())
    }

    pub(crate) fn apply_disable_thinking_parameter(&self, body: &mut Value) {
        match self.capabilities.thinking_disable_parameter {
            ProviderThinkingDisableParameter::None => {}
            ProviderThinkingDisableParameter::EnableThinkingFalse => {
                body["enable_thinking"] = json!(false);
            }
            ProviderThinkingDisableParameter::ThinkingTypeDisabled => {
                body["thinking"] = json!({ "type": "disabled" });
            }
        }
    }
}
