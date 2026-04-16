use crate::persistence::with_store;
use crate::runtime::{
    append_session_checkpoint, SessionCheckpointRecord, SessionToolResultRecord,
    SessionTranscriptRecord,
};
#[cfg(test)]
use crate::ChatSessionRecord;
use crate::{
    make_id, now_iso, slug_from_relative_path, store_root, AppState, AppStore, ChatMessageRecord,
    ChatSessionContextRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

pub const SESSION_CONTEXT_TAIL_MESSAGES: usize = 8;
pub const SESSION_COMPACT_THRESHOLD_MESSAGES: usize = 12;
const SESSION_CONTEXT_SUMMARY_MAX_CHARS: usize = 1200;
const SESSION_BUNDLE_MAX_SESSIONS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRuntimeBundle {
    pub session_id: String,
    pub created_at: String,
    pub protocol: String,
    pub runtime_mode: String,
    pub model_name: Option<String>,
    pub message_count: i64,
    pub updated_at: String,
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRuntimeBundleMeta {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub protocol: String,
    pub runtime_mode: String,
    pub model_name: Option<String>,
    pub summary: String,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRuntimeBundleIndex {
    pub sessions: Vec<SessionRuntimeBundleMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionTranscriptFileMeta {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub summary: String,
    pub protocol: String,
    pub runtime_mode: String,
    pub mode: Option<String>,
    pub model_name: Option<String>,
    pub tag: Option<String>,
    pub git_branch: Option<String>,
    pub worktree_path: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub message_count: i64,
    pub has_compaction: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionTranscriptFileIndex {
    pub sessions: Vec<SessionTranscriptFileMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionTranscriptFileEntry {
    Message {
        entry_id: String,
        session_id: String,
        message: Value,
        created_at: String,
    },
    Metadata {
        entry_id: String,
        session_id: String,
        title: Option<String>,
        tag: Option<String>,
        git_branch: Option<String>,
        worktree_path: Option<String>,
        pr_number: Option<i64>,
        pr_url: Option<String>,
        mode: Option<String>,
        runtime_mode: Option<String>,
        protocol: Option<String>,
        model_name: Option<String>,
        created_at: String,
    },
    CompactBoundary {
        entry_id: String,
        session_id: String,
        summary: String,
        preserved_entry_ids: Vec<String>,
        preserved_message_count: i64,
        created_at: String,
    },
}

pub fn trace_for_session(store: &AppStore, session_id: &str) -> Vec<SessionTranscriptRecord> {
    let mut items: Vec<SessionTranscriptRecord> = store
        .session_transcript_records
        .iter()
        .filter(|item| item.session_id == session_id)
        .cloned()
        .collect();
    items.sort_by_key(|item| item.created_at);
    items
}

fn session_ids_for_query(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
) -> Vec<String> {
    let mut session_ids = vec![session_id.to_string()];
    if include_child_sessions {
        session_ids.extend(
            store
                .chat_sessions
                .iter()
                .filter(|item| {
                    item.metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get("parentSessionId"))
                        .and_then(Value::as_str)
                        == Some(session_id)
                })
                .map(|item| item.id.clone()),
        );
    }
    session_ids
}

pub fn trace_value_for_session(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
) -> Value {
    let session_ids = session_ids_for_query(store, session_id, include_child_sessions);
    let mut items = store
        .session_transcript_records
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|candidate| candidate == &item.session_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.created_at);
    json!(items)
}

pub fn checkpoints_for_session(store: &AppStore, session_id: &str) -> Vec<SessionCheckpointRecord> {
    let mut items: Vec<SessionCheckpointRecord> = store
        .session_checkpoints
        .iter()
        .filter(|item| item.session_id == session_id)
        .cloned()
        .collect();
    items.sort_by_key(|item| item.created_at);
    items
}

pub fn checkpoints_value_for_session(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
    runtime_id: Option<&str>,
) -> Value {
    let session_ids = session_ids_for_query(store, session_id, include_child_sessions);
    let mut items = store
        .session_checkpoints
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|candidate| candidate == &item.session_id)
        })
        .filter(|item| {
            runtime_id
                .map(|value| item.runtime_id.as_deref() == Some(value))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.created_at);
    json!(items)
}

pub fn tool_results_for_session(
    store: &AppStore,
    session_id: &str,
) -> Vec<SessionToolResultRecord> {
    let mut items: Vec<SessionToolResultRecord> = store
        .session_tool_results
        .iter()
        .filter(|item| item.session_id == session_id)
        .cloned()
        .collect();
    items.sort_by_key(|item| item.created_at);
    items
}

pub fn tool_results_value_for_session(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
    runtime_id: Option<&str>,
) -> Value {
    let session_ids = session_ids_for_query(store, session_id, include_child_sessions);
    let mut items = store
        .session_tool_results
        .iter()
        .filter(|item| {
            session_ids
                .iter()
                .any(|candidate| candidate == &item.session_id)
        })
        .filter(|item| {
            runtime_id
                .map(|value| item.runtime_id.as_deref() == Some(value))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.created_at);
    json!(items)
}

pub fn transcript_count_for_session(store: &AppStore, session_id: &str) -> i64 {
    store
        .session_transcript_records
        .iter()
        .filter(|item| item.session_id == session_id)
        .count() as i64
}

pub fn checkpoint_count_for_session(store: &AppStore, session_id: &str) -> i64 {
    store
        .session_checkpoints
        .iter()
        .filter(|item| item.session_id == session_id)
        .count() as i64
}

pub fn last_checkpoint_for_session(
    store: &AppStore,
    session_id: &str,
) -> Option<SessionCheckpointRecord> {
    checkpoints_for_session(store, session_id)
        .into_iter()
        .max_by_key(|item| item.created_at)
}

#[cfg(test)]
pub fn session_list_item_value(store: &AppStore, session: &ChatSessionRecord) -> Value {
    crate::session_manager::session_list_item_value(store, session, None)
}

#[cfg(test)]
pub fn session_detail_value(store: &AppStore, session_id: &str) -> Value {
    crate::session_manager::session_detail_value(store, session_id, None)
}

#[cfg(test)]
pub fn session_resume_value(
    store: &AppStore,
    session_id: &str,
    resume_messages: Option<Vec<Value>>,
) -> Value {
    crate::session_manager::session_resume_value(store, session_id, None, resume_messages)
}

pub fn chat_messages_for_session(store: &AppStore, session_id: &str) -> Vec<ChatMessageRecord> {
    let mut items: Vec<ChatMessageRecord> = store
        .chat_messages
        .iter()
        .filter(|item| {
            item.session_id == session_id && (item.role == "user" || item.role == "assistant")
        })
        .cloned()
        .collect();
    items.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));
    items
}

pub fn session_message_count_for_session(store: &AppStore, session_id: &str) -> i64 {
    chat_messages_for_session(store, session_id).len() as i64
}

pub fn session_summary_text_for_session(store: &AppStore, session_id: &str) -> String {
    if let Some(summary) = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
        .map(|item| item.summary.clone())
        .filter(|item| !item.trim().is_empty())
    {
        return summary;
    }
    chat_messages_for_session(store, session_id)
        .into_iter()
        .find(|item| item.role == "user")
        .map(|item| snippet(&item.content, 120))
        .unwrap_or_default()
}

pub fn session_context_value_for_session(store: &AppStore, session_id: &str) -> Value {
    store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
        .map(session_context_record_value)
        .unwrap_or(Value::Null)
}

pub fn list_transcript_sessions(
    state: &State<'_, AppState>,
) -> Result<Vec<SessionTranscriptFileMeta>, String> {
    let mut items = load_session_transcript_file_index(state)?.sessions;
    items.sort_by(|a, b| compare_iso_or_numeric(&b.updated_at, &a.updated_at));
    Ok(items)
}

pub fn transcript_session_meta_value(meta: &SessionTranscriptFileMeta) -> Value {
    json!({
        "id": meta.session_id,
        "messageCount": meta.message_count,
        "summary": meta.summary,
        "title": meta.title,
        "tag": meta.tag,
        "gitBranch": meta.git_branch,
        "worktreePath": meta.worktree_path,
        "prNumber": meta.pr_number,
        "prUrl": meta.pr_url,
        "protocol": meta.protocol,
        "runtimeMode": meta.runtime_mode,
        "mode": meta.mode,
        "hasCompaction": meta.has_compaction,
        "chatSession": {
            "id": meta.session_id,
            "title": if meta.title.trim().is_empty() { "New Chat" } else { meta.title.as_str() },
            "updatedAt": meta.updated_at,
            "createdAt": meta.created_at,
        }
    })
}

pub fn transcript_session_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(list_transcript_sessions(state)?
        .iter()
        .map(transcript_session_meta_value)
        .collect::<Vec<_>>()))
}

pub fn transcript_session_meta_by_id(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Option<SessionTranscriptFileMeta>, String> {
    let resolved =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    Ok(load_session_transcript_file_index(state)?
        .sessions
        .into_iter()
        .find(|item| item.session_id == resolved))
}

pub fn transcript_resume_messages(
    state: &State<'_, AppState>,
    store: &AppStore,
    session_id: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let entries =
        load_transcript_entries(state, &resolve_session_id_or_latest(state, session_id)?)?;
    if entries.is_empty() {
        return Ok(runtime_context_messages_for_session(
            None, store, session_id, limit,
        ));
    }
    let (messages, summary_prompt, _) = rebuild_messages_after_last_compaction(&entries);
    Ok(bundle_messages_for_runtime(
        &messages,
        summary_prompt,
        limit,
    ))
}

pub fn load_session_bundle_messages(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    Ok(
        load_session_runtime_bundle(state, &resolve_session_id_or_latest(state, session_id)?)?
            .map(|bundle| bundle.messages)
            .unwrap_or_default(),
    )
}

pub fn save_session_bundle_messages(
    state: &State<'_, AppState>,
    session_id: &str,
    protocol: &str,
    runtime_mode: &str,
    model_name: Option<&str>,
    messages: &[Value],
) -> Result<(), String> {
    let resolved_session_id =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    let existing = load_session_runtime_bundle(state, &resolved_session_id)?;
    let bundle = SessionRuntimeBundle {
        session_id: resolved_session_id,
        created_at: existing
            .as_ref()
            .map(|item| item.created_at.clone())
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(now_iso),
        protocol: protocol.to_string(),
        runtime_mode: runtime_mode.to_string(),
        model_name: model_name.map(ToString::to_string),
        message_count: messages.len() as i64,
        updated_at: now_iso(),
        messages: messages.to_vec(),
    };
    persist_session_runtime_bundle(state, &bundle)?;
    sync_transcript_from_bundle(state, &bundle)
}

pub fn remove_session_bundle(state: &State<'_, AppState>, session_id: &str) -> Result<(), String> {
    let resolved_session_id =
        resolve_session_id_or_latest(state, session_id).unwrap_or_else(|_| session_id.to_string());
    let path = session_runtime_bundle_path(state, &resolved_session_id)?;
    let transcript_path = session_transcript_path(state, &resolved_session_id)?;
    match fs::remove_file(path) {
        Ok(_) => {
            remove_session_bundle_meta(state, &resolved_session_id)?;
            let _ = fs::remove_file(transcript_path);
            let _ = remove_session_transcript_meta(state, &resolved_session_id);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_session_bundle_meta(state, &resolved_session_id)?;
            let _ = fs::remove_file(transcript_path);
            let _ = remove_session_transcript_meta(state, &resolved_session_id);
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn duplicate_session_bundle(
    state: &State<'_, AppState>,
    source_session_id: &str,
    target_session_id: &str,
) -> Result<(), String> {
    let Some(mut bundle) = load_session_runtime_bundle(state, source_session_id)? else {
        return Ok(());
    };
    bundle.session_id = target_session_id.to_string();
    bundle.created_at = now_iso();
    bundle.updated_at = now_iso();
    persist_session_runtime_bundle(state, &bundle)?;
    let entries = load_transcript_entries(state, source_session_id)?;
    for entry in entries {
        let duplicated = match entry {
            SessionTranscriptFileEntry::Message {
                message,
                created_at,
                ..
            } => SessionTranscriptFileEntry::Message {
                entry_id: make_id("entry"),
                session_id: target_session_id.to_string(),
                message,
                created_at,
            },
            SessionTranscriptFileEntry::Metadata {
                title,
                tag,
                git_branch,
                worktree_path,
                pr_number,
                pr_url,
                mode,
                runtime_mode,
                protocol,
                model_name,
                created_at,
                ..
            } => SessionTranscriptFileEntry::Metadata {
                entry_id: make_id("entry"),
                session_id: target_session_id.to_string(),
                title,
                tag,
                git_branch,
                worktree_path,
                pr_number,
                pr_url,
                mode,
                runtime_mode,
                protocol,
                model_name,
                created_at,
            },
            SessionTranscriptFileEntry::CompactBoundary {
                summary,
                preserved_entry_ids: _,
                preserved_message_count,
                created_at,
                ..
            } => SessionTranscriptFileEntry::CompactBoundary {
                entry_id: make_id("entry"),
                session_id: target_session_id.to_string(),
                summary,
                preserved_entry_ids: Vec::new(),
                preserved_message_count,
                created_at,
            },
        };
        append_transcript_entry(state, target_session_id, &duplicated)?;
    }
    let summary = session_bundle_summary_from_messages(&bundle.messages);
    let meta = session_transcript_metadata_snapshot(
        state,
        target_session_id,
        &bundle.runtime_mode,
        &bundle.protocol,
        bundle.model_name.as_deref(),
        bundle.message_count,
        &bundle.updated_at,
        &summary,
    )?;
    update_session_transcript_index(state, meta)
}

pub fn session_context_usage_value(store: &AppStore, session_id: &str) -> Value {
    let messages = chat_messages_for_session(store, session_id);
    let total_chars = messages
        .iter()
        .map(|item| item.content.chars().count() as i64)
        .sum::<i64>();
    let context = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id);
    let estimated_total_tokens = context
        .map(|item| item.estimated_total_tokens)
        .unwrap_or_else(|| estimate_tokens_from_chars(total_chars));
    let compacted_message_count = context
        .map(|item| item.compacted_message_count)
        .unwrap_or(0);
    let compact_rounds = context.map(|item| item.compact_rounds).unwrap_or(0);
    let compact_updated_at = context
        .map(|item| Value::String(item.updated_at.clone()))
        .unwrap_or(Value::Null);
    let summary_chars = context.map(|item| item.summary_chars).unwrap_or(0);
    let effective_messages = if compacted_message_count > 0 {
        compacted_message_count.min(1) + messages.len().min(SESSION_CONTEXT_TAIL_MESSAGES) as i64
    } else {
        messages.len() as i64
    };

    json!({
        "success": true,
        "estimatedTotalTokens": estimated_total_tokens,
        "estimatedEffectiveTokens": estimate_tokens_from_chars(
            if compacted_message_count > 0 {
                summary_chars
                    + messages
                        .iter()
                        .rev()
                        .take(SESSION_CONTEXT_TAIL_MESSAGES)
                        .map(|item| item.content.chars().count() as i64)
                        .sum::<i64>()
            } else {
                total_chars
            }
        ),
        "totalMessages": messages.len(),
        "effectiveMessages": effective_messages,
        "compactedMessageCount": compacted_message_count,
        "recentMessageCount": messages.len().min(SESSION_CONTEXT_TAIL_MESSAGES),
        "compactThreshold": SESSION_COMPACT_THRESHOLD_MESSAGES,
        "compactRatio": if messages.is_empty() {
            0.0
        } else {
            compacted_message_count as f64 / messages.len() as f64
        },
        "compactRounds": compact_rounds,
        "compactUpdatedAt": compact_updated_at,
        "summaryChars": summary_chars,
    })
}

pub fn update_session_context_record(
    store: &mut AppStore,
    session_id: &str,
    source: &str,
    force: bool,
) -> Option<ChatSessionContextRecord> {
    let messages = chat_messages_for_session(store, session_id);
    if messages.len() < SESSION_COMPACT_THRESHOLD_MESSAGES {
        store
            .session_context_records
            .retain(|item| item.session_id != session_id);
        return None;
    }

    let archived_count = messages.len().saturating_sub(SESSION_CONTEXT_TAIL_MESSAGES);
    if archived_count == 0 {
        return None;
    }
    let archived = &messages[..archived_count];
    let existing = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
        .cloned();
    let summary = build_session_context_summary(archived);
    let record = ChatSessionContextRecord {
        session_id: session_id.to_string(),
        summary_chars: summary.chars().count() as i64,
        summary,
        summary_source: source.to_string(),
        total_message_count: messages.len() as i64,
        compacted_message_count: archived_count as i64,
        tail_message_count: messages.len().min(SESSION_CONTEXT_TAIL_MESSAGES) as i64,
        compact_rounds: match (existing.as_ref(), force) {
            (Some(item), true) => item.compact_rounds + 1,
            (Some(item), false) => item.compact_rounds.max(1),
            (None, _) => 1,
        },
        estimated_total_tokens: estimate_tokens_from_chars(
            messages
                .iter()
                .map(|item| item.content.chars().count() as i64)
                .sum::<i64>(),
        ),
        first_user_message: messages
            .iter()
            .find(|item| item.role == "user")
            .map(|item| snippet(&item.content, 160)),
        last_user_message: messages
            .iter()
            .rev()
            .find(|item| item.role == "user")
            .map(|item| snippet(&item.content, 200)),
        last_assistant_message: messages
            .iter()
            .rev()
            .find(|item| item.role == "assistant")
            .map(|item| snippet(&item.content, 200)),
        updated_at: now_iso(),
    };
    if let Some(existing_index) = store
        .session_context_records
        .iter()
        .position(|item| item.session_id == session_id)
    {
        store.session_context_records[existing_index] = record.clone();
    } else {
        store.session_context_records.push(record.clone());
    }
    Some(record)
}

pub fn append_compact_boundary_entry(
    state: &State<'_, AppState>,
    _store: &AppStore,
    session_id: &str,
    summary: &str,
) -> Result<(), String> {
    let entries = load_transcript_entries(state, session_id)?;
    let message_entries = transcript_message_entries(&entries);
    let preserve_from = message_entries
        .len()
        .saturating_sub(SESSION_CONTEXT_TAIL_MESSAGES);
    let preserved_entry_ids = message_entries[preserve_from..]
        .iter()
        .map(|(entry_id, _)| entry_id.clone())
        .collect::<Vec<_>>();
    append_transcript_entry(
        state,
        session_id,
        &SessionTranscriptFileEntry::CompactBoundary {
            entry_id: make_id("entry"),
            session_id: session_id.to_string(),
            summary: summary.to_string(),
            preserved_message_count: preserved_entry_ids.len() as i64,
            preserved_entry_ids,
            created_at: now_iso(),
        },
    )?;
    let resolved = resolve_session_id_or_latest(state, session_id)?;
    let mut index = load_session_transcript_file_index(state)?;
    if let Some(meta) = index
        .sessions
        .iter_mut()
        .find(|item| item.session_id == resolved)
    {
        meta.has_compaction = true;
        meta.summary = snippet(summary, 80);
        meta.updated_at = now_iso();
    }
    persist_session_transcript_file_index(state, &index)
}

pub fn runtime_context_messages_for_session(
    state: Option<&State<'_, AppState>>,
    store: &AppStore,
    session_id: &str,
    limit: usize,
) -> Vec<Value> {
    let initial_context_prompt = session_initial_context_prompt(store, session_id);
    if let Some(state) = state {
        if let Ok(bundle_messages) = load_session_bundle_messages(state, session_id) {
            if !bundle_messages.is_empty() {
                let mut result = bundle_messages_for_runtime(
                    &bundle_messages,
                    session_resume_summary_prompt(store, session_id),
                    limit,
                );
                if let Some(prompt) = initial_context_prompt.as_deref() {
                    result.insert(
                        0,
                        json!({
                            "role": "user",
                            "content": prompt
                        }),
                    );
                }
                return result;
            }
        }
    }

    let items = chat_messages_for_session(store, session_id)
        .into_iter()
        .map(|item| {
            json!({
                "role": item.role,
                "content": item.content
            })
        })
        .collect::<Vec<_>>();
    let mut result = bundle_messages_for_runtime(
        &items,
        session_resume_summary_prompt(store, session_id),
        limit,
    );
    if let Some(prompt) = initial_context_prompt.as_deref() {
        result.insert(
            0,
            json!({
                "role": "user",
                "content": prompt
            }),
        );
    }
    result
}

#[cfg(test)]
pub fn session_bridge_summary_value(session: &ChatSessionRecord, store: &AppStore) -> Value {
    crate::session_manager::session_bridge_summary_value(store, session, None)
}

fn session_context_record_value(record: &ChatSessionContextRecord) -> Value {
    json!({
        "sessionId": record.session_id,
        "summary": record.summary,
        "summarySource": record.summary_source,
        "totalMessageCount": record.total_message_count,
        "compactedMessageCount": record.compacted_message_count,
        "tailMessageCount": record.tail_message_count,
        "compactRounds": record.compact_rounds,
        "summaryChars": record.summary_chars,
        "estimatedTotalTokens": record.estimated_total_tokens,
        "firstUserMessage": record.first_user_message,
        "lastUserMessage": record.last_user_message,
        "lastAssistantMessage": record.last_assistant_message,
        "updatedAt": record.updated_at,
    })
}

fn session_resume_summary_prompt(store: &AppStore, session_id: &str) -> Option<String> {
    store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id && item.compacted_message_count > 0)
        .map(|item| {
            format!(
                "[Session resume summary]\n{}\n\nUse this archived context together with the recent messages below.",
                item.summary
            )
        })
}

fn session_initial_context_prompt(store: &AppStore, session_id: &str) -> Option<String> {
    store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .and_then(|session| session.metadata.as_ref())
        .and_then(|metadata| metadata.get("initialContext"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("[Session initial context]\n{value}"))
}

pub fn bundle_messages_for_runtime(
    messages: &[Value],
    summary_prompt: Option<String>,
    limit: usize,
) -> Vec<Value> {
    if messages.is_empty() {
        return Vec::new();
    }
    let start = messages.len().saturating_sub(limit);
    let mut result = Vec::new();
    if start > 0 {
        if let Some(summary) = summary_prompt.filter(|item| !item.trim().is_empty()) {
            result.push(json!({
                "role": "user",
                "content": summary
            }));
        }
    }
    result.extend(messages[start..].iter().cloned());
    result
}

fn build_session_context_summary(messages: &[ChatMessageRecord]) -> String {
    let total_count = messages.len();
    let user_count = messages.iter().filter(|item| item.role == "user").count();
    let assistant_count = messages
        .iter()
        .filter(|item| item.role == "assistant")
        .count();
    let first_user = messages
        .iter()
        .find(|item| item.role == "user")
        .map(|item| snippet(&item.content, 180));
    let last_user = messages
        .iter()
        .rev()
        .find(|item| item.role == "user")
        .map(|item| snippet(&item.content, 220));
    let last_assistant = messages
        .iter()
        .rev()
        .find(|item| item.role == "assistant")
        .map(|item| snippet(&item.content, 220));

    let mut lines = vec![format!(
        "Archived {total_count} messages ({user_count} user / {assistant_count} assistant) from this session."
    )];
    if let Some(value) = first_user {
        lines.push(format!("Conversation started with: {value}"));
    }
    if let Some(value) = last_user {
        lines.push(format!("Latest archived user intent: {value}"));
    }
    if let Some(value) = last_assistant {
        lines.push(format!("Latest archived assistant reply: {value}"));
    }
    let summary = lines.join("\n");
    snippet(&summary, SESSION_CONTEXT_SUMMARY_MAX_CHARS)
}

fn session_bundle_summary_from_messages(messages: &[Value]) -> String {
    messages
        .iter()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|item| item.get("content").and_then(Value::as_str))
        .map(|item| snippet(item, 80))
        .unwrap_or_default()
}

fn snippet(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= limit {
        return text;
    }
    let mut truncated: String = text.chars().take(limit.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

fn estimate_tokens_from_chars(chars: i64) -> i64 {
    ((chars.max(0) as f64) / 4.0).ceil() as i64
}

fn compare_created_at(left: &str, right: &str) -> std::cmp::Ordering {
    match (left.parse::<i64>(), right.parse::<i64>()) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => left.cmp(right),
    }
}

fn compare_iso_or_numeric(left: &str, right: &str) -> std::cmp::Ordering {
    compare_created_at(left, right)
}

fn session_transcript_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let dir = store_root(state)?.join("session-transcripts");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn session_transcript_path(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(session_transcript_dir(state)?
        .join(format!("{}.jsonl", slug_from_relative_path(session_id))))
}

fn session_transcript_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(session_transcript_dir(state)?.join("index.json"))
}

fn append_transcript_entry(
    state: &State<'_, AppState>,
    session_id: &str,
    entry: &SessionTranscriptFileEntry,
) -> Result<(), String> {
    let path = session_transcript_path(state, session_id)?;
    let serialized = serde_json::to_string(entry).map_err(|error| error.to_string())?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{serialized}").map_err(|error| error.to_string())
}

fn load_transcript_entries(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Vec<SessionTranscriptFileEntry>, String> {
    let path = session_transcript_path(state, session_id)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut entries = Vec::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(entry) = serde_json::from_str::<SessionTranscriptFileEntry>(line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

fn load_session_transcript_file_index(
    state: &State<'_, AppState>,
) -> Result<SessionTranscriptFileIndex, String> {
    let path = session_transcript_index_path(state)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionTranscriptFileIndex::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str::<SessionTranscriptFileIndex>(&content).map_err(|error| error.to_string())
}

fn persist_session_transcript_file_index(
    state: &State<'_, AppState>,
    index: &SessionTranscriptFileIndex,
) -> Result<(), String> {
    let path = session_transcript_index_path(state)?;
    let serialized = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn remove_session_transcript_meta(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let mut index = load_session_transcript_file_index(state)?;
    let before = index.sessions.len();
    index.sessions.retain(|item| item.session_id != session_id);
    if index.sessions.len() != before {
        persist_session_transcript_file_index(state, &index)?;
    }
    Ok(())
}

fn session_transcript_metadata_snapshot(
    state: &State<'_, AppState>,
    session_id: &str,
    runtime_mode: &str,
    protocol: &str,
    model_name: Option<&str>,
    message_count: i64,
    updated_at: &str,
    summary: &str,
) -> Result<SessionTranscriptFileMeta, String> {
    let (title, mode, tag, pr_number, pr_url, worktree_path) = with_store(state, |store| {
        let session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id);
        let metadata: Option<&Value> = session.and_then(|item| item.metadata.as_ref());
        Ok((
            session
                .map(|item| item.title.clone())
                .unwrap_or_else(|| "New Chat".to_string()),
            metadata
                .and_then(|value: &Value| value.get("mode"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            metadata
                .and_then(|value: &Value| value.get("tag"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            metadata
                .and_then(|value: &Value| value.get("prNumber"))
                .and_then(Value::as_i64),
            metadata
                .and_then(|value: &Value| value.get("prUrl"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            metadata
                .and_then(|value: &Value| value.get("worktreePath"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
        ))
    })?;
    let git_branch = current_git_branch(state).ok();
    Ok(SessionTranscriptFileMeta {
        session_id: session_id.to_string(),
        created_at: updated_at.to_string(),
        updated_at: updated_at.to_string(),
        title,
        summary: summary.to_string(),
        protocol: protocol.to_string(),
        runtime_mode: runtime_mode.to_string(),
        mode,
        model_name: model_name.map(ToString::to_string),
        tag,
        git_branch,
        worktree_path,
        pr_number,
        pr_url,
        message_count,
        has_compaction: false,
    })
}

fn update_session_transcript_index(
    state: &State<'_, AppState>,
    meta: SessionTranscriptFileMeta,
) -> Result<(), String> {
    let mut index = load_session_transcript_file_index(state)?;
    if let Some(existing) = index
        .sessions
        .iter_mut()
        .find(|item| item.session_id == meta.session_id)
    {
        let created_at = existing.created_at.clone();
        *existing = meta;
        existing.created_at = created_at;
    } else {
        index.sessions.push(meta);
    }
    index
        .sessions
        .sort_by(|a, b| compare_iso_or_numeric(&a.updated_at, &b.updated_at));
    let overflow = index
        .sessions
        .len()
        .saturating_sub(SESSION_BUNDLE_MAX_SESSIONS);
    let removed = if overflow > 0 {
        index.sessions.drain(..overflow).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    persist_session_transcript_file_index(state, &index)?;
    for meta in removed {
        let _ = fs::remove_file(session_transcript_path(state, &meta.session_id)?);
    }
    Ok(())
}

fn current_git_branch(state: &State<'_, AppState>) -> Result<String, String> {
    let cwd = crate::workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let output = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn session_runtime_bundle_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let dir = store_root(state)?.join("session-bundles");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn session_runtime_bundle_path(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(session_runtime_bundle_dir(state)?
        .join(format!("{}.json", slug_from_relative_path(session_id))))
}

fn session_runtime_bundle_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(session_runtime_bundle_dir(state)?.join("index.json"))
}

fn load_session_runtime_bundle_index(
    state: &State<'_, AppState>,
) -> Result<SessionRuntimeBundleIndex, String> {
    let path = session_runtime_bundle_index_path(state)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionRuntimeBundleIndex::default());
        }
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str::<SessionRuntimeBundleIndex>(&content).map_err(|error| error.to_string())
}

fn persist_session_runtime_bundle_index(
    state: &State<'_, AppState>,
    index: &SessionRuntimeBundleIndex,
) -> Result<(), String> {
    let path = session_runtime_bundle_index_path(state)?;
    let serialized = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn update_session_bundle_index(
    index: &mut SessionRuntimeBundleIndex,
    bundle: &SessionRuntimeBundle,
) -> Vec<String> {
    let meta = SessionRuntimeBundleMeta {
        session_id: bundle.session_id.clone(),
        created_at: bundle.created_at.clone(),
        updated_at: bundle.updated_at.clone(),
        protocol: bundle.protocol.clone(),
        runtime_mode: bundle.runtime_mode.clone(),
        model_name: bundle.model_name.clone(),
        summary: session_bundle_summary_from_messages(&bundle.messages),
        message_count: bundle.message_count,
    };
    if let Some(existing) = index
        .sessions
        .iter_mut()
        .find(|item| item.session_id == bundle.session_id)
    {
        *existing = meta;
    } else {
        index.sessions.push(meta);
    }
    index
        .sessions
        .sort_by(|a, b| compare_iso_or_numeric(&a.updated_at, &b.updated_at));
    let overflow = index
        .sessions
        .len()
        .saturating_sub(SESSION_BUNDLE_MAX_SESSIONS);
    if overflow == 0 {
        return Vec::new();
    }
    let removed = index
        .sessions
        .drain(..overflow)
        .map(|item| item.session_id)
        .collect::<Vec<_>>();
    removed
}

fn remove_session_bundle_meta(state: &State<'_, AppState>, session_id: &str) -> Result<(), String> {
    let mut index = load_session_runtime_bundle_index(state)?;
    let before = index.sessions.len();
    index.sessions.retain(|item| item.session_id != session_id);
    if index.sessions.len() != before {
        persist_session_runtime_bundle_index(state, &index)?;
    }
    Ok(())
}

fn resolve_session_id_or_latest(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<String, String> {
    let normalized = session_id.trim();
    if normalized != "latest" {
        return Ok(normalized.to_string());
    }
    let index = load_session_runtime_bundle_index(state)?;
    index
        .sessions
        .last()
        .map(|item| item.session_id.clone())
        .ok_or_else(|| "No session bundles found".to_string())
}

fn load_session_runtime_bundle(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Option<SessionRuntimeBundle>, String> {
    let path = session_runtime_bundle_path(state, session_id)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let bundle = serde_json::from_str::<SessionRuntimeBundle>(&content)
        .map_err(|error| error.to_string())?;
    Ok(Some(bundle))
}

fn persist_session_runtime_bundle(
    state: &State<'_, AppState>,
    bundle: &SessionRuntimeBundle,
) -> Result<(), String> {
    let path = session_runtime_bundle_path(state, &bundle.session_id)?;
    let serialized = serde_json::to_string_pretty(bundle).map_err(|error| error.to_string())?;
    fs::write(&path, serialized).map_err(|error| error.to_string())?;

    let mut index = load_session_runtime_bundle_index(state)?;
    let removed_ids = update_session_bundle_index(&mut index, bundle);
    persist_session_runtime_bundle_index(state, &index)?;
    for removed_id in removed_ids {
        let removed_path = session_runtime_bundle_path(state, &removed_id)?;
        let _ = fs::remove_file(removed_path);
    }
    Ok(())
}

fn transcript_message_entries(entries: &[SessionTranscriptFileEntry]) -> Vec<(String, Value)> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            SessionTranscriptFileEntry::Message {
                entry_id, message, ..
            } => Some((entry_id.clone(), message.clone())),
            _ => None,
        })
        .collect()
}

fn rebuild_messages_after_last_compaction(
    entries: &[SessionTranscriptFileEntry],
) -> (Vec<Value>, Option<String>, Vec<String>) {
    let message_entries = transcript_message_entries(entries);
    let mut summary_prompt: Option<String> = None;
    let mut preserved_ids = Vec::<String>::new();
    let mut start_idx = 0usize;
    for (idx, entry) in entries.iter().enumerate() {
        if let SessionTranscriptFileEntry::CompactBoundary {
            summary,
            preserved_entry_ids,
            ..
        } = entry
        {
            summary_prompt = Some(summary.clone());
            preserved_ids = preserved_entry_ids.clone();
            start_idx = idx + 1;
        }
    }
    if summary_prompt.is_none() {
        return (
            message_entries
                .into_iter()
                .map(|(_, message)| message)
                .collect::<Vec<_>>(),
            None,
            Vec::new(),
        );
    }

    let mut messages = Vec::<Value>::new();
    let preserved_set = preserved_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for (entry_id, message) in transcript_message_entries(entries) {
        if preserved_set.contains(&entry_id) {
            messages.push(message);
        }
    }
    for entry in &entries[start_idx..] {
        if let SessionTranscriptFileEntry::Message { message, .. } = entry {
            messages.push(message.clone());
        }
    }
    (messages, summary_prompt, preserved_ids)
}

fn sync_transcript_from_bundle(
    state: &State<'_, AppState>,
    bundle: &SessionRuntimeBundle,
) -> Result<(), String> {
    let existing_entries = load_transcript_entries(state, &bundle.session_id)?;
    let existing_messages = transcript_message_entries(&existing_entries);
    let prefix_len = existing_messages
        .iter()
        .zip(bundle.messages.iter())
        .take_while(|((_, left), right)| left == *right)
        .count();
    for message in bundle.messages.iter().skip(prefix_len) {
        append_transcript_entry(
            state,
            &bundle.session_id,
            &SessionTranscriptFileEntry::Message {
                entry_id: make_id("entry"),
                session_id: bundle.session_id.clone(),
                message: message.clone(),
                created_at: now_iso(),
            },
        )?;
    }
    let summary = session_bundle_summary_from_messages(&bundle.messages);
    let mut meta = session_transcript_metadata_snapshot(
        state,
        &bundle.session_id,
        &bundle.runtime_mode,
        &bundle.protocol,
        bundle.model_name.as_deref(),
        bundle.message_count,
        &bundle.updated_at,
        &summary,
    )?;
    let metadata = SessionTranscriptFileEntry::Metadata {
        entry_id: make_id("entry"),
        session_id: bundle.session_id.clone(),
        title: Some(meta.title.clone()),
        tag: meta.tag.clone(),
        git_branch: meta.git_branch.clone(),
        worktree_path: meta.worktree_path.clone(),
        pr_number: meta.pr_number,
        pr_url: meta.pr_url.clone(),
        mode: meta.mode.clone(),
        runtime_mode: Some(meta.runtime_mode.clone()),
        protocol: Some(meta.protocol.clone()),
        model_name: meta.model_name.clone(),
        created_at: now_iso(),
    };
    append_transcript_entry(state, &bundle.session_id, &metadata)?;
    meta.has_compaction = existing_entries
        .iter()
        .any(|entry| matches!(entry, SessionTranscriptFileEntry::CompactBoundary { .. }));
    update_session_transcript_index(state, meta)
}

#[cfg(test)]
pub fn session_bridge_detail_value(
    store: &AppStore,
    session_id: &str,
    background_tasks: &[Value],
) -> Value {
    crate::session_manager::session_bridge_detail_value(store, session_id, background_tasks, None)
}

pub fn persist_runtime_query_checkpoints(
    store: &mut AppStore,
    session_id: &str,
    route_reasoning: &str,
    route_value: Value,
    orchestration: Option<Value>,
) {
    append_session_checkpoint(
        store,
        session_id,
        "runtime.route",
        if route_reasoning.trim().is_empty() {
            "runtime route".to_string()
        } else {
            route_reasoning.to_string()
        },
        Some(route_value),
    );
    if let Some(orchestration_value) = orchestration {
        append_session_checkpoint(
            store,
            session_id,
            "runtime.orchestration",
            "subagent orchestration completed".to_string(),
            Some(orchestration_value),
        );
    }
}

pub fn runtime_query_checkpoint_events(
    route_reasoning: &str,
    route_value: Value,
    orchestration: Option<Value>,
) -> Vec<(String, String, Option<Value>)> {
    let mut events = vec![(
        "runtime.route".to_string(),
        if route_reasoning.trim().is_empty() {
            "runtime route".to_string()
        } else {
            route_reasoning.to_string()
        },
        Some(route_value),
    )];
    if let Some(orchestration_value) = orchestration {
        events.push((
            "runtime.orchestration".to_string(),
            "subagent orchestration completed".to_string(),
            Some(orchestration_value),
        ));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::SessionCheckpointRecord;

    fn test_session(id: &str) -> ChatSessionRecord {
        ChatSessionRecord {
            id: id.to_string(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({ "contextType": "chat" })),
        }
    }

    fn test_chat_message(
        session_id: &str,
        role: &str,
        content: &str,
        created_at: &str,
    ) -> crate::ChatMessageRecord {
        crate::ChatMessageRecord {
            id: format!("message-{}-{}", role, created_at),
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            display_content: None,
            attachment: None,
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn session_list_item_value_includes_counts_and_summary() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(test_session("session-1"));
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-1".to_string(),
                session_id: "session-1".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                payload: None,
                created_at: 1,
            });
        store.session_checkpoints.push(SessionCheckpointRecord {
            id: "checkpoint-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            checkpoint_type: "runtime.route".to_string(),
            summary: "route".to_string(),
            payload: None,
            created_at: 2,
        });

        let value = session_list_item_value(&store, &store.chat_sessions[0]);
        assert_eq!(
            value.get("transcriptCount").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            value.get("checkpointCount").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            value
                .get("chatSession")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("session-1")
        );
    }

    #[test]
    fn session_detail_and_resume_return_null_for_missing_session() {
        let store = crate::AppStore::default();
        assert_eq!(session_detail_value(&store, "missing"), Value::Null);
        assert_eq!(session_resume_value(&store, "missing", None), Value::Null);
    }

    #[test]
    fn session_bridge_values_include_counts_and_tasks() {
        let mut store = crate::AppStore::default();
        let session = test_session("session-1");
        store.chat_sessions.push(session.clone());
        store
            .runtime_tasks
            .push(crate::runtime::create_runtime_task(
                "manual",
                "pending",
                "default".to_string(),
                Some("session-1".to_string()),
                Some("draft".to_string()),
                crate::runtime::runtime_direct_route_record("default", "draft", None),
                None,
            ));

        let summary = session_bridge_summary_value(&session, &store);
        assert_eq!(
            summary.get("ownerTaskCount").and_then(Value::as_i64),
            Some(1)
        );

        let detail = session_bridge_detail_value(&store, "session-1", &[json!({"id": "bg-1"})]);
        assert_eq!(
            detail
                .get("session")
                .and_then(|item| item.get("backgroundTaskCount"))
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            detail
                .get("tasks")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
    }

    #[test]
    fn session_value_helpers_preserve_array_shapes() {
        let mut store = crate::AppStore::default();
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-1".to_string(),
                session_id: "session-1".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                payload: None,
                created_at: 1,
            });
        store.session_tool_results.push(SessionToolResultRecord {
            id: "tool-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            call_id: "call-1".to_string(),
            tool_name: "redbox_fs".to_string(),
            command: None,
            success: true,
            result_text: Some("ok".to_string()),
            summary_text: None,
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: None,
            created_at: 1,
            updated_at: 1,
        });

        assert!(trace_value_for_session(&store, "session-1", false).is_array());
        assert!(tool_results_value_for_session(&store, "session-1", false, None).is_array());
        assert!(checkpoints_value_for_session(&store, "session-1", false, None).is_array());
    }

    #[test]
    fn session_queries_can_include_child_sessions() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-parent".to_string(),
            title: "Parent".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({"contextType": "chat"})),
        });
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-child".to_string(),
            title: "Child".to_string(),
            created_at: "2".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({
                "contextType": "chat",
                "parentSessionId": "session-parent"
            })),
        });
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-parent".to_string(),
                session_id: "session-parent".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "parent".to_string(),
                payload: None,
                created_at: 1,
            });
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-child".to_string(),
                session_id: "session-child".to_string(),
                record_type: "message".to_string(),
                role: "assistant".to_string(),
                content: "child".to_string(),
                payload: None,
                created_at: 2,
            });

        let traces = trace_value_for_session(&store, "session-parent", true);
        assert_eq!(traces.as_array().map(|items| items.len()), Some(2));
    }

    #[test]
    fn runtime_query_checkpoint_events_include_route_and_optional_orchestration() {
        let events = runtime_query_checkpoint_events(
            "route resolved",
            json!({ "intent": "direct_answer" }),
            Some(json!({ "outputs": [{"roleId": "planner"}] })),
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "runtime.route");
        assert_eq!(events[1].0, "runtime.orchestration");
    }

    #[test]
    fn persist_runtime_query_checkpoints_writes_route_and_orchestration_records() {
        let mut store = crate::AppStore::default();

        persist_runtime_query_checkpoints(
            &mut store,
            "session-1",
            "route resolved",
            json!({ "intent": "direct_answer" }),
            Some(json!({ "outputs": [{ "roleId": "planner" }] })),
        );

        assert_eq!(store.session_checkpoints.len(), 2);
        assert_eq!(
            store.session_checkpoints[0].checkpoint_type,
            "runtime.route"
        );
        assert_eq!(
            store.session_checkpoints[1].checkpoint_type,
            "runtime.orchestration"
        );
    }

    #[test]
    fn session_context_snapshot_tracks_archived_history() {
        let mut store = crate::AppStore::default();
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-ctx",
                role,
                &format!("message {index}"),
                &index.to_string(),
            ));
        }

        let record = update_session_context_record(&mut store, "session-ctx", "manual", true)
            .expect("snapshot should be created");
        assert_eq!(record.compacted_message_count, 6);
        assert_eq!(record.tail_message_count, 8);
        assert_eq!(record.compact_rounds, 1);

        let usage = session_context_usage_value(&store, "session-ctx");
        assert_eq!(
            usage.get("compactedMessageCount").and_then(Value::as_i64),
            Some(6)
        );
        assert_eq!(
            usage.get("recentMessageCount").and_then(Value::as_u64),
            Some(8)
        );
    }

    #[test]
    fn runtime_context_messages_prepend_resume_summary_when_snapshot_exists() {
        let mut store = crate::AppStore::default();
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-ctx",
                role,
                &format!("message {index}"),
                &index.to_string(),
            ));
        }
        update_session_context_record(&mut store, "session-ctx", "auto", false);

        let messages = runtime_context_messages_for_session(None, &store, "session-ctx", 8);
        assert_eq!(messages.len(), 9);
        let summary = messages[0]
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(summary.contains("Archived 6 messages"));
        assert!(summary.contains("Conversation started with: message 0"));
        assert!(summary.contains("Latest archived user intent: message 4"));
        assert!(summary.contains("Latest archived assistant reply: message 5"));
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("message 6")
        );
    }

    #[test]
    fn runtime_context_messages_preserve_initial_context_for_context_bound_sessions() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-redclaw".to_string(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({
                "contextType": "redclaw",
                "contextId": "redclaw-singleton:default",
                "initialContext": "RedClaw seeded context"
            })),
        });
        store
            .chat_messages
            .push(test_chat_message("session-redclaw", "user", "hello", "1"));

        let messages = runtime_context_messages_for_session(None, &store, "session-redclaw", 8);
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].get("content").and_then(Value::as_str),
            Some("[Session initial context]\nRedClaw seeded context")
        );
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn session_resume_value_includes_context_and_resume_messages() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(test_session("session-1"));
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-1",
                role,
                &format!("message {index}"),
                &index.to_string(),
            ));
        }
        update_session_context_record(&mut store, "session-1", "auto", false);

        let value = session_resume_value(&store, "session-1", None);
        assert_eq!(value.get("messageCount").and_then(Value::as_i64), Some(14));
        assert!(value.get("context").is_some());
        assert_eq!(
            value
                .get("resumeMessages")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(9)
        );
    }

    #[test]
    fn session_bundle_index_updates_summary_and_prunes_oldest_entries() {
        let mut index = SessionRuntimeBundleIndex::default();
        for item in 0..(SESSION_BUNDLE_MAX_SESSIONS + 2) {
            let bundle = SessionRuntimeBundle {
                session_id: format!("session-{item}"),
                created_at: item.to_string(),
                updated_at: item.to_string(),
                protocol: "openai".to_string(),
                runtime_mode: "chat".to_string(),
                model_name: Some("gpt".to_string()),
                message_count: 2,
                messages: vec![
                    json!({ "role": "user", "content": format!("hello {item}") }),
                    json!({ "role": "assistant", "content": "ok" }),
                ],
            };
            let _removed = update_session_bundle_index(&mut index, &bundle);
        }

        assert_eq!(index.sessions.len(), SESSION_BUNDLE_MAX_SESSIONS);
        assert_eq!(
            index.sessions.first().map(|item| item.session_id.as_str()),
            Some("session-2")
        );
        assert_eq!(
            index.sessions.last().map(|item| item.summary.as_str()),
            Some("hello 201")
        );
    }

    #[test]
    fn rebuild_messages_after_last_compaction_keeps_preserved_and_post_boundary_messages() {
        let entries = vec![
            SessionTranscriptFileEntry::Message {
                entry_id: "m1".to_string(),
                session_id: "session-1".to_string(),
                message: json!({ "role": "user", "content": "hello" }),
                created_at: "1".to_string(),
            },
            SessionTranscriptFileEntry::Message {
                entry_id: "m2".to_string(),
                session_id: "session-1".to_string(),
                message: json!({ "role": "assistant", "content": "hi" }),
                created_at: "2".to_string(),
            },
            SessionTranscriptFileEntry::CompactBoundary {
                entry_id: "b1".to_string(),
                session_id: "session-1".to_string(),
                summary: "summary text".to_string(),
                preserved_entry_ids: vec!["m2".to_string()],
                preserved_message_count: 1,
                created_at: "3".to_string(),
            },
            SessionTranscriptFileEntry::Message {
                entry_id: "m3".to_string(),
                session_id: "session-1".to_string(),
                message: json!({ "role": "user", "content": "after" }),
                created_at: "4".to_string(),
            },
        ];
        let (messages, summary, preserved) = rebuild_messages_after_last_compaction(&entries);
        assert_eq!(summary.as_deref(), Some("summary text"));
        assert_eq!(preserved, vec!["m2".to_string()]);
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].get("content").and_then(Value::as_str),
            Some("hi")
        );
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("after")
        );
    }
}
