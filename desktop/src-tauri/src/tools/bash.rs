use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::interactive_runtime_shared::resolve_workspace_tool_path;
use crate::AppState;

const DEFAULT_OUTPUT_CHARS: usize = 8_000;
const MAX_OUTPUT_CHARS: usize = 20_000;

pub fn execute_bash(arguments: &Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let raw_command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| "command is required".to_string())?;
    let cwd = arguments
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve_workspace_tool_path(state, value))
        .transpose()?
        .unwrap_or(resolve_workspace_tool_path(state, ".")?);
    let max_chars = arguments
        .get("maxChars")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_OUTPUT_CHARS)
        .clamp(200, MAX_OUTPUT_CHARS);

    let argv = shell_words::split(raw_command).map_err(|error| error.to_string())?;
    let program = argv
        .first()
        .map(String::as_str)
        .ok_or_else(|| "command is empty".to_string())?;
    ensure_program_allowed(program)?;
    ensure_args_allowed(program, &argv[1..], &cwd)?;

    let output = Command::new(program)
        .args(&argv[1..])
        .current_dir(&cwd)
        .output()
        .map_err(|error| error.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(json!({
        "success": output.status.success(),
        "exitCode": output.status.code(),
        "cwd": cwd.display().to_string(),
        "command": raw_command,
        "stdout": truncate_output(&stdout, max_chars),
        "stderr": truncate_output(&stderr, max_chars / 2),
    }))
}

fn ensure_program_allowed(program: &str) -> Result<(), String> {
    match program {
        "pwd" | "ls" | "find" | "rg" | "cat" | "head" | "tail" | "sed" | "wc" | "jq" | "git" => {
            Ok(())
        }
        _ => Err(format!(
            "bash only allows read-only inspection commands. unsupported program: {program}"
        )),
    }
}

fn ensure_args_allowed(program: &str, args: &[String], cwd: &Path) -> Result<(), String> {
    if program == "git" {
        return ensure_git_args_allowed(args, cwd);
    }
    match program {
        "pwd" => Ok(()),
        "rg" => ensure_rg_args_allowed(args, cwd),
        "find" => ensure_find_args_allowed(args, cwd),
        "sed" => ensure_sed_args_allowed(args, cwd),
        "jq" => ensure_jq_args_allowed(args, cwd),
        _ => {
            for arg in args {
                if arg.starts_with('-') {
                    continue;
                }
                ensure_path_token_safe(arg, cwd)?;
            }
            Ok(())
        }
    }
}

fn ensure_git_args_allowed(args: &[String], cwd: &Path) -> Result<(), String> {
    let subcommand = args
        .iter()
        .find(|item| !item.starts_with('-'))
        .map(String::as_str)
        .unwrap_or("status");
    match subcommand {
        "status" | "diff" | "log" | "show" | "branch" | "rev-parse" => {}
        _ => {
            return Err(format!(
                "git subcommand is not allowed in bash: {subcommand}"
            ))
        }
    }
    for arg in args {
        if arg.starts_with('-') || arg == subcommand {
            continue;
        }
        if arg == "--" {
            continue;
        }
        if arg.contains("..") && !looks_like_revision(arg) {
            ensure_path_token_safe(arg, cwd)?;
            continue;
        }
        if arg.starts_with('/') || arg.contains('/') {
            ensure_path_token_safe(arg, cwd)?;
        }
    }
    Ok(())
}

fn ensure_jq_args_allowed(args: &[String], cwd: &Path) -> Result<(), String> {
    let positional = args
        .iter()
        .filter(|item| !item.starts_with('-'))
        .collect::<Vec<_>>();
    for path in positional.iter().skip(1) {
        ensure_path_token_safe(path, cwd)?;
    }
    Ok(())
}

fn ensure_rg_args_allowed(args: &[String], cwd: &Path) -> Result<(), String> {
    let mut non_option_index = 0usize;
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "-e" || arg == "-g" || arg == "--glob" || arg == "-f" {
            skip_next = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        non_option_index += 1;
        if non_option_index >= 2 {
            ensure_path_token_safe(arg, cwd)?;
        }
    }
    Ok(())
}

fn ensure_find_args_allowed(args: &[String], cwd: &Path) -> Result<(), String> {
    for arg in args {
        if arg.starts_with('-') {
            break;
        }
        ensure_path_token_safe(arg, cwd)?;
    }
    Ok(())
}

fn ensure_sed_args_allowed(args: &[String], cwd: &Path) -> Result<(), String> {
    let mut positional = Vec::<&String>::new();
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if matches!(arg.as_str(), "-e" | "-f") {
            skip_next = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        positional.push(arg);
    }
    for path in positional.iter().skip(1) {
        ensure_path_token_safe(path, cwd)?;
    }
    Ok(())
}

fn ensure_path_token_safe(token: &str, cwd: &Path) -> Result<(), String> {
    if token.trim().is_empty() || token == "." {
        return Ok(());
    }
    if token == ".." || token.starts_with("../") || token.contains("/../") {
        return Err(format!("path escapes currentSpaceRoot: {token}"));
    }
    if token.contains('*') || token.contains('?') {
        return Err(format!(
            "globs are not allowed in bash path arguments: {token}"
        ));
    }
    if token.starts_with('-') || token.starts_with("http://") || token.starts_with("https://") {
        return Ok(());
    }
    let candidate = if Path::new(token).is_absolute() {
        PathBuf::from(token)
    } else {
        cwd.join(token)
    };
    ensure_path_is_within_root(&candidate, cwd)
}

fn ensure_path_is_within_root(candidate: &Path, root: &Path) -> Result<(), String> {
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "path escapes currentSpaceRoot: {}",
            candidate.display()
        ));
    }
    let normalized = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    let root_normalized = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if !normalized.starts_with(&root_normalized) {
        return Err(format!(
            "path is outside currentSpaceRoot: {}",
            candidate.display()
        ));
    }
    Ok(())
}

fn looks_like_revision(value: &str) -> bool {
    value.contains("..")
        && !value.starts_with('/')
        && !value.starts_with("../")
        && !value.contains('/')
}

fn truncate_output(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let collected = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{collected}…")
    } else {
        collected
    }
}
