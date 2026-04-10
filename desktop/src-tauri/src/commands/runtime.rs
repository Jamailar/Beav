use serde_json::Value;
use tauri::{AppHandle, State};

use crate::AppState;

#[path = "runtime_session.rs"]
mod runtime_session;
#[path = "runtime_tasks.rs"]
mod runtime_tasks;

pub fn handle_runtime_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if let Some(result) =
        runtime_session::handle_runtime_session_channel(app, state, channel, payload)
    {
        return Some(result);
    }
    if let Some(result) = runtime_tasks::handle_runtime_task_channel(app, state, channel, payload) {
        return Some(result);
    }
    None
}
