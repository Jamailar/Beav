use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cli_runtime::{
    CliEnvironmentRecord, CliExecuteRequest, CliExecutionMode, CliPermissionGrantSet,
    find_executable,
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
        "/etc".to_string(),
        "/private/etc".to_string(),
        "/private/tmp".to_string(),
        "/private/var".to_string(),
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

fn parent_metadata_paths(paths: &[String]) -> Vec<String> {
    let mut metadata_paths = Vec::new();
    for path in paths {
        for ancestor in Path::new(path).ancestors().skip(1) {
            let text = ancestor.to_string_lossy().to_string();
            if !text.trim().is_empty() {
                push_unique_path(&mut metadata_paths, text);
            }
        }
    }
    metadata_paths.sort();
    metadata_paths.dedup();
    metadata_paths
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

fn push_homebrew_runtime_roots(paths: &mut Vec<String>, path: &Path) {
    let components = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let Some(cellar_index) = components.iter().position(|item| item == "Cellar") else {
        return;
    };
    if components.len() <= cellar_index + 2 {
        return;
    }
    let mut root = PathBuf::new();
    for component in components.iter().take(cellar_index + 3) {
        root.push(component);
    }
    let mut homebrew_root = PathBuf::new();
    for component in components.iter().take(cellar_index) {
        homebrew_root.push(component);
    }
    for child in ["Cellar", "opt", "lib", "etc"] {
        let candidate = homebrew_root.join(child);
        if candidate.exists() {
            push_unique_path(paths, candidate.to_string_lossy().to_string());
        }
    }
    for child in ["lib", "Frameworks", "share"] {
        let candidate = root.join(child);
        if candidate.exists() {
            push_unique_path(paths, candidate.to_string_lossy().to_string());
        }
    }
}

fn push_path_and_canonical(paths: &mut Vec<String>, path: &Path) {
    if let Some(parent) = path.parent() {
        push_unique_path(paths, parent.to_string_lossy().to_string());
    }
    if path.is_dir() {
        push_unique_path(paths, path.to_string_lossy().to_string());
    }
    push_homebrew_runtime_roots(paths, path);
    if let Ok(canonical) = fs::canonicalize(path) {
        if canonical.is_dir() {
            push_unique_path(paths, canonical.to_string_lossy().to_string());
        } else if let Some(parent) = canonical.parent() {
            push_unique_path(paths, parent.to_string_lossy().to_string());
        }
        push_homebrew_runtime_roots(paths, &canonical);
        push_node_package_roots(paths, &canonical);
    }
    push_node_package_roots(paths, path);
}

fn shebang_line(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if !bytes.starts_with(b"#!") {
        return None;
    }
    let newline = bytes
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(bytes.len());
    Some(
        String::from_utf8_lossy(&bytes[2..newline])
            .trim()
            .to_string(),
    )
}

fn interpreter_from_env_args(args: &[&str], env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let mut index = 0usize;
    while index < args.len() {
        let token = args[index];
        if token == "-S" {
            index += 1;
            break;
        }
        if token.starts_with('-') || token.contains('=') {
            index += 1;
            continue;
        }
        return find_executable(token, env);
    }
    args.get(index)
        .and_then(|token| find_executable(token, env))
}

fn shebang_interpreter_path(path: &Path, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let line = shebang_line(path)?;
    let parts = line.split_whitespace().collect::<Vec<_>>();
    let interpreter = parts.first().copied()?;
    let interpreter_path = Path::new(interpreter);
    if interpreter_path.file_name().and_then(|name| name.to_str()) == Some("env") {
        return interpreter_from_env_args(&parts[1..], env);
    }
    Some(PathBuf::from(interpreter))
}

fn push_tool_closure(
    paths: &mut Vec<String>,
    path: &Path,
    env: &BTreeMap<String, String>,
    depth: usize,
) {
    push_path_and_canonical(paths, path);
    if depth == 0 {
        return;
    }
    if let Some(interpreter) = shebang_interpreter_path(path, env) {
        push_tool_closure(paths, &interpreter, env, depth - 1);
    }
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
        push_tool_closure(&mut paths, &path, env, 2);
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
    let read_paths = canonical_read_paths(spec, env);
    for path in parent_metadata_paths(&read_paths) {
        lines.push(format!(
            "(allow file-read-metadata (literal \"{}\"))",
            profile_escape(&path)
        ));
    }
    for path in read_paths {
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
        assert!(
            spec.allow_write_paths
                .iter()
                .any(|item| item.contains("project"))
        );
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

    #[test]
    fn host_tool_read_paths_includes_env_interpreter_and_homebrew_lib() {
        let root =
            std::env::temp_dir().join(format!("redbox-cli-sandbox-closure-{}", crate::now_i64()));
        let script_bin = root.join("scripts");
        let node_bin = root
            .join("homebrew")
            .join("Cellar")
            .join("node")
            .join("25.9.0")
            .join("bin");
        let node_lib = root
            .join("homebrew")
            .join("Cellar")
            .join("node")
            .join("25.9.0")
            .join("lib");
        let homebrew_opt = root.join("homebrew").join("opt");
        let homebrew_etc = root.join("homebrew").join("etc");
        let command_name = format!("redbox-lark-cli-{}", crate::now_i64());
        fs::create_dir_all(&script_bin).expect("script bin should be created");
        fs::create_dir_all(&node_bin).expect("node bin should be created");
        fs::create_dir_all(&node_lib).expect("node lib should be created");
        fs::create_dir_all(&homebrew_opt).expect("homebrew opt should be created");
        fs::create_dir_all(&homebrew_etc).expect("homebrew etc should be created");
        fs::write(
            script_bin.join(&command_name),
            format!("#!{}\nconsole.log('ok')\n", node_bin.join("node").display()),
        )
        .expect("script should be written");
        fs::write(node_bin.join("node"), "").expect("node shim should be written");

        let env = BTreeMap::from([
            (
                "PATH".to_string(),
                format!("{}:{}", script_bin.display(), node_bin.display()),
            ),
            (
                "NVM_BIN".to_string(),
                node_bin.to_string_lossy().to_string(),
            ),
        ]);
        let paths = host_tool_read_paths(&[command_name], &env);
        let script_bin_text = script_bin.to_string_lossy().to_string();
        let node_bin_text = node_bin.to_string_lossy().to_string();
        let node_lib_text = node_lib.to_string_lossy().to_string();
        let homebrew_cellar_text = root
            .join("homebrew")
            .join("Cellar")
            .to_string_lossy()
            .to_string();
        let homebrew_opt_text = homebrew_opt.to_string_lossy().to_string();
        let homebrew_etc_text = homebrew_etc.to_string_lossy().to_string();

        assert!(paths.iter().any(|item| item == &script_bin_text));
        assert!(paths.iter().any(|item| item == &node_bin_text));
        assert!(paths.iter().any(|item| item == &node_lib_text));
        assert!(paths.iter().any(|item| item == &homebrew_cellar_text));
        assert!(paths.iter().any(|item| item == &homebrew_opt_text));
        assert!(paths.iter().any(|item| item == &homebrew_etc_text));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parent_metadata_paths_adds_only_ancestor_literals() {
        let paths = vec![
            "/Users/Jam/.nvm/versions/node/v20.20.0/bin".to_string(),
            "/tmp/redbox-env".to_string(),
        ];
        let metadata_paths = parent_metadata_paths(&paths);

        assert!(metadata_paths.iter().any(|item| item == "/Users"));
        assert!(metadata_paths.iter().any(|item| item == "/Users/Jam"));
        assert!(metadata_paths.iter().any(|item| item == "/Users/Jam/.nvm"));
        assert!(metadata_paths.iter().any(|item| item == "/tmp"));
        assert!(
            !metadata_paths
                .iter()
                .any(|item| item == "/Users/Jam/.nvm/versions/node/v20.20.0/bin")
        );
    }
}
