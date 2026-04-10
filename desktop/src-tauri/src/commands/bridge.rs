use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::commands::chat_runtime::execute_chat_exchange;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::runtime_task_value;
use crate::scheduler::{derived_background_tasks, sync_redclaw_job_definitions};
use crate::{
    make_id, now_i64, now_iso, payload_field, payload_string, redclaw_state_value, AppState,
    AppStore, ChatSessionRecord, SessionCheckpointRecord, SessionToolResultRecord,
    SessionTranscriptRecord,
};

fn session_bridge_summary(session: &ChatSessionRecord, store: &AppStore) -> Value {
    let updated_at = session.updated_at.parse::<i64>().unwrap_or(0);
    let created_at = session.created_at.parse::<i64>().unwrap_or(0);
    let owner_task_count = store
        .runtime_tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(session.id.as_str()))
        .count() as i64;
    json!({
        "id": session.id,
        "title": session.title,
        "updatedAt": updated_at,
        "createdAt": created_at,
        "contextType": "chat",
        "runtimeMode": "default",
        "isBackgroundSession": false,
        "ownerTaskCount": owner_task_count,
        "backgroundTaskCount": 0,
    })
}

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
                .map(|session| session_bridge_summary(session, &store))
                .collect::<Vec<_>>()))
        }),
        "session-bridge:get-session" => {
            let session_id = payload_string(payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let Some(session) = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == session_id)
                else {
                    return Ok(Value::Null);
                };
                let transcript: Vec<SessionTranscriptRecord> = store
                    .session_transcript_records
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let checkpoints: Vec<SessionCheckpointRecord> = store
                    .session_checkpoints
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let tool_results: Vec<SessionToolResultRecord> = store
                    .session_tool_results
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let tasks: Vec<Value> = store
                    .runtime_tasks
                    .iter()
                    .filter(|task| task.owner_session_id.as_deref() == Some(session_id.as_str()))
                    .map(runtime_task_value)
                    .collect();
                let background_tasks = derived_background_tasks(&store);
                Ok(json!({
                    "session": {
                        "id": session.id,
                        "title": session.title,
                        "updatedAt": session.updated_at.parse::<i64>().unwrap_or(0),
                        "createdAt": session.created_at.parse::<i64>().unwrap_or(0),
                        "contextType": "chat",
                        "runtimeMode": "default",
                        "isBackgroundSession": false,
                        "ownerTaskCount": tasks.len(),
                        "backgroundTaskCount": background_tasks.len(),
                        "metadata": session.metadata,
                    },
                    "transcript": transcript,
                    "checkpoints": checkpoints,
                    "toolResults": tool_results,
                    "tasks": tasks,
                    "backgroundTasks": background_tasks,
                    "permissionRequests": [],
                }))
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
            Ok(session_bridge_summary(&session, store))
        }),
        "session-bridge:send-message" => {
            let session_id = payload_string(payload, "sessionId").unwrap_or_default();
            let message = payload_string(payload, "message").unwrap_or_default();
            execute_chat_exchange(
                None,
                state,
                Some(session_id.clone()),
                message.clone(),
                message,
                None,
                None,
                "session-bridge",
                "Session bridge message completed",
            )
            .map(|execution| json!({ "accepted": true, "sessionId": execution.session_id }))
        }
        "session-bridge:resolve-permission" => Ok(json!({ "success": true })),
        "background-tasks:list" => {
            with_store(state, |store| Ok(json!(derived_background_tasks(&store))))
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
