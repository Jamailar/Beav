use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::hash::{DefaultHasher, Hash, Hasher};

use crate::McpServerRecord;

use super::tool_names::{qualify_mcp_tools, RawMcpToolIdentity};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpToolAvailability {
    Direct,
    Deferred,
}

impl Default for McpToolAvailability {
    fn default() -> Self {
        Self::Deferred
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub server_name: String,
    pub raw_tool_name: String,
    pub callable_name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub read_only: bool,
    pub destructive: bool,
    pub supports_parallel_tool_calls: bool,
    pub availability: McpToolAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSearchResult {
    pub kind: String,
    pub name: String,
    pub server_id: String,
    pub server_name: String,
    pub raw_tool_name: String,
    pub description: String,
    pub available_this_turn: bool,
    pub score: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInventorySnapshot {
    pub tools: Vec<McpToolInfo>,
    pub fingerprint: String,
}

pub fn inventory_from_tools_response(
    servers_and_responses: &[(McpServerRecord, Value)],
) -> McpToolInventorySnapshot {
    let mut raw_identities = Vec::<RawMcpToolIdentity>::new();
    let mut rows = Vec::<(McpServerRecord, Value)>::new();
    for (server, response) in servers_and_responses {
        for tool in response
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            raw_identities.push(RawMcpToolIdentity {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                tool_name: name.to_string(),
            });
            rows.push((server.clone(), tool));
        }
    }
    let qualified = qualify_mcp_tools(&raw_identities);
    let mut tools = Vec::<McpToolInfo>::new();
    for (server, tool) in rows {
        let raw_tool_name = tool
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let identity = RawMcpToolIdentity {
            server_id: server.id.clone(),
            server_name: server.name.clone(),
            tool_name: raw_tool_name.clone(),
        };
        let callable_name = qualified.get(&identity).cloned().unwrap_or_else(|| {
            super::tool_names::qualified_mcp_tool_name(&server.name, &raw_tool_name)
        });
        let supports_parallel_tool_calls =
            super::config::effective_server_config(&server).supports_parallel_tool_calls;
        tools.push(McpToolInfo {
            server_id: server.id,
            server_name: server.name,
            raw_tool_name,
            callable_name,
            title: tool
                .get("title")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            input_schema: tool
                .get("inputSchema")
                .or_else(|| tool.get("input_schema"))
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "additionalProperties": true })),
            read_only: tool
                .pointer("/annotations/readOnlyHint")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            destructive: tool
                .pointer("/annotations/destructiveHint")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            supports_parallel_tool_calls,
            availability: McpToolAvailability::Deferred,
        });
    }
    tools.sort_by(|left, right| left.callable_name.cmp(&right.callable_name));
    let fingerprint = mcp_tools_fingerprint(&tools);
    McpToolInventorySnapshot { tools, fingerprint }
}

pub fn mcp_tools_fingerprint(tools: &[McpToolInfo]) -> String {
    inventory_fingerprint(tools)
}

pub fn search_mcp_tools(
    direct: &[McpToolInfo],
    deferred: &[McpToolInfo],
    query: &str,
    limit: usize,
    include_direct: bool,
) -> Vec<McpToolSearchResult> {
    let tokens = tokenize(query);
    let mut results = Vec::new();
    if include_direct {
        results.extend(
            direct
                .iter()
                .filter_map(|tool| search_result(tool, true, &tokens)),
        );
    }
    results.extend(
        deferred
            .iter()
            .filter_map(|tool| search_result(tool, false, &tokens)),
    );
    results.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.available_this_turn.cmp(&a.available_this_turn))
            .then_with(|| a.name.cmp(&b.name))
    });
    results.truncate(limit.clamp(1, 50));
    results
}

fn search_result(
    tool: &McpToolInfo,
    available_this_turn: bool,
    tokens: &[String],
) -> Option<McpToolSearchResult> {
    let score = mcp_tool_score(tokens, tool)?;
    Some(McpToolSearchResult {
        kind: "mcp_tool".to_string(),
        name: tool.callable_name.clone(),
        server_id: tool.server_id.clone(),
        server_name: tool.server_name.clone(),
        raw_tool_name: tool.raw_tool_name.clone(),
        description: tool.description.clone().unwrap_or_default(),
        available_this_turn,
        score,
    })
}

fn mcp_tool_score(tokens: &[String], tool: &McpToolInfo) -> Option<usize> {
    if tokens.is_empty() {
        return Some(1);
    }
    let mut haystack = tokenize(&format!(
        "{} {} {} {}",
        tool.callable_name,
        tool.raw_tool_name,
        tool.server_name,
        tool.description.clone().unwrap_or_default()
    ));
    haystack.extend(
        schema_property_names(&tool.input_schema)
            .into_iter()
            .flat_map(|key| tokenize(&key)),
    );
    let haystack = haystack.into_iter().collect::<BTreeSet<_>>();
    let score = tokens
        .iter()
        .map(|token| {
            if tool.callable_name.to_ascii_lowercase().contains(token) {
                5
            } else if tool.raw_tool_name.to_ascii_lowercase().contains(token) {
                4
            } else if tool.server_name.to_ascii_lowercase().contains(token) {
                3
            } else if haystack.contains(token) {
                2
            } else {
                0
            }
        })
        .sum::<usize>();
    (score > 0).then_some(score)
}

fn schema_property_names(schema: &Value) -> Vec<String> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|object| object.keys().take(12).cloned().collect())
        .unwrap_or_default()
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| item.to_ascii_lowercase())
        .collect()
}

fn inventory_fingerprint(tools: &[McpToolInfo]) -> String {
    let mut hasher = DefaultHasher::new();
    for tool in tools {
        tool.server_id.hash(&mut hasher);
        tool.raw_tool_name.hash(&mut hasher);
        tool.callable_name.hash(&mut hasher);
        tool.input_schema.to_string().hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(id: &str, name: &str) -> McpServerRecord {
        McpServerRecord {
            id: id.to_string(),
            name: name.to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: None,
            args: None,
            env: None,
            cwd: None,
            url: None,
            oauth: None,
        }
    }

    #[test]
    fn inventory_parses_tools_and_keeps_raw_identity() {
        let snapshot = inventory_from_tools_response(&[(
            server("demo", "Demo"),
            json!({
                "result": {
                    "tools": [{
                        "name": "read",
                        "description": "Read a memo",
                        "inputSchema": {
                            "type": "object",
                            "properties": { "uri": { "type": "string" } }
                        }
                    }]
                }
            }),
        )]);
        assert_eq!(snapshot.tools.len(), 1);
        assert_eq!(snapshot.tools[0].server_id, "demo");
        assert_eq!(snapshot.tools[0].raw_tool_name, "read");
        assert_eq!(snapshot.tools[0].callable_name, "mcp__demo__read");
        assert_ne!(snapshot.fingerprint, "empty");
    }

    #[test]
    fn search_matches_schema_property_names() {
        let tool = McpToolInfo {
            callable_name: "mcp__demo__read".to_string(),
            raw_tool_name: "read".to_string(),
            server_name: "Demo".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { "uri": { "type": "string" } }
            }),
            ..McpToolInfo::default()
        };
        let results = search_mcp_tools(&[], &[tool], "uri", 5, false);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].kind, "mcp_tool");
    }
}
