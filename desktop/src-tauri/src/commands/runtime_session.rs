use serde_json::Value;
use tauri::{AppHandle, State};

#[path = "runtime_query.rs"]
mod runtime_query;
#[path = "runtime_script.rs"]
mod runtime_script;
#[path = "runtime_session_ops.rs"]
mod runtime_session_ops;

use crate::AppState;

pub fn handle_runtime_session_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "chat:get-runtime-state" => runtime_session_ops::runtime_state_value(state, payload),
        "runtime:query" => runtime_query::handle_runtime_query(app, state, payload),
        "runtime:resume" => runtime_session_ops::runtime_resume_value(state, payload),
        "runtime:fork-session" => runtime_session_ops::fork_runtime_session(app, state, payload),
        "runtime:get-trace" => runtime_session_ops::runtime_trace_value(state, payload),
        "runtime:get-checkpoints" => runtime_session_ops::runtime_checkpoints_value(state, payload),
        "runtime:get-tool-results" => {
            runtime_session_ops::runtime_tool_results_value(state, payload)
        }
        "runtime:recall" => runtime_session_ops::runtime_recall_value(state, payload),
        "runtime:execute-script" => {
            runtime_script::runtime_execute_script_value(app, state, payload)
        }
        _ => return None,
    })
}
