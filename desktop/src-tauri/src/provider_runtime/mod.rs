mod openai;

use std::fmt::{Display, Formatter};

use crate::InteractiveToolCall;

pub(crate) use openai::run_openai_provider_turn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderErrorKind {
    Auth,
    RateLimit,
    Transport,
    Protocol,
    InvalidRequest,
    Recovery,
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderError {
    pub kind: ProviderErrorKind,
    pub retryable: bool,
    pub message: String,
}

impl ProviderError {
    pub(crate) fn new(
        kind: ProviderErrorKind,
        retryable: bool,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            retryable,
            message: message.into(),
        }
    }
}

impl Display for ProviderError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderTurnDelivery {
    Streaming,
    JsonFallback,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderTurnResult {
    pub content: String,
    pub tool_calls: Vec<InteractiveToolCall>,
    pub delivery: ProviderTurnDelivery,
}
