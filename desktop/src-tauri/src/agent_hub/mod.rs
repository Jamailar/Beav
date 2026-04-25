use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

mod acp_runner;

pub use acp_runner::start_external_acp_member_run;

use crate::cli_runtime::{detect_tool_with_managed_paths, CliToolHealth};
use crate::AppStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendDescriptor {
    pub id: String,
    pub label: String,
    pub source_kind: String,
    pub backend: String,
    pub status: String,
    pub capabilities: Vec<String>,
    pub desired_current_config: Value,
}

pub fn list_agent_backends(_store: &AppStore) -> Vec<AgentBackendDescriptor> {
    let mut backends = vec![
        AgentBackendDescriptor {
            id: "internal-runtime".to_string(),
            label: "RedBox Internal Runtime".to_string(),
            source_kind: "internal_runtime".to_string(),
            backend: "redbox-runtime".to_string(),
            status: "available".to_string(),
            capabilities: vec![
                "runtime_tasks".to_string(),
                "team_tools".to_string(),
                "mailbox".to_string(),
            ],
            desired_current_config: json!({
                "desired": {},
                "current": {},
                "reassertOnWake": true
            }),
        },
        AgentBackendDescriptor {
            id: "external-acp-contract".to_string(),
            label: "External ACP Adapter Contract".to_string(),
            source_kind: "external_acp".to_string(),
            backend: "acp".to_string(),
            status: "adapter_contract_ready".to_string(),
            capabilities: vec![
                "desired_current_config".to_string(),
                "idle_suspended".to_string(),
                "team_mcp_contract".to_string(),
            ],
            desired_current_config: json!({
                "desired": {},
                "current": null,
                "reassertOnReconnect": true,
                "idleExitStatus": "suspended"
            }),
        },
    ];
    backends.extend(detected_acp_cli_backends());
    backends
}

fn detected_acp_cli_backends() -> Vec<AgentBackendDescriptor> {
    let env = std::env::vars().collect::<BTreeMap<_, _>>();
    [
        ("aionrs", "AionRS ACP CLI", "aionrs"),
        ("codex", "Codex CLI", "codex"),
        ("gemini", "Gemini CLI", "gemini"),
        ("claude", "Claude CLI", "claude"),
    ]
    .into_iter()
    .map(|(command, label, backend)| {
        let detected = detect_tool_with_managed_paths(command, &env, None, false);
        let is_ready = detected.health == CliToolHealth::Ready;
        AgentBackendDescriptor {
            id: format!("external-acp-{backend}"),
            label: label.to_string(),
            source_kind: "external_acp".to_string(),
            backend: backend.to_string(),
            status: if is_ready {
                "available".to_string()
            } else {
                "missing".to_string()
            },
            capabilities: vec![
                "acp_process".to_string(),
                "team_mcp_contract".to_string(),
                "desired_current_config".to_string(),
                "idle_suspended".to_string(),
            ],
            desired_current_config: json!({
                "desired": {
                    "command": command,
                    "teamMcpServer": "redbox-team",
                },
                "current": {
                    "resolvedPath": detected.resolved_path,
                    "version": detected.version,
                    "health": detected.health,
                },
                "reassertOnReconnect": true,
                "idleExitStatus": "suspended"
            }),
        }
    })
    .collect()
}
