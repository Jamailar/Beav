use serde_json::Value;
use std::collections::BTreeSet;

use super::tool_inventory::{McpToolAvailability, McpToolInfo, McpToolInventorySnapshot};

pub const DEFAULT_MAX_DIRECT_MCP_TOOLS: usize = 24;
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
    let max_direct = metadata
        .and_then(|value| value.get("maxDirectMcpTools"))
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 128) as usize)
        .unwrap_or(DEFAULT_MAX_DIRECT_MCP_TOOLS);
    let pinned = metadata_string_list(metadata, "directMcpTools")
        .into_iter()
        .collect::<BTreeSet<_>>();
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
    let defer_large = candidates.len() > max_direct
        || server_tool_counts(&candidates)
            .into_iter()
            .any(|(_, count)| count > DEFAULT_DEFER_SERVER_TOOL_COUNT);
    let mut direct = Vec::<McpToolInfo>::new();
    let mut deferred = Vec::<McpToolInfo>::new();
    if !defer_large {
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
    McpToolExposure {
        direct_tools: direct,
        deferred_tools: deferred,
        namespaces,
        mode: if defer_large {
            "deferred".to_string()
        } else {
            "direct".to_string()
        },
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
    fn small_tool_set_is_direct() {
        let snapshot = McpToolInventorySnapshot {
            tools: vec![tool("read"), tool("write")],
            fingerprint: "a".to_string(),
        };
        let exposure = build_mcp_tool_exposure(Some(&snapshot), None);
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
        assert_eq!(exposure.mode, "deferred");
    }
}
