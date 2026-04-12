use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use serde_json::{json, Value};

use crate::commands::redclaw_runtime::execute_redclaw_run;
use crate::persistence::with_store_mut;
use crate::runtime::{RedclawJobDefinitionRecord, RedclawJobExecutionRecord};
use crate::scheduler::dead_letter::mark_dead_lettered;
use crate::scheduler::heartbeat::start_execution_heartbeat;
use crate::scheduler::lease::lease_execution;
use crate::scheduler::retry::{
    retry_delay_ms, should_dead_letter, DEFAULT_HEARTBEAT_TIMEOUT_MS,
};
use crate::{
    make_id, now_i64, now_iso, redclaw_state_value, AppState, AppStore,
};

use super::{next_long_cycle_timestamp, next_scheduled_timestamp, parse_millis_string};

#[derive(Debug, Clone)]
pub struct PreparedJobExecution {
    pub execution_id: String,
    pub definition_id: String,
    pub source_kind: Option<String>,
    pub source_task_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub project_id: Option<String>,
    pub prompt: String,
    pub source_label: String,
}

fn background_status_from_execution_status(status: &str) -> &'static str {
    match status {
        "succeeded" | "completed" => "completed",
        "failed" | "dead_lettered" => "failed",
        "cancelled" => "cancelled",
        _ => "running",
    }
}

pub fn background_status(status: &str) -> &'static str {
    background_status_from_execution_status(status)
}

pub fn is_active_execution_status(status: &str) -> bool {
    matches!(status, "queued" | "leased" | "running" | "retrying")
}

pub fn is_terminal_execution_status(status: &str) -> bool {
    matches!(status, "succeeded" | "completed" | "failed" | "cancelled" | "dead_lettered")
}

fn is_valid_status_transition(from: &str, to: &str) -> bool {
    from == to
        || matches!(
            (from, to),
            ("queued", "leased")
                | ("queued", "cancelled")
                | ("leased", "running")
                | ("leased", "cancelled")
                | ("running", "succeeded")
                | ("running", "failed")
                | ("running", "cancelled")
                | ("failed", "retrying")
                | ("failed", "dead_lettered")
                | ("retrying", "queued")
                | ("retrying", "cancelled")
                | ("cancelled", "queued")
        )
}

fn transition_execution_status(
    execution: &mut RedclawJobExecutionRecord,
    next_status: &str,
    now: &str,
) -> Result<(), String> {
    if !is_valid_status_transition(&execution.status, next_status) {
        return Err(format!(
            "invalid execution transition: {} -> {}",
            execution.status, next_status
        ));
    }
    execution.status = next_status.to_string();
    execution.updated_at = now.to_string();
    if matches!(next_status, "succeeded" | "cancelled" | "dead_lettered") {
        execution.completed_at = Some(now.to_string());
    }
    Ok(())
}

fn append_execution_turn(
    execution: &mut RedclawJobExecutionRecord,
    at: &str,
    source: &str,
    text: impl Into<String>,
) {
    execution.checkpoints.push(json!({
        "id": make_id("bg-turn"),
        "at": at,
        "text": text.into(),
        "source": source,
    }));
}

fn active_execution_exists(store: &AppStore, definition_id: &str) -> bool {
    store
        .redclaw_job_executions
        .iter()
        .any(|item| item.definition_id == definition_id && is_active_execution_status(&item.status))
}

fn definition_prompt(definition: &RedclawJobDefinitionRecord) -> String {
    match definition.source_kind.as_deref() {
        Some("scheduled") => definition
            .payload
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some("long_cycle") => {
            let objective = definition
                .payload
                .get("objective")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let step_prompt = definition
                .payload
                .get("stepPrompt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("目标：{objective}\n\n当前轮执行指令：{step_prompt}")
        }
        _ => definition
            .payload
            .get("prompt")
            .or_else(|| definition.payload.get("objective"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn definition_source_label(definition: &RedclawJobDefinitionRecord) -> &'static str {
    match definition.source_kind.as_deref() {
        Some("scheduled") => "scheduled-task",
        Some("long_cycle") => "long-cycle-task",
        _ => "scheduler-execution",
    }
}

fn next_definition_due_at(store: &AppStore, definition: &RedclawJobDefinitionRecord, now: i64) -> Option<String> {
    match definition.source_kind.as_deref() {
        Some("scheduled") => store
            .redclaw_state
            .scheduled_tasks
            .iter()
            .find(|task| definition.source_task_id.as_deref() == Some(task.id.as_str()))
            .and_then(|task| next_scheduled_timestamp(task, now)),
        Some("long_cycle") => store
            .redclaw_state
            .long_cycle_tasks
            .iter()
            .find(|task| definition.source_task_id.as_deref() == Some(task.id.as_str()))
            .and_then(|task| {
                if task.completed_rounds >= task.total_rounds {
                    None
                } else {
                    next_long_cycle_timestamp(task, now)
                }
            }),
        _ => None,
    }
}

fn update_source_task_after_enqueue(
    store: &mut AppStore,
    definition: &RedclawJobDefinitionRecord,
    next_due_at: Option<String>,
    now: &str,
) {
    match definition.source_kind.as_deref() {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.next_run_at = next_due_at;
                task.updated_at = now.to_string();
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| definition.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.next_run_at = next_due_at;
                task.updated_at = now.to_string();
            }
        }
        _ => {}
    }
}

fn create_execution_record(
    definition: &RedclawJobDefinitionRecord,
    now: &str,
    input_snapshot: Option<Value>,
) -> RedclawJobExecutionRecord {
    let mut execution = RedclawJobExecutionRecord {
        id: make_id("jobexec"),
        definition_id: definition.id.clone(),
        status: "queued".to_string(),
        attempt_count: 0,
        worker_id: None,
        worker_mode: "main-process".to_string(),
        session_id: None,
        runtime_task_id: None,
        started_at: None,
        last_heartbeat_at: None,
        heartbeat_timeout_ms: Some(DEFAULT_HEARTBEAT_TIMEOUT_MS),
        completed_at: None,
        last_error: None,
        input_snapshot,
        output_summary: None,
        artifacts: Vec::new(),
        checkpoints: Vec::new(),
        retry_not_before_at: None,
        cancel_requested_at: None,
        cancel_reason: None,
        dead_lettered_at: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    };
    append_execution_turn(&mut execution, now, "system", "Execution queued");
    execution
}

pub fn enqueue_due_job_executions(store: &mut AppStore, now: i64) -> Vec<String> {
    let now_iso = now_iso();
    let mut enqueued = Vec::new();
    let definitions = store.redclaw_job_definitions.clone();
    for definition in definitions {
        if !definition.enabled {
            continue;
        }
        if parse_millis_string(definition.next_due_at.as_deref()).unwrap_or(i64::MAX) > now {
            continue;
        }
        if active_execution_exists(store, &definition.id) {
            continue;
        }
        let next_due_at = next_definition_due_at(store, &definition, now);
        let execution = create_execution_record(
            &definition,
            &now_iso,
            Some(json!({
                "trigger": "scheduler",
                "definitionId": definition.id,
                "prompt": definition_prompt(&definition),
                "sourceKind": definition.source_kind,
                "sourceTaskId": definition.source_task_id,
            })),
        );
        let execution_id = execution.id.clone();
        if let Some(current_definition) = store
            .redclaw_job_definitions
            .iter_mut()
            .find(|item| item.id == definition.id)
        {
            current_definition.last_enqueued_at = Some(now_iso.clone());
            current_definition.next_due_at = next_due_at.clone();
            current_definition.updated_at = now_iso.clone();
        }
        update_source_task_after_enqueue(store, &definition, next_due_at, &now_iso);
        store.redclaw_job_executions.push(execution);
        enqueued.push(execution_id);
    }
    enqueued
}

pub fn requeue_retrying_job_executions(store: &mut AppStore, now: i64) {
    let now_iso = now_iso();
    for execution in store.redclaw_job_executions.iter_mut() {
        if execution.status != "retrying" {
            continue;
        }
        if parse_millis_string(execution.retry_not_before_at.as_deref()).unwrap_or(i64::MAX) > now {
            continue;
        }
        if transition_execution_status(execution, "queued", &now_iso).is_ok() {
            execution.retry_not_before_at = None;
            append_execution_turn(&mut *execution, &now_iso, "system", "Retry re-queued");
        }
    }
}

pub fn recover_stale_job_executions(store: &mut AppStore, now: i64) {
    let now_iso = now_iso();
    for execution in store.redclaw_job_executions.iter_mut() {
        if !matches!(execution.status.as_str(), "leased" | "running") {
            continue;
        }
        let timeout_ms = execution
            .heartbeat_timeout_ms
            .unwrap_or(DEFAULT_HEARTBEAT_TIMEOUT_MS);
        let last_heartbeat_at = parse_millis_string(execution.last_heartbeat_at.as_deref())
            .or_else(|| parse_millis_string(Some(execution.updated_at.as_str())))
            .unwrap_or(now);
        if now - last_heartbeat_at <= timeout_ms {
            continue;
        }
        let reason = "Execution heartbeat expired".to_string();
        execution.last_error = Some(reason.clone());
        if should_dead_letter(execution.attempt_count) {
            mark_dead_lettered(execution, Some(reason.clone()), &now_iso);
            append_execution_turn(&mut *execution, &now_iso, "system", reason);
        } else {
            let _ = transition_execution_status(execution, "failed", &now_iso);
            let _ = transition_execution_status(execution, "retrying", &now_iso);
            execution.retry_not_before_at =
                Some((now + retry_delay_ms(execution.attempt_count)).to_string());
            execution.completed_at = None;
            append_execution_turn(&mut *execution, &now_iso, "system", "Heartbeat timeout; retry scheduled");
        }
    }
}

pub fn enqueue_manual_job_execution_for_source(
    store: &mut AppStore,
    source_kind: &str,
    source_task_id: &str,
    trigger: &str,
) -> Result<String, String> {
    let now_iso = now_iso();
    let definition = store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.source_kind.as_deref() == Some(source_kind)
                && item.source_task_id.as_deref() == Some(source_task_id)
        })
        .cloned()
        .ok_or_else(|| "任务定义不存在".to_string())?;
    if active_execution_exists(store, &definition.id) {
        return Err("任务已有执行实例".to_string());
    }
    let execution = create_execution_record(
        &definition,
        &now_iso,
        Some(json!({
            "trigger": trigger,
            "definitionId": definition.id,
            "prompt": definition_prompt(&definition),
            "sourceKind": definition.source_kind,
            "sourceTaskId": definition.source_task_id,
        })),
    );
    let execution_id = execution.id.clone();
    store.redclaw_job_executions.push(execution);
    if let Some(current_definition) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == definition.id)
    {
        current_definition.last_enqueued_at = Some(now_iso.clone());
        current_definition.updated_at = now_iso;
    }
    Ok(execution_id)
}

fn prepare_execution(store: &AppStore, execution: &RedclawJobExecutionRecord) -> Result<PreparedJobExecution, String> {
    let definition = store
        .redclaw_job_definitions
        .iter()
        .find(|item| item.id == execution.definition_id)
        .cloned()
        .ok_or_else(|| "任务定义不存在".to_string())?;
    Ok(PreparedJobExecution {
        execution_id: execution.id.clone(),
        definition_id: definition.id.clone(),
        source_kind: definition.source_kind.clone(),
        source_task_id: definition.source_task_id.clone(),
        kind: definition.kind.clone(),
        title: definition.title.clone(),
        project_id: definition.owner_context_id.clone(),
        prompt: definition_prompt(&definition),
        source_label: definition_source_label(&definition).to_string(),
    })
}

fn claim_execution(
    store: &mut AppStore,
    now: i64,
    preferred_execution_id: Option<&str>,
) -> Result<Option<PreparedJobExecution>, String> {
    let now_iso = now_iso();
    let candidate_index = if let Some(execution_id) = preferred_execution_id {
        store.redclaw_job_executions.iter().position(|item| {
            item.id == execution_id
                && matches!(item.status.as_str(), "queued" | "retrying" | "cancelled")
                && parse_millis_string(item.retry_not_before_at.as_deref()).unwrap_or(0) <= now
        })
    } else {
        store.redclaw_job_executions.iter().position(|item| {
            item.status == "queued"
                && parse_millis_string(item.retry_not_before_at.as_deref()).unwrap_or(0) <= now
        })
    };
    let Some(index) = candidate_index else {
        return Ok(None);
    };

    let definition_id = store.redclaw_job_executions[index].definition_id.clone();
    if preferred_execution_id.is_none()
        && store
            .redclaw_job_executions
            .iter()
            .any(|item| item.definition_id == definition_id && matches!(item.status.as_str(), "leased" | "running"))
    {
        return Ok(None);
    }

    {
        let execution = &mut store.redclaw_job_executions[index];
        if execution.status == "cancelled" {
            execution.completed_at = None;
            transition_execution_status(execution, "queued", &now_iso)?;
        }
        lease_execution(
            execution,
            "redclaw-runner",
            "main-process",
            DEFAULT_HEARTBEAT_TIMEOUT_MS,
            &now_iso,
        );
        execution.attempt_count += 1;
        execution.retry_not_before_at = None;
        append_execution_turn(&mut *execution, &now_iso, "system", "Execution leased");
    }

    let prepared = prepare_execution(store, &store.redclaw_job_executions[index])?;
    Ok(Some(prepared))
}

fn mark_execution_running(store: &mut AppStore, execution_id: &str) -> Result<(), String> {
    let now_iso = now_iso();
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| item.id == execution_id)
        .ok_or_else(|| "执行实例不存在".to_string())?;
    transition_execution_status(execution, "running", &now_iso)?;
    execution.started_at.get_or_insert_with(|| now_iso.clone());
    execution.last_heartbeat_at = Some(now_iso.clone());
    append_execution_turn(execution, &now_iso, "system", "Execution started");
    Ok(())
}

fn mark_execution_cancelled(store: &mut AppStore, execution_id: &str, reason: &str) -> Result<(), String> {
    let now_iso = now_iso();
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| item.id == execution_id)
        .ok_or_else(|| "执行实例不存在".to_string())?;
    if is_terminal_execution_status(&execution.status) {
        return Ok(());
    }
    transition_execution_status(execution, "cancelled", &now_iso)?;
    execution.cancel_requested_at = Some(now_iso.clone());
    execution.cancel_reason = Some(reason.to_string());
    execution.last_error = Some(reason.to_string());
    append_execution_turn(execution, &now_iso, "system", reason.to_string());
    Ok(())
}

fn mark_execution_succeeded(
    store: &mut AppStore,
    prepared: &PreparedJobExecution,
    result: &Value,
) -> Result<(), String> {
    let now_iso = now_iso();
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| item.id == prepared.execution_id)
        .ok_or_else(|| "执行实例不存在".to_string())?;
    execution.last_heartbeat_at = Some(now_iso.clone());
    execution.artifacts = result
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    execution.session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    execution.output_summary = result
        .get("response")
        .and_then(Value::as_str)
        .map(|value| value.chars().take(280).collect());
    if execution.status == "cancelled" {
        append_execution_turn(execution, &now_iso, "system", "Execution finished after cancellation request");
        return Ok(());
    }
    transition_execution_status(execution, "succeeded", &now_iso)?;
    append_execution_turn(
        execution,
        &now_iso,
        "response",
        execution.output_summary.clone().unwrap_or_else(|| "Execution completed".to_string()),
    );

    match prepared.source_kind.as_deref() {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| prepared.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.last_run_at = Some(now_iso.clone());
                task.last_result = Some("success".to_string());
                task.last_error = None;
                task.updated_at = now_iso.clone();
                if task.mode == "once" {
                    task.enabled = false;
                    task.next_run_at = None;
                }
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| prepared.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.completed_rounds += 1;
                task.last_run_at = Some(now_iso.clone());
                task.last_result = Some("success".to_string());
                task.last_error = None;
                task.updated_at = now_iso.clone();
                task.status = if task.completed_rounds >= task.total_rounds {
                    task.enabled = false;
                    task.next_run_at = None;
                    "completed".to_string()
                } else {
                    "running".to_string()
                };
            }
        }
        _ => {}
    }
    Ok(())
}

fn mark_execution_failed(
    store: &mut AppStore,
    prepared: &PreparedJobExecution,
    error: &str,
) -> Result<(), String> {
    let now = now_i64();
    let now_iso = now_iso();
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| item.id == prepared.execution_id)
        .ok_or_else(|| "执行实例不存在".to_string())?;
    execution.last_heartbeat_at = Some(now_iso.clone());
    execution.last_error = Some(error.to_string());
    let _ = transition_execution_status(execution, "failed", &now_iso);
    append_execution_turn(execution, &now_iso, "system", error.to_string());
    if should_dead_letter(execution.attempt_count) {
        mark_dead_lettered(execution, Some(error.to_string()), &now_iso);
        append_execution_turn(execution, &now_iso, "system", "Execution moved to dead-letter");
    } else {
        transition_execution_status(execution, "retrying", &now_iso)?;
        execution.completed_at = None;
        execution.retry_not_before_at = Some((now + retry_delay_ms(execution.attempt_count)).to_string());
        append_execution_turn(execution, &now_iso, "system", "Retry scheduled");
    }

    match prepared.source_kind.as_deref() {
        Some("scheduled") => {
            if let Some(task) = store
                .redclaw_state
                .scheduled_tasks
                .iter_mut()
                .find(|item| prepared.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.last_error = Some(error.to_string());
                task.last_result = Some("failed".to_string());
                task.updated_at = now_iso.clone();
            }
        }
        Some("long_cycle") => {
            if let Some(task) = store
                .redclaw_state
                .long_cycle_tasks
                .iter_mut()
                .find(|item| prepared.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.last_error = Some(error.to_string());
                task.last_result = Some("failed".to_string());
                task.status = "failed".to_string();
                task.updated_at = now_iso.clone();
            }
        }
        _ => {}
    }

    Ok(())
}

pub fn emit_scheduler_snapshot(app: &AppHandle, state: &State<'_, AppState>) {
    if let Ok(store) = state.store.lock() {
        let _ = app.emit("redclaw:runner-status", redclaw_state_value(&store.redclaw_state));
    }
}

pub fn run_job_queue_once(
    app: &AppHandle,
    state: &State<'_, AppState>,
    preferred_execution_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let prepared = with_store_mut(state, |store| claim_execution(store, now_i64(), preferred_execution_id))?;
    let Some(prepared) = prepared else {
        return Ok(None);
    };

    with_store_mut(state, |store| mark_execution_running(store, &prepared.execution_id))?;
    emit_scheduler_snapshot(app, state);

    let heartbeat = start_execution_heartbeat(app, prepared.execution_id.clone(), Duration::from_secs(5));
    let result = execute_redclaw_run(
        app,
        state,
        prepared.prompt.clone(),
        prepared.project_id.clone(),
        &prepared.source_label,
    );
    heartbeat.stop();

    match result {
        Ok(value) => {
            with_store_mut(state, |store| mark_execution_succeeded(store, &prepared, &value))?;
            emit_scheduler_snapshot(app, state);
            Ok(Some(json!({
                "success": true,
                "executionId": prepared.execution_id,
                "definitionId": prepared.definition_id,
                "status": "succeeded",
                "result": value,
                "backgroundStatus": background_status_from_execution_status("succeeded"),
                "title": prepared.title,
                "kind": prepared.kind,
            })))
        }
        Err(error) => {
            with_store_mut(state, |store| mark_execution_failed(store, &prepared, &error))?;
            emit_scheduler_snapshot(app, state);
            Err(error)
        }
    }
}

pub fn run_due_job_executions(
    app: &AppHandle,
    state: &State<'_, AppState>,
    limit: usize,
) -> Result<usize, String> {
    let mut processed = 0;
    while processed < limit {
        let next = run_job_queue_once(app, state, None)?;
        if next.is_none() {
            break;
        }
        processed += 1;
    }
    Ok(processed)
}

pub fn cancel_job_execution(
    store: &mut AppStore,
    task_id: &str,
    reason: &str,
) -> Option<(String, String)> {
    let now_iso = now_iso();
    if let Some(task) = store
        .redclaw_state
        .scheduled_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
    {
        let cancelled_id = task.id.clone();
        task.enabled = false;
        task.last_error = Some(reason.to_string());
        task.updated_at = now_iso.clone();
        let definition_id = store
            .redclaw_job_definitions
            .iter()
            .find(|item| {
                item.source_kind.as_deref() == Some("scheduled")
                    && item.source_task_id.as_deref() == Some(task_id)
            })
            .map(|item| item.id.clone());
        if let Some(execution_id) = definition_id.and_then(|definition_id| {
            store
                .redclaw_job_executions
                .iter()
                .filter(|item| item.definition_id == definition_id)
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                .map(|item| item.id.clone())
        }) {
            let _ = mark_execution_cancelled(store, &execution_id, reason);
        }
        return Some((cancelled_id, "scheduled-task".to_string()));
    }
    if let Some(task) = store
        .redclaw_state
        .long_cycle_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
    {
        let cancelled_id = task.id.clone();
        task.enabled = false;
        task.status = "cancelled".to_string();
        task.last_error = Some(reason.to_string());
        task.updated_at = now_iso.clone();
        let definition_id = store
            .redclaw_job_definitions
            .iter()
            .find(|item| {
                item.source_kind.as_deref() == Some("long_cycle")
                    && item.source_task_id.as_deref() == Some(task_id)
            })
            .map(|item| item.id.clone());
        if let Some(execution_id) = definition_id.and_then(|definition_id| {
            store
                .redclaw_job_executions
                .iter()
                .filter(|item| item.definition_id == definition_id)
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                .map(|item| item.id.clone())
        }) {
            let _ = mark_execution_cancelled(store, &execution_id, reason);
        }
        return Some((cancelled_id, "long-cycle".to_string()));
    }
    if let Some(execution_id) = store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == task_id || item.definition_id == task_id)
        .map(|item| item.id.clone())
    {
        let _ = mark_execution_cancelled(store, &execution_id, reason);
        return Some((execution_id, "job-execution".to_string()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_transition_matrix_rejects_invalid_edges() {
        assert!(is_valid_status_transition("queued", "leased"));
        assert!(is_valid_status_transition("running", "failed"));
        assert!(!is_valid_status_transition("queued", "succeeded"));
        assert!(!is_valid_status_transition("dead_lettered", "running"));
    }

    #[test]
    fn background_status_normalizes_runtime_states() {
        assert_eq!(background_status("queued"), "running");
        assert_eq!(background_status("succeeded"), "completed");
        assert_eq!(background_status("dead_lettered"), "failed");
    }
}
