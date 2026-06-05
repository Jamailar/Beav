use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::chat_state::{latest_session_id, request_chat_runtime_cancel};
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_tool_result};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    resolve_runtime_approval_by_approval_id, resolve_runtime_approval_by_call_id,
    RuntimeApprovalResolutionPayload, SessionToolResultRecord,
};
use crate::session_lineage_fields;
use crate::{make_id, now_i64, payload_field, payload_string, AppState};

pub(super) fn handle_chat_control_send_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Result<(), String> {
    match channel {
        "chat:cancel" | "ai:cancel" => cancel_chat_runtime(app, state, payload),
        "chat:confirm-tool" | "ai:confirm-tool" => confirm_runtime_tool(app, state, payload),
        _ => Ok(()),
    }
}

fn cancel_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<(), String> {
    let session_id = payload_string(payload, "sessionId")
        .or_else(|| payload.as_str().map(ToString::to_string))
        .unwrap_or_else(|| {
            with_store(state, |store| Ok(latest_session_id(&store))).unwrap_or_default()
        });
    request_chat_runtime_cancel(state, &session_id)?;
    if let Ok(guard) = state.active_chat_requests.lock() {
        if let Some(child) = guard.get(&session_id) {
            if let Ok(mut child_guard) = child.lock() {
                let _ = child_guard.kill();
            }
        }
    }
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        Some(&session_id),
        "chat.cancelled",
        "chat generation cancelled",
        Some(json!({ "sessionId": session_id, "cancelled": true })),
    );
    Ok(())
}

fn confirm_runtime_tool(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<(), String> {
    let resolution = serde_json::from_value::<RuntimeApprovalResolutionPayload>(payload.clone())
        .unwrap_or_else(|_| {
            RuntimeApprovalResolutionPayload::new(
                payload_string(payload, "callId").unwrap_or_else(|| make_id("call")),
                payload_field(payload, "confirmed")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
            )
        });
    let call_id = resolution.call_id.clone();
    let confirmed = resolution.confirmed;
    let _ = resolve_runtime_approval_by_call_id(state, &call_id, confirmed)?;
    let _ = resolve_runtime_approval_by_approval_id(state, &call_id, confirmed)?;
    let session_id = with_store_mut(state, |store| {
        let session_id = latest_session_id(store);
        let (runtime_id, parent_runtime_id, source_task_id) =
            session_lineage_fields(store, &session_id);
        store.session_tool_results.push(SessionToolResultRecord {
            id: make_id("tool-result"),
            session_id: session_id.clone(),
            runtime_id,
            parent_runtime_id,
            source_task_id,
            call_id: call_id.clone(),
            tool_name: "confirmation".to_string(),
            command: None,
            success: confirmed,
            result_text: Some(if confirmed {
                "User confirmed tool execution".to_string()
            } else {
                "User cancelled tool execution".to_string()
            }),
            summary_text: Some(if confirmed {
                "Tool execution confirmed".to_string()
            } else {
                "Tool execution cancelled".to_string()
            }),
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: serde_json::to_value(&resolution)
                .ok()
                .or_else(|| Some(json!({ "callId": call_id, "confirmed": confirmed }))),
            created_at: now_i64(),
            updated_at: now_i64(),
        });
        Ok(session_id)
    })?;
    emit_runtime_tool_result(
        app,
        Some(&session_id),
        &call_id,
        "confirmation",
        confirmed,
        if confirmed {
            "用户已确认执行"
        } else {
            "用户已取消执行"
        },
    );
    Ok(())
}
