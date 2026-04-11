use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[path = "runtime_query.rs"]
mod runtime_query;
#[path = "runtime_session_ops.rs"]
mod runtime_session_ops;

use crate::persistence::with_store;
use crate::runtime::{
    checkpoints_for_session, tool_results_for_session, trace_for_session,
};
use crate::{
    payload_string, AppState,
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
                runtime_session_ops::runtime_state_value(state, payload)
            }
            "runtime:query" => {
                runtime_query::handle_runtime_query(app, state, payload)
            }
            "runtime:resume" => {
                Ok(runtime_session_ops::runtime_resume_value(payload))
            }
            "runtime:fork-session" => {
                runtime_session_ops::fork_runtime_session(app, state, payload)
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
