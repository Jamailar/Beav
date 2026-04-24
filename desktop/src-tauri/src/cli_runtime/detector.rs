use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn resolve_executable(
    command: &str,
    env: &BTreeMap<String, String>,
    managed_path_entries: Option<&[String]>,
) -> CliExecutableResolution {
    let trimmed = command.trim();
    let path_entries = env_path_entries(env);
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
    let extra_paths = discover_extra_bin_paths_with_env(env);
    let managed_path_entries = managed_path_entries.unwrap_or(&[]);

    for root in &path_entries {
        for candidate in &candidates {
            let path = Path::new(root).join(candidate);
            if path.is_file() {
                return CliExecutableResolution {
                    resolved_path: Some(path),
                    resolved_from: Some(path_entry_origin(root, &extra_paths, managed_path_entries)),
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

pub fn find_executable(command: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    resolve_executable(command, env, None).resolved_path
}

pub fn detect_tool(command: &str, env: &BTreeMap<String, String>) -> CliToolRecord {
    detect_tool_with_managed_paths(command, env, None, true)
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
    let path_entries = env_path_entries(env);
    let extra_paths = discover_extra_bin_paths_with_env(env);
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
}
