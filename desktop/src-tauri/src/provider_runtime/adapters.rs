#![allow(dead_code)]

use super::catalog::adapter_key_for;
use super::{CapabilityScope, ResolvedProviderRequest};
use crate::runtime::ProviderWireApi;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdapterDescriptor {
    pub key: String,
    pub scope: CapabilityScope,
    pub wire_api: ProviderWireApi,
}

pub(crate) fn descriptor_for_request(request: &ResolvedProviderRequest) -> AdapterDescriptor {
    AdapterDescriptor {
        key: adapter_key_for(
            request.scope,
            request.wire_api,
            request.provider_template.as_deref(),
        ),
        scope: request.scope,
        wire_api: request.wire_api,
    }
}
