use serde_json::{json, Value};
use tauri::State;

use crate::runtime::{
    checkpoints_for_session, last_checkpoint_for_session, tool_results_for_session,
};
use crate::{payload_field, payload_string, truncate_chars, AppState, AppStore};

use super::store::{memory_is_active, normalized_memory_type, session_lineage_summary};
use super::types::{MemoryRecallHit, MemoryRecallRequest};

const DEFAULT_RECALL_LIMIT: usize = 8;
const DEFAULT_RECALL_MAX_CHARS: usize = 4_000;
const MAX_RECALL_LIMIT: usize = 20;
const MAX_RECALL_CHARS: usize = 10_000;

pub fn recall_query_enabled(settings: &Value) -> bool {
    settings
        .get("feature_flags")
        .and_then(|value| value.get("runtimeMemoryRecallV2"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn parse_request(payload: &Value) -> MemoryRecallRequest {
    let sources = payload_field(payload, "sources")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let memory_types = payload_field(payload, "memoryTypes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| super::types::normalize_memory_type(Some(value)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    MemoryRecallRequest {
        query: payload_string(payload, "query").unwrap_or_default(),
        session_id: payload_string(payload, "sessionId"),
        runtime_id: payload_string(payload, "runtimeId"),
        sources,
        memory_types,
        include_archived: payload
            .get("includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        include_child_sessions: payload
            .get("includeChildSessions")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        limit: payload
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_RECALL_LIMIT)
            .clamp(1, MAX_RECALL_LIMIT),
        max_chars: payload
            .get("maxChars")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_RECALL_MAX_CHARS)
            .clamp(400, MAX_RECALL_CHARS),
    }
}

fn source_enabled(request: &MemoryRecallRequest, source: &str) -> bool {
    request.sources.is_empty() || request.sources.iter().any(|item| item == source)
}

fn match_score(query: &str, haystacks: &[(&str, f64, &str)]) -> (f64, Vec<String>) {
    if query.trim().is_empty() {
        return (0.5, vec!["recent".to_string()]);
    }
    let normalized_query = query.trim().to_lowercase();
    let mut score = 0.0;
    let mut reasons = Vec::new();
    for (text, weight, reason) in haystacks {
        if text.to_lowercase().contains(&normalized_query) {
            score += weight;
            reasons.push((*reason).to_string());
        }
    }
    (score, reasons)
}

fn request_memory_type_allowed(request: &MemoryRecallRequest, memory_type: &str) -> bool {
    request.memory_types.is_empty() || request.memory_types.iter().any(|item| item == memory_type)
}

fn push_hit(hits: &mut Vec<MemoryRecallHit>, hit: MemoryRecallHit) {
    if hit.score > 0.0 {
        hits.push(hit);
    }
}

fn recall_memory_hits(store: &AppStore, request: &MemoryRecallRequest) -> Vec<MemoryRecallHit> {
    let mut hits = Vec::new();
    if !source_enabled(request, "memory") {
        return hits;
    }
    for item in &store.memories {
        let memory_type = normalized_memory_type(item);
        if !request_memory_type_allowed(request, &memory_type) {
            continue;
        }
        if !request.include_archived && !memory_is_active(item) {
            continue;
        }
        let (score, match_reasons) = match_score(
            &request.query,
            &[
                (&item.content, 0.7, "content"),
                (item.summary.as_deref().unwrap_or_default(), 0.95, "summary"),
                (&memory_type, 0.8, "type"),
                (&item.tags.join(" "), 0.75, "tags"),
                (
                    item.canonical_key.as_deref().unwrap_or_default(),
                    0.65,
                    "canonicalKey",
                ),
            ],
        );
        push_hit(
            &mut hits,
            MemoryRecallHit {
                id: item.id.clone(),
                source_kind: "memory".to_string(),
                source_label: memory_type.clone(),
                title: Some(memory_type.replace('_', " ")),
                summary: item
                    .summary
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| truncate_chars(item.content.trim(), 180)),
                excerpt: Some(truncate_chars(item.content.trim(), 260)),
                score,
                match_reasons,
                session_id: item.source_session_id.clone(),
                runtime_id: None,
                source_task_id: None,
                memory_type: Some(memory_type),
                created_at: json!(item.created_at),
                updated_at: item.updated_at.map(|value| json!(value)),
                lineage: item
                    .source_session_id
                    .as_deref()
                    .map(|session_id| session_lineage_summary(store, session_id)),
                payload: Some(json!({
                    "tags": item.tags,
                    "status": item.status,
                    "sourceCheckpointId": item.source_checkpoint_id,
                    "sourceToolResultId": item.source_tool_result_id,
                    "scopeKey": item.scope_key,
                    "confidence": item.confidence,
                    "expiresAt": item.expires_at,
                })),
            },
        );
    }
    hits
}

fn recall_session_hits(store: &AppStore, request: &MemoryRecallRequest) -> Vec<MemoryRecallHit> {
    let mut hits = Vec::new();
    if !source_enabled(request, "session") {
        return hits;
    }
    let mut sessions = store.chat_sessions.clone();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    for session in sessions {
        let summary = store
            .session_context_records
            .iter()
            .find(|item| item.session_id == session.id)
            .map(|item| item.summary.clone())
            .unwrap_or_default();
        let (score, match_reasons) = match_score(
            &request.query,
            &[
                (&session.title, 1.0, "title"),
                (&summary, 0.85, "summary"),
                (
                    session
                        .metadata
                        .as_ref()
                        .and_then(|value| value.get("contextType"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    0.55,
                    "contextType",
                ),
            ],
        );
        push_hit(
            &mut hits,
            MemoryRecallHit {
                id: session.id.clone(),
                source_kind: "session".to_string(),
                source_label: "session".to_string(),
                title: Some(session.title.clone()),
                summary: if summary.trim().is_empty() {
                    format!("session {}", session.id)
                } else {
                    truncate_chars(summary.trim(), 180)
                },
                excerpt: Some(truncate_chars(summary.trim(), 260)),
                score,
                match_reasons,
                session_id: Some(session.id.clone()),
                runtime_id: session
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("runtimeId"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                source_task_id: session
                    .metadata
                    .as_ref()
                    .and_then(|value| value.get("sourceTaskId"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                memory_type: None,
                created_at: json!(session.created_at),
                updated_at: Some(json!(session.updated_at)),
                lineage: Some(session_lineage_summary(store, &session.id)),
                payload: session.metadata.clone(),
            },
        );
    }
    hits
}

fn recall_checkpoint_hits(store: &AppStore, request: &MemoryRecallRequest) -> Vec<MemoryRecallHit> {
    let mut hits = Vec::new();
    if !source_enabled(request, "checkpoint") {
        return hits;
    }
    for checkpoint in &store.session_checkpoints {
        let payload_text = checkpoint
            .payload
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok())
            .unwrap_or_default();
        let (score, match_reasons) = match_score(
            &request.query,
            &[
                (&checkpoint.summary, 0.95, "summary"),
                (&checkpoint.checkpoint_type, 0.7, "checkpointType"),
                (&payload_text, 0.5, "payload"),
            ],
        );
        push_hit(
            &mut hits,
            MemoryRecallHit {
                id: checkpoint.id.clone(),
                source_kind: "checkpoint".to_string(),
                source_label: checkpoint.checkpoint_type.clone(),
                title: Some(checkpoint.summary.clone()),
                summary: truncate_chars(checkpoint.summary.trim(), 180),
                excerpt: checkpoint
                    .payload
                    .as_ref()
                    .map(|value| truncate_chars(&value.to_string(), 260)),
                score,
                match_reasons,
                session_id: Some(checkpoint.session_id.clone()),
                runtime_id: checkpoint.runtime_id.clone(),
                source_task_id: checkpoint.source_task_id.clone(),
                memory_type: None,
                created_at: json!(checkpoint.created_at),
                updated_at: None,
                lineage: Some(session_lineage_summary(store, &checkpoint.session_id)),
                payload: checkpoint.payload.clone(),
            },
        );
    }
    hits
}

fn recall_tool_result_hits(
    store: &AppStore,
    request: &MemoryRecallRequest,
) -> Vec<MemoryRecallHit> {
    let mut hits = Vec::new();
    if !source_enabled(request, "tool_result") {
        return hits;
    }
    for result in &store.session_tool_results {
        let haystack_payload = result
            .payload
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok())
            .unwrap_or_default();
        let (score, match_reasons) = match_score(
            &request.query,
            &[
                (&result.tool_name, 0.9, "tool"),
                (
                    result.summary_text.as_deref().unwrap_or_default(),
                    0.95,
                    "summary",
                ),
                (
                    result.result_text.as_deref().unwrap_or_default(),
                    0.75,
                    "result",
                ),
                (
                    result.prompt_text.as_deref().unwrap_or_default(),
                    0.45,
                    "prompt",
                ),
                (&haystack_payload, 0.35, "payload"),
            ],
        );
        push_hit(
            &mut hits,
            MemoryRecallHit {
                id: result.id.clone(),
                source_kind: "tool_result".to_string(),
                source_label: result.tool_name.clone(),
                title: Some(result.tool_name.clone()),
                summary: result
                    .summary_text
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| {
                        truncate_chars(result.result_text.as_deref().unwrap_or(""), 180)
                    }),
                excerpt: result
                    .result_text
                    .as_ref()
                    .map(|value| truncate_chars(value.trim(), 260)),
                score,
                match_reasons,
                session_id: Some(result.session_id.clone()),
                runtime_id: result.runtime_id.clone(),
                source_task_id: result.source_task_id.clone(),
                memory_type: None,
                created_at: json!(result.created_at),
                updated_at: Some(json!(result.updated_at)),
                lineage: Some(session_lineage_summary(store, &result.session_id)),
                payload: result.payload.clone(),
            },
        );
    }
    hits
}

fn apply_budget(
    mut hits: Vec<MemoryRecallHit>,
    request: &MemoryRecallRequest,
) -> (Vec<MemoryRecallHit>, bool, usize) {
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let right = b
                    .updated_at
                    .as_ref()
                    .and_then(Value::as_i64)
                    .or_else(|| b.created_at.as_i64())
                    .unwrap_or(0);
                let left = a
                    .updated_at
                    .as_ref()
                    .and_then(Value::as_i64)
                    .or_else(|| a.created_at.as_i64())
                    .unwrap_or(0);
                right.cmp(&left)
            })
    });
    let mut used_chars = 0_usize;
    let mut kept = Vec::new();
    let mut truncated = false;
    for hit in hits.into_iter().take(request.limit) {
        let cost = hit.summary.chars().count()
            + hit
                .excerpt
                .as_ref()
                .map(|value| value.chars().count())
                .unwrap_or(0)
            + hit
                .payload
                .as_ref()
                .map(|value| truncate_chars(&value.to_string(), 180).chars().count())
                .unwrap_or(0);
        if !kept.is_empty() && used_chars + cost > request.max_chars {
            truncated = true;
            break;
        }
        used_chars += cost;
        kept.push(hit);
    }
    (kept, truncated, used_chars)
}

pub fn runtime_recall_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request = parse_request(payload);
    crate::persistence::with_store(state, |store| {
        let mut hits = Vec::new();
        hits.extend(recall_memory_hits(&store, &request));
        hits.extend(recall_session_hits(&store, &request));
        hits.extend(recall_checkpoint_hits(&store, &request));
        hits.extend(recall_tool_result_hits(&store, &request));
        let total_hits = hits.len();
        let (hits, truncated, used_chars) = apply_budget(hits, &request);
        let checkpoints = request
            .session_id
            .as_deref()
            .map(|session_id| checkpoints_for_session(&store, session_id).len())
            .unwrap_or(store.session_checkpoints.len());
        let tool_results = request
            .session_id
            .as_deref()
            .map(|session_id| tool_results_for_session(&store, session_id).len())
            .unwrap_or(store.session_tool_results.len());
        let sources = if request.sources.is_empty() {
            vec![
                "memory".to_string(),
                "session".to_string(),
                "checkpoint".to_string(),
                "tool_result".to_string(),
            ]
        } else {
            request.sources.clone()
        };
        Ok(json!({
            "success": true,
            "query": request.query,
            "sources": sources,
            "memoryTypes": request.memory_types,
            "limit": request.limit,
            "maxChars": request.max_chars,
            "usedChars": used_chars,
            "truncated": truncated,
            "totalHits": total_hits,
            "hits": hits,
            "sessionLineage": request
                .session_id
                .as_deref()
                .map(|session_id| session_lineage_summary(&store, session_id)),
            "lastCheckpoint": request
                .session_id
                .as_deref()
                .and_then(|session_id| last_checkpoint_for_session(&store, session_id)),
            "evidenceCounts": {
                "memories": store.memories.len(),
                "sessions": store.chat_sessions.len(),
                "checkpoints": checkpoints,
                "toolResults": tool_results,
            }
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_memory(id: &str, content: &str, memory_type: &str) -> crate::UserMemoryRecord {
        crate::UserMemoryRecord {
            id: id.to_string(),
            content: content.to_string(),
            r#type: memory_type.to_string(),
            tags: vec!["rg".to_string()],
            created_at: 1,
            updated_at: Some(2),
            last_accessed: None,
            status: Some("active".to_string()),
            archived_at: None,
            archive_reason: None,
            origin_id: None,
            canonical_key: None,
            revision: Some(1),
            last_conflict_at: None,
            summary: Some("prefer rg".to_string()),
            scope_key: None,
            source_session_id: None,
            source_checkpoint_id: None,
            source_tool_result_id: None,
            confidence: None,
            expires_at: None,
            last_maintained_at: None,
        }
    }

    #[test]
    fn recall_memory_hits_match_content_and_summary() {
        let mut store = crate::AppStore::default();
        store
            .memories
            .push(test_memory("m1", "use rg before grep", "workspace_fact"));
        let request = MemoryRecallRequest {
            query: "rg".to_string(),
            sources: vec!["memory".to_string()],
            memory_types: vec![],
            include_archived: false,
            include_child_sessions: false,
            session_id: None,
            runtime_id: None,
            limit: 5,
            max_chars: 2000,
        };
        let hits = recall_memory_hits(&store, &request);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source_kind, "memory");
        assert!(hits[0].score > 0.0);
    }
}
