use glob::{MatchOptions, Pattern};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;

use crate::knowledge_index::{
    advisor_source_id, citation_anchors, document_blocks,
    hybrid::RetrievalMode,
    index_status,
    query_profile::{self, QueryProfile},
    retrieval_audit,
};
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
const DEFAULT_ATTACH_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone)]
enum KnowledgeScopeKind {
    Advisor,
    DocumentSource,
    Workspace,
}

#[derive(Debug, Clone)]
struct KnowledgeScope {
    kind: KnowledgeScopeKind,
    advisor_id: Option<String>,
    advisor_name: Option<String>,
    source_id: Option<String>,
    source_name: Option<String>,
    root: PathBuf,
}

pub fn execute_glob(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let scope = resolve_scope(state, session_id, arguments)?;
    if matches!(scope.kind, KnowledgeScopeKind::DocumentSource) {
        let root_path = scoped_root_path(&scope);
        let limit = parse_usize(arguments, "limit", DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
        let pattern_text = list_pattern_for_scope(&scope, arguments)?;
        let pattern = compile_pattern(&pattern_text)?;
        let mut matched = collect_matching_files(&scope.root, &pattern)?;
        matched.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let total_matches = matched.len();
        matched.truncate(limit);
        return Ok(json!({
            "scopeKind": scope_kind_label(&scope),
            "advisorId": scope.advisor_id,
            "advisorName": scope.advisor_name,
            "sourceId": scope.source_id,
            "sourceName": scope.source_name,
            "rootPath": root_path,
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
        }));
    }
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
        "sourceId": scope.source_id,
        "sourceName": scope.source_name,
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
    if scope.source_id.is_some() {
        return execute_source_search(state, &scope, arguments, &query);
    }
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
                "documentId": format!("{}:{}", scope.advisor_id.clone().unwrap_or_default(), file.relative_path),
                "blockId": Value::Null,
                "path": file.relative_path,
                "name": file.name,
                "blockType": Value::Null,
                "sectionPath": Value::Null,
                "page": Value::Null,
                "lineNumber": index + 1,
                "legalMetadata": Value::Null,
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
        "sourceId": scope.source_id,
        "sourceName": scope.source_name,
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
    if scope.source_id.is_some() {
        if let Some(anchor_id) =
            payload_string(arguments, "anchorId").filter(|value| !value.trim().is_empty())
        {
            if let Some(anchor) = citation_anchors::read_anchor(state, &anchor_id)? {
                let block = document_blocks::read_block(state, &anchor.block_id)?;
                return Ok(json!({
                    "scopeKind": scope_kind_label(&scope),
                    "sourceId": anchor.source_id,
                    "sourceName": anchor.source_name,
                    "documentId": anchor.document_id,
                    "blockId": anchor.block_id,
                    "anchorId": anchor.anchor_id,
                    "rootPath": anchor.root_path,
                    "path": anchor.path,
                    "absolutePath": anchor.absolute_path,
                    "title": anchor.title,
                    "language": anchor.language,
                    "page": anchor.page,
                    "blockType": anchor.block_type,
                    "sectionPath": anchor.section_path,
                    "charStart": anchor.char_start,
                    "charEnd": anchor.char_end,
                    "lineStart": anchor.line_start,
                    "lineEnd": anchor.line_end,
                    "contentOrigin": block.as_ref().map(|item| item.content_origin.clone()),
                    "ocrConfidence": block.as_ref().and_then(|item| item.ocr_confidence),
                    "content": truncate_chars(&anchor.quote_text, parse_usize(arguments, "maxChars", DEFAULT_READ_MAX_CHARS, 20_000))
                }));
            }
            return Err(format!("knowledge anchor does not exist: {anchor_id}"));
        }
        if let Some(block_id) =
            payload_string(arguments, "blockId").filter(|value| !value.trim().is_empty())
        {
            if let Some(block) = document_blocks::read_block(state, &block_id)? {
                let anchors = citation_anchors::anchors_for_block(state, &block.block_id)?;
                return Ok(json!({
                    "scopeKind": scope_kind_label(&scope),
                    "sourceId": block.source_id,
                    "sourceName": block.source_name,
                    "documentId": block.document_id,
                    "blockId": block.block_id,
                    "anchorIds": anchors.iter().map(|item| item.anchor_id.clone()).collect::<Vec<_>>(),
                    "anchors": anchors,
                    "rootPath": block.root_path,
                    "path": block.relative_path,
                    "absolutePath": block.absolute_path,
                    "title": block.title,
                    "language": block.language,
                    "contentOrigin": block.content_origin,
                    "ocrConfidence": block.ocr_confidence,
                    "legalMetadata": {
                        "jurisdiction": block.jurisdiction,
                        "authority": block.authority,
                        "authorityLevel": block.authority_level,
                        "effectiveDate": block.effective_date,
                        "expiryDate": block.expiry_date,
                        "documentType": block.document_type,
                        "isSuperseded": block.is_superseded
                    },
                    "page": block.page,
                    "blockType": block.block_type,
                    "sectionPath": serde_json::from_str::<Vec<String>>(&block.section_path_json).unwrap_or_default(),
                    "blockIndex": block.block_index,
                    "lineStart": block.line_start,
                    "lineEnd": block.line_end,
                    "content": truncate_chars(&block.text, parse_usize(arguments, "maxChars", DEFAULT_READ_MAX_CHARS, 20_000))
                }));
            }
            return Err(format!("knowledge block does not exist: {block_id}"));
        }
    }
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
        "sourceId": scope.source_id,
        "sourceName": scope.source_name,
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

pub fn execute_attach(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<Value, String> {
    let scope = resolve_scope(state, session_id, arguments)?;
    let relative_path = payload_string(arguments, "path")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "redbox_fs(action=knowledge.attach) requires path".to_string())
        .and_then(|value| normalize_scope_relative_path(&scope, &value))?;
    let target_path = resolve_relative_path(&scope.root, &relative_path)?;
    if !target_path.exists() {
        return Err(format!("knowledge file does not exist: {relative_path}"));
    }
    if !target_path.is_file() {
        return Err(format!("knowledge path is not a file: {relative_path}"));
    }
    let metadata = fs::metadata(&target_path).map_err(|error| error.to_string())?;
    if metadata.len() == 0 {
        return Err(format!("knowledge attachment is empty: {relative_path}"));
    }
    let max_bytes = payload_field(arguments, "maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_ATTACH_MAX_BYTES)
        .min(DEFAULT_ATTACH_MAX_BYTES);
    if metadata.len() > max_bytes {
        return Err(format!(
            "knowledge attachment is too large for direct model input: {} bytes > {} bytes",
            metadata.len(),
            max_bytes
        ));
    }
    let (mime_type, kind, _) = crate::guess_mime_and_kind(&target_path);
    if !matches!(kind.as_str(), "image" | "audio" | "video") {
        return Err(format!(
            "knowledge.attach only supports image/audio/video files, got {kind}: {relative_path}"
        ));
    }
    let name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("knowledge-attachment")
        .to_string();
    let absolute_path = target_path.display().to_string();
    Ok(json!({
        "scopeKind": scope_kind_label(&scope),
        "advisorId": scope.advisor_id,
        "advisorName": scope.advisor_name,
        "sourceId": scope.source_id,
        "sourceName": scope.source_name,
        "rootPath": scope.root.display().to_string(),
        "path": relative_path,
        "absolutePath": absolute_path,
        "name": name,
        "kind": kind,
        "mimeType": mime_type,
        "sizeBytes": metadata.len(),
        "llmInputAttachments": [{
            "type": "uploaded-file",
            "name": name,
            "kind": kind,
            "mimeType": mime_type,
            "size": metadata.len(),
            "absolutePath": absolute_path,
            "originalAbsolutePath": absolute_path,
            "workspaceRelativePath": format!("knowledge/{relative_path}"),
            "path": relative_path,
            "deliveryMode": "direct-input",
            "requiresMultimodal": true,
            "source": "knowledge"
        }]
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
            advisor_name: Some(advisor.1.clone()),
            source_id: Some(advisor_source_id(&advisor_id)),
            source_name: Some(advisor.1.clone()),
            root,
        });
    }

    if let Some(source_scope) = resolve_document_source_scope(state, arguments)? {
        return Ok(source_scope);
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
        source_id: None,
        source_name: None,
        root: crate::workspace_root(state)?.join("knowledge"),
    })
}

fn resolve_document_source_scope(
    state: &State<'_, AppState>,
    arguments: &Value,
) -> Result<Option<KnowledgeScope>, String> {
    let requested_source_id =
        payload_string(arguments, "sourceId").filter(|value| !value.trim().is_empty());
    let requested_root_path =
        payload_string(arguments, "rootPath").filter(|value| !value.trim().is_empty());
    if requested_source_id.is_none() && requested_root_path.is_none() {
        return Ok(None);
    }
    let requested_root_path = requested_root_path.as_deref().map(PathBuf::from);
    let matched = with_store(state, |store| {
        Ok(store
            .document_sources
            .iter()
            .find(|item| {
                requested_source_id.as_deref() == Some(item.id.as_str())
                    || requested_root_path
                        .as_ref()
                        .is_some_and(|path| path == &PathBuf::from(&item.root_path))
            })
            .map(|item| (item.id.clone(), item.name.clone(), item.root_path.clone())))
    })?;
    let Some((source_id, source_name, root_path)) = matched else {
        return Err("registered document source not found".to_string());
    };
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!(
            "document source root does not exist: {}",
            root.display()
        ));
    }
    Ok(Some(KnowledgeScope {
        kind: KnowledgeScopeKind::DocumentSource,
        advisor_id: None,
        advisor_name: None,
        source_id: Some(source_id),
        source_name: Some(source_name),
        root,
    }))
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
        KnowledgeScopeKind::Advisor | KnowledgeScopeKind::DocumentSource => Ok(normalized),
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
        KnowledgeScopeKind::DocumentSource => "document-source",
        KnowledgeScopeKind::Workspace => "workspace",
    }
}

fn scoped_root_path(scope: &KnowledgeScope) -> String {
    scope.root.display().to_string()
}

fn execute_source_search(
    state: &State<'_, AppState>,
    scope: &KnowledgeScope,
    arguments: &Value,
    query: &str,
) -> Result<Value, String> {
    let source_id = scope
        .source_id
        .as_deref()
        .ok_or_else(|| "document source id is missing".to_string())?;
    let pattern_text = search_pattern_for_scope(scope, arguments)?;
    let pattern = compile_pattern(&pattern_text)?;
    let limit = parse_usize(arguments, "limit", DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
    let snippet_chars = parse_usize(arguments, "snippetChars", DEFAULT_SNIPPET_CHARS, 800);
    let query_profile = query_profile::build_query_profile(query);
    let retrieval_mode = parse_retrieval_mode(arguments, &query_profile);
    let query_profile_json = query_profile::query_profile_to_json(&query_profile);
    let indexed_count = document_blocks::count_blocks_for_source(state, source_id)?;
    if indexed_count > 0 {
        let hits = document_blocks::search_blocks(
            state,
            source_id,
            query,
            &pattern,
            limit,
            snippet_chars,
            retrieval_mode,
        )?;
        let (hit_payloads, evidence_pack) = build_hit_payloads_and_evidence_pack(
            state,
            &hits,
            query,
            retrieval_mode,
            &query_profile,
        )?;
        let search_mode = if retrieval_mode == RetrievalMode::Hybrid {
            "indexed-blocks-hybrid"
        } else {
            "indexed-blocks-lexical"
        };
        let mut query_plan =
            build_query_plan_value(&query_profile_json, retrieval_mode, search_mode);
        if let Some(plan) = query_plan.as_object_mut() {
            plan.insert(
                "indexStaleness".to_string(),
                Value::String(index_staleness_label(state)),
            );
        }
        let audit_run_id = retrieval_audit::record_search_run(
            state,
            source_id,
            scope.source_name.as_deref(),
            query,
            search_mode,
            &query_profile_json,
            &query_plan,
            &hit_payloads,
            &evidence_pack,
        )?;
        return Ok(json!({
            "scopeKind": scope_kind_label(scope),
            "sourceId": scope.source_id,
            "sourceName": scope.source_name,
            "rootPath": scoped_root_path(scope),
            "pattern": pattern_text,
            "query": query,
            "auditRunId": audit_run_id,
            "queryProfile": query_profile_json.clone(),
            "queryPlan": query_plan,
            "searchMode": search_mode,
            "totalMatches": hits.len(),
            "hits": hit_payloads,
            "evidencePack": evidence_pack
        }));
    }

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
            let document_id = format!("{}:{}", source_id, file.relative_path);
            hits.push(json!({
                "documentId": document_id,
                "sourceId": source_id,
                "sourceName": scope.source_name,
                "blockId": Value::Null,
                "path": file.relative_path,
                "absolutePath": file.absolute_path.display().to_string(),
                "blockType": Value::Null,
                "sectionPath": Value::Null,
                "page": Value::Null,
                "blockIndex": Value::Null,
                "lineStart": index + 1,
                "lineEnd": index + 1,
                "lineNumber": index + 1,
                "contentOrigin": Value::Null,
                "ocrConfidence": Value::Null,
                "legalMetadata": Value::Null,
                "snippet": truncate_chars(line.trim(), snippet_chars),
            }));
            if hits.len() >= limit {
                break;
            }
        }
    }
    Ok(json!({
        "scopeKind": scope_kind_label(scope),
        "sourceId": scope.source_id,
        "sourceName": scope.source_name,
        "rootPath": scoped_root_path(scope),
        "pattern": pattern_text,
        "query": query,
        "queryProfile": query_profile_json.clone(),
        "queryPlan": build_query_plan_value(&query_profile_json, retrieval_mode, "filesystem-fallback"),
        "searchMode": "filesystem-fallback",
        "totalMatches": hits.len(),
        "hits": hits
    }))
}

fn build_hit_payloads_and_evidence_pack(
    state: &State<'_, AppState>,
    hits: &[document_blocks::DocumentBlockHit],
    query: &str,
    retrieval_mode: RetrievalMode,
    query_profile: &QueryProfile,
) -> Result<(Vec<Value>, Value), String> {
    let mut hit_payloads = Vec::<Value>::new();
    let mut evidences = Vec::<Value>::new();
    let query_profile_json = query_profile::query_profile_to_json(query_profile);
    for hit in hits {
        let anchors = citation_anchors::anchors_for_block_query(state, &hit.block_id, query, 3)?;
        let anchor_ids = anchors
            .iter()
            .map(|item| item.anchor_id.clone())
            .collect::<Vec<_>>();
        hit_payloads.push(json!({
            "blockId": hit.block_id,
            "documentId": hit.document_id,
            "sourceId": hit.source_id,
            "sourceName": hit.source_name,
            "rootPath": hit.root_path,
            "path": hit.path,
            "absolutePath": hit.absolute_path,
            "fileExtension": hit.file_extension,
            "title": hit.title,
            "language": hit.language,
            "contentOrigin": hit.content_origin,
            "ocrConfidence": hit.ocr_confidence,
            "legalMetadata": {
                "jurisdiction": hit.jurisdiction,
                "authority": hit.authority,
                "authorityLevel": hit.authority_level,
                "effectiveDate": hit.effective_date,
                "expiryDate": hit.expiry_date,
                "documentType": hit.document_type,
                "isSuperseded": hit.is_superseded
            },
            "page": hit.page,
            "blockType": hit.block_type,
            "sectionPath": hit.section_path,
            "blockIndex": hit.block_index,
            "lineStart": hit.line_start,
            "lineEnd": hit.line_end,
            "snippet": hit.snippet,
            "anchorIds": anchor_ids,
            "ranking": {
                "lexicalScore": hit.lexical_score,
                "bm25Score": hit.bm25_score,
                "semanticScore": hit.semantic_score,
                "fusionScore": hit.fusion_score,
                "rerankScore": hit.rerank_score,
                "legalScore": hit.legal_score,
                "totalScore": hit.total_score
            },
            "retrievalLanes": hit.retrieval_lanes,
        }));
        evidences.push(json!({
            "documentId": hit.document_id,
            "blockId": hit.block_id,
            "path": hit.path,
            "page": hit.page,
            "blockType": hit.block_type,
            "sectionPath": hit.section_path,
            "contentOrigin": hit.content_origin,
            "ocrConfidence": hit.ocr_confidence,
            "legalMetadata": {
                "jurisdiction": hit.jurisdiction,
                "authority": hit.authority,
                "authorityLevel": hit.authority_level,
                "effectiveDate": hit.effective_date,
                "expiryDate": hit.expiry_date,
                "documentType": hit.document_type,
                "isSuperseded": hit.is_superseded
            },
            "retrievalLanes": hit.retrieval_lanes,
            "anchorIds": anchors.iter().map(|item| item.anchor_id.clone()).collect::<Vec<_>>(),
            "anchors": anchors,
            "quotePreview": anchors.first().map(|item| item.quote_text.clone())
        }));
    }
    Ok((
        hit_payloads,
        json!({
            "query": query,
            "queryProfile": query_profile_json.clone(),
            "queryPlan": {
                "intent": query_profile_json.get("intent").cloned().unwrap_or(Value::Null),
                "retrievalMode": query_profile::retrieval_mode_label(retrieval_mode),
                "lexicalEngine": "sqlite-fts5-bm25",
                "lexicalFallback": "sqlite-like",
                "fusion": if retrieval_mode == RetrievalMode::Hybrid { "weighted-rrf" } else { "none" },
                "granularity": query_profile_json.get("granularity").cloned().unwrap_or(Value::Null),
                "citationRequirement": query_profile_json.get("citationRequirement").cloned().unwrap_or(Value::Null),
                "documentTypeHints": query_profile_json.get("documentTypeHints").cloned().unwrap_or(Value::Null),
                "legalBiases": query_profile_json.get("legalBiases").cloned().unwrap_or(Value::Null),
                "rerankers": query_profile.rerankers
            },
            "evidences": evidences,
            "groundingContract": {
                "claimField": "claim",
                "anchorIdsField": "supportingAnchorIds",
                "rule": "Every grounded claim must cite at least one anchorId."
            }
        }),
    ))
}

fn build_query_plan_value(
    query_profile_json: &Value,
    retrieval_mode: RetrievalMode,
    search_mode: &str,
) -> Value {
    json!({
        "retrievalMode": query_profile::retrieval_mode_label(retrieval_mode),
        "searchMode": search_mode,
        "lexicalEngine": "sqlite-fts5-bm25",
        "lexicalFallback": "sqlite-like",
        "granularity": query_profile_json.get("granularity").cloned().unwrap_or(Value::Null),
        "citationRequirement": query_profile_json.get("citationRequirement").cloned().unwrap_or(Value::Null),
        "documentTypeHints": query_profile_json.get("documentTypeHints").cloned().unwrap_or(Value::Null),
        "rerankers": query_profile_json.get("rerankers").cloned().unwrap_or(Value::Null),
    })
}

fn index_staleness_label(state: &State<'_, AppState>) -> String {
    match index_status(state) {
        Ok(status) if status.is_building => "rebuilding".to_string(),
        Ok(status) => status
            .migration_status
            .unwrap_or_else(|| "current".to_string()),
        Err(_) => "unknown".to_string(),
    }
}

fn parse_retrieval_mode(arguments: &Value, query_profile: &QueryProfile) -> RetrievalMode {
    match payload_string(arguments, "retrievalMode").map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "lexical" => RetrievalMode::Lexical,
        Some(value) if value == "hybrid" => RetrievalMode::Hybrid,
        _ => query_profile.recommended_retrieval_mode,
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
    use crate::knowledge_index::query_profile::build_query_profile;

    fn workspace_scope() -> KnowledgeScope {
        KnowledgeScope {
            kind: KnowledgeScopeKind::Workspace,
            advisor_id: None,
            advisor_name: None,
            source_id: None,
            source_name: None,
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
            source_id: None,
            source_name: None,
            root,
        };
        let arguments = json!({
            "path": "knowledge/redbook/knowledge-123"
        });
        let pattern = list_pattern_for_scope(&scope, &arguments).unwrap();
        assert_eq!(pattern, "redbook/knowledge-123/**/*");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn parse_retrieval_mode_defaults_to_query_profile_recommendation() {
        let statute_profile = build_query_profile("请引用民法典第577条原文");
        assert_eq!(
            parse_retrieval_mode(&json!({}), &statute_profile),
            RetrievalMode::Lexical
        );

        let synthesis_profile =
            build_query_profile("compare contract breach remedy across multiple documents");
        assert_eq!(
            parse_retrieval_mode(&json!({}), &synthesis_profile),
            RetrievalMode::Hybrid
        );
    }

    #[test]
    fn explicit_retrieval_mode_overrides_query_profile_recommendation() {
        let profile = build_query_profile("请引用民法典第577条原文");
        assert_eq!(
            parse_retrieval_mode(&json!({ "retrievalMode": "hybrid" }), &profile),
            RetrievalMode::Hybrid
        );
    }
}
