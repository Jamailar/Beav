use crate::runtime::{
    PreparedExecution, RuntimeRouteRecord, SessionCheckpointRecord, SessionToolResultRecord,
    SessionTranscriptRecord,
};
use crate::{payload_string, AppStore, ChatSessionRecord};
use serde_json::{json, Value};

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

pub fn chat_session_summary_value(session: &ChatSessionRecord) -> Value {
    json!({
        "id": session.id,
        "title": session.title,
        "updatedAt": session.updated_at,
    })
}

pub fn prepare_runtime_query_execution(
    route: RuntimeRouteRecord,
    orchestration: Option<Value>,
    message: &str,
) -> PreparedExecution {
    let effective_message = orchestration
        .as_ref()
        .and_then(|value| value.get("outputs"))
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .map(|items| {
            let summaries = items
                .iter()
                .filter_map(|item| {
                    Some(format!(
                        "- {}: {}",
                        payload_string(item, "roleId")?,
                        payload_string(item, "summary").unwrap_or_default()
                    ))
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{message}\n\nSubagent orchestration summary:\n{summaries}")
        })
        .unwrap_or_else(|| message.to_string());
    PreparedExecution {
        route,
        orchestration,
        effective_message,
    }
}
