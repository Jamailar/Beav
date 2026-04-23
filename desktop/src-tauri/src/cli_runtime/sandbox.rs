use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli_runtime::{CliEnvironmentRecord, CliExecuteRequest};

const MACOS_SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";

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

#[derive(Debug, Clone)]
pub struct CliLaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

fn macos_sandbox_available() -> bool {
    cfg!(target_os = "macos") && Path::new(MACOS_SANDBOX_EXEC_PATH).exists()
}

fn profile_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn canonical_read_paths(spec: &CliSandboxSpec, env: &BTreeMap<String, String>) -> Vec<String> {
    let mut paths = vec![
        "/bin".to_string(),
        "/usr".to_string(),
        "/System".to_string(),
        "/dev".to_string(),
        "/private/tmp".to_string(),
        "/tmp".to_string(),
        "/var".to_string(),
        spec.root_path.clone(),
    ];
    paths.extend(spec.allow_read_paths.iter().cloned());
    if let Some(path_value) = env.get("PATH") {
        paths.extend(
            std::env::split_paths(path_value)
                .map(|path| path.to_string_lossy().to_string())
                .filter(|path| !path.trim().is_empty()),
        );
    }
    paths.sort();
    paths.dedup();
    paths
}

fn build_macos_sandbox_profile(spec: &CliSandboxSpec, env: &BTreeMap<String, String>) -> String {
    let mut lines = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(import \"system.sb\")".to_string(),
        "(allow process-exec)".to_string(),
        "(allow process-fork)".to_string(),
        "(allow signal (target self))".to_string(),
        "(allow sysctl-read)".to_string(),
    ];
    for path in canonical_read_paths(spec, env) {
        lines.push(format!(
            "(allow file-read* (subpath \"{}\"))",
            profile_escape(&path)
        ));
    }
    for path in &spec.allow_write_paths {
        lines.push(format!(
            "(allow file-write* (subpath \"{}\"))",
            profile_escape(path)
        ));
    }
    if spec.allow_network {
        lines.push("(allow network-outbound)".to_string());
        lines.push("(allow network-inbound (local ip))".to_string());
    }
    lines.join("\n")
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
        backend: if macos_sandbox_available() {
            "sandbox-exec".to_string()
        } else {
            "policy".to_string()
        },
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

pub fn prepare_cli_launch(
    spec: &CliSandboxSpec,
    argv: &[String],
    env: &BTreeMap<String, String>,
) -> Result<CliLaunchPlan, String> {
    let program = argv
        .first()
        .cloned()
        .ok_or_else(|| "cli execute requires argv[0]".to_string())?;
    if spec.backend == "sandbox-exec" && macos_sandbox_available() {
        let profile = build_macos_sandbox_profile(spec, env);
        return Ok(CliLaunchPlan {
            program: MACOS_SANDBOX_EXEC_PATH.to_string(),
            args: std::iter::once("-p".to_string())
                .chain(std::iter::once(profile))
                .chain(std::iter::once(program))
                .chain(argv.iter().skip(1).cloned())
                .collect(),
            env: env.clone(),
        });
    }
    Ok(CliLaunchPlan {
        program,
        args: argv.iter().skip(1).cloned().collect(),
        env: env.clone(),
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

    #[test]
    fn prepare_cli_launch_wraps_command_when_macos_sandbox_is_available() {
        let spec = CliSandboxSpec {
            backend: if cfg!(target_os = "macos") {
                "sandbox-exec".to_string()
            } else {
                "policy".to_string()
            },
            mode: "managed".to_string(),
            root_path: "/tmp/redbox-env".to_string(),
            allow_read_paths: vec!["/tmp/redbox-env".to_string()],
            allow_write_paths: vec!["/tmp/redbox-env".to_string()],
            allow_network: false,
            metadata: None,
        };
        let mut env = BTreeMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        let plan = prepare_cli_launch(&spec, &["echo".to_string(), "hello".to_string()], &env)
            .expect("launch plan should build");
        if cfg!(target_os = "macos") {
            assert_eq!(plan.program, MACOS_SANDBOX_EXEC_PATH);
            assert_eq!(plan.args.first().map(String::as_str), Some("-p"));
        } else {
            assert_eq!(plan.program, "echo");
            assert_eq!(plan.args, vec!["hello".to_string()]);
        }
    }
}
