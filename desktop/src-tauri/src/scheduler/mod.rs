mod dead_letter;
mod heartbeat;
mod job_runtime;
mod lease;
mod retry;
pub mod task_policy;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use chrono::{NaiveTime, Timelike};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};

use crate::events::emit_runtime_task_checkpoint_saved;
use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawLongCycleTaskRecord, RedclawScheduledTaskRecord,
    RuntimeCheckpointRecord, RuntimeTaskRecord,
};
use crate::store::{redclaw as redclaw_store, runtime_tasks as runtime_task_store};
use crate::{format_timestamp_rfc3339_from_ms, AppState, AppStore};
use task_policy::{
    fingerprint_for_definition_payload, next_daily_timestamp_in_timezone,
    next_weekly_timestamp_in_timezone,
};

pub use job_runtime::{
    archive_job_execution, background_status, cancel_job_execution, emit_scheduler_snapshot,
    enqueue_due_job_executions, enqueue_manual_job_execution_for_definition,
    recover_stale_job_executions, requeue_retrying_job_executions, retry_job_execution,
    run_due_job_executions, run_job_queue_once,
};

pub fn parse_millis_string(value: Option<&str>) -> Option<i64> {
    value.and_then(|item| item.trim().parse::<i64>().ok())
}

fn parse_time_parts(value: Option<&str>) -> Option<(u32, u32)> {
    let raw = value?.trim();
    let parsed = NaiveTime::parse_from_str(raw, "%H:%M").ok()?;
    Some((parsed.hour(), parsed.minute()))
}

fn weekday_flags(values: &[i64]) -> [bool; 7] {
    let mut weekdays = [false; 7];
    for value in values {
        weekdays[value.rem_euclid(7) as usize] = true;
    }
    weekdays
}

pub fn next_scheduled_timestamp(
    task: &RedclawScheduledTaskRecord,
    now: i64,
    timezone: Option<&str>,
) -> Option<String> {
    let next_ms = match task.mode.as_str() {
        "interval" => now + task.interval_minutes.unwrap_or(60).max(1) * 60_000,
        "daily" => {
            let (hour, minute) = parse_time_parts(task.time.as_deref())?;
            next_daily_timestamp_in_timezone(hour, minute, now, timezone).ok()?
        }
        "weekly" => {
            let (hour, minute) = parse_time_parts(task.time.as_deref())?;
            let weekdays = task.weekdays.clone().unwrap_or_else(|| vec![1]);
            next_weekly_timestamp_in_timezone(hour, minute, weekday_flags(&weekdays), now, timezone)
                .ok()?
        }
        "once" => {
            let run_at = parse_millis_string(task.run_at.as_deref())?;
            if run_at > now {
                run_at
            } else {
                return None;
            }
        }
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
    let mut payload = existing
        .and_then(|item| item.payload.as_object().cloned())
        .unwrap_or_default();
    payload.insert("prompt".to_string(), json!(task.prompt));
    payload.insert("intervalMinutes".to_string(), json!(task.interval_minutes));
    payload.insert("time".to_string(), json!(task.time));
    payload.insert("weekdays".to_string(), json!(task.weekdays));
    payload.insert("runAt".to_string(), json!(task.run_at));
    payload.insert("lastRunAt".to_string(), json!(task.last_run_at));
    payload.insert("lastResult".to_string(), json!(task.last_result));
    payload.insert("lastError".to_string(), json!(task.last_error));
    payload
        .entry("actionType".to_string())
        .or_insert_with(|| json!("redclaw_prompt"));
    payload
        .entry("taskContractVersion".to_string())
        .or_insert_with(|| json!("task-contract/v1"));
    payload
        .entry("policyDecision".to_string())
        .or_insert_with(|| json!("allow"));
    RedclawJobDefinitionRecord {
        id: existing
            .map(|item| item.id.clone())
            .unwrap_or_else(|| legacy_redclaw_job_definition_id("scheduled", &task.id)),
        source_kind: Some("scheduled".to_string()),
        source_task_id: Some(task.id.clone()),
        kind: "scheduled".to_string(),
        title: task.name.clone(),
        enabled: task.enabled,
        owner_context_id: None,
        runtime_mode: "redclaw".to_string(),
        trigger_kind: task.mode.clone(),
        progression_kind: "single_run".to_string(),
        payload: Value::Object(payload),
        next_due_at: task.next_run_at.clone(),
        last_enqueued_at: existing.and_then(|item| item.last_enqueued_at.clone()),
        definition_fingerprint: existing
            .and_then(|item| item.definition_fingerprint.clone())
            .or_else(|| {
                Some(fingerprint_for_definition_payload(
                    "scheduled",
                    &task.name,
                    "manual:redclaw",
                    task.mode.as_str(),
                    &json!({
                        "prompt": task.prompt,
                        "intervalMinutes": task.interval_minutes,
                        "time": task.time,
                        "weekdays": task.weekdays,
                        "runAt": task.run_at,
                    }),
                ))
            }),
        task_contract_version: existing
            .and_then(|item| item.task_contract_version.clone())
            .or_else(|| Some("task-contract/v1".to_string())),
        agent_intent_ref: existing.and_then(|item| item.agent_intent_ref.clone()),
        policy_signature: existing
            .and_then(|item| item.policy_signature.clone())
            .or_else(|| Some("legacy-ui-direct".to_string())),
        owner_scope: existing
            .and_then(|item| item.owner_scope.clone())
            .or_else(|| Some("manual:redclaw".to_string())),
        created_by: existing
            .and_then(|item| item.created_by.clone())
            .or_else(|| Some("redclaw-panel".to_string())),
        creator_mode: existing
            .and_then(|item| item.creator_mode.clone())
            .or_else(|| Some("ui-manual".to_string())),
        requires_confirmation: existing
            .map(|item| item.requires_confirmation)
            .unwrap_or(false),
        draft_id: existing.and_then(|item| item.draft_id.clone()),
        timezone: existing
            .and_then(|item| item.timezone.clone())
            .or_else(|| Some("local".to_string())),
        missed_run_policy: existing
            .and_then(|item| item.missed_run_policy.clone())
            .or_else(|| Some("single".to_string())),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
    }
}

fn build_long_cycle_job_definition(
    task: &RedclawLongCycleTaskRecord,
    existing: Option<&RedclawJobDefinitionRecord>,
) -> RedclawJobDefinitionRecord {
    let mut payload = existing
        .and_then(|item| item.payload.as_object().cloned())
        .unwrap_or_default();
    payload.insert("objective".to_string(), json!(task.objective));
    payload.insert("stepPrompt".to_string(), json!(task.step_prompt));
    payload.insert("intervalMinutes".to_string(), json!(task.interval_minutes));
    payload.insert("totalRounds".to_string(), json!(task.total_rounds));
    payload.insert("completedRounds".to_string(), json!(task.completed_rounds));
    payload.insert("status".to_string(), json!(task.status));
    payload.insert("lastRunAt".to_string(), json!(task.last_run_at));
    payload.insert("lastResult".to_string(), json!(task.last_result));
    payload.insert("lastError".to_string(), json!(task.last_error));
    payload
        .entry("actionType".to_string())
        .or_insert_with(|| json!("long_cycle"));
    payload
        .entry("taskContractVersion".to_string())
        .or_insert_with(|| json!("task-contract/v1"));
    payload
        .entry("policyDecision".to_string())
        .or_insert_with(|| json!("allow"));
    RedclawJobDefinitionRecord {
        id: existing
            .map(|item| item.id.clone())
            .unwrap_or_else(|| legacy_redclaw_job_definition_id("long-cycle", &task.id)),
        source_kind: Some("long_cycle".to_string()),
        source_task_id: Some(task.id.clone()),
        kind: "long_cycle".to_string(),
        title: task.name.clone(),
        enabled: task.enabled,
        owner_context_id: None,
        runtime_mode: "redclaw".to_string(),
        trigger_kind: "interval".to_string(),
        progression_kind: "multi_round".to_string(),
        payload: Value::Object(payload),
        next_due_at: task.next_run_at.clone(),
        last_enqueued_at: existing.and_then(|item| item.last_enqueued_at.clone()),
        definition_fingerprint: existing
            .and_then(|item| item.definition_fingerprint.clone())
            .or_else(|| {
                Some(fingerprint_for_definition_payload(
                    "long_cycle",
                    &task.name,
                    "manual:redclaw",
                    "interval",
                    &json!({
                        "objective": task.objective,
                        "stepPrompt": task.step_prompt,
                        "intervalMinutes": task.interval_minutes,
                        "totalRounds": task.total_rounds,
                    }),
                ))
            }),
        task_contract_version: existing
            .and_then(|item| item.task_contract_version.clone())
            .or_else(|| Some("task-contract/v1".to_string())),
        agent_intent_ref: existing.and_then(|item| item.agent_intent_ref.clone()),
        policy_signature: existing
            .and_then(|item| item.policy_signature.clone())
            .or_else(|| Some("legacy-ui-direct".to_string())),
        owner_scope: existing
            .and_then(|item| item.owner_scope.clone())
            .or_else(|| Some("manual:redclaw".to_string())),
        created_by: existing
            .and_then(|item| item.created_by.clone())
            .or_else(|| Some("redclaw-panel".to_string())),
        creator_mode: existing
            .and_then(|item| item.creator_mode.clone())
            .or_else(|| Some("ui-manual".to_string())),
        requires_confirmation: existing
            .map(|item| item.requires_confirmation)
            .unwrap_or(false),
        draft_id: existing.and_then(|item| item.draft_id.clone()),
        timezone: existing
            .and_then(|item| item.timezone.clone())
            .or_else(|| Some("local".to_string())),
        missed_run_policy: existing
            .and_then(|item| item.missed_run_policy.clone())
            .or_else(|| Some("single".to_string())),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
    }
}

pub fn sync_redclaw_job_definitions(store: &mut AppStore) {
    let (existing, scheduled_tasks, long_cycle_tasks) =
        redclaw_store::job_definition_sync_snapshot(store);
    let mut next = existing
        .iter()
        .filter(|item| item.source_task_id.is_none())
        .cloned()
        .collect::<Vec<_>>();

    for task in &scheduled_tasks {
        let existing = existing.iter().find(|item| {
            item.source_kind.as_deref() == Some("scheduled")
                && item.source_task_id.as_deref() == Some(task.id.as_str())
        });
        next.push(build_scheduled_job_definition(task, existing));
    }

    for task in &long_cycle_tasks {
        let existing = existing.iter().find(|item| {
            item.source_kind.as_deref() == Some("long_cycle")
                && item.source_task_id.as_deref() == Some(task.id.as_str())
        });
        next.push(build_long_cycle_job_definition(task, existing));
    }

    next.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    redclaw_store::replace_job_definitions(store, next);
}

pub fn clear_definition_cooldown(definition: &mut RedclawJobDefinitionRecord) {
    if let Some(object) = definition.payload.as_object_mut() {
        object.remove("cooldown");
    }
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

pub fn derived_background_task_summaries(store: &AppStore) -> Vec<Value> {
    derived_background_tasks_internal(store, false)
}

pub fn derived_background_tasks(store: &AppStore) -> Vec<Value> {
    derived_background_tasks_internal(store, true)
}

fn derived_background_tasks_internal(store: &AppStore, include_turns: bool) -> Vec<Value> {
    let mut tasks = Vec::new();
    let executions = redclaw_store::list_job_executions(store);
    let definitions = redclaw_store::list_job_definitions(store);
    let latest_execution_by_definition: std::collections::HashMap<
        String,
        &crate::RedclawJobExecutionRecord,
    > = executions
        .iter()
        .fold(std::collections::HashMap::new(), |mut acc, execution| {
            if execution.archived_at.is_some() {
                return acc;
            }
            let replace = acc
                .get(&execution.definition_id)
                .map(|current| execution.updated_at > current.updated_at)
                .unwrap_or(true);
            if replace {
                acc.insert(execution.definition_id.clone(), execution);
            }
            acc
        });

    for definition in &definitions {
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
                .map(|value| execution.map(|item| item.id.clone()).unwrap_or(value))
                .unwrap_or_else(|| execution.map(|item| item.id.clone()).unwrap_or_else(|| definition.id.clone())),
            "definitionId": definition.id,
            "executionId": execution.map(|item| item.id.clone()),
            "sourceTaskId": definition.source_task_id,
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
            "deadLetteredAt": execution.and_then(|item| item.dead_lettered_at.clone()),
            "archivedAt": execution.and_then(|item| item.archived_at.clone()),
            "rollbackState": "not_required",
            "createdAt": execution
                .map(|item| item.created_at.clone())
                .unwrap_or_else(|| definition.created_at.clone()),
            "updatedAt": execution
                .map(|item| item.updated_at.clone())
                .unwrap_or_else(|| definition.updated_at.clone()),
            "completedAt": execution.and_then(|item| item.completed_at.clone()),
            "turns": if include_turns {
                execution.map(|item| item.checkpoints.clone()).unwrap_or_default()
            } else {
                Vec::<Value>::new()
            }
        }));
    }

    for execution in &executions {
        if execution.archived_at.is_some() {
            continue;
        }
        if latest_execution_by_definition
            .get(&execution.definition_id)
            .map(|item| item.id != execution.id)
            .unwrap_or(false)
        {
            continue;
        }
        if definitions
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
            "sourceTaskId": execution
                .input_snapshot
                .as_ref()
                .and_then(|value| value.get("sourceTaskId"))
                .and_then(Value::as_str),
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
            "deadLetteredAt": execution.dead_lettered_at,
            "archivedAt": execution.archived_at,
            "rollbackState": "not_required",
            "createdAt": execution.created_at,
            "updatedAt": execution.updated_at,
            "completedAt": execution.completed_at,
            "turns": if include_turns {
                execution.checkpoints.clone()
            } else {
                Vec::<Value>::new()
            }
        }));
    }
    for task in runtime_task_store::list_tasks(store) {
        if task.task_type == "media-followup" {
            continue;
        }
        tasks.push(runtime_task_background_projection(&task, include_turns));
    }
    tasks.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(Value::as_str)
            .cmp(&a.get("updatedAt").and_then(Value::as_str))
    });
    tasks
}

pub(crate) fn runtime_task_background_projection(
    task: &RuntimeTaskRecord,
    include_turns: bool,
) -> Value {
    let summary = task
        .goal
        .clone()
        .or_else(|| {
            task.metadata
                .as_ref()
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "后台任务".to_string());
    let latest_text = task
        .metadata
        .as_ref()
        .and_then(|value| value.get("latestText"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| task.checkpoints.last().map(|item| item.summary.clone()));
    json!({
        "id": task.id,
        "definitionId": Value::Null,
        "executionId": task.id,
        "sourceTaskId": task.id,
        "kind": "headless-runtime",
        "title": task
            .metadata
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("图片结果回传任务"),
        "status": runtime_task_background_status(&task.status),
        "phase": runtime_task_background_phase(&task.status),
        "sessionId": task.owner_session_id,
        "contextId": Value::Null,
        "error": task.last_error,
        "summary": summary,
        "latestText": latest_text,
        "attemptCount": 0,
        "workerState": runtime_task_worker_state(&task.status),
        "workerMode": "main-process",
        "workerLastHeartbeatAt": format_timestamp_rfc3339_from_ms(task.updated_at),
        "cancelReason": Value::Null,
        "deadLetteredAt": Value::Null,
        "archivedAt": Value::Null,
        "rollbackState": "not_required",
        "createdAt": format_timestamp_rfc3339_from_ms(task.created_at)
            .unwrap_or_else(|| task.created_at.to_string()),
        "updatedAt": format_timestamp_rfc3339_from_ms(task.updated_at)
            .unwrap_or_else(|| task.updated_at.to_string()),
        "completedAt": task.completed_at.and_then(format_timestamp_rfc3339_from_ms),
        "turns": if include_turns {
            runtime_task_background_turns(&task.checkpoints)
        } else {
            Vec::<Value>::new()
        },
    })
}

fn runtime_task_background_status(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "running",
    }
}

fn runtime_task_background_phase(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "cancelled",
        "pending" => "queued",
        _ => "updating",
    }
}

fn runtime_task_worker_state(status: &str) -> &'static str {
    match status {
        "completed" => "succeeded",
        "failed" => "failed",
        "cancelled" => "cancelled",
        "pending" => "queued",
        _ => "running",
    }
}

fn runtime_task_background_turns(checkpoints: &[RuntimeCheckpointRecord]) -> Vec<Value> {
    checkpoints
        .iter()
        .rev()
        .take(12)
        .map(|checkpoint| {
            json!({
                "id": checkpoint.id,
                "at": format_timestamp_rfc3339_from_ms(checkpoint.created_at)
                    .unwrap_or_else(|| checkpoint.created_at.to_string()),
                "text": checkpoint.summary,
                "source": "system",
            })
        })
        .collect::<Vec<_>>()
}

pub fn run_redclaw_scheduler(app: AppHandle, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(1500));
        while !stop.load(Ordering::Relaxed) {
            interval.tick().await;
            let app_handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let state = app_handle.state::<AppState>();
                let now = crate::now_i64();
                let mut should_run_maintenance = false;
                let mut enqueued_execution_ids = Vec::new();

                if crate::persistence::with_store_mut(&state, |store| {
                    sync_redclaw_job_definitions(store);
                    if redclaw_store::runner_is_ticking(store) {
                        recover_stale_job_executions(store, now);
                        requeue_retrying_job_executions(store, now);
                        enqueued_execution_ids = enqueue_due_job_executions(store, now);
                        let next_maintenance_at =
                            redclaw_store::mark_scheduler_tick(store, now).flatten();
                        should_run_maintenance =
                            parse_millis_string(next_maintenance_at.as_deref()).unwrap_or(0) <= now;
                    }
                    Ok(())
                })
                .is_ok()
                {
                    emit_scheduler_snapshot(&app_handle, &state);
                    for execution_id in enqueued_execution_ids {
                        emit_runtime_task_checkpoint_saved(
                            &app_handle,
                            Some(&execution_id),
                            None,
                            "task.enqueued",
                            "Scheduled task enqueued",
                            Some(json!({
                                "executionId": execution_id,
                                "trigger": "scheduler",
                            })),
                        );
                    }
                }

                if should_run_maintenance {
                    let _ = crate::memory::run_memory_maintenance_with_reason(&state, "periodic");
                    if let Ok(store) = state.store.lock() {
                        let _ = app_handle
                            .emit("redclaw:runner-status", redclaw_store::state_value(&store));
                    }
                }
            })
            .await;
        }
    })
}

pub fn run_redclaw_job_runner(app: AppHandle, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        while !stop.load(Ordering::Relaxed) {
            interval.tick().await;
            let app_handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let state = app_handle.state::<AppState>();
                let execution_limit = crate::persistence::with_store(&state, |store| {
                    Ok(redclaw_store::scheduler_execution_limit(&store))
                })
                .unwrap_or(0);

                if execution_limit > 0 {
                    let _ = run_due_job_executions(&app_handle, &state, execution_limit);
                }
            })
            .await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeCheckpointRecord, RuntimeTaskRecord};

    #[test]
    fn derived_background_tasks_excludes_media_followup_runtime_tasks() {
        let mut store = AppStore::default();
        runtime_task_store::push_task(
            &mut store,
            RuntimeTaskRecord {
                id: "task-1".to_string(),
                task_type: "media-followup".to_string(),
                status: "running".to_string(),
                runtime_mode: "default".to_string(),
                owner_session_id: Some("session-1".to_string()),
                goal: Some("等待图片完成".to_string()),
                checkpoints: vec![RuntimeCheckpointRecord::new(
                    "media-followup.started",
                    "execute_tools",
                    "waiting",
                    None,
                )],
                metadata: Some(json!({
                    "title": "图片结果回传 · 6 张",
                    "latestText": "等待图片生成完成",
                })),
                created_at: 1,
                updated_at: 2,
                ..RuntimeTaskRecord::default()
            },
        );

        let tasks = derived_background_tasks(&store);

        assert!(!tasks
            .iter()
            .any(|item| { item.get("id").and_then(Value::as_str) == Some("task-1") }));
    }
}
