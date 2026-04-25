use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::McpServerRecord;
use crate::{payload_string, slug_from_relative_path};

use super::team_server::team_mcp_tool_contracts;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMcpBridgeConfig {
    pub server: McpServerRecord,
    pub acp_config: Value,
    pub tool_names: Vec<String>,
    pub status: String,
    pub note: String,
}

pub fn build_team_mcp_bridge_config(payload: &Value) -> TeamMcpBridgeConfig {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let member_id = payload_string(payload, "memberId").unwrap_or_default();
    let command =
        payload_string(payload, "command").unwrap_or_else(|| "redbox-team-mcp".to_string());
    let server_name = if member_id.is_empty() {
        "redbox-team".to_string()
    } else {
        format!("redbox-team-{}", slug_from_relative_path(&member_id))
    };
    let mut env = HashMap::<String, String>::new();
    env.insert("REDBOX_TEAM_SESSION_ID".to_string(), session_id.clone());
    env.insert("REDBOX_TEAM_MEMBER_ID".to_string(), member_id.clone());
    if let Some(task_id) = payload_string(payload, "taskId") {
        env.insert("REDBOX_TEAM_TASK_ID".to_string(), task_id);
    }
    if let Some(endpoint) = payload_string(payload, "endpoint") {
        env.insert("REDBOX_HOST_ENDPOINT".to_string(), endpoint);
    }
    let server = McpServerRecord {
        id: format!("mcp-{}", slug_from_relative_path(&server_name)),
        name: server_name.clone(),
        enabled: true,
        transport: "stdio".to_string(),
        command: Some(command.clone()),
        args: Some(payload_string(payload, "args").map_or_else(Vec::new, |value| vec![value])),
        env: Some(env.clone()),
        url: None,
        oauth: None,
    };
    let tool_names = team_mcp_tool_contracts()
        .into_iter()
        .map(|tool| tool.name.to_string())
        .collect::<Vec<_>>();
    TeamMcpBridgeConfig {
        acp_config: json!({
            "mcpServers": {
                server_name: {
                    "command": command,
                    "args": server.args.clone().unwrap_or_default(),
                    "env": env,
                }
            }
        }),
        server,
        tool_names,
        status: "contract_ready".to_string(),
        note: "This config is ready for ACP backends that can spawn a redbox-team-mcp stdio bridge. The host-side tool contract and action mapping are implemented in-process.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn team_mcp_bridge_config_carries_member_context() {
        let config = build_team_mcp_bridge_config(&json!({
            "sessionId": "collab-session-1",
            "memberId": "member-1",
            "taskId": "task-1",
            "command": "redbox-team-mcp-test"
        }));
        assert_eq!(
            config
                .server
                .env
                .as_ref()
                .and_then(|env| env.get("REDBOX_TEAM_SESSION_ID"))
                .map(String::as_str),
            Some("collab-session-1")
        );
        assert_eq!(
            config.server.command.as_deref(),
            Some("redbox-team-mcp-test")
        );
        assert!(config.tool_names.contains(&"team_send_message".to_string()));
    }
}
