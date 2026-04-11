use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[path = "runtime_query.rs"]
mod runtime_query;

use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    checkpoints_for_session, tool_results_for_session, trace_for_session,
};
use crate::{
    make_id, now_iso, now_ms, payload_string, payload_value_as_string,
    AppState, ChatSessionRecord,
};

pub fn handle_runtime_session_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "chat:get-runtime-state"
        | "runtime:query"
        | "runtime:resume"
        | "runtime:fork-session"
        | "runtime:get-trace"
        | "runtime:get-checkpoints"
        | "runtime:get-tool-results" => {}
        _ => return None,
    }

    let result: Result<Value, String> = (|| -> Result<Value, String> {
        match channel {
            "chat:get-runtime-state" => {
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
            "runtime:query" => {
                runtime_query::handle_runtime_query(app, state, payload)
            }
            "runtime:resume" => {
                let session_id = payload_string(payload, "sessionId").unwrap_or_default();
                Ok(json!({ "success": true, "sessionId": session_id }))
            }
            "runtime:fork-session" => {
                let session_id = payload_string(payload, "sessionId").unwrap_or_default();
                let forked = with_store_mut(state, |store| {
                    let Some(source) = store
                        .chat_sessions
                        .iter()
                        .find(|item| item.id == session_id)
                        .cloned()
                    else {
                        return Ok(json!({ "success": false, "error": "会话不存在" }));
                    };
                    let new_id = make_id("session");
                    let timestamp = now_iso();
                    let forked = ChatSessionRecord {
                        id: new_id.clone(),
                        title: format!("{} (Fork)", source.title),
                        created_at: timestamp.clone(),
                        updated_at: timestamp,
                        metadata: source.metadata.clone(),
                    };
                    store.chat_sessions.push(forked);
                    Ok(
                        json!({ "success": true, "sessionId": session_id, "forkedSessionId": new_id }),
                    )
                })?;
                Ok(forked)
            }
            "runtime:get-trace" => {
                let session_id = payload_string(payload, "sessionId").unwrap_or_default();
                with_store(state, |store| Ok(json!(trace_for_session(&store, &session_id))))
            }
            "runtime:get-checkpoints" => {
                let session_id = payload_string(payload, "sessionId").unwrap_or_default();
                with_store(state, |store| Ok(json!(checkpoints_for_session(&store, &session_id))))
            }
            "runtime:get-tool-results" => {
                let session_id = payload_string(payload, "sessionId").unwrap_or_default();
                with_store(state, |store| Ok(json!(tool_results_for_session(&store, &session_id))))
            }
            _ => unreachable!("channel prefiltered"),
        }
    })();
    Some(result)
}
