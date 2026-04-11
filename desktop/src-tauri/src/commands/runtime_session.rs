use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::chat_runtime::execute_chat_exchange;
use crate::commands::runtime_orchestration::run_subagent_orchestration_for_task;
use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::events::{emit_chat_sequence, emit_runtime_task_checkpoint_saved};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_session_checkpoint, checkpoints_for_session, prepare_runtime_query_execution,
    tool_results_for_session, trace_for_session,
};
use crate::{
    make_id, now_iso, now_ms, payload_field, payload_string, payload_value_as_string,
    resolve_runtime_mode_for_session, AppState, ChatSessionRecord,
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
                let session_id = payload_string(payload, "sessionId");
                let message = payload_string(payload, "message").unwrap_or_default();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let runtime_mode = with_store(state, |store| {
                    Ok(session_id
                        .as_deref()
                        .map(|value| resolve_runtime_mode_for_session(&store, value))
                        .unwrap_or_else(|| "redclaw".to_string()))
                })?;
                let route = route_runtime_intent_with_settings(
                    &settings_snapshot,
                    &runtime_mode,
                    &message,
                    payload_field(payload, "metadata"),
                );
                let orchestration =
                    if route.requires_multi_agent || route.requires_long_running_task {
                        Some(run_subagent_orchestration_for_task(
                            Some(app),
                            &settings_snapshot,
                            &runtime_mode,
                            session_id.as_deref().unwrap_or("runtime-query"),
                            session_id.as_deref(),
                            &route,
                            &message,
                        )?)
                    } else {
                        None
                    };
                let prepared =
                    prepare_runtime_query_execution(route.clone(), orchestration.clone(), &message);
                let route_value = prepared.route.clone().into_value();
                let execution = execute_chat_exchange(
                    Some(app),
                    state,
                    session_id,
                    prepared.effective_message,
                    message.clone(),
                    payload_field(payload, "modelConfig"),
                    None,
                    "runtime-query",
                    "Runtime query completed",
                )?;
                let _ = with_store_mut(state, |store| {
                    append_session_checkpoint(
                        store,
                        &execution.session_id,
                        "runtime.route",
                        if route.reasoning.trim().is_empty() {
                            "runtime route".to_string()
                        } else {
                            prepared.route.reasoning.clone()
                        },
                        Some(route_value.clone()),
                    );
                    if let Some(orchestration_value) = prepared.orchestration.clone() {
                        append_session_checkpoint(
                            store,
                            &execution.session_id,
                            "runtime.orchestration",
                            "subagent orchestration completed".to_string(),
                            Some(orchestration_value),
                        );
                    }
                    Ok(())
                });
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(&execution.session_id),
                    "runtime.route",
                    if route.reasoning.trim().is_empty() {
                        "runtime route"
                    } else {
                        prepared.route.reasoning.as_str()
                    },
                    Some(route_value.clone()),
                );
                if let Some(orchestration_value) = prepared.orchestration.clone() {
                    emit_runtime_task_checkpoint_saved(
                        app,
                        None,
                        Some(&execution.session_id),
                        "runtime.orchestration",
                        "subagent orchestration completed",
                        Some(orchestration_value),
                    );
                }
                emit_chat_sequence(
                    app,
                    &execution.session_id,
                    &execution.response,
                    "正在规划并调用模型生成响应。",
                    &runtime_mode,
                    execution.title_update,
                );
                Ok(json!({
                    "success": true,
                    "sessionId": execution.session_id,
                    "response": execution.response,
                    "route": route_value,
                    "orchestration": prepared.orchestration
                }))
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
