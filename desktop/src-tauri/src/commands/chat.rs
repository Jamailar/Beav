use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{build_chat_send_turn, run_chat_send_turn, PreparedSessionAgentTurn};
use crate::commands::chat_state::{
    ensure_chat_session_record, latest_session_id, request_chat_runtime_cancel,
    resolve_runtime_mode_for_session,
};
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_tool_result};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::SessionToolResultRecord;
use crate::session_lineage_fields;
use crate::skills::{
    active_skill_activation_items, merge_requested_skills_into_session,
    requested_skill_names_from_task_hints, SkillActivationSource,
};
use crate::{
    append_debug_log_state, append_debug_trace_state, log_timing_event, make_id, now_i64, now_iso,
    now_ms, payload_field, payload_string, AppState,
};

fn merge_task_hints_into_session_metadata(
    state: &State<'_, AppState>,
    session_id: &str,
    task_hints: &Value,
) -> Result<Vec<String>, String> {
    let requested_skills = requested_skill_names_from_task_hints(task_hints);
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(());
        };
        let mut metadata = session
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if let Some(task_hints_object) = task_hints.as_object() {
            metadata.insert(
                "taskHints".to_string(),
                Value::Object(task_hints_object.clone()),
            );
            for field in [
                "intent",
                "platform",
                "taskType",
                "formatTarget",
                "allowedTools",
                "allowedAppCliActions",
                "saveSubdir",
                "sourcePlatform",
                "sourceNoteId",
                "sourceMode",
                "sourceTitle",
                "sourceManuscriptPath",
                "forceMultiAgent",
                "forceLongRunningTask",
            ] {
                if let Some(value) = task_hints_object.get(field) {
                    metadata.insert(field.to_string(), value.clone());
                }
            }
        }
        if !requested_skills.is_empty() {
            let active_skills = merge_requested_skills_into_session(
                session,
                &requested_skills,
                SkillActivationSource::TaskHints,
                "chat.task_hints",
            );
            metadata.insert("activeSkills".to_string(), json!(active_skills));
        }
        session.metadata = Some(Value::Object(metadata));
        session.updated_at = now_iso();
        Ok(())
    })?;
    Ok(requested_skills)
}

fn collect_active_skill_items_for_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(String, Vec<(String, String)>), String> {
    with_store(state, |store| {
        let runtime_mode = resolve_runtime_mode_for_session(&store, session_id);
        let metadata = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|item| item.metadata.as_ref());
        let items = active_skill_activation_items(&store.skills, &runtime_mode, metadata);
        Ok((runtime_mode, items))
    })
}

pub fn handle_send_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    match channel {
        "debug:ui-log" => {
            let scope = payload_string(&payload, "scope").unwrap_or_else(|| "unknown".to_string());
            let event = payload_string(&payload, "event").unwrap_or_else(|| "unknown".to_string());
            let payload_text =
                serde_json::to_string(payload_field(&payload, "payload").unwrap_or(&Value::Null))
                    .unwrap_or_else(|_| "null".to_string());
            let truncated_payload = if payload_text.chars().count() > 240 {
                let snippet = payload_text.chars().take(240).collect::<String>();
                format!("{snippet}...")
            } else {
                payload_text
            };
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][ui] scope={} event={} payload={}",
                    scope, event, truncated_payload
                ),
            );
            Ok(())
        }
        "chat:send-message" => {
            let started_at = now_ms();
            let requested_session_id = payload_string(&payload, "sessionId");
            let session_id = Some(ensure_chat_session_record(
                state,
                requested_session_id.clone(),
                None,
            )?);
            let message = payload_string(&payload, "message").unwrap_or_default();
            let display_content =
                payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone());
            let request_id = format!(
                "chat:send:{}",
                session_id
                    .clone()
                    .unwrap_or_else(|| "new-session".to_string())
            );
            log_timing_event(
                state,
                "ai",
                &request_id,
                "chat:send-message:start",
                started_at,
                Some(format!("chars={}", message.chars().count())),
            );
            let requested_skills = payload_field(&payload, "taskHints")
                .map(|task_hints| {
                    session_id
                        .as_deref()
                        .map(|value| {
                            merge_task_hints_into_session_metadata(state, value, task_hints)
                        })
                        .transpose()
                        .map(|value| {
                            value.unwrap_or_else(|| {
                                requested_skill_names_from_task_hints(task_hints)
                            })
                        })
                })
                .transpose()?
                .unwrap_or_default();
            if !requested_skills.is_empty() {
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][skills][chat][{}] requested={}",
                        session_id.as_deref().unwrap_or("new-session"),
                        requested_skills.join(",")
                    ),
                );
            }
            if let Some(active_session_id) = session_id.as_deref() {
                let (runtime_mode, activated_skills) =
                    collect_active_skill_items_for_session(state, active_session_id)?;
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][skills][chat][{}] activated={} runtimeMode={}",
                        active_session_id,
                        if activated_skills.is_empty() {
                            "none".to_string()
                        } else {
                            activated_skills
                                .iter()
                                .map(|(name, _)| name.as_str())
                                .collect::<Vec<_>>()
                                .join(",")
                        },
                        runtime_mode
                    ),
                );
                for (name, description) in activated_skills {
                    emit_runtime_task_checkpoint_saved(
                        app,
                        None,
                        Some(active_session_id),
                        "chat.skill_activated",
                        "skill activated",
                        Some(json!({
                            "name": name,
                            "description": description,
                        })),
                    );
                }
            }
            let turn = build_chat_send_turn(
                session_id.clone(),
                message.clone(),
                display_content.clone(),
                payload_field(&payload, "modelConfig"),
                payload_field(&payload, "attachment").cloned(),
            );
            let prepared_turn = PreparedSessionAgentTurn::chat_send(turn);
            let completed = run_chat_send_turn(app, state, &prepared_turn, &message)?;
            if prepared_turn.is_redclaw_session() {
                let _ = app.emit(
                    "redclaw:runner-message",
                    completed
                        .redclaw_postprocess
                        .map(|postprocess| postprocess.runner_payload)
                        .unwrap_or(Value::Null),
                );
            }
            log_timing_event(
                state,
                "ai",
                &request_id,
                "chat:send-message:done",
                started_at,
                Some("status=ok".to_string()),
            );
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
