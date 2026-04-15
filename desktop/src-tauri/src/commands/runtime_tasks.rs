use serde_json::Value;
use tauri::{AppHandle, State};

#[path = "runtime_task_ops.rs"]
mod runtime_task_ops;

use crate::AppState;
use crate::commands::runtime_task_resume::handle_runtime_task_resume;

pub fn handle_runtime_task_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "tasks:create" => runtime_task_ops::create_runtime_task_from_payload(state, payload),
        "tasks:list" => runtime_task_ops::list_runtime_tasks_value(state),
        "tasks:get" => runtime_task_ops::get_runtime_task_value(state, payload),
        "tasks:resume" => handle_runtime_task_resume(app, state, payload),
        "tasks:cancel" => runtime_task_ops::cancel_runtime_task_value(state, payload),
        "tasks:trace" => runtime_task_ops::runtime_task_trace_value(state, payload),
        _ => return None,
    })
}
