#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InteractiveToolChoice {
    Auto,
    Required,
    None,
}

impl InteractiveToolChoice {
    pub(crate) fn as_api_value(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Required => "required",
            Self::None => "none",
        }
    }

    pub(crate) fn requires_tool_choice(self) -> bool {
        matches!(self, Self::Required)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderTurnPolicy {
    pub disable_thinking: bool,
    pub allow_text_fallback: bool,
}
