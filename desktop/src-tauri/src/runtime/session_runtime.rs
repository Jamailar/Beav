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

pub fn session_list_item_value(store: &AppStore, session: &ChatSessionRecord) -> Value {
    json!({
        "id": session.id,
        "transcriptCount": transcript_count_for_session(store, &session.id),
        "checkpointCount": checkpoint_count_for_session(store, &session.id),
        "chatSession": chat_session_summary_value(session)
    })
}

pub fn session_detail_value(store: &AppStore, session_id: &str) -> Value {
    let Some(session) = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
    else {
        return Value::Null;
    };
    json!({
        "chatSession": chat_session_summary_value(session),
        "transcript": trace_for_session(store, session_id),
        "checkpoints": checkpoints_for_session(store, session_id),
        "toolResults": tool_results_for_session(store, session_id),
    })
}

pub fn session_resume_value(store: &AppStore, session_id: &str) -> Value {
    let Some(session) = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
    else {
        return Value::Null;
    };
    json!({
        "chatSession": chat_session_summary_value(session),
        "lastCheckpoint": last_checkpoint_for_session(store, session_id),
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

    #[test]
    fn session_list_item_value_includes_counts_and_summary() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(test_session("session-1"));
        store.session_transcript_records.push(SessionTranscriptRecord {
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
            checkpoint_type: "runtime.route".to_string(),
            summary: "route".to_string(),
            payload: None,
            created_at: 2,
        });

        let value = session_list_item_value(&store, &store.chat_sessions[0]);
        assert_eq!(value.get("transcriptCount").and_then(Value::as_i64), Some(1));
        assert_eq!(value.get("checkpointCount").and_then(Value::as_i64), Some(1));
        assert_eq!(
            value.get("chatSession")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("session-1")
        );
    }

    #[test]
    fn session_detail_and_resume_return_null_for_missing_session() {
        let store = crate::AppStore::default();
        assert_eq!(session_detail_value(&store, "missing"), Value::Null);
        assert_eq!(session_resume_value(&store, "missing"), Value::Null);
    }
}
