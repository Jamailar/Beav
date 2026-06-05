use super::emit_collab_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    create_collab_task, list_collab_tasks, pin_collab_task_session, retry_collab_task,
    transition_collab_task, update_collab_task,
};
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn list_tasks_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    with_store(state, |store| {
        Ok(json!(list_collab_tasks(&store, &session_id)))
    })
}

pub fn create_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| create_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task }),
    );
    Ok(json!(task))
}

pub fn update_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| update_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task }),
    );
    Ok(json!(task))
}

pub fn transition_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    transition: &str,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| {
        transition_collab_task(store, payload, transition)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": transition }),
    );
    Ok(json!(task))
}

pub fn pin_task_session_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| pin_collab_task_session(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": "pin-session" }),
    );
    Ok(json!(task))
}

pub fn retry_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| retry_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": "retry" }),
    );
    Ok(json!(task))
}
