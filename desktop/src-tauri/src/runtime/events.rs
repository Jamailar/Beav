use serde_json::Value;

use crate::runtime::{RuntimeTaskTraceRecord, SessionCheckpointRecord};
use crate::{make_id, now_i64, AppStore};

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
