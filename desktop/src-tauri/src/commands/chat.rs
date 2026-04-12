use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{
    build_chat_send_turn, emit_session_agent_completion, execute_prepared_session_agent_turn,
    run_redclaw_chat_postprocess, PreparedSessionAgentTurn,
};
use crate::commands::chat_state::{
    latest_session_id, request_chat_runtime_cancel,
};
use crate::events::{
    emit_runtime_task_checkpoint_saved, emit_runtime_tool_result,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::SessionToolResultRecord;
use crate::{make_id, now_i64, payload_field, payload_string, AppState};

pub fn handle_send_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    match channel {
        "chat:send-message" => {
            let session_id = payload_string(&payload, "sessionId");
            let message = payload_string(&payload, "message").unwrap_or_default();
            let display_content =
                payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone());
            let turn = build_chat_send_turn(
                session_id,
                message.clone(),
                display_content.clone(),
                payload_field(&payload, "modelConfig"),
                payload_field(&payload, "attachment").cloned(),
            );
            let prepared_turn = PreparedSessionAgentTurn::chat_send(turn);
            let execution = execute_prepared_session_agent_turn(Some(app), state, &prepared_turn)?;
            let redclaw_postprocess =
                run_redclaw_chat_postprocess(state, &prepared_turn, &execution, &message)?;
            emit_session_agent_completion(
                app,
                state,
                &execution,
                crate::agent::SessionAgentTurnKind::ChatSend,
            )?;
            if prepared_turn.is_redclaw_session() {
                let _ = app.emit(
                    "redclaw:runner-message",
                    redclaw_postprocess
                        .map(|postprocess| postprocess.runner_payload)
                        .unwrap_or(Value::Null),
                );
            }
            Ok(())
        }
        "chat:cancel" | "ai:cancel" => {
            let session_id = payload_string(&payload, "sessionId")
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
        "chat:confirm-tool" | "ai:confirm-tool" => {
            let call_id = payload_string(&payload, "callId").unwrap_or_else(|| make_id("call"));
            let confirmed = payload_field(&payload, "confirmed")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let session_id = with_store_mut(state, |store| {
                let session_id = latest_session_id(store);
                store.session_tool_results.push(SessionToolResultRecord {
                    id: make_id("tool-result"),
                    session_id: session_id.clone(),
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
                    payload: Some(json!({ "confirmed": confirmed })),
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
        "ai:start-chat" => {
            let message = payload_string(&payload, "message").unwrap_or_default();
            let model_config = payload_field(&payload, "modelConfig").cloned();
            handle_send_channel(
                app,
                "chat:send-message",
                json!({
                    "message": message,
                    "displayContent": payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone()),
                    "modelConfig": model_config
                }),
                state,
            )
        }
        _ => Ok(()),
    }
}
