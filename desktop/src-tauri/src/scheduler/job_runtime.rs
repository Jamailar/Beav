use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use serde_json::{json, Value};

use crate::assistant_core::{assistant_session_id_for_route, execute_assistant_daemon_job};
use crate::commands::redclaw_runtime::execute_redclaw_run;
use crate::commands::runtime_task_resume::execute_runtime_task_resume_job;
use crate::persistence::with_store_mut;
use crate::runtime::{RedclawJobDefinitionRecord, RedclawJobExecutionRecord};
use crate::skills::build_skill_runtime_state;
use crate::scheduler::dead_letter::mark_dead_lettered;
use crate::scheduler::heartbeat::start_execution_heartbeat;
use crate::scheduler::lease::lease_execution;
use crate::scheduler::retry::{retry_delay_ms, should_dead_letter, DEFAULT_HEARTBEAT_TIMEOUT_MS};
use crate::tools::capabilities::resolve_capability_set_for_store;
use crate::tools::registry::base_tool_names_for_session_metadata;
use crate::{make_id, now_i64, now_iso, redclaw_state_value, AppState, AppStore};

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
    pub owner_context_id: Option<String>,
    pub prompt: String,
    pub source_label: String,
    pub input_snapshot: Option<Value>,
    pub definition_payload: Value,
}

fn background_status_from_execution_status(status: &str) -> &'static str {
    match status {
        "succeeded" | "completed" => "completed",
        "held" => "held",
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
        "succeeded" | "completed" | "held" | "failed" | "cancelled" | "dead_lettered"
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
                | ("running", "held")
                | ("running", "failed")
                | ("running", "cancelled")
                | ("failed", "retrying")
                | ("failed", "dead_lettered")
                | ("retrying", "queued")
                | ("retrying", "cancelled")
                | ("held", "retrying")
                | ("held", "dead_lettered")
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

fn append_execution_payload_turn(
    execution: &mut RedclawJobExecutionRecord,
    at: &str,
    source: &str,
    text: impl Into<String>,
    payload: Option<Value>,
) {
    let mut value = json!({
        "id": make_id("bg-turn"),
        "at": at,
        "text": text.into(),
        "source": source,
    });
    if let Some(payload) = payload {
        if let Some(object) = value.as_object_mut() {
            object.insert("payload".to_string(), payload);
        }
    }
    execution.checkpoints.push(value);
}

pub fn agent_job_feature_enabled(settings: &Value) -> bool {
    let _ = settings;
    true
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

fn agent_job_attached_skills(
    store: &AppStore,
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<String> {
    let base_tools = base_tool_names_for_session_metadata(runtime_mode, metadata);
    build_skill_runtime_state(&store.skills, runtime_mode, metadata, &base_tools, None)
        .active_skills
        .into_iter()
        .map(|skill| skill.name)
        .collect()
}

fn runtime_task_job_definition_id(task_id: &str) -> String {
    format!("jobdef-runtime-task-{task_id}")
}

fn assistant_daemon_job_definition_id(route_kind: &str) -> String {
    format!("jobdef-assistant-daemon-{route_kind}")
}

fn build_job_contract_payload(
    store: &AppStore,
    runtime_mode: &str,
    metadata: Option<&Value>,
    session_id: Option<&str>,
    delivery_policy: Value,
    retry_policy: Value,
    checkpoint_policy: Value,
    result_policy: Value,
) -> Value {
    json!({
        "runtimeMode": runtime_mode,
        "attachedSkills": agent_job_attached_skills(store, runtime_mode, metadata),
        "capabilitySet": resolve_capability_set_for_store(store, runtime_mode, session_id),
        "deliveryPolicy": delivery_policy,
        "retryPolicy": retry_policy,
        "checkpointPolicy": checkpoint_policy,
        "resultPolicy": result_policy,
    })
}

pub fn ensure_runtime_task_job_definition(
    store: &mut AppStore,
    task_id: &str,
) -> Result<String, String> {
    let task = store
        .runtime_tasks
        .iter()
        .find(|item| item.id == task_id)
        .cloned()
        .ok_or_else(|| "运行时任务不存在".to_string())?;
    let definition_id = store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.source_kind.as_deref() == Some("runtime_task")
                && item.source_task_id.as_deref() == Some(task_id)
        })
        .map(|item| item.id.clone())
        .unwrap_or_else(|| runtime_task_job_definition_id(task_id));
    let title = task
        .goal
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Runtime Task {}", task.id));
    let payload = json!({
        "taskId": task.id,
        "goal": task.goal,
        "intent": task.intent,
        "ownerSessionId": task.owner_session_id,
        "route": task.route,
        "metadata": task.metadata,
        "sessionPolicy": {
            "mode": "existing_or_fresh",
            "sessionId": task.owner_session_id,
            "persistContextBundleSnapshot": true,
        },
        "jobContract": build_job_contract_payload(
            store,
            &task.runtime_mode,
            task.metadata.as_ref(),
            task.owner_session_id.as_deref(),
            json!({
                "writeLocalArtifact": true,
                "updateWorkspaceState": true,
                "appendTaskRecord": true,
                "uiNotification": true,
                "externalDelivery": Value::Null,
            }),
            json!({
                "mode": "retry_from_checkpoint",
                "maxAttempts": 3,
                "deadLetterAfter": 3,
            }),
            json!({
                "persistTaskCheckpoints": true,
                "persistExecutionCheckpoints": true,
                "persistContextBundle": true,
            }),
            json!({
                "type": "runtime_task_artifact",
                "summaryField": "outputSummary",
                "holdOnReviewFailure": true,
            }),
        ),
    });
    let definition = RedclawJobDefinitionRecord {
        id: definition_id.clone(),
        source_kind: Some("runtime_task".to_string()),
        source_task_id: Some(task_id.to_string()),
        kind: "runtime_task".to_string(),
        title,
        enabled: true,
        owner_context_id: task.owner_session_id.clone(),
        runtime_mode: task.runtime_mode.clone(),
        trigger_kind: "manual".to_string(),
        progression_kind: "single_run".to_string(),
        payload,
        next_due_at: None,
        last_enqueued_at: store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == definition_id)
            .and_then(|item| item.last_enqueued_at.clone()),
        created_at: store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == definition_id)
            .map(|item| item.created_at.clone())
            .unwrap_or_else(now_iso),
        updated_at: now_iso(),
    };
    if let Some(existing) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == definition_id)
    {
        *existing = definition;
    } else {
        store.redclaw_job_definitions.push(definition);
    }
    Ok(definition_id)
}

pub fn ensure_assistant_daemon_job_definition(
    store: &mut AppStore,
    route_kind: &str,
) -> Result<String, String> {
    let session_id = assistant_session_id_for_route(route_kind);
    let definition_id = store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.source_kind.as_deref() == Some("assistant_daemon")
                && item.source_task_id.as_deref() == Some(route_kind)
        })
        .map(|item| item.id.clone())
        .unwrap_or_else(|| assistant_daemon_job_definition_id(route_kind));
    let payload = json!({
        "routeKind": route_kind,
        "sessionId": session_id,
        "sessionPolicy": {
            "mode": "sticky_route_session",
            "sessionId": session_id,
            "persistContextBundleSnapshot": true,
        },
        "jobContract": build_job_contract_payload(
            store,
            "assistant-daemon",
            None,
            Some(session_id.as_str()),
            json!({
                "writeLocalArtifact": false,
                "updateWorkspaceState": false,
                "appendTaskRecord": false,
                "uiNotification": true,
                "externalDelivery": if route_kind == "feishu" { json!("feishu") } else { Value::Null },
            }),
            json!({
                "mode": "retry_from_start",
                "maxAttempts": 3,
                "deadLetterAfter": 3,
            }),
            json!({
                "persistExecutionCheckpoints": true,
                "persistContextBundle": true,
                "persistDeliveryReceipt": route_kind == "feishu",
            }),
            json!({
                "type": "assistant_reply",
                "summaryField": "reply",
                "allowExternalDelivery": route_kind == "feishu",
            }),
        ),
    });
    let definition = RedclawJobDefinitionRecord {
        id: definition_id.clone(),
        source_kind: Some("assistant_daemon".to_string()),
        source_task_id: Some(route_kind.to_string()),
        kind: "assistant_daemon".to_string(),
        title: format!("Assistant Daemon · {route_kind}"),
        enabled: true,
        owner_context_id: Some(session_id),
        runtime_mode: "assistant-daemon".to_string(),
        trigger_kind: "webhook".to_string(),
        progression_kind: "single_run".to_string(),
        payload,
        next_due_at: None,
        last_enqueued_at: store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == definition_id)
            .and_then(|item| item.last_enqueued_at.clone()),
        created_at: store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.id == definition_id)
            .map(|item| item.created_at.clone())
            .unwrap_or_else(now_iso),
        updated_at: now_iso(),
    };
    if let Some(existing) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == definition_id)
    {
        *existing = definition;
    } else {
        store.redclaw_job_definitions.push(definition);
    }
    Ok(definition_id)
}

fn definition_source_label(definition: &RedclawJobDefinitionRecord) -> &'static str {
    match definition.source_kind.as_deref() {
        Some("scheduled") => "scheduled-task",
        Some("long_cycle") => "long-cycle-task",
        _ => "scheduler-execution",
    }
}

fn next_definition_due_at(
    store: &AppStore,
    definition: &RedclawJobDefinitionRecord,
    now: i64,
) -> Option<String> {
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
        archived_at: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    };
    append_execution_turn(&mut execution, now, "system", "Execution queued");
    execution
}

fn enqueue_execution_for_definition(
    store: &mut AppStore,
    definition_id: &str,
    _trigger: &str,
    input_snapshot: Value,
    allow_parallel: bool,
) -> Result<String, String> {
    let now_iso = now_iso();
    let definition = store
        .redclaw_job_definitions
        .iter()
        .find(|item| item.id == definition_id)
        .cloned()
        .ok_or_else(|| "任务定义不存在".to_string())?;
    if !allow_parallel && active_execution_exists(store, &definition.id) {
        return Err("任务已有执行实例".to_string());
    }
    let execution = create_execution_record(&definition, &now_iso, Some(input_snapshot));
    let mut execution = execution;
    ensure_unique_execution_id(store, &mut execution);
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

pub fn enqueue_runtime_task_job_execution(
    store: &mut AppStore,
    task_id: &str,
    trigger: &str,
) -> Result<String, String> {
    let definition_id = ensure_runtime_task_job_definition(store, task_id)?;
    let task = store
        .runtime_tasks
        .iter()
        .find(|item| item.id == task_id)
        .cloned()
        .ok_or_else(|| "运行时任务不存在".to_string())?;
    enqueue_execution_for_definition(
        store,
        &definition_id,
        trigger,
        json!({
            "trigger": trigger,
            "definitionId": definition_id,
            "sourceKind": "runtime_task",
            "sourceTaskId": task_id,
            "taskId": task_id,
            "runtimeMode": task.runtime_mode,
            "goal": task.goal,
            "ownerSessionId": task.owner_session_id,
            "metadata": task.metadata,
        }),
        false,
    )
}

pub fn enqueue_assistant_daemon_job_execution(
    store: &mut AppStore,
    route_kind: &str,
    prompt: &str,
    request_body: Option<Value>,
    trigger: &str,
) -> Result<String, String> {
    let definition_id = ensure_assistant_daemon_job_definition(store, route_kind)?;
    let session_id = assistant_session_id_for_route(route_kind);
    enqueue_execution_for_definition(
        store,
        &definition_id,
        trigger,
        json!({
            "trigger": trigger,
            "definitionId": definition_id,
            "sourceKind": "assistant_daemon",
            "sourceTaskId": route_kind,
            "routeKind": route_kind,
            "runtimeMode": "assistant-daemon",
            "sessionId": session_id,
            "prompt": prompt,
            "sourceLabel": format!("assistant-daemon:{route_kind}"),
            "requestBody": request_body,
        }),
        false,
    )
}

fn ensure_unique_execution_id(store: &AppStore, execution: &mut RedclawJobExecutionRecord) {
    if store
        .redclaw_job_executions
        .iter()
        .any(|item| item.id == execution.id)
    {
        execution.id = format!(
            "{}-{}",
            execution.id,
            store.redclaw_job_executions.len() + 1
        );
    }
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
        let mut execution = execution;
        ensure_unique_execution_id(store, &mut execution);
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
            append_execution_turn(
                &mut *execution,
                &now_iso,
                "system",
                "Heartbeat timeout; retry scheduled",
            );
        }
    }
}

pub fn enqueue_manual_job_execution_for_source(
    store: &mut AppStore,
    source_kind: &str,
    source_task_id: &str,
    trigger: &str,
) -> Result<String, String> {
    let definition = store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.source_kind.as_deref() == Some(source_kind)
                && item.source_task_id.as_deref() == Some(source_task_id)
        })
        .cloned()
        .ok_or_else(|| "任务定义不存在".to_string())?;
    enqueue_execution_for_definition(
        store,
        &definition.id,
        trigger,
        json!({
            "trigger": trigger,
            "definitionId": definition.id,
            "prompt": definition_prompt(&definition),
            "sourceKind": definition.source_kind,
            "sourceTaskId": definition.source_task_id,
            "runtimeMode": definition.runtime_mode,
            "sourceLabel": definition_source_label(&definition),
        }),
        false,
    )
}

fn prepare_execution(
    store: &AppStore,
    execution: &RedclawJobExecutionRecord,
) -> Result<PreparedJobExecution, String> {
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
        owner_context_id: definition.owner_context_id.clone(),
        prompt: execution
            .input_snapshot
            .as_ref()
            .and_then(|value| value.get("prompt"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| definition_prompt(&definition)),
        source_label: execution
            .input_snapshot
            .as_ref()
            .and_then(|value| value.get("sourceLabel"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| definition_source_label(&definition))
            .to_string(),
        input_snapshot: execution.input_snapshot.clone(),
        definition_payload: definition.payload.clone(),
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
        execution.retry_not_before_at = None;
        append_execution_turn(&mut *execution, &now_iso, "system", "Execution leased");
    }

    let prepared = prepare_execution(store, &store.redclaw_job_executions[index])?;
    Ok(Some(prepared))
}

fn mark_execution_running(store: &mut AppStore, execution_id: &str) -> Result<(), String> {
    let now_iso = now_iso();
    let contract_payload = store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == execution_id)
        .and_then(|execution| {
            execution
                .input_snapshot
                .as_ref()
                .and_then(|value| value.get("jobContract"))
                .cloned()
                .or_else(|| {
                    store
                        .redclaw_job_definitions
                        .iter()
                        .find(|definition| definition.id == execution.definition_id)
                        .and_then(|definition| definition.payload.get("jobContract").cloned())
                })
        });
    let execution = store
        .redclaw_job_executions
        .iter_mut()
        .find(|item| item.id == execution_id)
        .ok_or_else(|| "执行实例不存在".to_string())?;
    transition_execution_status(execution, "running", &now_iso)?;
    execution.started_at.get_or_insert_with(|| now_iso.clone());
    execution.last_heartbeat_at = Some(now_iso.clone());
    append_execution_turn(execution, &now_iso, "system", "Execution started");
    if let Some(contract) = contract_payload {
        append_execution_payload_turn(
            execution,
            &now_iso,
            "system",
            "Agent job contract snapshot",
            Some(contract),
        );
    }
    Ok(())
}

fn mark_execution_cancelled(
    store: &mut AppStore,
    execution_id: &str,
    reason: &str,
) -> Result<(), String> {
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
    execution.runtime_task_id = result
        .get("runtimeTaskId")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    execution.session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    execution.output_summary = execution_output_summary(result);
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
    if let Some(checkpoint) = result
        .get("lastCheckpoint")
        .cloned()
        .or_else(|| result.get("checkpoint").cloned())
    {
        let summary = checkpoint
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("Job checkpoint updated")
            .to_string();
        append_execution_payload_turn(execution, &now_iso, "system", summary, Some(checkpoint));
    }
    if let Some(artifact) = result.get("lastArtifact").cloned() {
        append_execution_payload_turn(
            execution,
            &now_iso,
            "system",
            "Job artifact updated",
            Some(artifact),
        );
    }
    append_execution_turn(
        execution,
        &now_iso,
        "response",
        execution
            .output_summary
            .clone()
            .unwrap_or_else(|| "Execution completed".to_string()),
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

fn mark_execution_held(
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
    execution.runtime_task_id = result
        .get("runtimeTaskId")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    execution.session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .or_else(|| prepared.owner_context_id.clone());
    execution.output_summary = execution_output_summary(result);
    let hold_reason = result
        .get("holdReason")
        .or_else(|| result.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("execution held for approval")
        .to_string();
    execution.last_error = Some(hold_reason.clone());
    transition_execution_status(execution, "held", &now_iso)?;
    append_execution_payload_turn(
        execution,
        &now_iso,
        "system",
        hold_reason,
        result.get("lastCheckpoint").cloned(),
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
        Some("runtime_task") => {
            if let Some(task) = store
                .runtime_tasks
                .iter_mut()
                .find(|item| prepared.source_task_id.as_deref() == Some(item.id.as_str()))
            {
                task.status = "failed".to_string();
                task.last_error = Some(error.to_string());
                task.updated_at = now_i64();
                task.completed_at = Some(now_i64());
            }
        }
        _ => {}
    }

    Ok(())
}

fn execution_output_summary(result: &Value) -> Option<String> {
    result
        .get("outputSummary")
        .and_then(Value::as_str)
        .or_else(|| result.get("response").and_then(Value::as_str))
        .or_else(|| result.get("reply").and_then(Value::as_str))
        .map(|value| value.chars().take(280).collect())
}

pub fn emit_scheduler_snapshot(app: &AppHandle, state: &State<'_, AppState>) {
    if let Ok(store) = state.store.lock() {
        let _ = app.emit(
            "redclaw:runner-status",
            redclaw_state_value(&store.redclaw_state),
        );
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
    emit_scheduler_snapshot(app, state);

    let heartbeat =
        start_execution_heartbeat(app, prepared.execution_id.clone(), Duration::from_secs(5));
    let result = match prepared.source_kind.as_deref() {
        Some("runtime_task") => execute_runtime_task_resume_job(
            app,
            state,
            prepared
                .source_task_id
                .as_deref()
                .ok_or_else(|| "runtime task sourceTaskId missing".to_string())?,
        ),
        Some("assistant_daemon") => execute_assistant_daemon_job(
            app,
            prepared
                .input_snapshot
                .as_ref()
                .and_then(|value| value.get("routeKind"))
                .or_else(|| prepared.definition_payload.get("routeKind"))
                .and_then(Value::as_str)
                .unwrap_or("generic"),
            &prepared.prompt,
            prepared
                .input_snapshot
                .as_ref()
                .and_then(|value| value.get("requestBody"))
                .cloned(),
        ),
        _ => execute_redclaw_run(
            app,
            state,
            prepared.prompt.clone(),
            prepared.project_id.clone(),
            &prepared.source_label,
        ),
    };
    heartbeat.stop();

    match result {
        Ok(value) => {
            let status = value
                .get("jobOutcome")
                .and_then(Value::as_str)
                .unwrap_or("succeeded");
            with_store_mut(state, |store| {
                if status == "held" {
                    mark_execution_held(store, &prepared, &value)
                } else {
                    mark_execution_succeeded(store, &prepared, &value)
                }
            })?;
            emit_scheduler_snapshot(app, state);
            Ok(Some(json!({
                "success": status != "held",
                "executionId": prepared.execution_id,
                "definitionId": prepared.definition_id,
                "status": status,
                "result": value,
                "backgroundStatus": background_status_from_execution_status(status),
                "title": prepared.title,
                "kind": prepared.kind,
            })))
        }
        Err(error) => {
            with_store_mut(state, |store| {
                mark_execution_failed(store, &prepared, &error)
            })?;
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
    if let Some(task) = store
        .runtime_tasks
        .iter()
        .find(|item| item.id == task_id)
        .map(|item| item.id.clone())
    {
        let execution_id = store
            .redclaw_job_definitions
            .iter()
            .find(|item| {
                item.source_kind.as_deref() == Some("runtime_task")
                    && item.source_task_id.as_deref() == Some(task_id)
            })
            .and_then(|definition| {
                store
                    .redclaw_job_executions
                    .iter()
                    .filter(|item| item.definition_id == definition.id)
                    .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                    .map(|item| item.id.clone())
            });
        if let Some(task_record) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task)
        {
            task_record.status = "cancelled".to_string();
            task_record.last_error = Some(reason.to_string());
            task_record.updated_at = now_i64();
            task_record.completed_at = Some(now_i64());
        }
        if let Some(execution_id) = execution_id {
            let _ = mark_execution_cancelled(store, &execution_id, reason);
        }
        return Some((task, "runtime-task".to_string()));
    }
    if let Some(execution_id) = store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == task_id || item.definition_id == task_id)
        .map(|item| item.id.clone())
    {
        let runtime_task_id = store
            .redclaw_job_executions
            .iter()
            .find(|item| item.id == execution_id)
            .and_then(|execution| {
                store
                    .redclaw_job_definitions
                    .iter()
                    .find(|definition| definition.id == execution.definition_id)
                    .and_then(|definition| {
                        if definition.source_kind.as_deref() == Some("runtime_task") {
                            definition.source_task_id.clone()
                        } else {
                            None
                        }
                    })
            });
        let _ = mark_execution_cancelled(store, &execution_id, reason);
        if let Some(runtime_task_id) = runtime_task_id {
            if let Some(task) = store
                .runtime_tasks
                .iter_mut()
                .find(|item| item.id == runtime_task_id)
            {
                task.status = "cancelled".to_string();
                task.last_error = Some(reason.to_string());
                task.updated_at = now_i64();
                task.completed_at = Some(now_i64());
            }
        }
        return Some((execution_id, "job-execution".to_string()));
    }
    None
}

fn find_execution_definition_id(store: &AppStore, task_id: &str) -> Option<String> {
    if let Some(execution) = store
        .redclaw_job_executions
        .iter()
        .find(|item| item.id == task_id || item.definition_id == task_id)
    {
        return Some(execution.definition_id.clone());
    }
    store
        .redclaw_job_definitions
        .iter()
        .find(|item| item.id == task_id || item.source_task_id.as_deref() == Some(task_id))
        .map(|item| item.id.clone())
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
    let definition = store
        .redclaw_job_definitions
        .iter()
        .find(|item| item.id == definition_id)
        .cloned()
        .ok_or_else(|| "任务定义不存在".to_string())?;
    let now_iso = now_iso();
    let execution = create_execution_record(
        &definition,
        &now_iso,
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
    store.redclaw_job_executions.push(execution);
    if let Some(current_definition) = store
        .redclaw_job_definitions
        .iter_mut()
        .find(|item| item.id == definition.id)
    {
        current_definition.last_enqueued_at = Some(now_iso.clone());
        current_definition.updated_at = now_iso;
    }
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
    use crate::runtime::{
        create_runtime_task, runtime_direct_route_record, RedclawScheduledTaskRecord,
    };
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
                project_id: Some("project-1".to_string()),
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
        assert_eq!(background_status("held"), "held");
        assert_eq!(background_status("dead_lettered"), "failed");
    }

    #[test]
    fn retry_job_execution_enqueues_new_execution() {
        let mut store = default_store();
        seed_scheduled_definition(&mut store);
        let original_execution_id = enqueue_manual_job_execution_for_source(
            &mut store,
            "scheduled",
            "scheduled-1",
            "manual",
        )
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
        let execution_id = enqueue_manual_job_execution_for_source(
            &mut store,
            "scheduled",
            "scheduled-1",
            "manual",
        )
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

    #[test]
    fn enqueue_runtime_task_job_execution_creates_definition_and_background_snapshot() {
        let mut store = default_store();
        let route = runtime_direct_route_record("chatroom", "phase6 runtime task", None);
        let task = create_runtime_task(
            "manual",
            "pending",
            "chatroom".to_string(),
            Some("session-phase6".to_string()),
            Some("phase6 runtime task".to_string()),
            route,
            None,
        );
        let task_id = task.id.clone();
        store.runtime_tasks.push(task);

        let execution_id =
            enqueue_runtime_task_job_execution(&mut store, &task_id, "manual-phase6")
                .expect("runtime task execution");
        let definition = store
            .redclaw_job_definitions
            .iter()
            .find(|item| item.source_kind.as_deref() == Some("runtime_task"))
            .expect("runtime task definition");
        let execution = store
            .redclaw_job_executions
            .iter()
            .find(|item| item.id == execution_id)
            .expect("runtime task execution exists");
        let tasks = derived_background_tasks(&store);
        let background = tasks
            .iter()
            .find(|item| item.get("definitionId").and_then(Value::as_str) == Some(definition.id.as_str()))
            .expect("background snapshot for runtime task");

        assert_eq!(execution.definition_id, definition.id);
        assert_eq!(definition.runtime_mode, "chatroom");
        assert_eq!(
            background.get("kind").and_then(Value::as_str),
            Some("runtime-task")
        );
        assert_eq!(
            background
                .get("lineage")
                .and_then(|value| value.get("sourceKind"))
                .and_then(Value::as_str),
            Some("runtime_task")
        );
    }
}
