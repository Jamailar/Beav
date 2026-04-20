use serde_json::{Value, json};
use tauri::State;

use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace, cancel_runtime_task,
    get_runtime_task_value as runtime_task_lookup_value,
    list_runtime_task_traces_value as runtime_task_traces_lookup_value, list_runtime_tasks,
    store_runtime_task,
};
use crate::{AppState, log_timing_event, now_ms, payload_field, payload_string};

pub fn create_runtime_task_from_payload(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let runtime_mode =
        payload_string(payload, "runtimeMode").unwrap_or_else(|| "default".to_string());
    let owner_session_id = payload_string(payload, "sessionId");
    let user_input =
        payload_string(payload, "userInput").unwrap_or_else(|| "开发者手动创建任务".to_string());
    let metadata = payload_field(payload, "metadata").cloned();
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let route = route_runtime_intent_with_settings(
        &settings_snapshot,
        &runtime_mode,
        &user_input,
        metadata.as_ref(),
    );
    let created = with_store_mut(state, |store| {
        Ok(store_runtime_task(
            store,
            "manual",
            "pending",
            runtime_mode,
            owner_session_id,
            Some(user_input.clone()),
            route.clone(),
            metadata,
        ))
    })?;
    Ok(json!(created))
}

pub fn list_runtime_tasks_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
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
    })
}

pub fn get_runtime_task_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task_id = payload_string(payload, "taskId").unwrap_or_default();
    with_store(state, |store| {
        Ok(runtime_task_lookup_value(&store, &task_id))
    })
}

pub fn cancel_runtime_task_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task_id = payload_string(payload, "taskId").unwrap_or_default();
    with_store_mut(state, |store| {
        if !cancel_runtime_task(store, &task_id) {
            return Ok(json!({ "success": false, "error": "任务不存在" }));
        }
        append_runtime_task_trace(store, &task_id, "cancelled", None);
        Ok(json!({ "success": true, "taskId": task_id }))
    })
}

pub fn runtime_task_trace_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task_id = payload_string(payload, "taskId").unwrap_or_default();
    let include_children = payload_field(payload, "includeChildren")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let limit = payload_field(payload, "limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(runtime_task_traces_lookup_value(
            &store,
            &task_id,
            include_children,
            limit,
        ))
    })
}
