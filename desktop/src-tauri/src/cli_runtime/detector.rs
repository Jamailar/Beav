use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use crate::cli_runtime::{CliToolHealth, CliToolRecord, CliToolSource};
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

pub fn find_executable(command: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    if looks_like_path(trimmed) {
        let candidate = PathBuf::from(trimmed);
        if candidate.is_file() {
            return Some(candidate);
        }
        return None;
    }

    let path_value = env
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let candidates = if cfg!(windows) {
        windows_executable_candidates(trimmed)
    } else {
        vec![trimmed.to_string()]
    };

    for root in path_value.split(path_separator()) {
        if root.trim().is_empty() {
            continue;
        }
        for candidate in &candidates {
            let path = Path::new(root).join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub fn detect_tool(command: &str, env: &BTreeMap<String, String>) -> CliToolRecord {
    let resolved_path = find_executable(command, env);
    let version = resolved_path.as_deref().and_then(probe_version);
    let health = match resolved_path {
        Some(_) => CliToolHealth::Ready,
        None => CliToolHealth::Missing,
    };

    CliToolRecord {
        id: normalize_tool_id(command),
        name: command.to_string(),
        executable: command.to_string(),
        resolved_path: resolved_path.map(|path| path.to_string_lossy().to_string()),
        environment_id: None,
        source: CliToolSource::System,
        install_method: None,
        install_spec: None,
        version: version.clone(),
        health,
        manifest_id: None,
        last_checked_at: Some(now_i64()),
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
