use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

use crate::McpServerRecord;

pub const DEFAULT_MCP_STARTUP_TIMEOUT_MS: u64 = 15_000;
pub const DEFAULT_MCP_TOOL_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpToolApprovalMode {
    Never,
    Destructive,
    Always,
}

impl Default for McpToolApprovalMode {
    fn default() -> Self {
        Self::Destructive
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolPolicy {
    pub approval_mode: McpToolApprovalMode,
    pub enabled_tools: Vec<String>,
    pub disabled_tools: Vec<String>,
    pub per_tool: BTreeMap<String, McpPerToolPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpPerToolPolicy {
    pub approval_mode: Option<McpToolApprovalMode>,
    pub enabled: Option<bool>,
    pub tool_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpEffectiveServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub required: bool,
    pub startup_timeout_ms: u64,
    pub tool_timeout_ms: u64,
    pub supports_parallel_tool_calls: bool,
    pub elicitation_pauses_timeout: bool,
    pub policy: McpToolPolicy,
}

pub fn effective_server_config(server: &McpServerRecord) -> McpEffectiveServerConfig {
    let root_policy = server.oauth.as_ref().and_then(|value| {
        value
            .get("redbox")
            .or_else(|| value.get("policy"))
            .or_else(|| value.get("mcp"))
    });
    let required = bool_field(root_policy, "required").unwrap_or(false);
    let startup_timeout_ms =
        u64_field(root_policy, "startupTimeoutMs").unwrap_or(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    let tool_timeout_ms =
        u64_field(root_policy, "toolTimeoutMs").unwrap_or(DEFAULT_MCP_TOOL_TIMEOUT_MS);
    let supports_parallel_tool_calls =
        bool_field(root_policy, "supportsParallelToolCalls").unwrap_or(true);
    let elicitation_pauses_timeout =
        bool_field(root_policy, "elicitationPausesTimeout").unwrap_or(true);
    let approval_mode = string_field(root_policy, "approvalMode")
        .or_else(|| string_field(root_policy, "defaultToolsApprovalMode"))
        .map(|value| approval_mode_from_str(&value))
        .unwrap_or_default();
    let enabled_tools = string_list_field(root_policy, "enabledTools");
    let disabled_tools = string_list_field(root_policy, "disabledTools");
    let per_tool = per_tool_policy_field(root_policy);

    McpEffectiveServerConfig {
        id: server.id.clone(),
        name: server.name.clone(),
        enabled: server.enabled,
        required,
        startup_timeout_ms: startup_timeout_ms.clamp(1_000, 300_000),
        tool_timeout_ms: tool_timeout_ms.clamp(1_000, 600_000),
        supports_parallel_tool_calls,
        elicitation_pauses_timeout,
        policy: McpToolPolicy {
            approval_mode,
            enabled_tools,
            disabled_tools,
            per_tool,
        },
    }
}

pub fn effective_server_records(servers: &[McpServerRecord]) -> Vec<McpServerRecord> {
    servers
        .iter()
        .filter(|server| effective_server_config(server).enabled)
        .cloned()
        .collect()
}

pub fn mcp_tool_allowed(server: &McpServerRecord, raw_tool_name: &str) -> bool {
    let config = effective_server_config(server);
    let enabled = normalized_set(&config.policy.enabled_tools);
    let disabled = normalized_set(&config.policy.disabled_tools);
    let name = normalize_tool_policy_name(raw_tool_name);
    if let Some(policy) = config.policy.per_tool.get(&name) {
        if policy.enabled == Some(false) {
            return false;
        }
    }
    if !enabled.is_empty() && !enabled.contains(&name) {
        return false;
    }
    !disabled.contains(&name)
}

pub fn mcp_tool_requires_approval(
    server: &McpServerRecord,
    raw_tool_name: &str,
    destructive: bool,
) -> bool {
    let config = effective_server_config(server);
    if !mcp_tool_allowed(server, raw_tool_name) {
        return true;
    }
    let name = normalize_tool_policy_name(raw_tool_name);
    let approval_mode = config
        .policy
        .per_tool
        .get(&name)
        .and_then(|policy| policy.approval_mode.clone())
        .unwrap_or(config.policy.approval_mode);
    match approval_mode {
        McpToolApprovalMode::Never => false,
        McpToolApprovalMode::Destructive => destructive,
        McpToolApprovalMode::Always => true,
    }
}

pub fn mcp_tool_timeout_ms(server: &McpServerRecord, raw_tool_name: &str) -> u64 {
    let config = effective_server_config(server);
    let name = normalize_tool_policy_name(raw_tool_name);
    config
        .policy
        .per_tool
        .get(&name)
        .and_then(|policy| policy.tool_timeout_ms)
        .unwrap_or(config.tool_timeout_ms)
        .clamp(1_000, 600_000)
}

pub fn effective_servers_value(servers: &[McpServerRecord]) -> Value {
    json!(
        servers
            .iter()
            .map(effective_server_config)
            .collect::<Vec<_>>()
    )
}

fn bool_field(root: Option<&Value>, field: &str) -> Option<bool> {
    root.and_then(|value| value.get(field))
        .and_then(Value::as_bool)
}

fn u64_field(root: Option<&Value>, field: &str) -> Option<u64> {
    root.and_then(|value| value.get(field))
        .and_then(Value::as_u64)
}

fn string_field(root: Option<&Value>, field: &str) -> Option<String> {
    root.and_then(|value| value.get(field))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn string_list_field(root: Option<&Value>, field: &str) -> Vec<String> {
    root.and_then(|value| value.get(field))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn per_tool_policy_field(root: Option<&Value>) -> BTreeMap<String, McpPerToolPolicy> {
    let Some(object) = root
        .and_then(|value| value.get("perTool").or_else(|| value.get("per_tool")))
        .and_then(Value::as_object)
    else {
        return BTreeMap::new();
    };
    object
        .iter()
        .filter_map(|(raw_name, value)| {
            let name = normalize_tool_policy_name(raw_name);
            if name.is_empty() {
                return None;
            }
            let policy = if let Some(mode) = value.as_str() {
                McpPerToolPolicy {
                    approval_mode: Some(approval_mode_from_str(mode)),
                    enabled: None,
                    tool_timeout_ms: None,
                }
            } else if let Some(object) = value.as_object() {
                McpPerToolPolicy {
                    approval_mode: object
                        .get("approvalMode")
                        .or_else(|| object.get("defaultToolsApprovalMode"))
                        .and_then(Value::as_str)
                        .map(approval_mode_from_str),
                    enabled: object.get("enabled").and_then(Value::as_bool),
                    tool_timeout_ms: object
                        .get("toolTimeoutMs")
                        .and_then(Value::as_u64)
                        .map(|value| value.clamp(1_000, 600_000)),
                }
            } else {
                return None;
            };
            Some((name, policy))
        })
        .collect()
}

fn approval_mode_from_str(value: &str) -> McpToolApprovalMode {
    match value.trim().to_ascii_lowercase().as_str() {
        "never" | "none" | "trusted" => McpToolApprovalMode::Never,
        "always" | "require" | "required" => McpToolApprovalMode::Always,
        _ => McpToolApprovalMode::Destructive,
    }
}

fn normalized_set(items: &[String]) -> BTreeSet<String> {
    items
        .iter()
        .map(|item| normalize_tool_policy_name(item))
        .filter(|item| !item.is_empty())
        .collect()
}

fn normalize_tool_policy_name(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(oauth: Option<Value>) -> McpServerRecord {
        McpServerRecord {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: Some("node".to_string()),
            args: None,
            env: None,
            cwd: None,
            url: None,
            oauth,
        }
    }

    #[test]
    fn effective_config_reads_redbox_policy_from_oauth() {
        let server = server(Some(json!({
            "enabled": true,
            "redbox": {
                "required": true,
                "toolTimeoutMs": 45000,
                "approvalMode": "always",
                "enabledTools": ["read"],
                "disabledTools": ["write"],
                "perTool": {
                    "read": { "approvalMode": "never", "toolTimeoutMs": 3000 },
                    "danger": "always"
                }
            }
        })));
        let config = effective_server_config(&server);
        assert!(config.required);
        assert_eq!(config.tool_timeout_ms, 45_000);
        assert_eq!(config.policy.approval_mode, McpToolApprovalMode::Always);
        assert!(mcp_tool_allowed(&server, "read"));
        assert!(!mcp_tool_allowed(&server, "write"));
        assert!(!mcp_tool_allowed(&server, "other"));
        assert_eq!(mcp_tool_timeout_ms(&server, "read"), 3_000);
        assert!(!mcp_tool_requires_approval(&server, "read", false));
        assert!(mcp_tool_requires_approval(&server, "danger", false));
    }

    #[test]
    fn destructive_tools_require_approval_by_default() {
        let server = server(None);
        assert!(mcp_tool_requires_approval(&server, "write", true));
        assert!(!mcp_tool_requires_approval(&server, "read", false));
    }
}
