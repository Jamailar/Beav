use serde_json::Value;
use std::collections::BTreeSet;

use super::tool_inventory::{McpToolAvailability, McpToolInfo, McpToolInventorySnapshot};

pub const DEFAULT_MAX_DIRECT_MCP_TOOLS: usize = 0;
pub const DEFAULT_PINNED_DIRECT_MCP_TOOLS: usize = 8;
pub const DEFAULT_DEFER_SERVER_TOOL_COUNT: usize = 12;

#[derive(Debug, Clone, Default)]
pub struct McpToolExposure {
    pub direct_tools: Vec<McpToolInfo>,
    pub deferred_tools: Vec<McpToolInfo>,
    pub namespaces: Vec<String>,
    pub mode: String,
}

pub fn build_mcp_tool_exposure(
    snapshot: Option<&McpToolInventorySnapshot>,
    metadata: Option<&Value>,
) -> McpToolExposure {
    let Some(snapshot) = snapshot else {
        return McpToolExposure::default();
    };
    if snapshot.tools.is_empty() {
        return McpToolExposure::default();
    }
    let explicit_direct_budget = metadata
        .and_then(|value| value.get("maxDirectMcpTools"))
        .and_then(Value::as_u64);
    let pinned = metadata_string_list(metadata, "directMcpTools")
        .into_iter()
        .collect::<BTreeSet<_>>();
    let max_direct = explicit_direct_budget
        .map(|value| value.clamp(0, 128) as usize)
        .unwrap_or_else(|| {
            if pinned.is_empty() {
                DEFAULT_MAX_DIRECT_MCP_TOOLS
            } else {
                DEFAULT_PINNED_DIRECT_MCP_TOOLS
            }
        });
    let enabled_servers = metadata_string_list(metadata, "enabledMcpServers")
        .into_iter()
        .collect::<BTreeSet<_>>();
    let candidates = snapshot
        .tools
        .iter()
        .filter(|tool| enabled_servers.is_empty() || enabled_servers.contains(&tool.server_id))
        .cloned()
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return McpToolExposure::default();
    }
    let exceeds_direct_budget = candidates.len() > max_direct
        || server_tool_counts(&candidates)
            .into_iter()
            .any(|(_, count)| count > DEFAULT_DEFER_SERVER_TOOL_COUNT);
    let mut direct = Vec::<McpToolInfo>::new();
    let mut deferred = Vec::<McpToolInfo>::new();
    if explicit_direct_budget.is_some() && pinned.is_empty() && !exceeds_direct_budget {
        direct = candidates;
    } else {
        for tool in candidates {
            let is_pinned = pinned.contains(&tool.callable_name)
                || pinned.contains(&tool.raw_tool_name)
                || pinned.contains(&format!("{}:{}", tool.server_id, tool.raw_tool_name));
            if is_pinned && direct.len() < max_direct {
                direct.push(tool);
            } else {
                deferred.push(tool);
            }
        }
    }
    for tool in &mut direct {
        tool.availability = McpToolAvailability::Direct;
    }
    for tool in &mut deferred {
        tool.availability = McpToolAvailability::Deferred;
    }
    let namespaces = direct
        .iter()
        .chain(deferred.iter())
        .map(|tool| tool.server_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mode = match (direct.is_empty(), deferred.is_empty()) {
        (false, true) => "direct",
        (true, false) => "deferred",
        (false, false) => "mixed",
        (true, true) => "empty",
    };
    McpToolExposure {
        direct_tools: direct,
        deferred_tools: deferred,
        namespaces,
        mode: mode.to_string(),
    }
}

fn server_tool_counts(tools: &[McpToolInfo]) -> Vec<(String, usize)> {
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for tool in tools {
        *counts.entry(tool.server_id.clone()).or_default() += 1;
    }
    counts.into_iter().collect()
}

fn metadata_string_list(metadata: Option<&Value>, field: &str) -> Vec<String> {
    metadata
        .and_then(|item| item.get(field))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tool_inventory::McpToolInventorySnapshot;
    use serde_json::json;

    fn tool(name: &str) -> McpToolInfo {
        McpToolInfo {
            server_id: "demo".to_string(),
            server_name: "Demo".to_string(),
            raw_tool_name: name.to_string(),
            callable_name: format!("mcp__demo__{name}"),
            ..McpToolInfo::default()
        }
    }

    #[test]
    fn small_tool_set_is_deferred_by_default() {
        let snapshot = McpToolInventorySnapshot {
            tools: vec![tool("read"), tool("write")],
            fingerprint: "a".to_string(),
        };
        let exposure = build_mcp_tool_exposure(Some(&snapshot), None);
        assert!(exposure.direct_tools.is_empty());
        assert_eq!(exposure.deferred_tools.len(), 2);
        assert_eq!(exposure.mode, "deferred");
    }

    #[test]
    fn explicit_direct_budget_can_expose_small_tool_set() {
        let snapshot = McpToolInventorySnapshot {
            tools: vec![tool("read"), tool("write")],
            fingerprint: "a".to_string(),
        };
        let metadata = json!({ "maxDirectMcpTools": 4 });
        let exposure = build_mcp_tool_exposure(Some(&snapshot), Some(&metadata));
        assert_eq!(exposure.direct_tools.len(), 2);
        assert!(exposure.deferred_tools.is_empty());
        assert_eq!(exposure.mode, "direct");
    }

    #[test]
    fn large_tool_set_defers_unpinned_tools() {
        let snapshot = McpToolInventorySnapshot {
            tools: (0..30).map(|index| tool(&format!("t{index}"))).collect(),
            fingerprint: "a".to_string(),
        };
        let metadata = json!({ "directMcpTools": ["mcp__demo__t1"], "maxDirectMcpTools": 4 });
        let exposure = build_mcp_tool_exposure(Some(&snapshot), Some(&metadata));
        assert_eq!(exposure.direct_tools.len(), 1);
        assert_eq!(exposure.direct_tools[0].callable_name, "mcp__demo__t1");
        assert_eq!(exposure.deferred_tools.len(), 29);
        assert_eq!(exposure.mode, "mixed");
    }
}
