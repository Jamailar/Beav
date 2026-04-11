use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::runtime_orchestration::{
    run_reviewer_repair_for_task, run_subagent_orchestration_for_task, save_runtime_task_artifact,
};
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_task_node_changed};
use crate::runtime::{
    build_repair_goal, reviewer_rejected, route_for_task_snapshot, PreparedTaskResumeExecution,
    RuntimeArtifact, RuntimeCheckpointEvent, RuntimeNodeEvent, RuntimeTaskRecord,
};
use crate::AppState;

pub fn prepare_task_resume_execution(
    app: &AppHandle,
    settings_snapshot: &Value,
    task_snapshot: &RuntimeTaskRecord,
) -> Result<PreparedTaskResumeExecution, String> {
    let route = route_for_task_snapshot(task_snapshot).unwrap_or_else(|| {
        crate::runtime::runtime_direct_route_record(
            &task_snapshot.runtime_mode,
            task_snapshot.goal.as_deref().unwrap_or(""),
            task_snapshot.metadata.as_ref(),
        )
    });
    let route_value = route.clone().into_value();
    let orchestration = if route.requires_multi_agent
        || task_snapshot.runtime_mode == "background-maintenance"
    {
        Some(run_subagent_orchestration_for_task(
            Some(app),
            settings_snapshot,
            &task_snapshot.runtime_mode,
            &task_snapshot.id,
            task_snapshot.owner_session_id.as_deref(),
            &route,
            task_snapshot.goal.as_deref().unwrap_or(""),
        )?)
    } else {
        None
    };
    let reviewer_blocked = reviewer_rejected(orchestration.as_ref());
    let repair_plan = if reviewer_blocked {
        orchestration
            .as_ref()
            .map(|value| {
                run_reviewer_repair_for_task(
                    settings_snapshot,
                    &task_snapshot.id,
                    &route,
                    task_snapshot.goal.as_deref().unwrap_or(""),
                    value,
                )
            })
            .transpose()?
    } else {
        None
    };
    let repair_orchestration = if reviewer_blocked {
        repair_plan
            .as_ref()
            .map(|repair| {
                let repair_goal =
                    build_repair_goal(task_snapshot.goal.as_deref().unwrap_or(""), repair);
                run_subagent_orchestration_for_task(
                    Some(app),
                    settings_snapshot,
                    &task_snapshot.runtime_mode,
                    &format!("{}-repair", task_snapshot.id),
                    task_snapshot.owner_session_id.as_deref(),
                    &route,
                    &repair_goal,
                )
            })
            .transpose()?
    } else {
        None
    };
    let repair_pass_failed = reviewer_rejected(repair_orchestration.as_ref());
    Ok(PreparedTaskResumeExecution {
        route,
        route_value,
        orchestration,
        repair_plan,
        repair_orchestration,
        reviewer_blocked,
        repair_pass_failed,
    })
}

pub fn maybe_save_task_resume_artifact(
    state: &State<'_, AppState>,
    task_snapshot: &RuntimeTaskRecord,
    prepared: &PreparedTaskResumeExecution,
) -> Result<Option<RuntimeArtifact>, String> {
    let final_orchestration = prepared
        .repair_orchestration
        .as_ref()
        .or(prepared.orchestration.as_ref());
    if prepared.reviewer_blocked && prepared.repair_pass_failed {
        return Ok(None);
    }
    save_runtime_task_artifact(
        state,
        &task_snapshot.id,
        &prepared.route,
        task_snapshot.goal.as_deref().unwrap_or(""),
        final_orchestration,
    )
    .map(Some)
}

pub fn emit_task_resume_events(
    app: &AppHandle,
    task_id: &str,
    owner_session_id: Option<&str>,
    runtime_node_events: Vec<RuntimeNodeEvent>,
    runtime_checkpoint_events: Vec<RuntimeCheckpointEvent>,
) {
    for (node_id, status, summary, error) in runtime_node_events {
        emit_runtime_task_node_changed(
            app,
            task_id,
            owner_session_id,
            &node_id,
            &status,
            summary.as_deref(),
            error.as_deref(),
        );
    }
    for (checkpoint_type, summary, payload) in runtime_checkpoint_events {
        emit_runtime_task_checkpoint_saved(
            app,
            Some(task_id),
            owner_session_id,
            &checkpoint_type,
            &summary,
            payload,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{create_runtime_task, runtime_direct_route_record};

    fn prepared_execution(
        reviewer_blocked: bool,
        repair_pass_failed: bool,
        repair_plan: Option<Value>,
    ) -> PreparedTaskResumeExecution {
        let route = runtime_direct_route_record("default", "draft something", None);
        PreparedTaskResumeExecution {
            route_value: route.clone().into_value(),
            route,
            orchestration: None,
            repair_plan,
            repair_orchestration: None,
            reviewer_blocked,
            repair_pass_failed,
        }
    }

    #[test]
    fn apply_task_resume_execution_saves_artifact_and_work_item_on_success() {
        let prepared = prepared_execution(false, false, None);
        let mut store = crate::AppStore::default();
        let task = create_runtime_task(
            "manual",
            "running",
            "default".to_string(),
            Some("session-1".to_string()),
            Some("draft something".to_string()),
            prepared.route.clone(),
            None,
        );
        let task_id = task.id.clone();
        store.runtime_tasks.push(task);
        let artifact = RuntimeArtifact::new(
            "saved-artifact",
            "Saved Artifact",
            Some("/tmp/task-artifact.md".to_string()),
            None,
            None,
        );

        let applied = crate::runtime::apply_task_resume_execution(
            &mut store,
            &task_id,
            &prepared,
            Some(artifact),
        )
        .unwrap();

        assert_eq!(applied.response.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(store.work_items.len(), 1);
        assert_eq!(store.work_items[0].r#type, "runtime-artifact");
        assert_eq!(store.runtime_tasks[0].status, "completed");
        assert!(applied
            .runtime_node_events
            .iter()
            .any(|(node_id, status, _, _)| node_id == "save_artifact" && status == "completed"));
    }

    #[test]
    fn apply_task_resume_execution_creates_repair_work_item_when_blocked() {
        let prepared = prepared_execution(
            true,
            true,
            Some(serde_json::json!({ "summary": "repair missing evidence" })),
        );
        let mut store = crate::AppStore::default();
        let task = create_runtime_task(
            "manual",
            "running",
            "default".to_string(),
            Some("session-1".to_string()),
            Some("draft something".to_string()),
            prepared.route.clone(),
            None,
        );
        let task_id = task.id.clone();
        store.runtime_tasks.push(task);

        let applied =
            crate::runtime::apply_task_resume_execution(&mut store, &task_id, &prepared, None)
                .unwrap();

        assert_eq!(applied.response.get("success").and_then(Value::as_bool), Some(false));
        assert_eq!(
            applied.response.get("error").and_then(Value::as_str),
            Some("reviewer rejected execution")
        );
        assert_eq!(store.work_items.len(), 1);
        assert_eq!(store.work_items[0].r#type, "runtime-repair");
        assert_eq!(store.runtime_tasks[0].status, "failed");
        assert!(applied
            .runtime_node_events
            .iter()
            .any(|(node_id, status, _, _)| node_id == "execute_tools" && status == "failed"));
    }
}
