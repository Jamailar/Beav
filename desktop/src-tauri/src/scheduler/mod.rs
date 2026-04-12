mod dead_letter;
mod heartbeat;
mod job_runtime;
mod lease;
mod retry;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawLongCycleTaskRecord, RedclawScheduledTaskRecord,
};
use crate::{run_memory_maintenance_with_reason, AppState, AppStore};

pub use job_runtime::{
    background_status, cancel_job_execution, emit_scheduler_snapshot, enqueue_due_job_executions,
    enqueue_manual_job_execution_for_source, recover_stale_job_executions,
    requeue_retrying_job_executions, run_due_job_executions, run_job_queue_once,
};

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

fn definition_kind_for_background(kind: &str) -> &str {
    match kind {
        "long_cycle" => "long-cycle",
        "scheduled" => "scheduled-task",
        other => other,
    }
}

pub fn derived_background_tasks(store: &AppStore) -> Vec<Value> {
    let mut tasks = Vec::new();
    let latest_execution_by_definition: std::collections::HashMap<
        String,
        &crate::RedclawJobExecutionRecord,
    > = store.redclaw_job_executions.iter().fold(
        std::collections::HashMap::new(),
        |mut acc, execution| {
            let replace = acc
                .get(&execution.definition_id)
                .map(|current| execution.updated_at > current.updated_at)
                .unwrap_or(true);
            if replace {
                acc.insert(execution.definition_id.clone(), execution);
            }
            acc
        },
    );

    for definition in &store.redclaw_job_definitions {
        let execution = latest_execution_by_definition.get(&definition.id).copied();
        let worker_state = execution
            .map(|item| item.status.clone())
            .unwrap_or_else(|| {
                if definition.enabled {
                    "idle".to_string()
                } else {
                    "cancelled".to_string()
                }
            });
        let status = background_status(&worker_state);
        let summary = definition
            .payload
            .get("objective")
            .or_else(|| definition.payload.get("prompt"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let latest_text = execution
            .and_then(|item| item.output_summary.clone())
            .or_else(|| {
                definition
                    .payload
                    .get("stepPrompt")
                    .or_else(|| definition.payload.get("prompt"))
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
            });
        tasks.push(json!({
            "id": definition
                .source_task_id
                .clone()
                .unwrap_or_else(|| execution.map(|item| item.id.clone()).unwrap_or_else(|| definition.id.clone())),
            "definitionId": definition.id,
            "executionId": execution.map(|item| item.id.clone()),
            "kind": definition_kind_for_background(&definition.kind),
            "title": definition.title,
            "status": status,
            "phase": background_phase_from_status(&worker_state),
            "sessionId": execution.and_then(|item| item.session_id.clone()),
            "contextId": definition.owner_context_id,
            "error": execution
                .and_then(|item| item.last_error.clone())
                .or_else(|| definition.payload.get("lastError").and_then(Value::as_str).map(|value| value.to_string())),
            "summary": summary,
            "latestText": latest_text,
            "attemptCount": execution.map(|item| item.attempt_count).unwrap_or(0),
            "workerState": worker_state,
            "workerMode": execution
                .map(|item| item.worker_mode.clone())
                .unwrap_or_else(|| "main-process".to_string()),
            "workerLastHeartbeatAt": execution.and_then(|item| item.last_heartbeat_at.clone()),
            "cancelReason": execution.and_then(|item| item.cancel_reason.clone()),
            "rollbackState": "not_required",
            "createdAt": execution
                .map(|item| item.created_at.clone())
                .unwrap_or_else(|| definition.created_at.clone()),
            "updatedAt": execution
                .map(|item| item.updated_at.clone())
                .unwrap_or_else(|| definition.updated_at.clone()),
            "completedAt": execution.and_then(|item| item.completed_at.clone()),
            "turns": execution.map(|item| item.checkpoints.clone()).unwrap_or_default()
        }));
    }

    for execution in &store.redclaw_job_executions {
        if latest_execution_by_definition
            .get(&execution.definition_id)
            .map(|item| item.id != execution.id)
            .unwrap_or(false)
        {
            continue;
        }
        if store
            .redclaw_job_definitions
            .iter()
            .any(|item| item.id == execution.definition_id)
        {
            continue;
        }
        let worker_state = execution.status.clone();
        tasks.push(json!({
            "id": execution.id,
            "definitionId": execution.definition_id,
            "executionId": execution.id,
            "kind": "headless-runtime",
            "title": execution.output_summary.clone().unwrap_or_else(|| "Orphaned execution".to_string()),
            "status": background_status(&worker_state),
            "phase": background_phase_from_status(&worker_state),
            "sessionId": execution.session_id,
            "contextId": Value::Null,
            "error": execution.last_error,
            "summary": execution
                .input_snapshot
                .as_ref()
                .and_then(|value| value.get("prompt"))
                .and_then(Value::as_str),
            "latestText": execution.output_summary,
            "attemptCount": execution.attempt_count,
            "workerState": worker_state,
            "workerMode": execution.worker_mode,
            "workerLastHeartbeatAt": execution.last_heartbeat_at,
            "cancelReason": execution.cancel_reason,
            "rollbackState": "not_required",
            "createdAt": execution.created_at,
            "updatedAt": execution.updated_at,
            "completedAt": execution.completed_at,
            "turns": execution.checkpoints
        }));
    }
    tasks.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(Value::as_str)
            .cmp(&a.get("updatedAt").and_then(Value::as_str))
    });
    tasks
}

pub fn run_redclaw_scheduler(app: AppHandle, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let state = app.state::<AppState>();
            let now = crate::now_i64();
            let mut should_run_maintenance = false;
            let mut execution_limit = 0usize;

            if let Ok(limit) = crate::persistence::with_store_mut(&state, |store| {
                sync_redclaw_job_definitions(store);
                if store.redclaw_state.enabled && store.redclaw_state.is_ticking {
                    recover_stale_job_executions(store, now);
                    requeue_retrying_job_executions(store, now);
                    let _ = enqueue_due_job_executions(store, now);
                    should_run_maintenance =
                        parse_millis_string(store.redclaw_state.next_maintenance_at.as_deref())
                            .unwrap_or(0)
                            <= now;
                    store.redclaw_state.last_tick_at = Some(now.to_string());
                    store.redclaw_state.next_tick_at =
                        Some((now + store.redclaw_state.interval_minutes * 60_000).to_string());
                    return Ok(store.redclaw_state.max_automation_per_tick.max(1) as usize);
                }
                Ok(0)
            }) {
                execution_limit = limit;
            }

            if execution_limit > 0 {
                let _ = run_due_job_executions(&app, &state, execution_limit);
                emit_scheduler_snapshot(&app, &state);
            }

            if should_run_maintenance {
                let _ = run_memory_maintenance_with_reason(&state, "periodic");
                if let Ok(store) = state.store.lock() {
                    let _ = app.emit(
                        "redclaw:runner-status",
                        crate::redclaw_state_value(&store.redclaw_state),
                    );
                }
            }

            thread::sleep(std::time::Duration::from_millis(1500));
        }
    })
}
