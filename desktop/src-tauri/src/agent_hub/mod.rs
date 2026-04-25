use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

mod acp_runner;

pub use acp_runner::start_external_acp_member_run;

use crate::cli_runtime::{
    discover_all_commands, load_host_shell_env, CliToolHealth, CliToolManifestRecord, CliToolRecord,
};
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
    let mut backends = vec![AgentBackendDescriptor {
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
    }];
    backends.extend(discover_agent_cli_backends(_store));
    backends
}

fn discover_agent_cli_backends(store: &AppStore) -> Vec<AgentBackendDescriptor> {
    let env =
        load_host_shell_env().unwrap_or_else(|_| std::env::vars().collect::<BTreeMap<_, _>>());
    let mut candidates = discover_all_commands(&env, None, 500);
    candidates.extend(store.cli_tools.iter().cloned());

    let mut seen = BTreeSet::<String>::new();
    let mut descriptors = Vec::<AgentBackendDescriptor>::new();
    for tool in candidates {
        if tool.health != CliToolHealth::Ready {
            continue;
        }
        let command = tool.executable.trim();
        if command.is_empty() || !seen.insert(command.to_ascii_lowercase()) {
            continue;
        }
        let manifest = store.cli_manifests.iter().find(|manifest| {
            manifest.tool_name == tool.name || manifest.tool_name == tool.executable
        });
        if !looks_like_agent_cli(&tool, manifest) {
            continue;
        }
        descriptors.push(agent_cli_backend_descriptor(&tool));
    }
    descriptors.sort_by(|left, right| left.label.cmp(&right.label));
    descriptors
}

fn agent_cli_backend_descriptor(tool: &CliToolRecord) -> AgentBackendDescriptor {
    let backend = tool.executable.trim().to_string();
    AgentBackendDescriptor {
        id: format!(
            "external-agent-cli-{}",
            backend.replace(|ch: char| !ch.is_ascii_alphanumeric(), "-")
        ),
        label: format!("{} CLI", tool.name),
        source_kind: "external_acp".to_string(),
        backend: backend.clone(),
        status: "available".to_string(),
        capabilities: vec![
            "agent_cli_process".to_string(),
            "team_mcp_contract".to_string(),
            "desired_current_config".to_string(),
            "idle_suspended".to_string(),
        ],
        desired_current_config: json!({
            "desired": {
                "command": backend,
                "teamMcpServer": "redbox-team",
            },
            "current": {
                "resolvedPath": tool.resolved_path,
                "version": tool.version,
                "health": tool.health,
                "source": tool.source,
                "environmentId": tool.environment_id,
            },
            "reassertOnReconnect": true,
            "idleExitStatus": "suspended"
        }),
    }
}

fn looks_like_agent_cli(tool: &CliToolRecord, manifest: Option<&CliToolManifestRecord>) -> bool {
    let mut haystack = format!("{} {}", tool.name, tool.executable).to_ascii_lowercase();
    if let Some(metadata) = tool.metadata.as_ref() {
        haystack.push(' ');
        haystack.push_str(&metadata.to_string().to_ascii_lowercase());
    }
    if let Some(manifest) = manifest {
        if let Some(help) = manifest.help_excerpt.as_ref() {
            haystack.push(' ');
            haystack.push_str(&help.to_ascii_lowercase());
        }
        for command in &manifest.commands {
            haystack.push(' ');
            haystack.push_str(&command.name.to_ascii_lowercase());
            haystack.push(' ');
            haystack.push_str(&command.summary.to_ascii_lowercase());
        }
    }
    [
        "agent",
        "assistant",
        " ai ",
        "-ai",
        "_ai",
        "llm",
        "chatbot",
        "chat model",
        "language model",
        "prompt",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::cli_runtime::{CliToolHealth, CliToolSource};

    fn ready_tool(name: &str) -> CliToolRecord {
        CliToolRecord {
            id: format!("cli-tool-{name}"),
            name: name.to_string(),
            executable: name.to_string(),
            health: CliToolHealth::Ready,
            source: CliToolSource::System,
            resolved_path: Some(format!("/tmp/{name}")),
            ..CliToolRecord::default()
        }
    }

    #[test]
    fn agent_cli_detection_uses_generic_signals_not_fixed_brands() {
        let mut tool = ready_tool("local-helper");
        tool.metadata =
            Some(json!({ "category": "agent cli", "description": "local AI assistant" }));
        assert!(looks_like_agent_cli(&tool, None));
        assert!(!looks_like_agent_cli(&ready_tool("ffmpeg"), None));
    }
}
