use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{build_chat_send_turn, run_chat_send_turn, PreparedSessionAgentTurn};
use crate::commands::chat_state::{
    latest_session_id, request_chat_runtime_cancel, resolve_runtime_mode_for_session,
};
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_tool_result};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::SessionToolResultRecord;
use crate::skills::{active_hooks_for_event, build_resolved_skill_runtime_state, resolve_skill_records};
use crate::session_lineage_fields;
use crate::skills::active_skill_activation_items;
use crate::{log_timing_event, make_id, now_i64, now_ms, payload_field, payload_string, AppState};

fn merge_request_metadata(base: Option<Value>, overlay: Option<Value>) -> Option<Value> {
    match (base, overlay) {
        (Some(Value::Object(mut base_map)), Some(Value::Object(overlay_map))) => {
            for (key, value) in overlay_map {
                base_map.insert(key, value);
            }
            Some(Value::Object(base_map))
        }
        (_, Some(overlay)) => Some(overlay),
        (Some(base), None) => Some(base),
        (None, None) => None,
    }
}

fn build_request_metadata(payload: &Value) -> Option<Value> {
    let mut metadata = payload_field(payload, "taskHints")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(attachment_type) = payload_field(payload, "attachment")
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
    {
        metadata.insert("attachmentType".to_string(), json!(attachment_type));
    }
    if let Some(display_content) = payload_string(payload, "displayContent") {
        metadata.insert("displayContent".to_string(), json!(display_content));
    }
    (!metadata.is_empty()).then_some(Value::Object(metadata))
}

pub fn handle_send_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    match channel {
        "chat:send-message" => {
            let started_at = now_ms();
            let session_id = payload_string(&payload, "sessionId");
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
            let request_metadata = build_request_metadata(&payload);
            let turn = build_chat_send_turn(
                session_id.clone(),
                message.clone(),
                display_content.clone(),
                payload_field(&payload, "modelConfig"),
                payload_field(&payload, "attachment").cloned(),
                request_metadata.clone(),
            );
            let prepared_turn = PreparedSessionAgentTurn::chat_send(turn);
            let completed = run_chat_send_turn(app, state, &prepared_turn, &message)?;
            let session_hint = session_id.clone();
            let workspace = crate::workspace_root(state).ok();
            let (active_session_id, activated_skills, skill_runtime_state) = with_store(state, |store| {
                let target_session_id = session_hint
                    .clone()
                    .unwrap_or_else(|| latest_session_id(&store));
                let runtime_mode = resolve_runtime_mode_for_session(&store, &target_session_id);
                let metadata = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == target_session_id)
                    .and_then(|item| item.metadata.clone());
                let merged_metadata = merge_request_metadata(metadata, request_metadata.clone());
                let items = active_skill_activation_items(
                    &resolve_skill_records(&store.skills, workspace.as_deref()),
                    &runtime_mode,
                    merged_metadata.as_ref(),
                    Some(&crate::skills::SkillActivationContext {
                        current_message: Some(message.clone()),
                        intent: merged_metadata
                            .as_ref()
                            .and_then(|value| value.get("intent"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        touched_paths: Vec::new(),
                        args: None,
                    }),
                );
                let base_tools = crate::tools::registry::base_tool_names_for_session_metadata(
                    &runtime_mode,
                    merged_metadata.as_ref(),
                );
                let skill_state = build_resolved_skill_runtime_state(
                    &store.skills,
                    workspace.as_deref(),
                    &runtime_mode,
                    merged_metadata.as_ref(),
                    &base_tools,
                    Some(&crate::skills::SkillActivationContext {
                        current_message: Some(message.clone()),
                        intent: merged_metadata
                            .as_ref()
                            .and_then(|value| value.get("intent"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        touched_paths: Vec::new(),
                        args: None,
                    }),
                );
                Ok((target_session_id, items, skill_state))
            })?;
            for (name, description) in activated_skills {
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(&active_session_id),
                    "chat.skill_activated",
                    "skill activated",
                    Some(json!({
                        "name": name,
                        "description": description,
                    })),
                );
            }
            if let Some(runtime_mode) = with_store(state, |store| {
                Ok(Some(resolve_runtime_mode_for_session(&store, &active_session_id)))
            })? {
                let hook_actions =
                    active_hooks_for_event(&skill_runtime_state.active_skills, "skillActivated", &runtime_mode, &message);
                if !hook_actions.is_empty() {
                    let _ = with_store_mut(state, |store| {
                        for hook in hook_actions {
                            if hook.action_type != "checkpoint" {
                                continue;
                            }
                            crate::runtime::append_session_checkpoint(
                                store,
                                &active_session_id,
                                "skill.hook.skill_activated",
                                hook.summary
                                    .clone()
                                    .or(hook.message.clone())
                                    .unwrap_or_else(|| "skill activation hook fired".to_string()),
                                hook.payload.clone(),
                            );
                        }
                        Ok(())
                    });
                }
            }
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
