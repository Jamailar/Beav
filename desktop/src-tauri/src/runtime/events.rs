use serde_json::Value;

use crate::runtime::{RuntimeTaskTraceRecord, SessionCheckpointRecord};
use crate::{make_id, now_i64, AppStore};

pub fn append_session_checkpoint(
    store: &mut AppStore,
    session_id: &str,
    checkpoint_type: &str,
    summary: String,
    payload: Option<Value>,
) {
    store.session_checkpoints.push(SessionCheckpointRecord {
        id: make_id("checkpoint"),
        session_id: session_id.to_string(),
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
        task_id,
        None,
        event_type,
        payload,
    ));
}

