#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use super::CapabilityScope;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealthSnapshot {
    pub source_id: String,
    pub scope: Option<CapabilityScope>,
    pub last_success_at: Option<String>,
    pub last_error_at: Option<String>,
    pub last_error_kind: Option<String>,
    pub last_endpoint: Option<String>,
    pub consecutive_failures: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDiagnosticEvent {
    pub source_id: String,
    pub scope: CapabilityScope,
    pub provider_key: String,
    pub adapter_key: String,
    pub endpoint: String,
    pub status: String,
    pub error_kind: Option<String>,
    pub message: Option<String>,
}
