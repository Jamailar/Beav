use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli_runtime::{CliEnvironmentRecord, CliExecuteRequest};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliSandboxSpec {
    pub backend: String,
    pub mode: String,
    pub root_path: String,
    pub allow_read_paths: Vec<String>,
    pub allow_write_paths: Vec<String>,
    pub allow_network: bool,
    pub metadata: Option<Value>,
}

pub fn build_cli_sandbox_spec(
    request: &CliExecuteRequest,
    environment: &CliEnvironmentRecord,
    cwd: &Path,
) -> CliSandboxSpec {
    let allow_network = request.argv.iter().any(|arg| {
        let lower = arg.trim().to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://")
    });
    let mut allow_read_paths = vec![environment.root_path.clone()];
    let cwd_text = cwd.to_string_lossy().to_string();
    if !allow_read_paths.iter().any(|item| item == &cwd_text) {
        allow_read_paths.push(cwd_text.clone());
    }
    let allow_write_paths = vec![environment.root_path.clone(), cwd_text];
    CliSandboxSpec {
        backend: "policy".to_string(),
        mode: "managed".to_string(),
        root_path: environment.root_path.clone(),
        allow_read_paths,
        allow_write_paths,
        allow_network,
        metadata: Some(json!({
            "environmentScope": environment.scope,
            "usePty": request.use_pty,
            "taskId": request.task_id,
        })),
    }
}

pub fn sandbox_metadata(spec: &CliSandboxSpec) -> Value {
    json!({
        "backend": spec.backend,
        "mode": spec.mode,
        "rootPath": spec.root_path,
        "allowReadPaths": spec.allow_read_paths,
        "allowWritePaths": spec.allow_write_paths,
        "allowNetwork": spec.allow_network,
        "metadata": spec.metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runtime::{CliEnvironmentRecord, CliEnvironmentScope, CliRuntimeInventory};

    #[test]
    fn build_cli_sandbox_spec_tracks_environment_root() {
        let environment = CliEnvironmentRecord {
            id: "env-1".to_string(),
            scope: CliEnvironmentScope::WorkspaceLocal,
            root_path: "/tmp/redbox-env".to_string(),
            workspace_root: None,
            path_entries: Vec::new(),
            runtimes: CliRuntimeInventory::default(),
            installed_tool_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            metadata: None,
        };
        let spec = build_cli_sandbox_spec(
            &CliExecuteRequest::default(),
            &environment,
            Path::new("/tmp/redbox-env/project"),
        );
        assert_eq!(spec.backend, "policy");
        assert!(spec
            .allow_write_paths
            .iter()
            .any(|item| item.contains("project")));
    }
}
