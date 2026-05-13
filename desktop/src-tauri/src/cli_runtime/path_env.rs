use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use dirs::home_dir;
use serde_json::{json, Value};

use crate::cli_runtime::{CliEnvironmentRecord, CliRuntimeInventory};
use crate::process_utils::configure_background_command;

fn path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

fn parse_env_output(content: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().is_empty() {
            continue;
        }
        values.insert(key.to_string(), value.to_string());
    }
    values
}

fn shell_env_command() -> Option<(String, Vec<String>)> {
    #[cfg(target_os = "windows")]
    {
        Some((
            "powershell".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Get-ChildItem Env: | ForEach-Object { \"{0}={1}\" -f $_.Name, $_.Value }"
                    .to_string(),
            ],
        ))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        Some((
            shell,
            vec!["-l".to_string(), "-c".to_string(), "env".to_string()],
        ))
    }
}

#[derive(Debug, Clone)]
pub struct CliHostShellSnapshot {
    pub env: BTreeMap<String, String>,
    pub shell_path: Option<String>,
    pub login_shell_loaded: bool,
    pub fallback_used: bool,
    pub error: Option<String>,
}

impl CliHostShellSnapshot {
    pub fn metadata_value(&self) -> Value {
        json!({
            "path": self.shell_path,
            "loginShellLoaded": self.login_shell_loaded,
            "fallbackUsed": self.fallback_used,
            "error": self.error,
        })
    }
}

#[derive(Debug, Clone)]
pub struct CliEffectiveEnvironment {
    pub env: BTreeMap<String, String>,
    pub environment_id: Option<String>,
    pub shell_path: Option<String>,
    pub login_shell_loaded: bool,
    pub fallback_used: bool,
    pub host_path_entries_count: usize,
    pub effective_path_preview: Vec<String>,
}

impl CliEffectiveEnvironment {
    pub fn metadata_value(&self) -> Value {
        json!({
            "environmentId": self.environment_id,
            "hostShell": self.shell_path,
            "loginShellLoaded": self.login_shell_loaded,
            "fallbackUsed": self.fallback_used,
            "hostPathEntriesCount": self.host_path_entries_count,
            "effectivePathPreview": self.effective_path_preview,
        })
    }
}

pub fn load_host_shell_snapshot() -> CliHostShellSnapshot {
    let mut merged = std::env::vars().collect::<BTreeMap<_, _>>();
    let Some((program, args)) = shell_env_command() else {
        return CliHostShellSnapshot {
            env: merged,
            shell_path: None,
            login_shell_loaded: false,
            fallback_used: true,
            error: Some("host shell env command is unavailable".to_string()),
        };
    };

    let mut command = Command::new(&program);
    command.args(args);
    configure_background_command(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => {
            let parsed = parse_env_output(&String::from_utf8_lossy(&output.stdout));
            for (key, value) in parsed {
                merged.insert(key, value);
            }
            CliHostShellSnapshot {
                env: merged,
                shell_path: Some(program),
                login_shell_loaded: true,
                fallback_used: false,
                error: None,
            }
        }
        Ok(output) => CliHostShellSnapshot {
            env: merged,
            shell_path: Some(program),
            login_shell_loaded: false,
            fallback_used: true,
            error: Some(format!(
                "host shell env exited with status {}",
                output.status
            )),
        },
        Err(error) => CliHostShellSnapshot {
            env: merged,
            shell_path: Some(program),
            login_shell_loaded: false,
            fallback_used: true,
            error: Some(error.to_string()),
        },
    }
}

pub fn load_host_shell_env() -> Result<BTreeMap<String, String>, String> {
    Ok(load_host_shell_snapshot().env)
}

pub fn discover_extra_bin_paths() -> Vec<String> {
    let env = std::env::vars().collect::<BTreeMap<_, _>>();
    discover_extra_bin_paths_with_env(&env)
}

pub fn env_path_entries(env: &BTreeMap<String, String>) -> Vec<String> {
    let separator = path_separator();
    env.get("PATH")
        .cloned()
        .unwrap_or_default()
        .split(separator)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub fn discover_extra_bin_paths_with_env(env: &BTreeMap<String, String>) -> Vec<String> {
    let mut items = Vec::<PathBuf>::new();

    #[cfg(target_os = "macos")]
    {
        items.push(PathBuf::from("/opt/homebrew/bin"));
        items.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "linux")]
    {
        items.push(PathBuf::from("/usr/local/bin"));
        items.push(PathBuf::from("/usr/bin"));
    }

    #[cfg(target_os = "windows")]
    {
        items.push(PathBuf::from(r"C:\Windows\System32"));
        if let Some(program_data) = env
            .get("ProgramData")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        {
            items.push(program_data.join("chocolatey").join("bin"));
            items.push(program_data.join("scoop").join("shims"));
        }
    }

    if let Some(home) = home_dir() {
        items.push(home.join(".local").join("bin"));
        items.push(home.join(".cargo").join("bin"));
        items.push(home.join(".npm-global").join("bin"));
        items.push(home.join(".bun").join("bin"));
        items.push(home.join(".deno").join("bin"));
        items.push(home.join("go").join("bin"));
        #[cfg(target_os = "windows")]
        {
            items.push(home.join("scoop").join("shims"));
            items.push(home.join("AppData").join("Roaming").join("npm"));
            items.push(
                home.join("AppData")
                    .join("Local")
                    .join("Microsoft")
                    .join("WindowsApps"),
            );
            items.push(
                home.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("Git")
                    .join("cmd"),
            );
            items.push(home.join("AppData").join("Local").join("pnpm"));
        }
        if let Some(nvm_dir) = env
            .get("NVM_BIN")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        {
            items.push(nvm_dir);
        }
        let nvm_versions_dir = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = fs::read_dir(&nvm_versions_dir) {
            let mut entries = entries.flatten().collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            entries.reverse();
            for entry in entries {
                items.push(entry.path().join("bin"));
            }
        }
        if let Some(volta_home) = env
            .get("VOLTA_HOME")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        {
            items.push(volta_home.join("bin"));
        } else {
            items.push(home.join(".volta").join("bin"));
        }
        if let Some(fnm_multishell) = env
            .get("FNM_MULTISHELL_PATH")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        {
            items.push(fnm_multishell.join("bin"));
        }
        items.push(home.join(".asdf").join("shims"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = env
            .get("APPDATA")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        {
            items.push(appdata.join("npm"));
        }
        if let Some(local_appdata) = env
            .get("LOCALAPPDATA")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
        {
            items.push(local_appdata.join("Microsoft").join("WindowsApps"));
            items.push(local_appdata.join("pnpm"));
            items.push(local_appdata.join("Programs").join("Git").join("cmd"));
        }
    }

    let mut deduped = Vec::<String>::new();
    for path in items {
        if !path.exists() {
            continue;
        }
        let text = path.to_string_lossy().to_string();
        if deduped.iter().any(|item| item == &text) {
            continue;
        }
        deduped.push(text);
    }
    deduped
}

fn push_unique_path(paths: &mut Vec<String>, candidate: impl Into<String>) {
    let candidate = candidate.into();
    if candidate.trim().is_empty() {
        return;
    }
    if paths.iter().any(|item| item == &candidate) {
        return;
    }
    paths.push(candidate);
}

pub fn merge_execution_env(
    base: &BTreeMap<String, String>,
    environment: &CliEnvironmentRecord,
    custom: Option<&BTreeMap<String, String>>,
) -> BTreeMap<String, String> {
    let mut merged = base.clone();
    let separator = path_separator();
    let existing_path = merged.get("PATH").cloned().unwrap_or_default();
    let mut path_entries = Vec::<String>::new();

    for entry in &environment.path_entries {
        push_unique_path(&mut path_entries, entry.clone());
    }
    for entry in discover_extra_bin_paths_with_env(base) {
        push_unique_path(&mut path_entries, entry);
    }
    for entry in existing_path.split(separator) {
        push_unique_path(&mut path_entries, entry.to_string());
    }

    merged.insert(
        "PATH".to_string(),
        path_entries.join(&separator.to_string()),
    );
    merged.insert(
        "REDBOX_CLI_ENVIRONMENT_ID".to_string(),
        environment.id.clone(),
    );
    merged.insert(
        "REDBOX_CLI_ENVIRONMENT_ROOT".to_string(),
        environment.root_path.clone(),
    );
    if let Some(custom) = custom {
        for (key, value) in custom {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

pub fn build_effective_environment(
    host: &CliHostShellSnapshot,
    environment: Option<&CliEnvironmentRecord>,
    custom: Option<&BTreeMap<String, String>>,
) -> CliEffectiveEnvironment {
    let env = match environment {
        Some(environment) => merge_execution_env(&host.env, environment, custom),
        None => {
            let mut merged = host.env.clone();
            if let Some(custom) = custom {
                for (key, value) in custom {
                    merged.insert(key.clone(), value.clone());
                }
            }
            merged
        }
    };
    let host_path_entries_count = env_path_entries(&host.env).len();
    let effective_path_preview = env_path_entries(&env).into_iter().take(12).collect();
    CliEffectiveEnvironment {
        env,
        environment_id: environment.map(|item| item.id.clone()),
        shell_path: host.shell_path.clone(),
        login_shell_loaded: host.login_shell_loaded,
        fallback_used: host.fallback_used,
        host_path_entries_count,
        effective_path_preview,
    }
}

pub fn default_environment_path_entries(root: &Path) -> Vec<String> {
    let mut items = Vec::<String>::new();
    push_unique_path(&mut items, root.join("bin").to_string_lossy().to_string());
    push_unique_path(
        &mut items,
        root.join("node_modules")
            .join(".bin")
            .to_string_lossy()
            .to_string(),
    );
    items
}

pub fn detect_runtime_inventory(env: &BTreeMap<String, String>) -> CliRuntimeInventory {
    use crate::cli_runtime::{cli_runtime_inventory_commands, find_executable};

    let mut inventory = CliRuntimeInventory::default();
    for (slot, command) in cli_runtime_inventory_commands() {
        let resolved = find_executable(command, env).map(|path| path.to_string_lossy().to_string());
        match slot {
            "node" => inventory.node = resolved,
            "python" => inventory.python = resolved,
            "uv" => inventory.uv = resolved,
            "pnpm" => inventory.pnpm = resolved,
            "cargo" => inventory.cargo = resolved,
            "go" => inventory.go = resolved,
            _ => {}
        }
    }
    inventory
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runtime::{CliEnvironmentScope, CliToolHealth};

    #[test]
    fn merge_execution_env_prepends_environment_paths_without_duplicates() {
        let base = BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
        let environment = CliEnvironmentRecord {
            id: "env-1".to_string(),
            scope: CliEnvironmentScope::AppGlobal,
            root_path: "/tmp/redbox-env".to_string(),
            path_entries: vec!["/tmp/redbox-env/bin".to_string(), "/usr/bin".to_string()],
            runtimes: CliRuntimeInventory::default(),
            installed_tool_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            metadata: Some(serde_json::json!({ "health": CliToolHealth::Ready })),
            workspace_root: None,
        };
        let merged = merge_execution_env(&base, &environment, None);
        let path = merged.get("PATH").cloned().unwrap_or_default();
        assert!(path.starts_with("/tmp/redbox-env/bin"));
        assert_eq!(path.matches("/usr/bin").count(), 1);
    }

    #[test]
    fn default_environment_path_entries_adds_bin_and_node_modules_bin() {
        let values = default_environment_path_entries(Path::new("/tmp/redbox-cli"));
        assert_eq!(values.len(), 2);
        assert!(values[0].ends_with("/bin"));
        assert!(values[1].contains("node_modules"));
    }

    #[test]
    fn build_effective_environment_preserves_shell_metadata_and_path_order() {
        let host = CliHostShellSnapshot {
            env: BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]),
            shell_path: Some("/bin/zsh".to_string()),
            login_shell_loaded: true,
            fallback_used: false,
            error: None,
        };
        let environment = CliEnvironmentRecord {
            id: "env-1".to_string(),
            scope: CliEnvironmentScope::AppGlobal,
            root_path: "/tmp/redbox-env".to_string(),
            path_entries: vec!["/tmp/redbox-env/bin".to_string()],
            runtimes: CliRuntimeInventory::default(),
            installed_tool_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            metadata: None,
            workspace_root: None,
        };

        let effective = build_effective_environment(&host, Some(&environment), None);
        assert_eq!(effective.environment_id.as_deref(), Some("env-1"));
        assert_eq!(effective.shell_path.as_deref(), Some("/bin/zsh"));
        assert!(effective.login_shell_loaded);
        assert_eq!(effective.host_path_entries_count, 2);
        assert_eq!(
            effective.effective_path_preview.first().map(String::as_str),
            Some("/tmp/redbox-env/bin")
        );
    }
}
