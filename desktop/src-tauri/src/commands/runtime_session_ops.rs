use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    checkpoints_value_for_session, tool_results_value_for_session, trace_value_for_session,
};
use crate::session_manager::fork_session;
use crate::{AppState, now_ms, payload_string, payload_value_as_string};

pub fn runtime_state_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let requested_session_id = payload_value_as_string(payload).unwrap_or_default();
    let guard = state
        .chat_runtime_states
        .lock()
        .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
    if let Some(current) = guard.get(&requested_session_id) {
        Ok(json!({
            "success": true,
            "sessionId": current.session_id,
            "isProcessing": current.is_processing,
            "partialResponse": current.partial_response,
            "updatedAt": current.updated_at,
            "error": current.error,
            "cancelRequested": current.cancel_requested,
        }))
    } else {
        Ok(json!({
            "success": true,
            "sessionId": requested_session_id,
            "isProcessing": false,
            "partialResponse": "",
            "updatedAt": now_ms(),
            "cancelRequested": false,
        }))
    }
}

pub fn runtime_resume_value(payload: &Value) -> Value {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    json!({ "success": true, "sessionId": session_id })
}

pub fn runtime_trace_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(trace_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            limit,
        ))
    })
}

pub fn runtime_checkpoints_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runtime_id = payload_string(payload, "runtimeId");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(checkpoints_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            runtime_id.as_deref(),
            limit,
        ))
    })
}

pub fn runtime_tool_results_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runtime_id = payload_string(payload, "runtimeId");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(tool_results_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            runtime_id.as_deref(),
            limit,
        ))
    })
}

pub fn fork_runtime_session(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    with_store_mut(state, |store| {
        let Some(forked) = fork_session(store, &session_id) else {
            return Ok(json!({ "success": false, "error": "会话不存在" }));
        };
        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "forkedSessionId": forked.session.id
        }))
    })
}
