use serde_json::{json, Value};

use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawLongCycleTaskRecord, RedclawScheduledTaskRecord,
};
use crate::AppStore;

pub fn parse_millis_string(value: Option<&str>) -> Option<i64> {
    value.and_then(|item| item.trim().parse::<i64>().ok())
}

pub fn next_scheduled_timestamp(task: &RedclawScheduledTaskRecord, now: i64) -> Option<String> {
    let next_ms = match task.mode.as_str() {
        "interval" => now + task.interval_minutes.unwrap_or(60) * 60_000,
        "daily" => now + 24 * 60 * 60_000,
        "weekly" => now + 7 * 24 * 60 * 60_000,
        "once" => return None,
        _ => now + 60 * 60_000,
    };
    Some(next_ms.to_string())
}

pub fn next_long_cycle_timestamp(task: &RedclawLongCycleTaskRecord, now: i64) -> Option<String> {
    Some((now + task.interval_minutes * 60_000).to_string())
}

fn legacy_redclaw_job_definition_id(source_kind: &str, source_task_id: &str) -> String {
    format!("jobdef-{source_kind}-{source_task_id}")
}

fn build_scheduled_job_definition(
    task: &RedclawScheduledTaskRecord,
    existing: Option<&RedclawJobDefinitionRecord>,
) -> RedclawJobDefinitionRecord {
    RedclawJobDefinitionRecord {
        id: existing
            .map(|item| item.id.clone())
            .unwrap_or_else(|| legacy_redclaw_job_definition_id("scheduled", &task.id)),
        source_kind: Some("scheduled".to_string()),
        source_task_id: Some(task.id.clone()),
        kind: "scheduled".to_string(),
        title: task.name.clone(),
        enabled: task.enabled,
        owner_context_id: task.project_id.clone(),
        runtime_mode: "redclaw".to_string(),
        trigger_kind: task.mode.clone(),
        progression_kind: "single_run".to_string(),
        payload: json!({
            "prompt": task.prompt,
            "intervalMinutes": task.interval_minutes,
            "time": task.time,
            "weekdays": task.weekdays,
            "runAt": task.run_at,
            "lastRunAt": task.last_run_at,
            "lastResult": task.last_result,
            "lastError": task.last_error,
        }),
        next_due_at: task.next_run_at.clone(),
        last_enqueued_at: existing.and_then(|item| item.last_enqueued_at.clone()),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
    }
}

fn build_long_cycle_job_definition(
    task: &RedclawLongCycleTaskRecord,
    existing: Option<&RedclawJobDefinitionRecord>,
) -> RedclawJobDefinitionRecord {
    RedclawJobDefinitionRecord {
        id: existing
            .map(|item| item.id.clone())
            .unwrap_or_else(|| legacy_redclaw_job_definition_id("long-cycle", &task.id)),
        source_kind: Some("long_cycle".to_string()),
        source_task_id: Some(task.id.clone()),
        kind: "long_cycle".to_string(),
        title: task.name.clone(),
        enabled: task.enabled,
        owner_context_id: task.project_id.clone(),
        runtime_mode: "redclaw".to_string(),
        trigger_kind: "interval".to_string(),
        progression_kind: "multi_round".to_string(),
        payload: json!({
            "objective": task.objective,
            "stepPrompt": task.step_prompt,
            "intervalMinutes": task.interval_minutes,
            "totalRounds": task.total_rounds,
            "completedRounds": task.completed_rounds,
            "status": task.status,
            "lastRunAt": task.last_run_at,
            "lastResult": task.last_result,
            "lastError": task.last_error,
        }),
        next_due_at: task.next_run_at.clone(),
        last_enqueued_at: existing.and_then(|item| item.last_enqueued_at.clone()),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
    }
}

pub fn sync_redclaw_job_definitions(store: &mut AppStore) {
    let existing = store.redclaw_job_definitions.clone();
    let mut next = existing
        .iter()
        .filter(|item| item.source_task_id.is_none())
        .cloned()
        .collect::<Vec<_>>();

    for task in &store.redclaw_state.scheduled_tasks {
        let existing = existing.iter().find(|item| {
            item.source_kind.as_deref() == Some("scheduled")
                && item.source_task_id.as_deref() == Some(task.id.as_str())
        });
        next.push(build_scheduled_job_definition(task, existing));
    }

    for task in &store.redclaw_state.long_cycle_tasks {
        let existing = existing.iter().find(|item| {
            item.source_kind.as_deref() == Some("long_cycle")
                && item.source_task_id.as_deref() == Some(task.id.as_str())
        });
        next.push(build_long_cycle_job_definition(task, existing));
    }

    next.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    store.redclaw_job_definitions = next;
}

fn background_phase_from_status(status: &str) -> &str {
    match status {
        "queued" | "leased" => "queued",
        "running" | "retrying" => "thinking",
        "succeeded" | "completed" => "completed",
        "failed" | "dead_lettered" => "failed",
        "cancelled" => "cancelled",
        _ => "thinking",
    }
}

pub fn derived_background_tasks(store: &AppStore) -> Vec<Value> {
    let mut tasks = Vec::new();
    for task in &store.redclaw_state.scheduled_tasks {
        let definition_id = store
            .redclaw_job_definitions
            .iter()
            .find(|item| {
                item.source_kind.as_deref() == Some("scheduled")
                    && item.source_task_id.as_deref() == Some(task.id.as_str())
            })
            .map(|item| item.id.clone());
        let execution = definition_id.as_ref().and_then(|definition_id| {
            store
                .redclaw_job_executions
                .iter()
                .filter(|item| item.definition_id == *definition_id)
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
        });
        let status = execution
            .map(|item| item.status.as_str())
            .unwrap_or(if task.enabled { "running" } else { "cancelled" });
        tasks.push(json!({
            "id": task.id,
            "definitionId": definition_id,
            "executionId": execution.map(|item| item.id.clone()),
            "kind": "scheduled-task",
            "title": task.name,
            "status": status,
            "phase": background_phase_from_status(status),
            "sessionId": execution.and_then(|item| item.session_id.clone()),
            "contextId": task.project_id,
            "error": execution
                .and_then(|item| item.last_error.clone())
                .or_else(|| task.last_error.clone()),
            "summary": task.prompt,
            "latestText": task.prompt,
            "attemptCount": execution.map(|item| item.attempt_count).unwrap_or(0),
            "workerState": status,
            "workerMode": execution
                .map(|item| item.worker_mode.clone())
                .unwrap_or_else(|| "main-process".to_string()),
            "rollbackState": "not_required",
            "createdAt": execution
                .map(|item| item.created_at.clone())
                .unwrap_or_else(|| task.created_at.clone()),
            "updatedAt": execution
                .map(|item| item.updated_at.clone())
                .unwrap_or_else(|| task.updated_at.clone()),
            "completedAt": execution.and_then(|item| item.completed_at.clone()),
            "turns": execution.map(|item| item.checkpoints.clone()).unwrap_or_default()
        }));
    }
    for task in &store.redclaw_state.long_cycle_tasks {
        let definition_id = store
            .redclaw_job_definitions
            .iter()
            .find(|item| {
                item.source_kind.as_deref() == Some("long_cycle")
                    && item.source_task_id.as_deref() == Some(task.id.as_str())
            })
            .map(|item| item.id.clone());
        let execution = definition_id.as_ref().and_then(|definition_id| {
            store
                .redclaw_job_executions
                .iter()
                .filter(|item| item.definition_id == *definition_id)
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
        });
        let status = execution
            .map(|item| item.status.as_str())
            .unwrap_or(task.status.as_str());
        tasks.push(json!({
            "id": task.id,
            "definitionId": definition_id,
            "executionId": execution.map(|item| item.id.clone()),
            "kind": "long-cycle",
            "title": task.name,
            "status": status,
            "phase": background_phase_from_status(status),
            "sessionId": execution.and_then(|item| item.session_id.clone()),
            "contextId": task.project_id,
            "error": execution
                .and_then(|item| item.last_error.clone())
                .or_else(|| task.last_error.clone()),
            "summary": task.objective,
            "latestText": task.step_prompt,
            "attemptCount": execution
                .map(|item| item.attempt_count)
                .unwrap_or(task.completed_rounds),
            "workerState": status,
            "workerMode": execution
                .map(|item| item.worker_mode.clone())
                .unwrap_or_else(|| "main-process".to_string()),
            "rollbackState": "not_required",
            "createdAt": execution
                .map(|item| item.created_at.clone())
                .unwrap_or_else(|| task.created_at.clone()),
            "updatedAt": execution
                .map(|item| item.updated_at.clone())
                .unwrap_or_else(|| task.updated_at.clone()),
            "completedAt": execution.and_then(|item| item.completed_at.clone()),
            "turns": execution.map(|item| item.checkpoints.clone()).unwrap_or_default()
        }));
    }
    tasks
}
