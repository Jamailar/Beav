use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    checkpoints_value_for_session, tool_results_value_for_session, trace_value_for_session,
};
use crate::session_manager::fork_session;
use crate::{now_ms, payload_string, payload_value_as_string, AppState};

const CHATROOM_SYNTHETIC_SESSION_PREFIX: &str = "chatroom:";

fn room_id_from_synthetic_session_id(session_id: &str) -> Option<&str> {
    session_id.strip_prefix(CHATROOM_SYNTHETIC_SESSION_PREFIX)
}

fn synthetic_chatroom_tool_results_value(
    store: &crate::AppStore,
    session_id: &str,
    limit: Option<usize>,
) -> Value {
    let Some(room_id) = room_id_from_synthetic_session_id(session_id) else {
        return json!([]);
    };
    let mut items = store
        .session_checkpoints
        .iter()
        .filter(|item| item.session_id == session_id && item.checkpoint_type == "creative_chat.tool")
        .filter_map(|item| {
            let payload = item.payload.as_ref()?;
            let tool_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
            if tool_type != "tool_end" {
                return None;
            }
            let tool = payload.get("tool")?;
            let result = tool.get("result");
            Some(json!({
                "id": item.id,
                "sessionId": session_id,
                "callId": format!("creative-chat:{}:{}", room_id, item.id),
                "toolName": tool.get("name").and_then(Value::as_str).unwrap_or("tool"),
                "command": Value::Null,
                "success": result.and_then(|value| value.get("success")).and_then(Value::as_bool).unwrap_or(true),
                "summaryText": result
                    .and_then(|value| value.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                "resultText": result
                    .and_then(|value| value.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                "promptText": Value::Null,
                "originalChars": Value::Null,
                "promptChars": Value::Null,
                "truncated": false,
                "payload": payload,
                "createdAt": item.created_at,
                "updatedAt": item.created_at,
            }))
        })
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.get("createdAt").and_then(Value::as_i64).unwrap_or(0));
    if let Some(limit) = limit.filter(|value| *value > 0) {
        let split_at = items.len().saturating_sub(limit);
        items.drain(..split_at);
    }
    json!(items)
}

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
        let direct = tool_results_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            runtime_id.as_deref(),
            limit,
        );
        let needs_chatroom_fallback = direct
            .as_array()
            .map(|items| items.is_empty())
            .unwrap_or(false)
            && room_id_from_synthetic_session_id(&session_id).is_some();
        if needs_chatroom_fallback {
            return Ok(synthetic_chatroom_tool_results_value(
                &store,
                &session_id,
                limit,
            ));
        }
        Ok(direct)
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
