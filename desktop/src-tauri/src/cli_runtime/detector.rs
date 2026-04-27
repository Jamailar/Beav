use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::json;

use crate::cli_runtime::{
    discover_extra_bin_paths_with_env, env_path_entries, CliResolvedFrom, CliToolHealth,
    CliToolRecord, CliToolSource,
};
use crate::now_i64;
use crate::process_utils::configure_background_command;

const VERSION_FLAGS: [&str; 3] = ["--version", "version", "-V"];

fn path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

fn looks_like_path(command: &str) -> bool {
    command.contains('/') || command.contains('\\')
}

fn windows_executable_candidates(command: &str) -> Vec<String> {
    let mut items = vec![command.to_string()];
    if Path::new(command)
        .extension()
        .and_then(|value| value.to_str())
        .is_some()
    {
        return items;
    }

    let path_ext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string());
    for suffix in path_ext.split(';') {
        let suffix = suffix.trim();
        if suffix.is_empty() {
            continue;
        }
        items.push(format!("{command}{suffix}"));
    }
    items
}

fn current_default_detect_commands() -> Vec<String> {
    default_detect_commands()
}

fn normalize_tool_id(command: &str) -> String {
    let mut normalized = String::from("cli-tool-");
    for ch in command.chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch.to_ascii_lowercase());
        } else if !normalized.ends_with('-') {
            normalized.push('-');
        }
    }
    while normalized.ends_with('-') {
        normalized.pop();
    }
    if normalized == "cli-tool" {
        return "cli-tool-unknown".to_string();
    }
    normalized
}

fn first_non_empty_line(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| {
            let mut compact = line.to_string();
            if compact.chars().count() > 240 {
                compact = compact.chars().take(240).collect();
            }
            compact
        })
}

fn probe_version(path: &Path) -> Option<String> {
    for flag in VERSION_FLAGS {
        let mut command = Command::new(path);
        command.arg(flag);
        configure_background_command(&mut command);
        let Ok(output) = command.output() else {
            continue;
        };
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if let Some(line) = first_non_empty_line(&combined) {
            return Some(line);
        }
    }
    None
}

fn preview_path_entries(entries: &[String], max_items: usize) -> Vec<String> {
    entries.iter().take(max_items).cloned().collect()
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

fn effective_path_entries(env: &BTreeMap<String, String>) -> (Vec<String>, Vec<String>) {
    let extra_paths = discover_extra_bin_paths_with_env(env);
    let mut entries = Vec::<String>::new();
    for entry in &extra_paths {
        push_unique_path(&mut entries, entry.clone());
    }
    for entry in env_path_entries(env) {
        push_unique_path(&mut entries, entry);
    }
    (entries, extra_paths)
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn path_entry_origin(
    root: &str,
    extra_paths: &[String],
    managed_path_entries: &[String],
) -> CliResolvedFrom {
    if managed_path_entries.iter().any(|item| item == root) {
        return CliResolvedFrom::ManagedEnvironment;
    }
    if extra_paths.iter().any(|item| item == root) {
        return CliResolvedFrom::ExtraBinPath;
    }
    CliResolvedFrom::HostShellPath
}

#[derive(Debug, Clone)]
struct CliExecutableResolution {
    resolved_path: Option<PathBuf>,
    resolved_from: Option<CliResolvedFrom>,
    effective_path_preview: Vec<String>,
    searched_path_entries_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliShellResolvedKind {
    ExecutablePath,
    ShellBuiltin,
    ShellFunction,
    Alias,
    Unknown,
    ProbeUnavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliShellResolveProbe {
    pub shell_path: Option<String>,
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub resolved_path: Option<String>,
    pub resolved_kind: CliShellResolvedKind,
    pub skipped: bool,
    pub skip_reason: Option<String>,
}

fn resolve_executable(
    command: &str,
    env: &BTreeMap<String, String>,
    managed_path_entries: Option<&[String]>,
) -> CliExecutableResolution {
    let trimmed = command.trim();
    let (path_entries, extra_paths) = effective_path_entries(env);
    let effective_path_preview = preview_path_entries(&path_entries, 12);
    if trimmed.is_empty() {
        return CliExecutableResolution {
            resolved_path: None,
            resolved_from: None,
            effective_path_preview,
            searched_path_entries_count: path_entries.len(),
        };
    }

    if looks_like_path(trimmed) {
        let candidate = PathBuf::from(trimmed);
        return CliExecutableResolution {
            resolved_path: candidate.is_file().then_some(candidate),
            resolved_from: Some(CliResolvedFrom::ExplicitPath),
            effective_path_preview,
            searched_path_entries_count: path_entries.len(),
        };
    }

    let candidates = if cfg!(windows) {
        windows_executable_candidates(trimmed)
    } else {
        vec![trimmed.to_string()]
    };
    let managed_path_entries = managed_path_entries.unwrap_or(&[]);

    for root in &path_entries {
        for candidate in &candidates {
            let path = Path::new(root).join(candidate);
            if path.is_file() {
                return CliExecutableResolution {
                    resolved_path: Some(path),
                    resolved_from: Some(path_entry_origin(
                        root,
                        &extra_paths,
                        managed_path_entries,
                    )),
                    effective_path_preview,
                    searched_path_entries_count: path_entries.len(),
                };
            }
        }
    }

    CliExecutableResolution {
        resolved_path: None,
        resolved_from: None,
        effective_path_preview,
        searched_path_entries_count: path_entries.len(),
    }
}

fn shell_probe_input_safe(command: &str) -> bool {
    let trimmed = command.trim();
    !trimmed.is_empty()
        && !looks_like_path(trimmed)
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+' | '@'))
}

fn classify_shell_resolution(output: &str) -> (CliShellResolvedKind, Option<String>) {
    let line = output.lines().map(str::trim).find(|line| !line.is_empty());
    let Some(line) = line else {
        return (CliShellResolvedKind::Unknown, None);
    };
    let path = Path::new(line);
    if path.is_absolute() && path.is_file() {
        return (CliShellResolvedKind::ExecutablePath, Some(line.to_string()));
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("alias") {
        return (CliShellResolvedKind::Alias, None);
    }
    if lower.contains("function") {
        return (CliShellResolvedKind::ShellFunction, None);
    }
    if lower.contains("builtin") {
        return (CliShellResolvedKind::ShellBuiltin, None);
    }
    (CliShellResolvedKind::Unknown, None)
}

pub fn probe_shell_command_resolution(
    command: &str,
    shell_path: Option<&str>,
    env: &BTreeMap<String, String>,
) -> CliShellResolveProbe {
    let command = command.trim().to_string();
    let Some(shell_path) = shell_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    else {
        return CliShellResolveProbe {
            shell_path: None,
            command,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            resolved_path: None,
            resolved_kind: CliShellResolvedKind::ProbeUnavailable,
            skipped: true,
            skip_reason: Some("host shell path unavailable".to_string()),
        };
    };
    if !shell_probe_input_safe(&command) {
        return CliShellResolveProbe {
            shell_path: Some(shell_path),
            command,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            resolved_path: None,
            resolved_kind: CliShellResolvedKind::ProbeUnavailable,
            skipped: true,
            skip_reason: Some("command is not safe for shell-native resolution probe".to_string()),
        };
    }

    #[cfg(target_os = "windows")]
    {
        CliShellResolveProbe {
            shell_path: Some(shell_path),
            command,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            resolved_path: None,
            resolved_kind: CliShellResolvedKind::ProbeUnavailable,
            skipped: true,
            skip_reason: Some(
                "shell-native resolution probe is not implemented on Windows".to_string(),
            ),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let script = r#"candidate=$(type -p -- "$1" 2>/dev/null || command -v -- "$1" 2>/dev/null); if [ -n "$candidate" ]; then printf '%s\n' "$candidate"; fi"#;
        let mut process = Command::new(&shell_path);
        process.args(["-lc", script, "_", &command]);
        process.env_clear();
        process.envs(env);
        configure_background_command(&mut process);
        match process.output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let (resolved_kind, resolved_path) = classify_shell_resolution(&stdout);
                CliShellResolveProbe {
                    shell_path: Some(shell_path),
                    command,
                    exit_code: output.status.code(),
                    stdout,
                    stderr,
                    resolved_path,
                    resolved_kind,
                    skipped: false,
                    skip_reason: None,
                }
            }
            Err(error) => CliShellResolveProbe {
                shell_path: Some(shell_path),
                command,
                exit_code: None,
                stdout: String::new(),
                stderr: error.to_string(),
                resolved_path: None,
                resolved_kind: CliShellResolvedKind::ProbeUnavailable,
                skipped: false,
                skip_reason: None,
            },
        }
    }
}

pub fn find_executable(command: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    resolve_executable(command, env, None).resolved_path
}

pub fn detect_tool(command: &str, env: &BTreeMap<String, String>) -> CliToolRecord {
    detect_tool_with_managed_paths(command, env, None, true)
}

pub fn detect_tool_with_shell_probe(
    command: &str,
    env: &BTreeMap<String, String>,
    managed_path_entries: Option<&[String]>,
    probe_version_enabled: bool,
    shell_path: Option<&str>,
) -> CliToolRecord {
    let mut detected =
        detect_tool_with_managed_paths(command, env, managed_path_entries, probe_version_enabled);
    let path_scan = json!({
        "resolvedPath": detected.resolved_path.clone(),
        "resolvedFrom": detected.resolved_from.clone(),
    });
    let shell_probe = probe_shell_command_resolution(command, shell_path, env);
    if detected.health != CliToolHealth::Ready {
        if let Some(path) = shell_probe.resolved_path.as_deref() {
            detected.health = CliToolHealth::Ready;
            detected.resolved_path = Some(path.to_string());
            detected.resolved_from = Some(CliResolvedFrom::HostShellPath);
            if probe_version_enabled {
                detected.version = probe_version(Path::new(path));
            }
        }
    }
    detected.metadata = Some(json!({
        "versionProbeSucceeded": detected.version.is_some(),
        "pathScan": path_scan,
        "shellResolveProbe": shell_probe,
    }));
    detected
}

pub fn detect_tool_with_managed_paths(
    command: &str,
    env: &BTreeMap<String, String>,
    managed_path_entries: Option<&[String]>,
    probe_version_enabled: bool,
) -> CliToolRecord {
    let resolution = resolve_executable(command, env, managed_path_entries);
    let version = if probe_version_enabled {
        resolution.resolved_path.as_deref().and_then(probe_version)
    } else {
        None
    };
    let health = match resolution.resolved_path.as_ref() {
        Some(_) => CliToolHealth::Ready,
        None => CliToolHealth::Missing,
    };
    let is_in_default_detect_catalog = current_default_detect_commands()
        .iter()
        .any(|item| item == command.trim());

    CliToolRecord {
        id: normalize_tool_id(command),
        name: command.to_string(),
        executable: command.to_string(),
        resolved_path: resolution
            .resolved_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        resolved_from: resolution.resolved_from,
        environment_id: None,
        source: CliToolSource::System,
        install_method: None,
        install_spec: None,
        version: version.clone(),
        health,
        manifest_id: None,
        last_checked_at: Some(now_i64()),
        effective_path_preview: resolution.effective_path_preview,
        searched_path_entries_count: Some(resolution.searched_path_entries_count),
        is_in_default_detect_catalog,
        metadata: Some(json!({
            "versionProbeSucceeded": version.is_some(),
        })),
    }
}

pub fn detect_many(commands: &[String], env: &BTreeMap<String, String>) -> Vec<CliToolRecord> {
    commands
        .iter()
        .filter_map(|command| {
            let trimmed = command.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some(detect_tool(trimmed, env))
        })
        .collect()
}

pub fn default_detect_commands() -> Vec<String> {
    vec![
        "node".to_string(),
        "npm".to_string(),
        "pnpm".to_string(),
        "python3".to_string(),
        "python".to_string(),
        "uv".to_string(),
        "cargo".to_string(),
        "go".to_string(),
        "git".to_string(),
        "ffmpeg".to_string(),
        "gh".to_string(),
        "wrangler".to_string(),
        "supabase".to_string(),
    ]
}

pub fn discover_all_commands(
    env: &BTreeMap<String, String>,
    query: Option<&str>,
    limit: usize,
) -> Vec<CliToolRecord> {
    let normalized_query = query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    let (path_entries, extra_paths) = effective_path_entries(env);
    let capped_limit = limit.clamp(1, 500);
    let mut discovered = Vec::<CliToolRecord>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    let default_catalog = current_default_detect_commands();

    for root in &path_entries {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_executable_file(&path) {
                continue;
            }
            let Some(name) = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if let Some(query) = normalized_query.as_deref() {
                if !name.to_ascii_lowercase().contains(query) {
                    continue;
                }
            }
            if !seen.insert(name.to_string()) {
                continue;
            }
            let resolved_from = path_entry_origin(root, &extra_paths, &[]);
            discovered.push(CliToolRecord {
                id: normalize_tool_id(name),
                name: name.to_string(),
                executable: name.to_string(),
                resolved_path: Some(path.to_string_lossy().to_string()),
                resolved_from: Some(resolved_from),
                environment_id: None,
                source: CliToolSource::System,
                install_method: None,
                install_spec: None,
                version: None,
                health: CliToolHealth::Ready,
                manifest_id: None,
                last_checked_at: Some(now_i64()),
                effective_path_preview: preview_path_entries(&path_entries, 12),
                searched_path_entries_count: Some(path_entries.len()),
                is_in_default_detect_catalog: default_catalog.iter().any(|item| item == name),
                metadata: Some(json!({
                    "discoveredBy": "path-enumeration",
                    "versionProbeSucceeded": false,
                })),
            });
            if discovered.len() >= capped_limit {
                return discovered;
            }
        }
    }

    discovered
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn normalize_tool_id_keeps_ascii_alnum_and_collapses_separators() {
        assert_eq!(normalize_tool_id("ffmpeg"), "cli-tool-ffmpeg");
        assert_eq!(normalize_tool_id("Git LFS"), "cli-tool-git-lfs");
        assert_eq!(normalize_tool_id(""), "cli-tool-unknown");
    }

    #[test]
    fn detect_many_skips_blank_entries() {
        let env = BTreeMap::new();
        let records = detect_many(
            &["git".to_string(), "".to_string(), "node".to_string()],
            &env,
        );
        assert_eq!(records.len(), 2);
    }

    #[test]
    fn first_non_empty_line_truncates_long_output() {
        let input = format!("\n{}\n", "a".repeat(400));
        let line = first_non_empty_line(&input).unwrap_or_default();
        assert_eq!(line.chars().count(), 240);
    }

    #[test]
    fn detect_tool_marks_default_catalog_membership() {
        let env = BTreeMap::new();
        let ready = detect_tool_with_managed_paths("git", &env, None, false);
        let unknown = detect_tool_with_managed_paths("lark-cli", &env, None, false);
        assert!(ready.is_in_default_detect_catalog);
        assert!(!unknown.is_in_default_detect_catalog);
    }

    #[cfg(unix)]
    #[test]
    fn explicit_path_resolution_reports_source() {
        use std::os::unix::fs::PermissionsExt;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("redbox-cli-detector-{unique}.sh"));
        fs::write(&path, "#!/bin/sh\necho test\n").expect("write temp command");
        let mut perms = fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).expect("chmod temp command");

        let env = BTreeMap::new();
        let detected =
            detect_tool_with_managed_paths(path.to_string_lossy().as_ref(), &env, None, false);
        assert_eq!(detected.resolved_from, Some(CliResolvedFrom::ExplicitPath));
        assert_eq!(
            detected.resolved_path.as_deref(),
            Some(path.to_string_lossy().as_ref())
        );

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn detects_tools_from_extra_bin_paths_not_present_in_path() {
        use std::os::unix::fs::PermissionsExt;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-cli-extra-bin-{unique}"));
        let bin = root.join("bin");
        let command_path = bin.join("lark-cli");
        fs::create_dir_all(&bin).expect("create temp bin");
        fs::write(&command_path, "#!/bin/sh\necho lark-cli-test\n").expect("write temp command");
        let mut perms = fs::metadata(&command_path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&command_path, perms).expect("chmod temp command");

        let env = BTreeMap::from([
            ("NVM_BIN".to_string(), bin.to_string_lossy().to_string()),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ]);
        let detected = detect_tool_with_managed_paths("lark-cli", &env, None, false);
        assert_eq!(detected.health, CliToolHealth::Ready);
        assert_eq!(detected.resolved_from, Some(CliResolvedFrom::ExtraBinPath));
        assert_eq!(
            detected.resolved_path.as_deref(),
            Some(command_path.to_string_lossy().as_ref())
        );
        assert!(detected
            .effective_path_preview
            .iter()
            .any(|item| item == bin.to_string_lossy().as_ref()));

        let discovered = discover_all_commands(&env, Some("lark-cli"), 10);
        assert!(discovered.iter().any(|item| item.executable == "lark-cli"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn shell_probe_can_upgrade_missing_path_scan_for_hyphenated_command() {
        use std::os::unix::fs::PermissionsExt;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-cli-shell-probe-{unique}"));
        let bin = root.join("bin");
        let command_name = format!("redbox-lark-cli-{unique}");
        let command_path = bin.join(&command_name);
        fs::create_dir_all(&bin).expect("create temp bin");
        fs::write(&command_path, "#!/bin/sh\necho lark-cli-test\n").expect("write temp command");
        let mut perms = fs::metadata(&command_path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&command_path, perms).expect("chmod temp command");

        let env = BTreeMap::from([("PATH".to_string(), bin.to_string_lossy().to_string())]);
        let detected =
            detect_tool_with_shell_probe(&command_name, &env, None, false, Some("/bin/sh"));
        assert_eq!(detected.health, CliToolHealth::Ready);
        assert_eq!(
            detected.resolved_path.as_deref(),
            Some(command_path.to_string_lossy().as_ref())
        );
        assert_eq!(detected.resolved_from, Some(CliResolvedFrom::HostShellPath));
        assert!(detected
            .metadata
            .as_ref()
            .and_then(|value| value.get("shellResolveProbe"))
            .is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_probe_skips_unsafe_command_strings() {
        let env = BTreeMap::new();
        let probe = probe_shell_command_resolution("bad;command", Some("/bin/sh"), &env);
        assert!(probe.skipped);
        assert_eq!(probe.resolved_kind, CliShellResolvedKind::ProbeUnavailable);
    }
}
