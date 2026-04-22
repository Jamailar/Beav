use glob::{MatchOptions, Pattern};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;

use crate::persistence::with_store;
use crate::{payload_field, payload_string, AppState};

const DEFAULT_GLOB_LIMIT: usize = 50;
const MAX_GLOB_LIMIT: usize = 200;
const DEFAULT_GREP_LIMIT: usize = 20;
const MAX_GREP_LIMIT: usize = 100;
const DEFAULT_READ_LIMIT: usize = 160;
const MAX_READ_LIMIT: usize = 400;
const DEFAULT_READ_MAX_CHARS: usize = 8000;
const DEFAULT_SNIPPET_CHARS: usize = 220;

#[derive(Debug, Clone)]
enum KnowledgeScopeKind {
    Advisor,
    Workspace,
}

#[derive(Debug, Clone)]
struct KnowledgeScope {
    kind: KnowledgeScopeKind,
    advisor_id: Option<String>,
    advisor_name: Option<String>,
    root: PathBuf,
}

pub fn execute_glob(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let scope = resolve_scope(state, session_id, arguments)?;
    let limit = parse_usize(arguments, "limit", DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
    let pattern_text = list_pattern_for_scope(&scope, arguments)?;
    let pattern = compile_pattern(&pattern_text)?;
    let mut matched = collect_matching_files(&scope.root, &pattern)?;
    matched.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let total_matches = matched.len();
    matched.truncate(limit);

    Ok(json!({
        "scopeKind": scope_kind_label(&scope),
        "advisorId": scope.advisor_id,
        "advisorName": scope.advisor_name,
        "rootPath": scope.root.display().to_string(),
        "pattern": pattern_text,
        "totalMatches": total_matches,
        "files": matched.into_iter().map(|item| {
            json!({
                "path": item.relative_path,
                "name": item.name,
                "extension": item.extension,
                "sizeBytes": item.size_bytes,
                "updatedAt": item.updated_at_ms
            })
        }).collect::<Vec<_>>()
    }))
}

pub fn execute_grep(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let scope = resolve_scope(state, session_id, arguments)?;
    let query = payload_string(arguments, "query")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "redbox_fs(action=knowledge.search) requires query".to_string())?;
    let pattern_text = search_pattern_for_scope(&scope, arguments)?;
    let pattern = compile_pattern(&pattern_text)?;
    let limit = parse_usize(arguments, "limit", DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
    let snippet_chars = parse_usize(arguments, "snippetChars", DEFAULT_SNIPPET_CHARS, 800);
    let query_lower = query.to_lowercase();
    let mut files = collect_matching_files(&scope.root, &pattern)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let mut hits = Vec::<Value>::new();
    for file in files {
        if hits.len() >= limit {
            break;
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
                "lineNumber": index + 1,
                "snippet": truncate_chars(line.trim(), snippet_chars),
            }));
            if hits.len() >= limit {
                break;
            }
        }
    }

    Ok(json!({
        "scopeKind": scope_kind_label(&scope),
        "advisorId": scope.advisor_id,
        "advisorName": scope.advisor_name,
        "rootPath": scope.root.display().to_string(),
        "pattern": pattern_text,
        "query": query,
        "totalMatches": hits.len(),
        "hits": hits
    }))
}

pub fn execute_read(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let scope = resolve_scope(state, session_id, arguments)?;
    let relative_path = payload_string(arguments, "path")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "redbox_fs(action=knowledge.read) requires path".to_string())
        .and_then(|value| normalize_scope_relative_path(&scope, &value))?;
    let offset = parse_usize(arguments, "offset", 0, usize::MAX);
    let limit = parse_usize(arguments, "limit", DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    let max_chars = parse_usize(arguments, "maxChars", DEFAULT_READ_MAX_CHARS, 20_000);
    let target_path = resolve_relative_path(&scope.root, &relative_path)?;
    if !target_path.exists() {
        return Err(format!("knowledge file does not exist: {relative_path}"));
    }
    if !target_path.is_file() {
        return Err(format!("knowledge path is not a file: {relative_path}"));
    }
    let content = fs::read_to_string(&target_path).map_err(|error| error.to_string())?;
    let lines = content.lines().collect::<Vec<_>>();
    let safe_offset = offset.min(lines.len());
    let line_end = safe_offset.saturating_add(limit).min(lines.len());
    let sliced = lines[safe_offset..line_end].join("\n");
    let truncated = sliced.chars().count() > max_chars;

    Ok(json!({
        "scopeKind": scope_kind_label(&scope),
        "advisorId": scope.advisor_id,
        "advisorName": scope.advisor_name,
        "rootPath": scope.root.display().to_string(),
        "path": relative_path,
        "absolutePath": target_path.display().to_string(),
        "lineStart": if line_end > safe_offset { safe_offset + 1 } else { 0 },
        "lineEnd": line_end,
        "totalLines": lines.len(),
        "truncated": truncated,
        "content": truncate_chars(&sliced, max_chars)
    }))
}

#[derive(Debug, Clone)]
struct MatchedFile {
    absolute_path: PathBuf,
    relative_path: String,
    name: String,
    extension: Option<String>,
    size_bytes: u64,
    updated_at_ms: i64,
}

fn resolve_scope(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<KnowledgeScope, String> {
    let advisor_id = payload_string(arguments, "advisorId")
        .or_else(|| resolve_session_advisor_id(state, session_id));
    if let Some(advisor_id) = advisor_id {
        let advisor = with_store(state, |store| {
            Ok(store
                .advisors
                .iter()
                .find(|item| item.id == advisor_id)
                .map(|item| (item.id.clone(), item.name.clone())))
        })?
        .ok_or_else(|| format!("advisor not found: {advisor_id}"))?;
        let root = crate::advisor_knowledge_dir(state, &advisor.0)?;
        return Ok(KnowledgeScope {
            kind: KnowledgeScopeKind::Advisor,
            advisor_id: Some(advisor.0),
            advisor_name: Some(advisor.1),
            root,
        });
    }

    let has_workspace_target = payload_string(arguments, "path")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || payload_string(arguments, "pattern")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    if !has_workspace_target {
        return Err(
            "knowledge tool requires advisorId, or a session bound to one advisor".to_string(),
        );
    }

    Ok(KnowledgeScope {
        kind: KnowledgeScopeKind::Workspace,
        advisor_id: None,
        advisor_name: None,
        root: crate::workspace_root(state)?.join("knowledge"),
    })
}

fn list_pattern_for_scope(scope: &KnowledgeScope, arguments: &Value) -> Result<String, String> {
    if let Some(path) = payload_string(arguments, "path").filter(|value| !value.trim().is_empty()) {
        let normalized = normalize_scope_relative_path(scope, &path)?;
        let target = resolve_relative_path(&scope.root, &normalized)?;
        if !target.exists() {
            return Err(format!("knowledge path does not exist: {normalized}"));
        }
        return Ok(if target.is_dir() {
            if normalized.is_empty() {
                "**/*".to_string()
            } else {
                format!("{}/**/*", normalized.trim_end_matches('/'))
            }
        } else {
            normalized
        });
    }
    payload_string(arguments, "pattern")
        .map(|value| normalize_scope_pattern(scope, &value))
        .transpose()
        .map(|value| value.unwrap_or_else(|| "**/*".to_string()))
}

fn search_pattern_for_scope(scope: &KnowledgeScope, arguments: &Value) -> Result<String, String> {
    if let Some(pattern) =
        payload_string(arguments, "pattern").filter(|value| !value.trim().is_empty())
    {
        return normalize_scope_pattern(scope, &pattern);
    }
    if let Some(path) = payload_string(arguments, "path").filter(|value| !value.trim().is_empty()) {
        let normalized = normalize_scope_relative_path(scope, &path)?;
        let target = resolve_relative_path(&scope.root, &normalized)?;
        if !target.exists() {
            return Err(format!("knowledge path does not exist: {normalized}"));
        }
        return Ok(if target.is_dir() {
            if normalized.is_empty() {
                "**/*".to_string()
            } else {
                format!("{}/**/*", normalized.trim_end_matches('/'))
            }
        } else {
            normalized
        });
    }
    Ok("**/*".to_string())
}

fn normalize_scope_pattern(scope: &KnowledgeScope, value: &str) -> Result<String, String> {
    normalize_scope_relative_path(scope, value)
}

fn normalize_scope_relative_path(scope: &KnowledgeScope, value: &str) -> Result<String, String> {
    let normalized = normalize_relative_display(value.trim().to_string());
    if normalized.is_empty() {
        return Ok(String::new());
    }
    match scope.kind {
        KnowledgeScopeKind::Advisor => Ok(normalized),
        KnowledgeScopeKind::Workspace => {
            let stripped = normalized
                .strip_prefix("knowledge/")
                .or_else(|| normalized.strip_prefix("knowledge\\"))
                .unwrap_or(normalized.as_str())
                .trim_matches('/')
                .to_string();
            if stripped.is_empty() {
                return Ok(String::new());
            }
            if stripped == "knowledge" {
                return Ok(String::new());
            }
            Ok(stripped)
        }
    }
}

fn scope_kind_label(scope: &KnowledgeScope) -> &'static str {
    match scope.kind {
        KnowledgeScopeKind::Advisor => "advisor",
        KnowledgeScopeKind::Workspace => "workspace",
    }
}

fn resolve_session_advisor_id(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Option<String> {
    let session_id = session_id?;
    with_store(state, |store| {
        Ok(store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|item| item.metadata.as_ref().cloned()))
    })
    .ok()
    .flatten()
    .and_then(|metadata| {
        payload_string(&metadata, "advisorId").or_else(|| {
            let context_type = payload_string(&metadata, "contextType");
            if context_type.as_deref() == Some("advisor-discussion") {
                return payload_string(&metadata, "contextId");
            }
            payload_field(&metadata, "advisorIds")
                .and_then(Value::as_array)
                .and_then(|items| {
                    if items.len() == 1 {
                        items
                            .first()
                            .and_then(Value::as_str)
                            .map(|value| value.to_string())
                    } else {
                        None
                    }
                })
        })
    })
}

fn collect_matching_files(root: &Path, pattern: &Pattern) -> Result<Vec<MatchedFile>, String> {
    let mut files = Vec::<MatchedFile>::new();
    collect_matching_files_recursive(root, root, pattern, &mut files)?;
    Ok(files)
}

fn collect_matching_files_recursive(
    root: &Path,
    current: &Path,
    pattern: &Pattern,
    files: &mut Vec<MatchedFile>,
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
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let updated_at_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as i64)
            .unwrap_or_default();
        files.push(MatchedFile {
            absolute_path: path.clone(),
            relative_path,
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string(),
            extension: path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_string()),
            size_bytes: metadata.len(),
            updated_at_ms,
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

fn resolve_relative_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let mut resolved = root.to_path_buf();
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            Component::ParentDir => {
                return Err("parent directory traversal is not allowed".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute paths are not allowed".to_string());
            }
        }
    }
    Ok(resolved)
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
                    | "vtt" | "html" | "htm" | "xml" | "js" | "ts" | "jsx" | "tsx"
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

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_scope() -> KnowledgeScope {
        KnowledgeScope {
            kind: KnowledgeScopeKind::Workspace,
            advisor_id: None,
            advisor_name: None,
            root: PathBuf::from("/tmp/workspace/knowledge"),
        }
    }

    #[test]
    fn normalize_workspace_knowledge_path_strips_prefix() {
        let normalized = normalize_scope_relative_path(
            &workspace_scope(),
            "knowledge/redbook/knowledge-123/meta.json",
        )
        .unwrap();
        assert_eq!(normalized, "redbook/knowledge-123/meta.json");
    }

    #[test]
    fn normalize_workspace_knowledge_root_to_empty_relative_path() {
        let normalized = normalize_scope_relative_path(&workspace_scope(), "knowledge").unwrap();
        assert_eq!(normalized, "");
    }

    #[test]
    fn list_pattern_uses_directory_path_as_glob_root() {
        let unique = format!(
            "redbox-knowledge-search-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique).join("knowledge");
        let temp_root = root.parent().unwrap_or(root.as_path()).to_path_buf();
        let folder = root.join("redbook").join("knowledge-123");
        fs::create_dir_all(&folder).unwrap();
        let scope = KnowledgeScope {
            kind: KnowledgeScopeKind::Workspace,
            advisor_id: None,
            advisor_name: None,
            root,
        };
        let arguments = json!({
            "path": "knowledge/redbook/knowledge-123"
        });
        let pattern = list_pattern_for_scope(&scope, &arguments).unwrap();
        assert_eq!(pattern, "redbook/knowledge-123/**/*");
        let _ = fs::remove_dir_all(temp_root);
    }
}
