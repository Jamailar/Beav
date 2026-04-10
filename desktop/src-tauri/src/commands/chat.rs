use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::commands::chat_runtime::execute_chat_exchange;
use crate::commands::chat_state::{latest_session_id, resolve_runtime_mode_for_session};
use crate::commands::redclaw_runtime::{detect_redclaw_artifact_kind, save_redclaw_outputs};
use crate::events::{emit_chat_sequence, emit_runtime_tool_result};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::SessionToolResultRecord;
use crate::{create_work_item, make_id, now_i64, payload_field, payload_string, AppState};

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
            let is_redclaw_session = session_id
                .as_deref()
                .map(|value| value.starts_with("context-session:redclaw:"))
                .unwrap_or(false);
            let execution = execute_chat_exchange(
                Some(app),
                state,
                session_id,
                message.clone(),
                display_content.clone(),
                payload_field(&payload, "modelConfig"),
                payload_field(&payload, "attachment").cloned(),
                "chat-send",
                "Chat response completed",
            )?;
            let mut redclaw_artifacts: Vec<Value> = Vec::new();
            let mut redclaw_artifact_kind: Option<&str> = None;

            if is_redclaw_session {
                let project_id = with_store(state, |store| {
                    Ok(store
                        .redclaw_state
                        .projects
                        .first()
                        .map(|item| item.id.clone())
                        .unwrap_or_else(|| "redclaw-chat".to_string()))
                })?;
                let artifact_kind = detect_redclaw_artifact_kind(&message, "chat-session");
                redclaw_artifacts = save_redclaw_outputs(
                    state,
                    artifact_kind,
                    &project_id,
                    &execution.session_id,
                    &message,
                    &execution.response,
                    "chat-session",
                )?;
                redclaw_artifact_kind = Some(artifact_kind);
                let _ = with_store_mut(state, |store| {
                    store.work_items.push(create_work_item(
                        "redclaw-note",
                        format!("RedClaw Chat {}", artifact_kind),
                        Some("RedClaw fixed session generated a persisted artifact.".to_string()),
                        Some(display_content.clone()),
                        Some(json!({
                            "sessionId": execution.session_id,
                            "artifactKind": artifact_kind,
                            "artifacts": redclaw_artifacts.clone(),
                        })),
                        2,
                    ));
                    Ok(())
                });
            }
            let runtime_mode = with_store(state, |store| {
                Ok(resolve_runtime_mode_for_session(
                    &store,
                    &execution.session_id,
                ))
            })?;

            emit_chat_sequence(
                app,
                &execution.session_id,
                &execution.response,
                "正在分析输入并生成回答。",
                &runtime_mode,
                execution.title_update,
            );
            if is_redclaw_session {
                let _ = app.emit(
                    "redclaw:runner-message",
                    json!({
                        "sessionId": execution.session_id,
                        "artifactKind": redclaw_artifact_kind,
                        "artifacts": redclaw_artifacts,
                    }),
                );
            }
            Ok(())
        }
        "chat:cancel" | "ai:cancel" => Ok(()),
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
