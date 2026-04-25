use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli_runtime::{
    find_executable, CliEnvironmentRecord, CliExecuteRequest, CliExecutionMode,
    CliPermissionGrantSet,
};

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

fn push_unique_path(paths: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if value.trim().is_empty() || paths.iter().any(|item| item == &value) {
        return;
    }
    paths.push(value);
}

fn push_node_package_roots(paths: &mut Vec<String>, path: &Path) {
    let text = path.to_string_lossy();
    let Some((prefix, suffix)) = text.split_once("/node_modules/") else {
        if path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some("bin")
        {
            if let Some(root) = path.parent().and_then(Path::parent) {
                let node_modules = root.join("lib").join("node_modules");
                if node_modules.exists() {
                    push_unique_path(paths, node_modules.to_string_lossy().to_string());
                }
            }
        }
        return;
    };
    let mut parts = suffix.split('/').filter(|part| !part.is_empty());
    let Some(first) = parts.next() else {
        return;
    };
    let mut package_root = format!("{prefix}/node_modules/{first}");
    if first.starts_with('@') {
        if let Some(second) = parts.next() {
            package_root.push('/');
            package_root.push_str(second);
        }
    }
    push_unique_path(paths, format!("{prefix}/node_modules"));
    push_unique_path(paths, package_root);
}

fn push_path_and_canonical(paths: &mut Vec<String>, path: &Path) {
    if let Some(parent) = path.parent() {
        push_unique_path(paths, parent.to_string_lossy().to_string());
    }
    if path.is_dir() {
        push_unique_path(paths, path.to_string_lossy().to_string());
    }
    if let Ok(canonical) = fs::canonicalize(path) {
        if canonical.is_dir() {
            push_unique_path(paths, canonical.to_string_lossy().to_string());
        } else if let Some(parent) = canonical.parent() {
            push_unique_path(paths, parent.to_string_lossy().to_string());
        }
        push_node_package_roots(paths, &canonical);
    }
    push_node_package_roots(paths, path);
}

fn host_tool_read_paths(argv: &[String], env: &BTreeMap<String, String>) -> Vec<String> {
    let Some(command) = argv
        .first()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    else {
        return Vec::new();
    };
    let resolved = if command.contains('/') || command.contains('\\') {
        Some(std::path::PathBuf::from(command))
    } else {
        find_executable(command, env)
    };
    let mut paths = Vec::new();
    if let Some(path) = resolved {
        push_path_and_canonical(&mut paths, &path);
    }
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
    env: &BTreeMap<String, String>,
    permissions: &CliPermissionGrantSet,
) -> CliSandboxSpec {
    let execution_mode = request.execution_mode.clone().unwrap_or_default();
    let allow_network = permissions.network
        || request.argv.iter().any(|arg| {
            let lower = arg.trim().to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        });
    let mut allow_read_paths = vec![environment.root_path.clone()];
    let cwd_text = cwd.to_string_lossy().to_string();
    if !allow_read_paths.iter().any(|item| item == &cwd_text) {
        allow_read_paths.push(cwd_text.clone());
    }
    if execution_mode == CliExecutionMode::HostCompatible {
        allow_read_paths.extend(host_tool_read_paths(&request.argv, env));
    }
    allow_read_paths.sort();
    allow_read_paths.dedup();
    let mut allow_write_paths = vec![environment.root_path.clone(), cwd_text];
    allow_write_paths.extend(permissions.paths.iter().cloned());
    allow_write_paths.sort();
    allow_write_paths.dedup();
    CliSandboxSpec {
        backend: if execution_mode == CliExecutionMode::Unrestricted {
            "none".to_string()
        } else if macos_sandbox_available() {
            "sandbox-exec".to_string()
        } else {
            "policy".to_string()
        },
        mode: serde_json::to_value(&execution_mode)
            .ok()
            .and_then(|value| value.as_str().map(ToString::to_string))
            .unwrap_or_else(|| "host_compatible".to_string()),
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
    use crate::cli_runtime::{
        CliEnvironmentRecord, CliEnvironmentScope, CliPermissionGrantSet, CliRuntimeInventory,
    };

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
            &BTreeMap::new(),
            &CliPermissionGrantSet::default(),
        );
        if cfg!(target_os = "macos") {
            assert_eq!(spec.backend, "sandbox-exec");
        } else {
            assert_eq!(spec.backend, "policy");
        }
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
