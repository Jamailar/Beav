use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::agent::{
    PreparedSessionAgentTurn, build_session_bridge_turn, execute_prepared_session_agent_turn,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::transcript_session_meta_by_id;
use crate::scheduler::{
    archive_job_execution, cancel_job_execution, derived_background_tasks, emit_scheduler_snapshot,
    retry_job_execution, sync_redclaw_job_definitions,
};
use crate::session_manager::{
    create_session, list_sessions, session_bridge_detail_value, session_bridge_summary_value,
};
use crate::{AppState, log_timing_event, now_i64, now_ms, payload_field, payload_string};

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
        "session-bridge:list-sessions" => (|| {
            let sessions = with_store(state, |store| Ok(list_sessions(&store)))?;
            let transcript_meta_by_session_id = sessions
                .iter()
                .filter_map(|session| {
                    transcript_session_meta_by_id(state, &session.id)
                        .ok()
                        .flatten()
                        .map(|meta| (session.id.clone(), meta))
                })
                .collect::<std::collections::HashMap<_, _>>();
            with_store(state, |store| {
                Ok(json!(
                    sessions
                        .iter()
                        .map(|session| {
                            let transcript_meta = transcript_meta_by_session_id.get(&session.id);
                            session_bridge_summary_value(&store, session, transcript_meta)
                        })
                        .collect::<Vec<_>>()
                ))
            })
        })(),
        "session-bridge:get-session" => (|| {
            let session_id = payload_string(payload, "sessionId").unwrap_or_default();
            let transcript_meta = transcript_session_meta_by_id(state, &session_id)
                .ok()
                .flatten();
            with_store(state, |store| {
                let background_tasks = derived_background_tasks(&store);
                Ok(session_bridge_detail_value(
                    &store,
                    &session_id,
                    &background_tasks,
                    transcript_meta.as_ref(),
                ))
            })
        })(),
        "session-bridge:list-permissions" => Ok(json!([])),
        "session-bridge:create-session" => with_store_mut(state, |store| {
            let title =
                payload_string(payload, "title").unwrap_or_else(|| "Session Bridge".to_string());
            let session = create_session(store, title, payload_field(payload, "metadata").cloned());
            Ok(session_bridge_summary_value(store, &session, None))
        }),
        "session-bridge:send-message" => {
            let session_id = payload_string(payload, "sessionId").unwrap_or_default();
            let message = payload_string(payload, "message").unwrap_or_default();
            let turn = PreparedSessionAgentTurn::session_bridge(build_session_bridge_turn(
                session_id.clone(),
                message,
            ));
            execute_prepared_session_agent_turn(None, state, &turn)
                .map(|execution| json!({ "accepted": true, "sessionId": execution.session_id() }))
        }
        "session-bridge:resolve-permission" => Ok(json!({ "success": true })),
        "background-tasks:list" => with_store(state, |store| {
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
        }),
        "background-tasks:get" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            with_store(state, |store| {
                let task = derived_background_tasks(&store)
                    .into_iter()
                    .find(|item| {
                        item.get("id").and_then(|v| v.as_str()) == Some(task_id.as_str())
                            || item.get("executionId").and_then(|v| v.as_str())
                                == Some(task_id.as_str())
                            || item.get("definitionId").and_then(|v| v.as_str())
                                == Some(task_id.as_str())
                            || item.get("sourceTaskId").and_then(|v| v.as_str())
                                == Some(task_id.as_str())
                    })
                    .unwrap_or(Value::Null);
                Ok(task)
            })
        }
        "background-tasks:cancel" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            match with_store_mut(state, |store| {
                if let Some((cancelled_id, kind)) =
                    cancel_job_execution(store, &task_id, "Cancelled from background tasks")
                {
                    sync_redclaw_job_definitions(store);
                    return Ok(json!({ "success": true, "id": cancelled_id, "kind": kind }));
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
                    emit_scheduler_snapshot(app, state);
                    Ok(result)
                }
                Err(error) => Err(error),
            }
        }
        "background-tasks:retry" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            match with_store_mut(state, |store| {
                let (execution_id, definition_id) = retry_job_execution(store, &task_id)?;
                sync_redclaw_job_definitions(store);
                Ok(json!({
                    "success": true,
                    "executionId": execution_id,
                    "definitionId": definition_id,
                }))
            }) {
                Ok(result) => {
                    emit_scheduler_snapshot(app, state);
                    Ok(result)
                }
                Err(error) => Err(error),
            }
        }
        "background-tasks:archive" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            match with_store_mut(state, |store| {
                let execution_id = archive_job_execution(store, &task_id)?;
                Ok(json!({
                    "success": true,
                    "executionId": execution_id,
                }))
            }) {
                Ok(result) => {
                    emit_scheduler_snapshot(app, state);
                    Ok(result)
                }
                Err(error) => Err(error),
            }
        }
        _ => return None,
    };
    Some(result)
}
