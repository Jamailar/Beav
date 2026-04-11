use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{build_session_bridge_turn, PreparedSessionAgentTurn};
use crate::commands::chat_runtime::execute_session_agent_turn_request;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    session_bridge_detail_value, session_bridge_summary_value,
};
use crate::scheduler::{derived_background_tasks, sync_redclaw_job_definitions};
use crate::{
    log_timing_event, make_id, now_i64, now_iso, now_ms, payload_field, payload_string,
    redclaw_state_value, AppState, ChatSessionRecord,
};

pub fn handle_bridge_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result: Result<Value, String> = match channel {
        "session-bridge:status" => Ok(json!({
            "enabled": true,
            "listening": false,
            "host": "127.0.0.1",
            "port": 0,
            "authToken": "",
            "websocketUrl": "",
            "httpBaseUrl": "",
            "subscriberCount": 0,
            "lastError": Value::Null,
        })),
        "session-bridge:list-sessions" => with_store(state, |store| {
            let mut sessions = store.chat_sessions.clone();
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!(sessions
                .iter()
                .map(|session| session_bridge_summary_value(session, &store))
                .collect::<Vec<_>>()))
        }),
        "session-bridge:get-session" => {
            let session_id = payload_string(payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let background_tasks = derived_background_tasks(&store);
                Ok(session_bridge_detail_value(&store, &session_id, &background_tasks))
            })
        }
        "session-bridge:list-permissions" => Ok(json!([])),
        "session-bridge:create-session" => with_store_mut(state, |store| {
            let title =
                payload_string(payload, "title").unwrap_or_else(|| "Session Bridge".to_string());
            let session = ChatSessionRecord {
                id: make_id("session"),
                title,
                created_at: now_iso(),
                updated_at: now_iso(),
                metadata: payload_field(payload, "metadata").cloned(),
            };
            store.chat_sessions.push(session.clone());
            Ok(session_bridge_summary_value(&session, store))
        }),
        "session-bridge:send-message" => {
            let session_id = payload_string(payload, "sessionId").unwrap_or_default();
            let message = payload_string(payload, "message").unwrap_or_default();
            let turn = PreparedSessionAgentTurn::SessionBridge(
                build_session_bridge_turn(session_id.clone(), message),
            );
            execute_session_agent_turn_request(
                None,
                state,
                turn.request().clone(),
            )
            .map(|execution| json!({ "accepted": true, "sessionId": execution.session_id }))
        }
        "session-bridge:resolve-permission" => Ok(json!({ "success": true })),
        "background-tasks:list" => {
            with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("background-tasks:list:{}", started_at);
                let tasks = derived_background_tasks(&store);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "background-tasks:list",
                    started_at,
                    Some(format!("tasks={}", tasks.len())),
                );
                Ok(json!(tasks))
            })
        }
        "background-tasks:get" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            with_store(state, |store| {
                let task = derived_background_tasks(&store)
                    .into_iter()
                    .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(task_id.as_str()))
                    .unwrap_or(Value::Null);
                Ok(task)
            })
        }
        "background-tasks:cancel" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            match with_store_mut(state, |store| {
                if let Some(index) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter()
                    .position(|item| item.id == task_id)
                {
                    let task = &mut store.redclaw_state.scheduled_tasks[index];
                    task.enabled = false;
                    task.last_error = Some("Cancelled from background tasks".to_string());
                    task.updated_at = now_iso();
                    sync_redclaw_job_definitions(store);
                    return Ok(json!({ "success": true, "kind": "scheduled-task" }));
                }
                if let Some(index) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter()
                    .position(|item| item.id == task_id)
                {
                    let task = &mut store.redclaw_state.long_cycle_tasks[index];
                    task.enabled = false;
                    task.status = "cancelled".to_string();
                    task.last_error = Some("Cancelled from background tasks".to_string());
                    task.updated_at = now_iso();
                    sync_redclaw_job_definitions(store);
                    return Ok(json!({ "success": true, "kind": "long-cycle" }));
                }
                if let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.status = "cancelled".to_string();
                    task.updated_at = now_i64();
                    task.completed_at = Some(now_i64());
                    return Ok(json!({ "success": true, "kind": "runtime-task" }));
                }
                Ok(json!({ "success": false, "error": "后台任务不存在" }))
            }) {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state))) {
                        Ok(status) => {
                            let _ = app.emit("redclaw:runner-status", status);
                            Ok(result)
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        _ => return None,
    };
    Some(result)
}
