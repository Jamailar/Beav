use serde_json::{json, Value};

use crate::runtime::{SessionCheckpointRecord, SessionToolResultRecord, SessionTranscriptRecord};
use crate::AppStore;

pub fn trace_for_session(store: &AppStore, session_id: &str) -> Vec<SessionTranscriptRecord> {
    let mut items: Vec<SessionTranscriptRecord> = store
        .session_transcript_records
        .iter()
        .filter(|item| item.session_id == session_id)
        .filter(|item| !is_internal_transcript_record(item))
        .cloned()
        .collect();
    items.sort_by_key(|item| item.created_at);
    items
}

fn is_internal_transcript_record(item: &SessionTranscriptRecord) -> bool {
    item.record_type == "skill.instruction"
        || (item.role == "user"
            && super::is_internal_runtime_history_user_message(item.content.trim()))
}

fn take_recent_items<T>(mut items: Vec<T>, limit: Option<usize>) -> Vec<T> {
    let Some(limit) = limit.filter(|value| *value > 0) else {
        return items;
    };
    if items.len() <= limit {
        return items;
    }
    let split_at = items.len().saturating_sub(limit);
    items.drain(..split_at);
    items
}

pub(super) fn session_ids_for_query(
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
    limit: Option<usize>,
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
    json!(take_recent_items(items, limit))
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
    limit: Option<usize>,
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
    json!(take_recent_items(items, limit))
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
    limit: Option<usize>,
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
    json!(take_recent_items(items, limit))
}

pub fn runtime_events_value_for_session(
    store: &AppStore,
    session_id: &str,
    include_child_sessions: bool,
    category: Option<&str>,
    event_type: Option<&str>,
    limit: Option<usize>,
) -> Value {
    let session_ids = session_ids_for_query(store, session_id, include_child_sessions);
    let mut items = store
        .runtime_events
        .iter()
        .filter(|item| {
            session_ids.iter().any(|candidate| {
                item.session_id
                    .as_deref()
                    .map(|value| value == candidate)
                    .unwrap_or(false)
            })
        })
        .filter(|item| category.map(|value| item.category == value).unwrap_or(true))
        .filter(|item| {
            event_type
                .map(|value| item.event_type == value)
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.created_at);
    json!(take_recent_items(items, limit))
}
