use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::interactive_runtime_shared::resolve_workspace_tool_path_for_session;
use crate::AppState;

const DEFAULT_OUTPUT_CHARS: usize = 8_000;
const MAX_OUTPUT_CHARS: usize = 20_000;

pub fn execute_bash(
    arguments: &Value,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Result<Value, String> {
    let raw_command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| "command is required".to_string())?;
    let cwd = arguments
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve_workspace_tool_path_for_session(state, session_id, value))
        .transpose()?
        .unwrap_or(resolve_workspace_tool_path_for_session(
            state, session_id, ".",
        )?);
    let max_chars = arguments
        .get("maxChars")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_OUTPUT_CHARS)
        .clamp(200, MAX_OUTPUT_CHARS);

    let argv = split_command(raw_command)?;
    let program = argv
        .first()
        .map(String::as_str)
        .ok_or_else(|| "command is empty".to_string())?;
    ensure_program_allowed(program)?;
    ensure_args_allowed(program, &argv[1..], &cwd)?;

    let output = if is_builtin_program(program) {
        execute_builtin(program, &argv[1..], &cwd)?
    } else {
        execute_external(program, &argv[1..], &cwd)?
    };

    Ok(json!({
        "success": output.success,
        "exitCode": output.exit_code,
        "cwd": cwd.display().to_string(),
        "command": raw_command,
        "stdout": truncate_output(&output.stdout, max_chars),
        "stderr": truncate_output(&output.stderr, max_chars / 2),
    }))
}

#[derive(Debug, Clone)]
struct BashOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn split_command(raw_command: &str) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        split_command_windows(raw_command)
    }
    #[cfg(not(target_os = "windows"))]
    {
        shell_words::split(raw_command).map_err(|error| error.to_string())
    }
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn split_command_windows(raw_command: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::<String>::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut token_started = false;
    for ch in raw_command.chars() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            token_started = true;
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                token_started = true;
            }
            value if value.is_whitespace() => {
                if token_started {
                    args.push(current.clone());
                    current.clear();
                    token_started = false;
                }
            }
            _ => {
                current.push(ch);
                token_started = true;
            }
        }
    }
    if quote.is_some() {
        return Err("unterminated quoted string".to_string());
    }
    if token_started {
        args.push(current);
    }
    Ok(args)
}

fn is_builtin_program(program: &str) -> bool {
    matches!(
        program,
        "pwd" | "ls" | "find" | "cat" | "head" | "tail" | "sed" | "wc"
    )
}

fn execute_external(program: &str, args: &[String], cwd: &Path) -> Result<BashOutput, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    Ok(BashOutput {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn execute_builtin(program: &str, args: &[String], cwd: &Path) -> Result<BashOutput, String> {
    let stdout = match program {
        "pwd" => builtin_pwd(cwd),
        "ls" => builtin_ls(args, cwd)?,
        "find" => builtin_find(args, cwd)?,
        "cat" => builtin_cat(args, cwd)?,
        "head" => builtin_head(args, cwd)?,
        "tail" => builtin_tail(args, cwd)?,
        "sed" => builtin_sed(args, cwd)?,
        "wc" => builtin_wc(args, cwd)?,
        _ => return Err(format!("unsupported builtin command: {program}")),
    };
    Ok(BashOutput {
        success: true,
        exit_code: Some(0),
        stdout,
        stderr: String::new(),
    })
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
            ));
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

fn builtin_pwd(cwd: &Path) -> String {
    format!("{}\n", cwd.display())
}

fn builtin_ls(args: &[String], cwd: &Path) -> Result<String, String> {
    let mut show_all = false;
    let mut long_format = false;
    let mut targets = Vec::<String>::new();
    for arg in args {
        if let Some(flags) = arg.strip_prefix('-') {
            for flag in flags.chars() {
                match flag {
                    'a' => show_all = true,
                    'l' => long_format = true,
                    _ => return Err(format!("unsupported ls flag: -{flag}")),
                }
            }
        } else {
            targets.push(arg.clone());
        }
    }
    if targets.is_empty() {
        targets.push(".".to_string());
    }

    let mut sections = Vec::<String>::new();
    let multiple_targets = targets.len() > 1;
    for target in targets {
        let resolved = resolve_path_token(&target, cwd);
        let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
        let mut lines = Vec::<String>::new();
        if metadata.is_file() {
            let name = resolved
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| resolved.to_string_lossy().to_string());
            lines.push(format_ls_entry(&name, &metadata, long_format));
        } else {
            let mut entries = fs::read_dir(&resolved)
                .map_err(|error| error.to_string())?
                .flatten()
                .map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    (name, entry.path(), entry.metadata().ok())
                })
                .filter(|(name, _, _)| show_all || !name.starts_with('.'))
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            for (name, _, metadata) in entries {
                let line = if let Some(metadata) = metadata {
                    format_ls_entry(&name, &metadata, long_format)
                } else {
                    name
                };
                lines.push(line);
            }
        }
        let mut section = String::new();
        if multiple_targets {
            section.push_str(&format!("{}:\n", resolved.display()));
        }
        section.push_str(&lines.join("\n"));
        sections.push(section);
    }
    Ok(ensure_trailing_newline(&sections.join("\n\n")))
}

fn format_ls_entry(name: &str, metadata: &fs::Metadata, long_format: bool) -> String {
    if !long_format {
        return name.to_string();
    }
    let kind = if metadata.is_dir() { 'd' } else { '-' };
    format!("{kind} {:>10} {}", metadata.len(), name)
}

fn builtin_cat(args: &[String], cwd: &Path) -> Result<String, String> {
    if args.is_empty() {
        return Err("cat requires at least one file path".to_string());
    }
    let mut output = String::new();
    for (index, arg) in args.iter().enumerate() {
        let resolved = resolve_path_token(arg, cwd);
        if !resolved.is_file() {
            return Err(format!("not a file: {}", resolved.display()));
        }
        let content = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
        if index > 0 && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&content);
    }
    Ok(output)
}

fn builtin_head(args: &[String], cwd: &Path) -> Result<String, String> {
    let (line_count, paths) = parse_line_window_args("head", args)?;
    render_line_window(&paths, cwd, WindowMode::Head, line_count)
}

fn builtin_tail(args: &[String], cwd: &Path) -> Result<String, String> {
    let (line_count, paths) = parse_line_window_args("tail", args)?;
    render_line_window(&paths, cwd, WindowMode::Tail, line_count)
}

#[derive(Clone, Copy)]
enum WindowMode {
    Head,
    Tail,
}

fn parse_line_window_args(program: &str, args: &[String]) -> Result<(usize, Vec<String>), String> {
    let mut line_count = 10usize;
    let mut files = Vec::<String>::new();
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        if arg == "-n" {
            let Some(value) = args.get(index + 1) else {
                return Err(format!("{program} missing value for -n"));
            };
            line_count = value
                .parse::<usize>()
                .map_err(|_| format!("{program} invalid line count: {value}"))?;
            index += 2;
            continue;
        }
        files.push(arg.clone());
        index += 1;
    }
    if files.is_empty() {
        return Err(format!("{program} requires at least one file path"));
    }
    Ok((line_count, files))
}

fn render_line_window(
    paths: &[String],
    cwd: &Path,
    mode: WindowMode,
    line_count: usize,
) -> Result<String, String> {
    let multiple = paths.len() > 1;
    let mut sections = Vec::<String>::new();
    for path in paths {
        let resolved = resolve_path_token(path, cwd);
        let content = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
        let lines = content.lines().collect::<Vec<_>>();
        let selected = match mode {
            WindowMode::Head => lines.into_iter().take(line_count).collect::<Vec<_>>(),
            WindowMode::Tail => {
                let start = lines.len().saturating_sub(line_count);
                lines.into_iter().skip(start).collect::<Vec<_>>()
            }
        };
        let mut section = String::new();
        if multiple {
            section.push_str(&format!("==> {} <==\n", resolved.display()));
        }
        section.push_str(&selected.join("\n"));
        sections.push(section);
    }
    Ok(ensure_trailing_newline(&sections.join("\n\n")))
}

fn builtin_wc(args: &[String], cwd: &Path) -> Result<String, String> {
    let mut count_lines = false;
    let mut count_words = false;
    let mut count_bytes = false;
    let mut files = Vec::<String>::new();
    for arg in args {
        if let Some(flags) = arg.strip_prefix('-') {
            for flag in flags.chars() {
                match flag {
                    'l' => count_lines = true,
                    'w' => count_words = true,
                    'c' => count_bytes = true,
                    _ => return Err(format!("unsupported wc flag: -{flag}")),
                }
            }
        } else {
            files.push(arg.clone());
        }
    }
    if files.is_empty() {
        return Err("wc requires at least one file path".to_string());
    }
    if !count_lines && !count_words && !count_bytes {
        count_lines = true;
        count_words = true;
        count_bytes = true;
    }

    let mut rows = Vec::<String>::new();
    for path in files {
        let resolved = resolve_path_token(&path, cwd);
        let content = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
        let mut columns = Vec::<String>::new();
        if count_lines {
            columns.push(content.lines().count().to_string());
        }
        if count_words {
            columns.push(content.split_whitespace().count().to_string());
        }
        if count_bytes {
            columns.push(content.len().to_string());
        }
        columns.push(resolved.display().to_string());
        rows.push(columns.join(" "));
    }
    Ok(ensure_trailing_newline(&rows.join("\n")))
}

fn builtin_sed(args: &[String], cwd: &Path) -> Result<String, String> {
    let mut suppress_default = false;
    let mut positional = Vec::<String>::new();
    for arg in args {
        if arg == "-n" {
            suppress_default = true;
        } else if !arg.starts_with('-') || arg == "-" {
            positional.push(arg.clone());
        }
    }
    if !suppress_default {
        return Err("sed only supports read-only `-n start,endp file` usage".to_string());
    }
    if positional.len() < 2 {
        return Err("sed expects a range expression and a file path".to_string());
    }
    let (start, end) = parse_sed_range(&positional[0])?;
    let resolved = resolve_path_token(&positional[1], cwd);
    let content = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
    let lines = content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let line_number = index + 1;
            (line_number >= start && line_number <= end).then_some(line)
        })
        .collect::<Vec<_>>();
    Ok(ensure_trailing_newline(&lines.join("\n")))
}

fn parse_sed_range(script: &str) -> Result<(usize, usize), String> {
    let trimmed = script.trim();
    let command = trimmed
        .strip_suffix('p')
        .ok_or_else(|| "sed only supports print expressions ending with `p`".to_string())?;
    let (start, end) = if let Some((raw_start, raw_end)) = command.split_once(',') {
        (
            raw_start
                .trim()
                .parse::<usize>()
                .map_err(|_| format!("invalid sed start line: {raw_start}"))?,
            raw_end
                .trim()
                .parse::<usize>()
                .map_err(|_| format!("invalid sed end line: {raw_end}"))?,
        )
    } else {
        let line = command
            .trim()
            .parse::<usize>()
            .map_err(|_| format!("invalid sed line expression: {command}"))?;
        (line, line)
    };
    if start == 0 || end == 0 || end < start {
        return Err("sed line range must be positive and ordered".to_string());
    }
    Ok((start, end))
}

fn builtin_find(args: &[String], cwd: &Path) -> Result<String, String> {
    let mut roots = Vec::<String>::new();
    let mut max_depth: Option<usize> = None;
    let mut name_pattern: Option<glob::Pattern> = None;
    let mut type_filter: Option<char> = None;
    let mut index = 0usize;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "-maxdepth" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("find missing value for -maxdepth".to_string());
                };
                max_depth = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| format!("find invalid maxdepth: {value}"))?,
                );
                index += 2;
            }
            "-name" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("find missing value for -name".to_string());
                };
                name_pattern = Some(
                    glob::Pattern::new(value)
                        .map_err(|error| format!("find invalid -name pattern: {error}"))?,
                );
                index += 2;
            }
            "-type" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("find missing value for -type".to_string());
                };
                let filter = match value.as_str() {
                    "f" | "d" => value.chars().next(),
                    _ => return Err(format!("find unsupported -type value: {value}")),
                };
                type_filter = filter;
                index += 2;
            }
            value if value.starts_with('-') => {
                return Err(format!("find unsupported flag: {value}"));
            }
            _ => {
                roots.push(arg.clone());
                index += 1;
            }
        }
    }
    if roots.is_empty() {
        roots.push(".".to_string());
    }

    let mut matches = Vec::<String>::new();
    for root in roots {
        let resolved = resolve_path_token(&root, cwd);
        collect_find_matches(
            &resolved,
            0,
            max_depth,
            name_pattern.as_ref(),
            type_filter,
            &mut matches,
        )?;
    }
    Ok(ensure_trailing_newline(&matches.join("\n")))
}

fn collect_find_matches(
    path: &Path,
    depth: usize,
    max_depth: Option<usize>,
    name_pattern: Option<&glob::Pattern>,
    type_filter: Option<char>,
    matches: &mut Vec<String>,
) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(".");
    let type_matches = match type_filter {
        Some('f') => metadata.is_file(),
        Some('d') => metadata.is_dir(),
        _ => true,
    };
    let name_matches = name_pattern
        .map(|pattern| pattern.matches(file_name))
        .unwrap_or(true);
    if type_matches && name_matches {
        matches.push(path.display().to_string());
    }
    if metadata.is_dir() {
        if max_depth.is_some_and(|value| depth >= value) {
            return Ok(());
        }
        let mut children = fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        children.sort();
        for child in children {
            collect_find_matches(
                &child,
                depth + 1,
                max_depth,
                name_pattern,
                type_filter,
                matches,
            )?;
        }
    }
    Ok(())
}

fn resolve_path_token(token: &str, cwd: &Path) -> PathBuf {
    let candidate = if Path::new(token).is_absolute() {
        PathBuf::from(token)
    } else {
        cwd.join(token)
    };
    candidate.canonicalize().unwrap_or(candidate)
}

fn ensure_trailing_newline(value: &str) -> String {
    if value.is_empty() || value.ends_with('\n') {
        value.to_string()
    } else {
        format!("{value}\n")
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("redbox-bash-{label}-{nanos}"));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[test]
    fn windows_split_preserves_backslashes_in_quoted_paths() {
        let argv =
            split_command_windows(r#"cat "C:\Users\Jam\.redconvert\spaces\default\meta.json""#)
                .expect("windows command should parse");
        assert_eq!(argv[0], "cat");
        assert_eq!(
            argv[1],
            r#"C:\Users\Jam\.redconvert\spaces\default\meta.json"#
        );
    }

    #[test]
    fn builtin_cat_reads_file_content() {
        let root = temp_dir("cat");
        let file = root.join("note.txt");
        fs::write(&file, "hello\nworld\n").expect("fixture should be written");

        let output = builtin_cat(&[file.display().to_string()], &root).expect("cat should work");
        assert_eq!(output, "hello\nworld\n");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn builtin_sed_supports_print_ranges() {
        let root = temp_dir("sed");
        let file = root.join("note.txt");
        fs::write(&file, "a\nb\nc\nd\n").expect("fixture should be written");

        let output = builtin_sed(
            &[
                "-n".to_string(),
                "2,3p".to_string(),
                file.display().to_string(),
            ],
            &root,
        )
        .expect("sed should work");
        assert_eq!(output, "b\nc\n");

        let _ = fs::remove_dir_all(root);
    }
}
