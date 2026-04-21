use glob::{MatchOptions, Pattern};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::State;

use crate::interactive_runtime_shared::resolve_workspace_tool_path_for_session;
use crate::{payload_field, payload_string, AppState};

const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_SEARCH_LIMIT: usize = 100;
const DEFAULT_SNIPPET_CHARS: usize = 220;

#[derive(Debug, Clone)]
struct MatchedWorkspaceFile {
    absolute_path: PathBuf,
    relative_path: String,
    name: String,
}

pub fn execute_search(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let query = payload_string(arguments, "query")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "redbox_fs(action=search, scope=workspace) requires query".to_string())?;
    let root = resolve_workspace_tool_path_for_session(state, session_id, ".")?;
    let pattern_text = search_pattern_for_workspace(state, session_id, &root, arguments)?;
    let pattern = compile_pattern(&pattern_text)?;
    let limit = parse_usize(arguments, "limit", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    let snippet_chars = parse_usize(arguments, "snippetChars", DEFAULT_SNIPPET_CHARS, 800);
    let query_lower = query.to_lowercase();
    let mut files = collect_matching_files(&root, &pattern)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let mut hits = Vec::<Value>::new();
    for file in files {
        if hits.len() >= limit {
            break;
        }

        let relative_lower = file.relative_path.to_lowercase();
        let name_lower = file.name.to_lowercase();
        if relative_lower.contains(&query_lower) || name_lower.contains(&query_lower) {
            hits.push(json!({
                "path": file.relative_path,
                "name": file.name,
                "matchType": "path",
                "lineNumber": Value::Null,
                "snippet": truncate_chars(&file.relative_path, snippet_chars),
            }));
            if hits.len() >= limit {
                break;
            }
        }

        if !is_text_file(&file.absolute_path) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&file.absolute_path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if !line.to_lowercase().contains(&query_lower) {
                continue;
            }
            hits.push(json!({
                "path": file.relative_path,
                "name": file.name,
                "matchType": "content",
                "lineNumber": index + 1,
                "snippet": truncate_chars(line.trim(), snippet_chars),
            }));
            if hits.len() >= limit {
                break;
            }
        }
    }

    Ok(json!({
        "scopeKind": "workspace",
        "rootPath": root.display().to_string(),
        "pattern": pattern_text,
        "query": query,
        "totalMatches": hits.len(),
        "hits": hits
    }))
}

fn search_pattern_for_workspace(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    root: &Path,
    arguments: &Value,
) -> Result<String, String> {
    if let Some(pattern) =
        payload_string(arguments, "pattern").filter(|value| !value.trim().is_empty())
    {
        return normalize_scope_pattern(&pattern);
    }
    if let Some(path) = payload_string(arguments, "path").filter(|value| !value.trim().is_empty()) {
        let resolved = resolve_workspace_tool_path_for_session(state, session_id, &path)?;
        let relative_path = resolved
            .strip_prefix(root)
            .map_err(|_| format!("path is outside currentSpaceRoot: {}", resolved.display()))?;
        let normalized = normalize_relative_display(relative_path.display().to_string());
        if normalized.is_empty() {
            return Ok("**/*".to_string());
        }
        return Ok(if resolved.is_dir() {
            format!("{}/**/*", normalized.trim_end_matches('/'))
        } else {
            normalized
        });
    }
    Ok("**/*".to_string())
}

fn normalize_scope_pattern(value: &str) -> Result<String, String> {
    let path = value.trim().replace('\\', "/");
    if path.is_empty() {
        return Ok("**/*".to_string());
    }
    if Path::new(&path).is_absolute() {
        return Err("absolute patterns are not allowed".to_string());
    }
    for component in Path::new(&path).components() {
        match component {
            Component::CurDir | Component::Normal(_) => {}
            Component::ParentDir => {
                return Err("parent directory traversal is not allowed".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute patterns are not allowed".to_string());
            }
        }
    }
    Ok(path)
}

fn collect_matching_files(
    root: &Path,
    pattern: &Pattern,
) -> Result<Vec<MatchedWorkspaceFile>, String> {
    let mut files = Vec::<MatchedWorkspaceFile>::new();
    collect_matching_files_recursive(root, root, pattern, &mut files)?;
    Ok(files)
}

fn collect_matching_files_recursive(
    root: &Path,
    current: &Path,
    pattern: &Pattern,
    files: &mut Vec<MatchedWorkspaceFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_matching_files_recursive(root, &path, pattern, files)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let relative_path = normalize_relative_display(
            path.strip_prefix(root)
                .unwrap_or(path.as_path())
                .display()
                .to_string(),
        );
        if !pattern.matches_with(&relative_path, match_options()) {
            continue;
        }
        files.push(MatchedWorkspaceFile {
            absolute_path: path.clone(),
            relative_path,
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(())
}

fn compile_pattern(pattern: &str) -> Result<Pattern, String> {
    Pattern::new(if pattern.trim().is_empty() {
        "**/*"
    } else {
        pattern
    })
    .map_err(|error| format!("invalid glob pattern: {error}"))
}

fn match_options() -> MatchOptions {
    MatchOptions {
        case_sensitive: false,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    }
}

fn normalize_relative_display(value: String) -> String {
    value.replace('\\', "/")
}

fn parse_usize(arguments: &Value, key: &str, default: usize, max: usize) -> usize {
    payload_field(arguments, key)
        .and_then(|value| match value {
            Value::Number(number) => number.as_u64().map(|item| item as usize),
            Value::String(text) => text.trim().parse::<usize>().ok(),
            _ => None,
        })
        .map(|value| value.clamp(0, max))
        .unwrap_or(default)
}

fn is_text_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()),
        Some(ext)
            if matches!(
                ext.as_str(),
                "md" | "markdown" | "txt" | "json" | "yaml" | "yml" | "csv" | "tsv" | "srt"
                    | "vtt" | "html" | "htm" | "xml" | "js" | "ts" | "jsx" | "tsx" | "rs"
                    | "toml" | "css" | "scss" | "py" | "java" | "c" | "cpp" | "h" | "hpp"
            )
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars.into_iter().take(max_chars).collect::<String>()
}
