use serde_json::Value;

use crate::runtime::{RuntimeEventRecord, RuntimeTaskTraceRecord, SessionCheckpointRecord};
use crate::{make_id, now_i64, AppStore};

const MAX_RUNTIME_EVENTS: usize = 1_000;
const MAX_RUNTIME_EVENT_PAYLOAD_CHARS: usize = 2_000;

pub fn session_lineage_fields(
    store: &AppStore,
    session_id: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let metadata = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .and_then(|item| item.metadata.as_ref());
    (
        metadata
            .and_then(|item| item.get("runtimeId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        metadata
            .and_then(|item| item.get("parentRuntimeId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        metadata
            .and_then(|item| item.get("sourceTaskId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for ch in value.chars().take(max_chars) {
        output.push(ch);
    }
    output
}

fn sanitize_runtime_event_payload(payload: Option<Value>) -> Option<Value> {
    let payload = payload?;
    let serialized = serde_json::to_string(&payload).unwrap_or_else(|_| payload.to_string());
    if serialized.chars().count() <= MAX_RUNTIME_EVENT_PAYLOAD_CHARS {
        return Some(payload);
    }
    Some(serde_json::json!({
        "truncated": true,
        "summary": truncate_chars(&serialized, MAX_RUNTIME_EVENT_PAYLOAD_CHARS)
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn append_runtime_event(
    store: &mut AppStore,
    category: &str,
    event_type: &str,
    session_id: Option<String>,
    runtime_id: Option<String>,
    parent_runtime_id: Option<String>,
    source_task_id: Option<String>,
    task_id: Option<String>,
    tool_call_id: Option<String>,
    project_id: Option<String>,
    payload: Option<Value>,
) -> String {
    let record = RuntimeEventRecord::new(
        category,
        event_type,
        session_id,
        runtime_id,
        parent_runtime_id,
        source_task_id,
        task_id,
        tool_call_id,
        project_id,
        sanitize_runtime_event_payload(payload),
    );
    let id = record.id.clone();
    store.runtime_events.push(record);
    if store.runtime_events.len() > MAX_RUNTIME_EVENTS {
        let excess = store.runtime_events.len() - MAX_RUNTIME_EVENTS;
        store.runtime_events.drain(..excess);
    }
    id
}

pub fn append_runtime_event_for_session(
    store: &mut AppStore,
    category: &str,
    event_type: &str,
    session_id: Option<String>,
    task_id: Option<String>,
    tool_call_id: Option<String>,
    project_id: Option<String>,
    payload: Option<Value>,
) -> String {
    let (runtime_id, parent_runtime_id, source_task_id) = session_id
        .as_deref()
        .map(|value| session_lineage_fields(store, value))
        .unwrap_or((None, None, None));
    append_runtime_event(
        store,
        category,
        event_type,
        session_id,
        runtime_id,
        parent_runtime_id,
        source_task_id,
        task_id,
        tool_call_id,
        project_id,
        payload,
    )
}

pub fn append_session_checkpoint(
    store: &mut AppStore,
    session_id: &str,
    checkpoint_type: &str,
    summary: String,
    payload: Option<Value>,
) {
    let (runtime_id, parent_runtime_id, source_task_id) = session_lineage_fields(store, session_id);
    store.session_checkpoints.push(SessionCheckpointRecord {
        id: make_id("checkpoint"),
        session_id: session_id.to_string(),
        runtime_id,
        parent_runtime_id,
        source_task_id,
        checkpoint_type: checkpoint_type.to_string(),
        summary,
        payload,
        created_at: now_i64(),
    });
}

pub fn append_session_checkpoint_scoped(
    store: &mut AppStore,
    session_id: &str,
    runtime_id: Option<String>,
    parent_runtime_id: Option<String>,
    source_task_id: Option<String>,
    checkpoint_type: &str,
    summary: String,
    payload: Option<Value>,
) {
    store.session_checkpoints.push(SessionCheckpointRecord {
        id: make_id("checkpoint"),
        session_id: session_id.to_string(),
        runtime_id,
        parent_runtime_id,
        source_task_id,
        checkpoint_type: checkpoint_type.to_string(),
        summary,
        payload,
        created_at: now_i64(),
    });
}

pub fn append_runtime_task_trace(
    store: &mut AppStore,
    task_id: &str,
    event_type: &str,
    payload: Option<Value>,
) {
    store.runtime_task_traces.push(RuntimeTaskTraceRecord::new(
        task_id, None, None, None, None, event_type, payload,
    ));
}

pub fn append_runtime_task_trace_scoped(
    store: &mut AppStore,
    task_id: &str,
    runtime_id: Option<String>,
    parent_runtime_id: Option<String>,
    source_task_id: Option<String>,
    node_id: Option<String>,
    event_type: &str,
    payload: Option<Value>,
) {
    store.runtime_task_traces.push(RuntimeTaskTraceRecord::new(
        task_id,
        runtime_id,
        parent_runtime_id,
        source_task_id,
        node_id,
        event_type,
        payload,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::default_store;
    use serde_json::{json, Value};

    #[test]
    fn append_runtime_event_bounds_total_count() {
        let mut store = default_store();
        for index in 0..(MAX_RUNTIME_EVENTS + 5) {
            append_runtime_event(
                &mut store,
                "media_generation",
                "request.started",
                Some(format!("session-{index}")),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            );
        }

        assert_eq!(store.runtime_events.len(), MAX_RUNTIME_EVENTS);
        assert_eq!(
            store
                .runtime_events
                .first()
                .and_then(|item| item.session_id.as_deref()),
            Some("session-5")
        );
    }

    #[test]
    fn append_runtime_event_truncates_large_payloads() {
        let mut store = default_store();
        append_runtime_event(
            &mut store,
            "media_generation",
            "request.failed",
            Some("session-1".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(json!({ "error": "x".repeat(MAX_RUNTIME_EVENT_PAYLOAD_CHARS + 500) })),
        );

        let payload = store
            .runtime_events
            .first()
            .and_then(|item| item.payload.as_ref())
            .expect("runtime event payload should be recorded");
        assert_eq!(
            payload.get("truncated").and_then(Value::as_bool),
            Some(true)
        );
        assert!(payload
            .get("summary")
            .and_then(Value::as_str)
            .map(|value| value.chars().count() <= MAX_RUNTIME_EVENT_PAYLOAD_CHARS)
            .unwrap_or(false));
    }
}
