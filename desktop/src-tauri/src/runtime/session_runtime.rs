use crate::runtime::{
    append_session_checkpoint, runtime_task_value, PreparedExecution, RuntimeRouteRecord,
    SessionCheckpointRecord, SessionToolResultRecord, SessionTranscriptRecord,
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

pub fn trace_value_for_session(store: &AppStore, session_id: &str) -> Value {
    json!(trace_for_session(store, session_id))
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

pub fn checkpoints_value_for_session(store: &AppStore, session_id: &str) -> Value {
    json!(checkpoints_for_session(store, session_id))
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

pub fn tool_results_value_for_session(store: &AppStore, session_id: &str) -> Value {
    json!(tool_results_for_session(store, session_id))
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

pub fn session_bridge_summary_value(session: &ChatSessionRecord, store: &AppStore) -> Value {
    let updated_at = session.updated_at.parse::<i64>().unwrap_or(0);
    let created_at = session.created_at.parse::<i64>().unwrap_or(0);
    let owner_task_count = store
        .runtime_tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(session.id.as_str()))
        .count() as i64;
    json!({
        "id": session.id,
        "title": session.title,
        "updatedAt": updated_at,
        "createdAt": created_at,
        "contextType": "chat",
        "runtimeMode": "default",
        "isBackgroundSession": false,
        "ownerTaskCount": owner_task_count,
        "backgroundTaskCount": 0,
    })
}

pub fn session_bridge_detail_value(
    store: &AppStore,
    session_id: &str,
    background_tasks: &[Value],
) -> Value {
    let Some(session) = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
    else {
        return Value::Null;
    };
    let tasks: Vec<Value> = store
        .runtime_tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(session_id))
        .map(runtime_task_value)
        .collect();
    json!({
        "session": {
            "id": session.id,
            "title": session.title,
            "updatedAt": session.updated_at.parse::<i64>().unwrap_or(0),
            "createdAt": session.created_at.parse::<i64>().unwrap_or(0),
            "contextType": "chat",
            "runtimeMode": "default",
            "isBackgroundSession": false,
            "ownerTaskCount": tasks.len(),
            "backgroundTaskCount": background_tasks.len(),
            "metadata": session.metadata,
        },
        "transcript": trace_for_session(store, session_id),
        "checkpoints": checkpoints_for_session(store, session_id),
        "toolResults": tool_results_for_session(store, session_id),
        "tasks": tasks,
        "backgroundTasks": background_tasks,
        "permissionRequests": [],
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

    #[test]
    fn session_bridge_values_include_counts_and_tasks() {
        let mut store = crate::AppStore::default();
        let session = test_session("session-1");
        store.chat_sessions.push(session.clone());
        store.runtime_tasks.push(crate::runtime::create_runtime_task(
            "manual",
            "pending",
            "default".to_string(),
            Some("session-1".to_string()),
            Some("draft".to_string()),
            crate::runtime::runtime_direct_route_record("default", "draft", None),
            None,
        ));

        let summary = session_bridge_summary_value(&session, &store);
        assert_eq!(summary.get("ownerTaskCount").and_then(Value::as_i64), Some(1));

        let detail = session_bridge_detail_value(&store, "session-1", &[json!({"id": "bg-1"})]);
        assert_eq!(
            detail.get("session")
                .and_then(|item| item.get("backgroundTaskCount"))
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            detail.get("tasks")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
    }

    #[test]
    fn prepare_runtime_query_execution_includes_orchestration_summary_when_present() {
        let route = crate::runtime::runtime_direct_route_record("default", "draft", None);
        let prepared = prepare_runtime_query_execution(
            route,
            Some(json!({
                "outputs": [
                    { "roleId": "planner", "summary": "break into steps" },
                    { "roleId": "reviewer", "summary": "verify saved artifact" }
                ]
            })),
            "help me",
        );

        assert!(prepared.effective_message.contains("Subagent orchestration summary"));
        assert!(prepared.effective_message.contains("- planner: break into steps"));
        assert!(prepared.effective_message.contains("- reviewer: verify saved artifact"));
    }

    #[test]
    fn prepare_runtime_query_execution_keeps_original_message_without_outputs() {
        let route = crate::runtime::runtime_direct_route_record("default", "draft", None);
        let prepared = prepare_runtime_query_execution(route, Some(json!({ "outputs": [] })), "help me");
        assert_eq!(prepared.effective_message, "help me");
    }

    #[test]
    fn session_value_helpers_preserve_array_shapes() {
        let mut store = crate::AppStore::default();
        store.session_transcript_records.push(SessionTranscriptRecord {
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

        assert!(trace_value_for_session(&store, "session-1").is_array());
        assert!(tool_results_value_for_session(&store, "session-1").is_array());
        assert!(checkpoints_value_for_session(&store, "session-1").is_array());
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
        assert_eq!(store.session_checkpoints[0].checkpoint_type, "runtime.route");
        assert_eq!(
            store.session_checkpoints[1].checkpoint_type,
            "runtime.orchestration"
        );
    }
}
