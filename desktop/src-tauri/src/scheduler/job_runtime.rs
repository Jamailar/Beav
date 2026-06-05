use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use serde_json::{json, Value};

use crate::commands::redclaw_runtime::execute_redclaw_task_run;
use crate::events::{emit_redclaw_task_event, emit_runtime_task_checkpoint_saved};
use crate::persistence::with_store_mut;
use crate::runtime::{RedclawJobDefinitionRecord, RedclawJobExecutionRecord};
use crate::scheduler::dead_letter::mark_dead_lettered;
use crate::scheduler::heartbeat::start_execution_heartbeat;
use crate::scheduler::lease::lease_execution;
use crate::scheduler::retry::{retry_delay_ms, should_dead_letter, DEFAULT_HEARTBEAT_TIMEOUT_MS};
use crate::store::redclaw as redclaw_store;
use crate::{make_id, now_i64, now_iso, AppState, AppStore};

use super::{
    clear_definition_cooldown, next_long_cycle_timestamp, next_scheduled_timestamp,
    parse_millis_string,
};

#[derive(Debug, Clone)]
pub struct PreparedJobExecution {
    pub execution_id: String,
    pub definition_id: String,
    pub source_kind: Option<String>,
    pub source_task_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub prompt: String,
    pub source_label: String,
}

const MAX_CATCHUP_EXECUTIONS_PER_SWEEP: usize = 24;
const MAX_SCHEDULE_ADVANCE_GUARD: usize = 4096;
const COOLDOWN_FAILURE_THRESHOLD: usize = 3;

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
    matches!(
        status,
        "succeeded" | "completed" | "failed" | "cancelled" | "dead_lettered"
    )
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
    redclaw_store::active_job_execution_exists(store, definition_id)
}

fn definition_prompt(definition: &RedclawJobDefinitionRecord) -> String {
    match definition.source_kind.as_deref() {
        Some("scheduled") => {
            let prompt = definition
                .payload
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!(
                "你正在执行一个已经创建好的自动化任务，不是在创建新的定时任务。\n不要调用或请求 redclaw.task 创建/修改/确认任务；也不要解释定时任务工具是否可用。\n请直接完成本次任务，并把结果作为本次自动化执行的输出。\n\n任务指令：\n{prompt}"
            )
        }
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

fn next_definition_due_after(
    store: &AppStore,
    definition: &RedclawJobDefinitionRecord,
    after_ms: i64,
) -> Option<String> {
    match definition.source_kind.as_deref() {
        Some("scheduled") => definition
            .source_task_id
            .as_deref()
            .and_then(|task_id| redclaw_store::scheduled_task_by_id(store, task_id))
            .and_then(|task| {
                next_scheduled_timestamp(&task, after_ms, definition.timezone.as_deref())
            }),
        Some("long_cycle") => definition
            .source_task_id
            .as_deref()
            .and_then(|task_id| redclaw_store::long_cycle_task_by_id(store, task_id))
            .and_then(|task| {
                if task.completed_rounds >= task.total_rounds {
                    None
                } else {
                    next_long_cycle_timestamp(&task, after_ms)
                }
            }),
        _ => None,
    }
}

fn normalize_missed_run_policy(value: Option<&str>) -> &'static str {
    match value.unwrap_or("single").trim().to_lowercase().as_str() {
        "drop" => "drop",
        "catchup" => "catchup",
        _ => "single",
    }
}

fn next_future_due_at(
    store: &AppStore,
    definition: &RedclawJobDefinitionRecord,
    from_ms: i64,
    now: i64,
) -> Option<String> {
    let mut cursor = from_ms;
    for _ in 0..MAX_SCHEDULE_ADVANCE_GUARD {
        let next_due_at = next_definition_due_after(store, definition, cursor)?;
        let next_ms = parse_millis_string(Some(next_due_at.as_str()))?;
        if next_ms > now {
            return Some(next_due_at);
        }
        cursor = next_ms;
    }
    None
}

fn due_execution_plan(
    store: &AppStore,
    definition: &RedclawJobDefinitionRecord,
    now: i64,
) -> (Vec<String>, Option<String>) {
    let Some(first_due_at) = definition.next_due_at.clone() else {
        return (Vec::new(), None);
    };
    let Some(first_due_ms) = parse_millis_string(Some(first_due_at.as_str())) else {
        return (Vec::new(), None);
    };
    match normalize_missed_run_policy(definition.missed_run_policy.as_deref()) {
        "drop" => (
            Vec::new(),
            next_future_due_at(store, definition, first_due_ms, now),
        ),
        "catchup" => {
            let mut anchors = vec![first_due_at];
            let mut cursor = first_due_ms;
            let mut next_due_at = next_definition_due_after(store, definition, cursor);
            for _ in 0..MAX_CATCHUP_EXECUTIONS_PER_SWEEP {
                let Some(candidate) = next_due_at.clone() else {
                    break;
                };
                let Some(candidate_ms) = parse_millis_string(Some(candidate.as_str())) else {
                    next_due_at = None;
                    break;
                };
                if candidate_ms > now {
                    break;
                }
                anchors.push(candidate);
                cursor = candidate_ms;
                next_due_at = next_definition_due_after(store, definition, cursor);
            }
            (anchors, next_due_at)
        }
        _ => (
            vec![first_due_at],
            next_future_due_at(store, definition, first_due_ms, now),
        ),
    }
}

fn update_source_task_after_enqueue(
    store: &mut AppStore,
    definition: &RedclawJobDefinitionRecord,
    next_due_at: Option<String>,
    now: &str,
) {
    redclaw_store::update_source_task_next_run(
        store,
        definition.source_kind.as_deref(),
        definition.source_task_id.as_deref(),
        next_due_at,
        now,
    );
}

fn create_execution_record(
    definition: &RedclawJobDefinitionRecord,
    now: &str,
    scheduled_for_at: Option<String>,
    trigger: Option<String>,
    input_snapshot: Option<Value>,
) -> RedclawJobExecutionRecord {
    let scheduled_anchor = scheduled_for_at
        .clone()
        .or_else(|| definition.next_due_at.clone())
        .unwrap_or_else(|| now.to_string());
    let mut execution = RedclawJobExecutionRecord {
        id: make_id("jobexec"),
        definition_id: definition.id.clone(),
        run_id: Some(make_id("run")),
        status: "queued".to_string(),
        attempt_count: 0,
        attempt_no: 0,
        worker_id: None,
        worker_mode: "main-process".to_string(),
        session_id: None,
        runtime_task_id: None,
        scheduled_for_at: Some(scheduled_anchor.clone()),
        idempotency_key: Some(format!("{}:{scheduled_anchor}", definition.id)),
        trigger,
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
        retry_bucket: Some("initial".to_string()),
        cancel_requested_at: None,
        cancel_reason: None,
        dead_lettered_at: None,
        archived_at: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    };
    append_execution_turn(&mut execution, now, "system", "Execution queued");
    execution
}

fn duplicate_execution_anchor_exists(
    store: &AppStore,
    definition_id: &str,
    scheduled_for_at: &str,
) -> Option<String> {
    redclaw_store::duplicate_job_execution_anchor_id(store, definition_id, scheduled_for_at)
}

fn ensure_unique_execution_id(store: &AppStore, execution: &mut RedclawJobExecutionRecord) {
    if redclaw_store::job_execution_id_exists(store, &execution.id) {
        execution.id = format!(
            "{}-{}",
            execution.id,
            redclaw_store::job_execution_count(store) + 1
        );
    }
}

pub fn enqueue_due_job_executions(store: &mut AppStore, now: i64) -> Vec<String> {
    let now_iso = now_iso();
    let mut enqueued = Vec::new();
    let definitions = redclaw_store::list_job_definitions(store);
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
        let (scheduled_anchors, next_due_at) = due_execution_plan(store, &definition, now);
        if scheduled_anchors.is_empty() {
            redclaw_store::update_job_definition(store, &definition.id, |current_definition| {
                current_definition.next_due_at = next_due_at.clone();
                current_definition.updated_at = now_iso.clone();
            });
            update_source_task_after_enqueue(store, &definition, next_due_at, &now_iso);
            continue;
        }
        for scheduled_for_at in &scheduled_anchors {
            if let Some(existing_execution_id) =
                duplicate_execution_anchor_exists(store, &definition.id, scheduled_for_at)
            {
                enqueued.push(existing_execution_id);
                continue;
            }
            let execution = create_execution_record(
                &definition,
                &now_iso,
                Some(scheduled_for_at.clone()),
                Some("scheduler".to_string()),
                Some(json!({
                    "trigger": "scheduler",
                    "definitionId": definition.id,
                    "prompt": definition_prompt(&definition),
                    "sourceKind": definition.source_kind,
                    "sourceTaskId": definition.source_task_id,
                    "scheduledForAt": scheduled_for_at,
                })),
            );
            let mut execution = execution;
            ensure_unique_execution_id(store, &mut execution);
            let execution_id = execution.id.clone();
            redclaw_store::push_job_execution(store, execution);
            enqueued.push(execution_id);
        }
        redclaw_store::update_job_definition(store, &definition.id, |current_definition| {
            current_definition.last_enqueued_at = Some(now_iso.clone());
            current_definition.next_due_at = next_due_at.clone();
            current_definition.updated_at = now_iso.clone();
        });
        update_source_task_after_enqueue(store, &definition, next_due_at, &now_iso);
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
            execution.retry_bucket = Some("retry-ready".to_string());
            append_execution_turn(&mut *execution, &now_iso, "system", "Retry re-queued");
        }
    }
}

pub fn recover_stale_job_executions(store: &mut AppStore, now: i64) {
    let now_iso = now_iso();
    let mut cooldown_candidates = Vec::new();
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
        let definition_id = execution.definition_id.clone();
        execution.last_error = Some(reason.clone());
        if should_dead_letter(execution.attempt_count) {
            mark_dead_lettered(execution, Some(reason.clone()), &now_iso);
            append_execution_turn(&mut *execution, &now_iso, "system", reason);
        } else {
            let _ = transition_execution_status(execution, "failed", &now_iso);
            let _ = transition_execution_status(execution, "retrying", &now_iso);
            execution.retry_not_before_at =
                Some((now + retry_delay_ms(execution.attempt_count)).to_string());
            execution.retry_bucket = Some("heartbeat-timeout".to_string());
            execution.completed_at = None;
            append_execution_turn(
                &mut *execution,
                &now_iso,
                "system",
                "Heartbeat timeout; retry scheduled",
            );
        }
        cooldown_candidates.push(definition_id);
    }

    for definition_id in cooldown_candidates {
        if let Some(prepared) = store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == definition_id)
            .map(|definition| PreparedJobExecution {
                execution_id: String::new(),
                definition_id: definition.id.clone(),
                source_kind: definition.source_kind.clone(),
                source_task_id: definition.source_task_id.clone(),
                kind: definition.kind.clone(),
                title: definition.title.clone(),
                prompt: String::new(),
                source_label: String::new(),
            })
        {
            activate_definition_cooldown(store, &prepared, "Execution heartbeat expired", &now_iso);
        }
    }
}

pub fn enqueue_manual_job_execution_for_definition(
    store: &mut AppStore,
    definition_id: &str,
    trigger: &str,
) -> Result<String, String> {
    let now_iso = now_iso();
    let definition = redclaw_store::job_definition_by_id(store, definition_id)
        .ok_or_else(|| "任务定义不存在".to_string())?;
    if active_execution_exists(store, &definition.id) {
        return Err("任务已有执行实例".to_string());
    }
    let scheduled_for_at = now_iso.clone();
    if let Some(existing_execution_id) =
        duplicate_execution_anchor_exists(store, &definition.id, &scheduled_for_at)
    {
        return Ok(existing_execution_id);
    }
    let execution = create_execution_record(
        &definition,
        &now_iso,
        Some(scheduled_for_at.clone()),
        Some(trigger.to_string()),
        Some(json!({
            "trigger": trigger,
            "definitionId": definition.id,
            "prompt": definition_prompt(&definition),
            "sourceKind": definition.source_kind,
            "sourceTaskId": definition.source_task_id,
            "scheduledForAt": scheduled_for_at,
        })),
    );
    let mut execution = execution;
    ensure_unique_execution_id(store, &mut execution);
    let execution_id = execution.id.clone();
    redclaw_store::push_job_execution(store, execution);
    redclaw_store::update_job_definition(store, &definition.id, |current_definition| {
        current_definition.last_enqueued_at = Some(now_iso.clone());
        current_definition.updated_at = now_iso;
    });
    Ok(execution_id)
}

fn prepare_execution(
    store: &AppStore,
    execution: &RedclawJobExecutionRecord,
) -> Result<PreparedJobExecution, String> {
    let definition = redclaw_store::job_definition_by_id(store, &execution.definition_id)
        .ok_or_else(|| "任务定义不存在".to_string())?;
    Ok(PreparedJobExecution {
        execution_id: execution.id.clone(),
        definition_id: definition.id.clone(),
        source_kind: definition.source_kind.clone(),
        source_task_id: definition.source_task_id.clone(),
        kind: definition.kind.clone(),
        title: definition.title.clone(),
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
        && store.redclaw_job_executions.iter().any(|item| {
            item.definition_id == definition_id
                && matches!(item.status.as_str(), "leased" | "running")
        })
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
        execution.attempt_no = execution.attempt_count;
        execution.retry_not_before_at = None;
        execution.retry_bucket = Some("claimed".to_string());
        append_execution_turn(&mut *execution, &now_iso, "system", "Execution leased");
    }

    let prepared = prepare_execution(store, &store.redclaw_job_executions[index])?;
    Ok(Some(prepared))
}

fn mark_execution_running(store: &mut AppStore, execution_id: &str) -> Result<(), String> {
    let now_iso = now_iso();
    redclaw_store::update_job_execution(store, execution_id, |execution| {
        transition_execution_status(execution, "running", &now_iso)?;
        execution.started_at.get_or_insert_with(|| now_iso.clone());
        execution.last_heartbeat_at = Some(now_iso.clone());
        execution.retry_bucket = Some("running".to_string());
        append_execution_turn(execution, &now_iso, "system", "Execution started");
        Ok(())
    })
    .ok_or_else(|| "执行实例不存在".to_string())?
}

fn mark_execution_cancelled(
    store: &mut AppStore,
    execution_id: &str,
    reason: &str,
) -> Result<(), String> {
    let now_iso = now_iso();
    redclaw_store::update_job_execution(store, execution_id, |execution| {
        if is_terminal_execution_status(&execution.status) {
            return Ok(());
        }
        transition_execution_status(execution, "cancelled", &now_iso)?;
        execution.cancel_requested_at = Some(now_iso.clone());
        execution.cancel_reason = Some(reason.to_string());
        execution.last_error = Some(reason.to_string());
        append_execution_turn(execution, &now_iso, "system", reason.to_string());
        Ok(())
    })
    .ok_or_else(|| "执行实例不存在".to_string())?
}

fn consecutive_failure_count(store: &AppStore, definition_id: &str) -> usize {
    redclaw_store::consecutive_job_failure_count(store, definition_id)
}

fn activate_definition_cooldown(
    store: &mut AppStore,
    prepared: &PreparedJobExecution,
    error: &str,
    now_iso: &str,
) {
    let consecutive = consecutive_failure_count(store, &prepared.definition_id);
    if consecutive < COOLDOWN_FAILURE_THRESHOLD {
        return;
    }

    redclaw_store::activate_job_definition_cooldown(
        store,
        &prepared.definition_id,
        prepared.source_kind.as_deref(),
        prepared.source_task_id.as_deref(),
        error,
        now_iso,
        consecutive,
    );
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
        append_execution_turn(
            execution,
            &now_iso,
            "system",
            "Execution finished after cancellation request",
        );
        return Ok(());
    }
    transition_execution_status(execution, "succeeded", &now_iso)?;
    append_execution_turn(
        execution,
        &now_iso,
        "response",
        execution
            .output_summary
            .clone()
            .unwrap_or_else(|| "Execution completed".to_string()),
    );
    execution.retry_bucket = Some("succeeded".to_string());
    if let Some(definition) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == prepared.definition_id)
    {
        clear_definition_cooldown(definition);
        definition.updated_at = now_iso.clone();
    }

    redclaw_store::mark_source_task_succeeded(
        store,
        prepared.source_kind.as_deref(),
        prepared.source_task_id.as_deref(),
        &now_iso,
    );
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
        execution.retry_bucket = Some("dead-letter".to_string());
        append_execution_turn(
            execution,
            &now_iso,
            "system",
            "Execution moved to dead-letter",
        );
    } else {
        transition_execution_status(execution, "retrying", &now_iso)?;
        execution.completed_at = None;
        execution.retry_not_before_at =
            Some((now + retry_delay_ms(execution.attempt_count)).to_string());
        execution.retry_bucket = Some("retry-scheduled".to_string());
        append_execution_turn(execution, &now_iso, "system", "Retry scheduled");
    }

    redclaw_store::mark_source_task_failed(
        store,
        prepared.source_kind.as_deref(),
        prepared.source_task_id.as_deref(),
        error,
        &now_iso,
    );

    activate_definition_cooldown(store, prepared, error, &now_iso);

    Ok(())
}

fn redclaw_task_id(prepared: &PreparedJobExecution) -> &str {
    prepared
        .source_task_id
        .as_deref()
        .unwrap_or(prepared.execution_id.as_str())
}

fn redclaw_task_kind(prepared: &PreparedJobExecution) -> &str {
    prepared
        .source_kind
        .as_deref()
        .unwrap_or(prepared.kind.as_str())
}

pub fn emit_scheduler_snapshot(app: &AppHandle, state: &State<'_, AppState>) {
    if let Ok(store) = state.store.lock() {
        let _ = app.emit("redclaw:runner-status", redclaw_store::state_value(&store));
    }
}

pub fn run_job_queue_once(
    app: &AppHandle,
    state: &State<'_, AppState>,
    preferred_execution_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let prepared = with_store_mut(state, |store| {
        claim_execution(store, now_i64(), preferred_execution_id)
    })?;
    let Some(prepared) = prepared else {
        return Ok(None);
    };

    with_store_mut(state, |store| {
        mark_execution_running(store, &prepared.execution_id)
    })?;
    emit_runtime_task_checkpoint_saved(
        app,
        Some(&prepared.execution_id),
        None,
        "task.start",
        "Scheduled task execution started",
        Some(json!({
            "executionId": prepared.execution_id,
            "definitionId": prepared.definition_id,
            "title": prepared.title,
            "kind": prepared.kind,
        })),
    );
    emit_scheduler_snapshot(app, state);

    let heartbeat =
        start_execution_heartbeat(app, prepared.execution_id.clone(), Duration::from_secs(5));
    let result = execute_redclaw_task_run(
        app,
        state,
        prepared.prompt.clone(),
        &prepared.source_label,
        prepared.source_kind.as_deref(),
        prepared.source_task_id.as_deref(),
        &prepared.title,
    );
    heartbeat.stop();

    match result {
        Ok(value) => {
            with_store_mut(state, |store| {
                mark_execution_succeeded(store, &prepared, &value)
            })?;
            let artifact_count = value
                .get("artifacts")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let summary = value
                .get("response")
                .and_then(Value::as_str)
                .map(|text| text.chars().take(120).collect::<String>());
            let session_id = value.get("sessionId").and_then(Value::as_str);
            emit_redclaw_task_event(
                app,
                "task_completed",
                redclaw_task_id(&prepared),
                &prepared.title,
                redclaw_task_kind(&prepared),
                Some("success"),
                summary.as_deref(),
                session_id,
                Some(&prepared.execution_id),
                artifact_count,
            );
            emit_runtime_task_checkpoint_saved(
                app,
                Some(&prepared.execution_id),
                None,
                "task.finish",
                "Scheduled task execution finished",
                Some(json!({
                    "executionId": prepared.execution_id,
                    "definitionId": prepared.definition_id,
                    "status": "succeeded",
                    "title": prepared.title,
                    "kind": prepared.kind,
                })),
            );
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
            with_store_mut(state, |store| {
                mark_execution_failed(store, &prepared, &error)
            })?;
            let final_status = with_store_mut(state, |store| {
                Ok(store
                    .redclaw_job_executions
                    .iter()
                    .find(|item| item.id == prepared.execution_id)
                    .map(|item| item.status.clone()))
            })?;
            if matches!(
                final_status.as_deref(),
                Some("dead_lettered") | Some("failed")
            ) {
                emit_redclaw_task_event(
                    app,
                    "task_failed",
                    redclaw_task_id(&prepared),
                    &prepared.title,
                    redclaw_task_kind(&prepared),
                    Some("failed"),
                    Some(&error),
                    None,
                    Some(&prepared.execution_id),
                    0,
                );
            }
            emit_runtime_task_checkpoint_saved(
                app,
                Some(&prepared.execution_id),
                None,
                "task.finish",
                "Scheduled task execution failed",
                Some(json!({
                    "executionId": prepared.execution_id,
                    "definitionId": prepared.definition_id,
                    "status": "failed",
                    "title": prepared.title,
                    "kind": prepared.kind,
                    "error": error,
                })),
            );
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
    if let Some(cancelled_id) =
        redclaw_store::cancel_scheduled_task(store, task_id, reason, &now_iso)
    {
        if let Some(execution_id) =
            redclaw_store::job_definition_id_by_source(store, "scheduled", task_id).and_then(
                |definition_id| {
                    redclaw_store::latest_job_execution_id_for_definition(store, &definition_id)
                },
            )
        {
            let _ = mark_execution_cancelled(store, &execution_id, reason);
        }
        return Some((cancelled_id, "scheduled-task".to_string()));
    }
    if let Some(cancelled_id) =
        redclaw_store::cancel_long_cycle_task(store, task_id, reason, &now_iso)
    {
        if let Some(execution_id) =
            redclaw_store::job_definition_id_by_source(store, "long_cycle", task_id).and_then(
                |definition_id| {
                    redclaw_store::latest_job_execution_id_for_definition(store, &definition_id)
                },
            )
        {
            let _ = mark_execution_cancelled(store, &execution_id, reason);
        }
        return Some((cancelled_id, "long-cycle".to_string()));
    }
    if let Some(execution_id) =
        redclaw_store::job_execution_id_by_task_or_definition(store, task_id)
    {
        let _ = mark_execution_cancelled(store, &execution_id, reason);
        return Some((execution_id, "job-execution".to_string()));
    }
    None
}

fn find_execution_definition_id(store: &AppStore, task_id: &str) -> Option<String> {
    redclaw_store::job_execution_definition_id_by_task_or_definition(store, task_id)
        .or_else(|| redclaw_store::job_definition_id_by_id_or_source_task(store, task_id))
}

pub fn retry_job_execution(
    store: &mut AppStore,
    task_id: &str,
) -> Result<(String, String), String> {
    let definition_id = find_execution_definition_id(store, task_id)
        .ok_or_else(|| "任务执行实例不存在".to_string())?;
    if active_execution_exists(store, &definition_id) {
        return Err("任务已有执行实例".to_string());
    }
    let definition = redclaw_store::job_definition_by_id(store, &definition_id)
        .ok_or_else(|| "任务定义不存在".to_string())?;
    let now_iso = now_iso();
    let execution = create_execution_record(
        &definition,
        &now_iso,
        Some(now_iso.clone()),
        Some("retry".to_string()),
        Some(json!({
            "trigger": "retry",
            "definitionId": definition.id,
            "prompt": definition_prompt(&definition),
            "sourceKind": definition.source_kind,
            "sourceTaskId": definition.source_task_id,
            "retryOf": task_id,
        })),
    );
    let mut execution = execution;
    ensure_unique_execution_id(store, &mut execution);
    let execution_id = execution.id.clone();
    redclaw_store::push_job_execution(store, execution);
    redclaw_store::update_job_definition(store, &definition.id, |current_definition| {
        current_definition.last_enqueued_at = Some(now_iso.clone());
        current_definition.updated_at = now_iso;
    });
    Ok((execution_id, definition.id))
}

pub fn archive_job_execution(store: &mut AppStore, task_id: &str) -> Result<String, String> {
    let now_iso = now_iso();
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| {
            item.id == task_id
                || item.definition_id == task_id
                || item
                    .input_snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.get("sourceTaskId"))
                    .and_then(Value::as_str)
                    == Some(task_id)
        })
        .ok_or_else(|| "任务执行实例不存在".to_string())?;
    if is_active_execution_status(&execution.status) {
        return Err("运行中的执行实例不能归档".to_string());
    }
    execution.archived_at = Some(now_iso.clone());
    execution.updated_at = now_iso;
    Ok(execution.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::default_store;
    use crate::runtime::RedclawScheduledTaskRecord;
    use crate::scheduler::{derived_background_tasks, sync_redclaw_job_definitions};

    fn seed_scheduled_definition(store: &mut AppStore) {
        store
            .redclaw_state
            .scheduled_tasks
            .push(RedclawScheduledTaskRecord {
                id: "scheduled-1".to_string(),
                name: "Retry me".to_string(),
                enabled: true,
                mode: "interval".to_string(),
                prompt: "hello".to_string(),
                project_id: None,
                interval_minutes: Some(15),
                time: None,
                weekdays: None,
                run_at: None,
                created_at: "1".to_string(),
                updated_at: "1".to_string(),
                last_run_at: None,
                last_result: None,
                last_error: None,
                next_run_at: Some("1".to_string()),
            });
        sync_redclaw_job_definitions(store);
    }

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

    #[test]
    fn retry_job_execution_enqueues_new_execution() {
        let mut store = default_store();
        seed_scheduled_definition(&mut store);
        let original_execution_id =
            enqueue_manual_job_execution_for_definition(&mut store, "jobdef-scheduled-1", "manual")
                .expect("seed execution");
        let original_execution = store
            .redclaw_job_executions
            .iter_mut()
            .find(|item| item.id == original_execution_id)
            .expect("original execution exists");
        original_execution.status = "failed".to_string();
        original_execution.completed_at = Some("2".to_string());

        let (retry_execution_id, definition_id) =
            retry_job_execution(&mut store, &original_execution_id).expect("retry execution");

        assert_ne!(retry_execution_id, original_execution_id);
        assert_eq!(store.redclaw_job_executions.len(), 2);
        assert_eq!(
            store
                .redclaw_job_executions
                .iter()
                .find(|item| item.id == retry_execution_id)
                .map(|item| item.status.as_str()),
            Some("queued")
        );
        assert_eq!(
            store
                .redclaw_job_executions
                .iter()
                .find(|item| item.id == retry_execution_id)
                .map(|item| item.definition_id.as_str()),
            Some(definition_id.as_str())
        );
    }

    #[test]
    fn archive_job_execution_hides_terminal_execution_from_background_snapshot() {
        let mut store = default_store();
        seed_scheduled_definition(&mut store);
        let execution_id =
            enqueue_manual_job_execution_for_definition(&mut store, "jobdef-scheduled-1", "manual")
                .expect("seed execution");
        let execution = store
            .redclaw_job_executions
            .iter_mut()
            .find(|item| item.id == execution_id)
            .expect("execution exists");
        execution.status = "dead_lettered".to_string();
        execution.completed_at = Some("2".to_string());
        execution.dead_lettered_at = Some("2".to_string());

        let archived_execution_id =
            archive_job_execution(&mut store, &execution_id).expect("archive execution");
        let tasks = derived_background_tasks(&store);

        assert_eq!(archived_execution_id, execution_id);
        assert_eq!(
            store
                .redclaw_job_executions
                .iter()
                .find(|item| item.id == execution_id)
                .and_then(|item| item.archived_at.as_deref())
                .is_some(),
            true
        );
        assert!(tasks.iter().all(
            |item| item.get("executionId").and_then(|value| value.as_str())
                != Some(execution_id.as_str())
        ));
    }
}
