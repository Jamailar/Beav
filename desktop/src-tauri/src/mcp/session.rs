use crate::{now_i64, McpServerRecord};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::resources::McpCapabilitySnapshot;
use super::transport::ManagedMcpTransport;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionSnapshot {
    pub key: String,
    pub server_id: String,
    pub server_name: String,
    pub transport: String,
    pub connection_strategy: String,
    pub initialized_at: i64,
    pub last_used_at: i64,
    pub call_count: u64,
    pub tool_count: usize,
    pub resource_count: usize,
    pub resource_template_count: usize,
}

pub struct McpSession {
    key: String,
    server: McpServerRecord,
    transport: ManagedMcpTransport,
    capabilities: McpCapabilitySnapshot,
    initialized_at: i64,
    last_used_at: i64,
    call_count: u64,
}

impl McpSession {
    pub fn connect(key: String, server: McpServerRecord) -> Result<Self, String> {
        let mut transport = ManagedMcpTransport::connect(server.clone())?;
        let capabilities = transport.load_capabilities()?;
        let timestamp = now_i64();
        Ok(Self {
            key,
            server,
            transport,
            capabilities,
            initialized_at: timestamp,
            last_used_at: timestamp,
            call_count: 0,
        })
    }

    pub fn invoke(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(cached) = self.capabilities.cached_response(method) {
            if method == "initialize" || self.transport.prefers_cached_capabilities() {
                self.touch();
                return Ok(cached);
            }
        }

        let response = self.transport.call(method, params)?;
        self.capabilities
            .apply_method_response(method, response.clone());
        self.touch();
        Ok(response)
    }

    pub fn capabilities(&self) -> McpCapabilitySnapshot {
        self.capabilities.clone()
    }

    pub fn snapshot(&self) -> McpSessionSnapshot {
        McpSessionSnapshot {
            key: self.key.clone(),
            server_id: self.server.id.clone(),
            server_name: self.server.name.clone(),
            transport: self.server.transport.clone(),
            connection_strategy: self.capabilities.connection_strategy.clone(),
            initialized_at: self.initialized_at,
            last_used_at: self.last_used_at,
            call_count: self.call_count,
            tool_count: self.capabilities.tool_count(),
            resource_count: self.capabilities.resource_count(),
            resource_template_count: self.capabilities.resource_template_count(),
        }
    }

    fn touch(&mut self) {
        self.call_count += 1;
        self.last_used_at = now_i64();
    }
}
