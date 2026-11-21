mod adapters;
mod catalog;
mod diagnostics;
mod endpoint;
mod model_fetch;
mod openai;
mod resolver;
mod types;

use std::fmt::{Display, Formatter};

use crate::InteractiveToolCall;

pub(crate) use catalog::{catalog_entry_for, provider_key_from_parts};
pub(crate) use endpoint::{model_list_candidates, resolve_endpoint};
pub(crate) use model_fetch::{fetch_models_blocking, FetchModelsInput};
pub(crate) use openai::{run_openai_provider_turn, should_prefer_non_streaming_openai_turn};
pub(crate) use resolver::resolve_provider_request;
pub(crate) use types::{
    AuthStrategy, CapabilityDeclaration, CapabilityScope, EndpointBaseKind, EndpointPolicy,
    ModelListPolicy, ProviderCatalogEntry, ProviderQuirk, ResolvedProviderRequest, RouteMode,
};

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
    pub reasoning_content: String,
    pub tool_calls: Vec<InteractiveToolCall>,
    pub delivery: ProviderTurnDelivery,
}
