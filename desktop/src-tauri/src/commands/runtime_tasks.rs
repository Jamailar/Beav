use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[path = "runtime_task_resume.rs"]
mod runtime_task_resume;
#[path = "runtime_task_ops.rs"]
mod runtime_task_ops;

use crate::persistence::{with_store, with_store_mut};
use crate::runtime::resume_runtime_task_snapshot;
use crate::runtime::apply_task_resume_execution;
use crate::{payload_string, AppState};
use runtime_task_resume::{
    emit_task_resume_events, maybe_save_task_resume_artifact, prepare_task_resume_execution,
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
            "tasks:create" => runtime_task_ops::create_runtime_task_from_payload(state, payload),
            "tasks:list" => runtime_task_ops::list_runtime_tasks_value(state),
            "tasks:get" => runtime_task_ops::get_runtime_task_value(state, payload),
            "tasks:resume" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                let task_snapshot = with_store_mut(state, |store| {
                    Ok(resume_runtime_task_snapshot(
                        store,
                        &task_id,
                        "route and execution plan resumed",
                    ))
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
            "tasks:cancel" => runtime_task_ops::cancel_runtime_task_value(state, payload),
            "tasks:trace" => runtime_task_ops::runtime_task_trace_value(state, payload),
            _ => unreachable!("channel prefiltered"),
        }
    })();
    Some(result)
}
