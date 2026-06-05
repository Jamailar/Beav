use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::events::emit_runtime_task_checkpoint_saved;
use crate::persistence::with_store_mut;
use crate::scheduler::{
    cancel_job_execution, emit_scheduler_snapshot, sync_redclaw_job_definitions,
};
use crate::store::redclaw as redclaw_store;
use crate::{now_iso, payload_field, payload_string, AppState};

pub fn handle_task_cancel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let job_definition_id = payload_string(payload, "jobDefinitionId")
        .or_else(|| payload_string(payload, "draftId"))
        .ok_or_else(|| "jobDefinitionId is required".to_string())?;
    let reason = payload_string(payload, "reason")
        .unwrap_or_else(|| "Cancelled by task control".to_string());
    let delete_source = payload_field(payload, "deleteSource")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let result = with_store_mut(state, |store| {
        let definition = redclaw_store::job_definition_by_id(store, &job_definition_id)
            .ok_or_else(|| "任务定义不存在".to_string())?;
        if definition.requires_confirmation {
            redclaw_store::remove_job_definition(store, &job_definition_id);
            return Ok(json!({
                "cancelled": true,
                "jobDefinitionId": job_definition_id,
                "draft": true,
            }));
        }

        if delete_source {
            redclaw_store::remove_source_task_for_definition(store, &definition);
            if let Some(source_task_id) = definition.source_task_id.clone() {
                let _ = cancel_job_execution(store, &source_task_id, &reason);
            }
            sync_redclaw_job_definitions(store);
            return Ok(json!({
                "cancelled": true,
                "deleted": true,
                "jobDefinitionId": job_definition_id,
                "reason": reason,
            }));
        }

        redclaw_store::pause_source_task_for_definition(store, &definition, &reason, &now_iso());

        if let Some(source_task_id) = definition.source_task_id.clone() {
            let _ = cancel_job_execution(store, &source_task_id, &reason);
        }
        sync_redclaw_job_definitions(store);
        Ok(json!({
            "cancelled": true,
            "jobDefinitionId": job_definition_id,
            "reason": reason,
        }))
    })?;

    emit_runtime_task_checkpoint_saved(
        app,
        Some(&job_definition_id),
        None,
        "task.cancelled",
        "Task definition cancelled",
        Some(result.clone()),
    );
    emit_scheduler_snapshot(app, state);
    Ok(json!({ "success": true, "result": result }))
}
