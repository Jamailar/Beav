use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[path = "runtime_task_resume.rs"]
mod runtime_task_resume;

use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace, create_runtime_task, get_runtime_task, list_runtime_task_traces,
    list_runtime_tasks, mark_task_running, runtime_task_value,
};
use crate::{log_timing_event, now_i64, now_ms, payload_field, payload_string, AppState};
use runtime_task_resume::{
    apply_task_resume_execution, emit_task_resume_events, maybe_save_task_resume_artifact,
    prepare_task_resume_execution,
};

pub fn handle_runtime_task_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "tasks:create" | "tasks:list" | "tasks:get" | "tasks:resume" | "tasks:cancel"
        | "tasks:trace" => {}
        _ => return None,
    }

    let result: Result<Value, String> = (|| -> Result<Value, String> {
        match channel {
            "tasks:create" => {
                let runtime_mode =
                    payload_string(payload, "runtimeMode").unwrap_or_else(|| "default".to_string());
                let owner_session_id = payload_string(payload, "sessionId");
                let user_input = payload_string(payload, "userInput")
                    .unwrap_or_else(|| "开发者手动创建任务".to_string());
                let metadata = payload_field(payload, "metadata").cloned();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let route = route_runtime_intent_with_settings(
                    &settings_snapshot,
                    &runtime_mode,
                    &user_input,
                    metadata.as_ref(),
                );
                let route_value = route.clone().into_value();
                let created = with_store_mut(state, |store| {
                    let task = create_runtime_task(
                        "manual",
                        "pending",
                        runtime_mode,
                        owner_session_id,
                        Some(user_input.clone()),
                        route.clone(),
                        metadata,
                    );
                    append_runtime_task_trace(
                        store,
                        &task.id,
                        "created",
                        Some(json!({
                            "goal": task.goal.clone(),
                            "runtimeMode": task.runtime_mode,
                            "intent": task.intent,
                            "roleId": task.role_id,
                            "route": route_value
                        })),
                    );
                    store.runtime_tasks.push(task.clone());
                    Ok(task)
                })?;
                Ok(json!(created))
            }
            "tasks:list" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("tasks:list:{}", started_at);
                let tasks = list_runtime_tasks(&store);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "tasks:list",
                    started_at,
                    Some(format!("tasks={}", tasks.len())),
                );
                Ok(json!(tasks))
            }),
            "tasks:get" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                with_store(state, |store| {
                    Ok(get_runtime_task(&store, &task_id).map_or(Value::Null, |item| {
                        runtime_task_value(&item)
                    }))
                })
            }
            "tasks:resume" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                let task_snapshot = with_store_mut(state, |store| {
                    let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    else {
                        return Ok(None);
                    };
                    mark_task_running(task, "route and execution plan resumed");
                    Ok(Some(task.clone()))
                })?;
                let Some(task_snapshot) = task_snapshot else {
                    return Ok(json!({ "success": false, "error": "任务不存在" }));
                };

                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let prepared = prepare_task_resume_execution(app, &settings_snapshot, &task_snapshot)?;
                let saved_artifact =
                    maybe_save_task_resume_artifact(state, &task_snapshot, &prepared)?;

                let applied = with_store_mut(state, |store| {
                    apply_task_resume_execution(store, &task_id, &prepared, saved_artifact.clone())
                })?;
                emit_task_resume_events(
                    app,
                    &task_id,
                    task_snapshot.owner_session_id.as_deref(),
                    applied.runtime_node_events,
                    applied.runtime_checkpoint_events,
                );
                Ok(applied.response)
            }
            "tasks:cancel" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    else {
                        return Ok(json!({ "success": false, "error": "任务不存在" }));
                    };
                    task.status = "cancelled".to_string();
                    task.updated_at = now_i64();
                    task.completed_at = Some(now_i64());
                    append_runtime_task_trace(store, &task_id, "cancelled", None);
                    Ok(json!({ "success": true, "taskId": task_id }))
                })?;
                Ok(result)
            }
            "tasks:trace" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                with_store(state, |store| Ok(json!(list_runtime_task_traces(&store, &task_id))))
            }
            _ => unreachable!("channel prefiltered"),
        }
    })();
    Some(result)
}
