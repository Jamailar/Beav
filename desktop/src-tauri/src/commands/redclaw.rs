#[path = "redclaw_task_control.rs"]
mod redclaw_task_control;

use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};

use crate::commands::redclaw_runtime::execute_redclaw_run;
use crate::persistence::{ensure_store_hydrated_for_redclaw, with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, collab_session_snapshot, create_collab_session, create_collab_task,
    plan_redclaw_orchestration, redclaw_orchestration_registry_value, runtime_direct_route_record,
    store_runtime_task, CollabSessionSnapshot, RedclawAgentId, RedclawOrchestrationPlan,
    RedclawRuntime,
};
use crate::scheduler::task_policy::TaskIntentSchema;
use crate::scheduler::{
    clear_definition_cooldown, emit_scheduler_snapshot, enqueue_manual_job_execution_for_source,
    run_job_queue_once, run_redclaw_job_runner, run_redclaw_scheduler,
    sync_redclaw_job_definitions,
};
use crate::{
    complete_redclaw_mvp_onboarding, handle_redclaw_onboarding_turn,
    load_redbox_prompt_or_embedded, load_redclaw_onboarding_state,
    load_redclaw_profile_prompt_bundle, load_redclaw_style_profile, now_i64, now_iso,
    payload_field, payload_string, redclaw_state_value, save_redclaw_mvp_onboarding_progress,
    update_redclaw_profile_doc, AppState,
};
use redclaw_task_control::{
    create_confirmed_task_from_intent, handle_task_cancel, handle_task_confirm, handle_task_create,
    handle_task_list, handle_task_preview, handle_task_stats, handle_task_update,
};

pub(crate) fn redclaw_runner_status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_redclaw(state);
    with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))
}

#[tauri::command]
pub async fn redclaw_runner_status(state: State<'_, AppState>) -> Result<Value, String> {
    redclaw_runner_status_value(&state)
}

fn stop_redclaw_runtime(runtime: &mut RedclawRuntime) {
    runtime.stop.store(true, Ordering::Relaxed);
    if let Some(join) = runtime.scheduler_join.take() {
        join.abort();
    }
    if let Some(join) = runtime.runner_join.take() {
        join.abort();
    }
}

pub fn ensure_redclaw_runtime_running(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<bool, String> {
    let should_run = with_store(state, |store| {
        Ok(store.redclaw_state.enabled && store.redclaw_state.is_ticking)
    })?;
    if !should_run {
        return Ok(false);
    }
    if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
        if runtime_guard.is_none() {
            let stop = Arc::new(AtomicBool::new(false));
            let scheduler_join = run_redclaw_scheduler(app.clone(), stop.clone());
            let runner_join = run_redclaw_job_runner(app.clone(), stop.clone());
            *runtime_guard = Some(RedclawRuntime {
                stop,
                scheduler_join: Some(scheduler_join),
                runner_join: Some(runner_join),
            });
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn handle_redclaw_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result: Result<Value, String> = match channel {
        "redclaw:runner-status" => redclaw_runner_status_value(state),
        "redclaw:list-projects" => with_store(state, |store| {
            let mut projects = store.redclaw_state.projects.clone();
            projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!({ "success": true, "items": projects, "count": projects.len() }))
        }),
        "redclaw:orchestration-plan" => plan_redclaw_orchestration(payload).map(|plan| json!(plan)),
        "redclaw:orchestration-registry" => Ok(redclaw_orchestration_registry_value()),
        "redclaw:orchestration-create-team" => create_redclaw_orchestration_team(state, payload),
        "redclaw:orchestration-create-run" => create_redclaw_orchestration_run(state, payload),
        "redclaw:learning-candidate-update" => update_redclaw_learning_candidate(state, payload),
        "redclaw:project-section-update" => update_redclaw_project_section(state, payload),
        "redclaw:profile:get-bundle" => (|| {
            let bundle = load_redclaw_profile_prompt_bundle(state)?;
            let active_space_id =
                crate::with_store(state, |store| Ok(store.active_space_id.clone()))?;
            Ok(json!({
                "success": true,
                "activeSpaceId": active_space_id,
                "profileRoot": bundle.profile_root.display().to_string(),
                "agent": bundle.agent,
                "soul": bundle.soul,
                "identity": bundle.identity,
                "user": bundle.user,
                "creatorProfile": bundle.creator_profile,
                "bootstrap": bundle.bootstrap,
                "styleProfile": load_redclaw_style_profile(state)?,
                "files": {
                    "agent": bundle.agent,
                    "soul": bundle.soul,
                    "identity": bundle.identity,
                    "user": bundle.user,
                    "creatorProfile": bundle.creator_profile,
                    "bootstrap": bundle.bootstrap
                },
                "onboardingState": bundle.onboarding_state
            }))
        })(),
        "redclaw:profile:update-doc" => (|| {
            let doc_type = payload_string(payload, "docType")
                .ok_or_else(|| "docType is required".to_string())?;
            let markdown = payload_string(payload, "markdown")
                .ok_or_else(|| "markdown is required".to_string())?;
            let reason = payload_string(payload, "reason");
            let mut result = update_redclaw_profile_doc(state, &doc_type, &markdown)?;
            if let Some(reason_text) = reason {
                if let Some(object) = result.as_object_mut() {
                    object.insert("reason".to_string(), json!(reason_text));
                }
            }
            Ok(result)
        })(),
        "redclaw:profile:onboarding-status" => (|| {
            let onboarding_state = load_redclaw_onboarding_state(state)?;
            let completed = onboarding_state
                .get("completedAt")
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            Ok(json!({
                "success": true,
                "completed": completed,
                "state": onboarding_state
            }))
        })(),
        "redclaw:profile:onboarding-turn" => (|| {
            let input = payload_string(payload, "input").unwrap_or_default();
            let result = handle_redclaw_onboarding_turn(state, &input)?;
            Ok(json!({
                "success": true,
                "handled": result.is_some(),
                "result": result.map(|(response, completed)| json!({
                    "responseText": response,
                    "completed": completed
                }))
            }))
        })(),
        "redclaw:profile:save-initialization-progress" => (|| {
            let step_index = payload_field(payload, "stepIndex")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let answers = payload_field(payload, "answers")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let onboarding_state =
                save_redclaw_mvp_onboarding_progress(state, step_index, &answers)?;
            Ok(json!({
                "success": true,
                "state": onboarding_state
            }))
        })(),
        "redclaw:profile:complete-initialization" => (|| {
            let answers = payload_field(payload, "answers")
                .cloned()
                .unwrap_or_else(|| json!({}));
            complete_redclaw_mvp_onboarding(app, state, &answers)
        })(),
        "redclaw:runner-start" => (|| {
            let status = with_store_mut(state, |store| {
                store.redclaw_state.enabled = true;
                store.redclaw_state.is_ticking = true;
                store.redclaw_state.last_tick_at = Some(now_iso());
                store.redclaw_state.next_tick_at = Some(now_iso());
                if store.redclaw_state.next_maintenance_at.is_none() {
                    store.redclaw_state.next_maintenance_at =
                        Some((now_i64() + 10 * 60 * 1000).to_string());
                }
                if let Some(interval) =
                    payload_field(payload, "intervalMinutes").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.interval_minutes = interval;
                }
                if let Some(max_auto) =
                    payload_field(payload, "maxAutomationPerTick").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.max_automation_per_tick = max_auto;
                }
                if let Some(heartbeat) =
                    payload_field(payload, "heartbeatEnabled").and_then(|v| v.as_bool())
                {
                    if let Some(object) = store.redclaw_state.heartbeat.as_object_mut() {
                        object.insert("enabled".to_string(), json!(heartbeat));
                    }
                }
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = ensure_redclaw_runtime_running(app, state)?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })(),
        "redclaw:runner-stop" => (|| {
            if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
                if let Some(mut runtime) = runtime_guard.take() {
                    stop_redclaw_runtime(&mut runtime);
                }
            }
            let status = with_store_mut(state, |store| {
                store.redclaw_state.enabled = false;
                store.redclaw_state.is_ticking = false;
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })(),
        "redclaw:runner-run-now" => (|| {
            let prompt = load_redbox_prompt_or_embedded(
                "runtime/redclaw/runner_run_now_default.txt",
                include_str!("../../../prompts/library/runtime/redclaw/runner_run_now_default.txt"),
            );
            let run_result = execute_redclaw_run(app, state, prompt, "runner-run-now")?;
            let status = with_store_mut(state, |store| {
                store.redclaw_state.last_tick_at = Some(now_iso());
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(json!({ "success": true, "status": status, "run": run_result }))
        })(),
        "redclaw:runner-set-project" => Ok(json!({ "success": true, "deprecated": true })),
        "redclaw:runner-set-config" => (|| {
            let status = with_store_mut(state, |store| {
                if let Some(interval) =
                    payload_field(payload, "intervalMinutes").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.interval_minutes = interval;
                }
                if let Some(max_auto) =
                    payload_field(payload, "maxAutomationPerTick").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.max_automation_per_tick = max_auto;
                }
                if let Some(object) = store.redclaw_state.heartbeat.as_object_mut() {
                    if let Some(value) =
                        payload_field(payload, "heartbeatEnabled").and_then(|v| v.as_bool())
                    {
                        object.insert("enabled".to_string(), json!(value));
                    }
                    if let Some(value) =
                        payload_field(payload, "heartbeatIntervalMinutes").and_then(|v| v.as_i64())
                    {
                        object.insert("intervalMinutes".to_string(), json!(value));
                    }
                    if let Some(value) = payload_field(payload, "heartbeatSuppressEmptyReport")
                        .and_then(|v| v.as_bool())
                    {
                        object.insert("suppressEmptyReport".to_string(), json!(value));
                    }
                    if let Some(value) = payload_field(payload, "heartbeatReportToMainSession")
                        .and_then(|v| v.as_bool())
                    {
                        object.insert("reportToMainSession".to_string(), json!(value));
                    }
                }
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })(),
        "redclaw:runner-list-scheduled" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.scheduled_tasks.clone()))
        }),
        "redclaw:runner-list-job-definitions" => with_store(state, |store| {
            Ok(json!(store.redclaw_job_definitions.clone()))
        }),
        "redclaw:runner-list-job-executions" => with_store(state, |store| {
            Ok(json!(store.redclaw_job_executions.clone()))
        }),
        "redclaw:task-preview" => handle_task_preview(app, state, payload),
        "redclaw:task-create" => handle_task_create(app, state, payload),
        "redclaw:task-confirm" => handle_task_confirm(app, state, payload),
        "redclaw:task-update" => handle_task_update(app, state, payload),
        "redclaw:task-cancel" => handle_task_cancel(app, state, payload),
        "redclaw:task-list" => handle_task_list(state, payload),
        "redclaw:task-stats" => handle_task_stats(state),
        "redclaw:runner-add-scheduled" => (|| {
            let enabled = payload_field(payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let result = create_confirmed_task_from_intent(
                app,
                state,
                TaskIntentSchema {
                    kind: "scheduled".to_string(),
                    intent: "legacy-ui-direct".to_string(),
                    name: payload_string(payload, "name").unwrap_or_else(|| "定时任务".to_string()),
                    action_type: payload_string(payload, "actionType")
                        .unwrap_or_else(|| "redclaw_prompt".to_string()),
                    owner_scope: payload_string(payload, "ownerScope")
                        .unwrap_or_else(|| "manual:redclaw".to_string()),
                    timezone: Some(
                        payload_string(payload, "timezone").unwrap_or_else(|| "local".to_string()),
                    ),
                    creator_mode: Some("ui-manual".to_string()),
                    created_by: Some("redclaw-panel".to_string()),
                    risk_rationale: payload_string(payload, "riskRationale"),
                    prompt: payload_string(payload, "prompt"),
                    mode: payload_string(payload, "mode"),
                    interval_minutes: payload_field(payload, "intervalMinutes")
                        .and_then(|v| v.as_i64()),
                    time: payload_string(payload, "time"),
                    weekdays: payload_field(payload, "weekdays")
                        .and_then(|v| v.as_array())
                        .map(|items| items.iter().filter_map(|i| i.as_i64()).collect()),
                    run_at: payload_string(payload, "runAt"),
                    missed_run_policy: payload_string(payload, "missedRunPolicy"),
                    metadata: payload_field(payload, "metadata").cloned(),
                    ..TaskIntentSchema::default()
                },
            )?;
            let source_task_id = result
                .get("definition")
                .and_then(|value| value.get("sourceTaskId"))
                .and_then(Value::as_str)
                .ok_or_else(|| "任务创建成功但缺少 sourceTaskId".to_string())?;
            let task = with_store_mut(state, |store| {
                if !enabled {
                    if let Some(item) = store
                        .redclaw_state
                        .scheduled_tasks
                        .iter_mut()
                        .find(|item| item.id == source_task_id)
                    {
                        item.enabled = false;
                        item.updated_at = now_iso();
                    }
                    sync_redclaw_job_definitions(store);
                }
                store
                    .redclaw_state
                    .scheduled_tasks
                    .iter()
                    .find(|item| item.id == source_task_id)
                    .cloned()
                    .ok_or_else(|| "任务创建成功但源记录不存在".to_string())
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(json!({ "success": true, "task": task }))
        })(),
        "redclaw:runner-remove-scheduled" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store
                    .redclaw_state
                    .scheduled_tasks
                    .retain(|item| item.id != task_id);
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state))) {
                        Ok(status) => {
                            let _ = app.emit("redclaw:runner-status", status);
                            Ok(result)
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "redclaw:runner-set-scheduled-enabled" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let enabled = payload_field(payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.enabled = enabled;
                    if enabled {
                        task.last_error = None;
                    }
                    task.updated_at = now_iso();
                }
                if enabled {
                    if let Some(definition) =
                        store.redclaw_job_definitions.iter_mut().find(|item| {
                            item.source_kind.as_deref() == Some("scheduled")
                                && item.source_task_id.as_deref() == Some(task_id.as_str())
                        })
                    {
                        clear_definition_cooldown(definition);
                    }
                }
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state))) {
                        Ok(status) => {
                            let _ = app.emit("redclaw:runner-status", status);
                            Ok(result)
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "redclaw:runner-run-scheduled-now" => (|| {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let execution_id = with_store_mut(state, |store| {
                sync_redclaw_job_definitions(store);
                enqueue_manual_job_execution_for_source(
                    store,
                    "scheduled",
                    &task_id,
                    "manual-scheduled-now",
                )
            })?;
            crate::events::emit_runtime_task_checkpoint_saved(
                app,
                Some(&execution_id),
                None,
                "task.enqueued",
                "Manual scheduled task execution enqueued",
                Some(json!({
                    "executionId": execution_id,
                    "sourceTaskId": task_id,
                    "trigger": "manual-scheduled-now",
                })),
            );
            let run_result = run_job_queue_once(app, state, Some(&execution_id))?
                .unwrap_or_else(|| json!({ "success": false, "executionId": execution_id, "status": "not-started" }));
            with_store_mut(state, |store| {
                sync_redclaw_job_definitions(store);
                Ok(())
            })?;
            emit_scheduler_snapshot(app, state);
            Ok(json!({ "success": true, "executionId": execution_id, "run": run_result }))
        })(),
        "redclaw:runner-list-long-cycle" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.long_cycle_tasks.clone()))
        }),
        "redclaw:runner-add-long-cycle" => (|| {
            let enabled = payload_field(payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let result = create_confirmed_task_from_intent(
                app,
                state,
                TaskIntentSchema {
                    kind: "long_cycle".to_string(),
                    intent: "legacy-ui-direct".to_string(),
                    name: payload_string(payload, "name")
                        .unwrap_or_else(|| "长周期任务".to_string()),
                    action_type: payload_string(payload, "actionType")
                        .unwrap_or_else(|| "long_cycle".to_string()),
                    owner_scope: payload_string(payload, "ownerScope")
                        .unwrap_or_else(|| "manual:redclaw".to_string()),
                    timezone: Some(
                        payload_string(payload, "timezone").unwrap_or_else(|| "local".to_string()),
                    ),
                    creator_mode: Some("ui-manual".to_string()),
                    created_by: Some("redclaw-panel".to_string()),
                    risk_rationale: payload_string(payload, "riskRationale"),
                    objective: payload_string(payload, "objective"),
                    step_prompt: payload_string(payload, "stepPrompt"),
                    interval_minutes: payload_field(payload, "intervalMinutes")
                        .and_then(|v| v.as_i64()),
                    total_rounds: payload_field(payload, "totalRounds").and_then(|v| v.as_i64()),
                    missed_run_policy: payload_string(payload, "missedRunPolicy"),
                    metadata: payload_field(payload, "metadata").cloned(),
                    ..TaskIntentSchema::default()
                },
            )?;
            let source_task_id = result
                .get("definition")
                .and_then(|value| value.get("sourceTaskId"))
                .and_then(Value::as_str)
                .ok_or_else(|| "任务创建成功但缺少 sourceTaskId".to_string())?;
            let task = with_store_mut(state, |store| {
                if !enabled {
                    if let Some(item) = store
                        .redclaw_state
                        .long_cycle_tasks
                        .iter_mut()
                        .find(|item| item.id == source_task_id)
                    {
                        item.enabled = false;
                        item.status = "paused".to_string();
                        item.updated_at = now_iso();
                    }
                    sync_redclaw_job_definitions(store);
                }
                store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter()
                    .find(|item| item.id == source_task_id)
                    .cloned()
                    .ok_or_else(|| "任务创建成功但源记录不存在".to_string())
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(json!({ "success": true, "task": task }))
        })(),
        "redclaw:runner-remove-long-cycle" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store
                    .redclaw_state
                    .long_cycle_tasks
                    .retain(|item| item.id != task_id);
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state))) {
                        Ok(status) => {
                            let _ = app.emit("redclaw:runner-status", status);
                            Ok(result)
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "redclaw:runner-set-long-cycle-enabled" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let enabled = payload_field(payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.enabled = enabled;
                    task.status = if enabled {
                        "running".to_string()
                    } else {
                        "paused".to_string()
                    };
                    if enabled {
                        task.last_error = None;
                    }
                    task.updated_at = now_iso();
                }
                if enabled {
                    if let Some(definition) =
                        store.redclaw_job_definitions.iter_mut().find(|item| {
                            item.source_kind.as_deref() == Some("long_cycle")
                                && item.source_task_id.as_deref() == Some(task_id.as_str())
                        })
                    {
                        clear_definition_cooldown(definition);
                    }
                }
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state))) {
                        Ok(status) => {
                            let _ = app.emit("redclaw:runner-status", status);
                            Ok(result)
                        }
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        }
        "redclaw:runner-run-long-cycle-now" => (|| {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let execution_id = with_store_mut(state, |store| {
                sync_redclaw_job_definitions(store);
                enqueue_manual_job_execution_for_source(
                    store,
                    "long_cycle",
                    &task_id,
                    "manual-long-cycle-now",
                )
            })?;
            crate::events::emit_runtime_task_checkpoint_saved(
                app,
                Some(&execution_id),
                None,
                "task.enqueued",
                "Manual long-cycle execution enqueued",
                Some(json!({
                    "executionId": execution_id,
                    "sourceTaskId": task_id,
                    "trigger": "manual-long-cycle-now",
                })),
            );
            let run_result = run_job_queue_once(app, state, Some(&execution_id))?
                    .unwrap_or_else(|| json!({ "success": false, "executionId": execution_id, "status": "not-started" }));
            with_store_mut(state, |store| {
                sync_redclaw_job_definitions(store);
                Ok(())
            })?;
            emit_scheduler_snapshot(app, state);
            Ok(json!({ "success": true, "executionId": execution_id, "run": run_result }))
        })(),
        _ => return None,
    };
    Some(result)
}

fn update_redclaw_learning_candidate(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let candidate_id = payload_string(payload, "candidateId")
        .ok_or_else(|| "candidateId is required".to_string())?;
    let status = payload_string(payload, "status").unwrap_or_else(|| "accepted".to_string());
    if !matches!(status.as_str(), "accepted" | "rejected" | "pending") {
        return Err("status must be accepted, rejected, or pending".to_string());
    }
    with_store_mut(state, |store| {
        let project = store
            .redclaw_state
            .projects
            .iter_mut()
            .find(|item| item.id == project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())?;
        let candidate = project
            .learning_candidates
            .iter_mut()
            .find(|item| {
                item.get("id").and_then(Value::as_str).map(str::trim) == Some(candidate_id.as_str())
            })
            .ok_or_else(|| "learning candidate not found".to_string())?;
        if let Some(object) = candidate.as_object_mut() {
            object.insert("status".to_string(), json!(status.clone()));
            object.insert("updatedAt".to_string(), json!(now_iso()));
        }
        let candidate_snapshot = candidate.clone();
        if status == "accepted" {
            let statement = candidate_snapshot
                .get("statement")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .unwrap_or("RedClaw learning candidate accepted")
                .to_string();
            store.memories.push(crate::UserMemoryRecord {
                id: crate::make_id("memory"),
                content: statement,
                r#type: "redclaw_learning".to_string(),
                tags: vec!["redclaw".to_string(), "learning".to_string()],
                entities: Vec::new(),
                scope: Some(
                    candidate_snapshot
                        .get("scope")
                        .and_then(Value::as_str)
                        .unwrap_or("project")
                        .to_string(),
                ),
                space_id: Some(store.active_space_id.clone()),
                project_id: Some(project_id.clone()),
                session_id: None,
                source: Some(json!({
                    "kind": "redclaw_learning_candidate",
                    "projectId": project_id,
                    "candidateId": candidate_id,
                    "candidate": candidate_snapshot,
                })),
                confidence: candidate_snapshot.get("confidence").and_then(Value::as_f64),
                created_at: now_i64(),
                updated_at: None,
                last_accessed: None,
                status: Some("active".to_string()),
                archived_at: None,
                archive_reason: None,
                origin_id: None,
                canonical_key: None,
                revision: Some(1),
                last_conflict_at: None,
            });
        }
        project.updated_at = now_iso();
        Ok(json!({
            "success": true,
            "project": project,
            "candidate": candidate_snapshot
        }))
    })
}

fn update_redclaw_project_section(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let section_id =
        payload_string(payload, "sectionId").ok_or_else(|| "sectionId is required".to_string())?;
    let content =
        payload_string(payload, "content").ok_or_else(|| "content is required".to_string())?;
    let allowed = [
        "brief",
        "script",
        "storyboard",
        "media",
        "publish",
        "review",
        "research",
    ];
    if !allowed.iter().any(|item| item == &section_id.as_str()) {
        return Err("sectionId is not supported".to_string());
    }
    with_store_mut(state, |store| {
        let project = store
            .redclaw_state
            .projects
            .iter_mut()
            .find(|item| item.id == project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())?;
        let now = now_iso();
        let mut metadata = project
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut drafts = metadata
            .get("sectionDrafts")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        drafts.insert(
            section_id.clone(),
            json!({
                "content": content,
                "updatedAt": now,
                "source": "user_edit"
            }),
        );
        metadata.insert("sectionDrafts".to_string(), Value::Object(drafts));
        project.metadata = Some(Value::Object(metadata));
        project.updated_at = now;
        Ok(json!({
            "success": true,
            "project": project,
            "sectionId": section_id
        }))
    })
}

fn redclaw_agent_role_id(agent_id: &RedclawAgentId) -> &'static str {
    match agent_id {
        RedclawAgentId::ResearchAgent => "research_agent",
        RedclawAgentId::InsightAgent => "insight_agent",
        RedclawAgentId::ScriptAgent => "script_agent",
        RedclawAgentId::StoryboardAgent => "storyboard_agent",
        RedclawAgentId::MediaAgent => "media_agent",
        RedclawAgentId::EditorAgent => "editor_agent",
        RedclawAgentId::PublishAgent => "publish_agent",
        RedclawAgentId::ReviewAgent => "review_agent",
    }
}

fn redclaw_agent_display_name(agent_id: &RedclawAgentId) -> &'static str {
    match agent_id {
        RedclawAgentId::ResearchAgent => "Research Agent",
        RedclawAgentId::InsightAgent => "Insight Agent",
        RedclawAgentId::ScriptAgent => "Script Agent",
        RedclawAgentId::StoryboardAgent => "Storyboard Agent",
        RedclawAgentId::MediaAgent => "Media Agent",
        RedclawAgentId::EditorAgent => "Editor Agent",
        RedclawAgentId::PublishAgent => "Publish Agent",
        RedclawAgentId::ReviewAgent => "Review Agent",
    }
}

fn create_redclaw_orchestration_team(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let plan = plan_redclaw_orchestration(payload)?;
    with_store_mut(state, |store| {
        let (session_id, snapshot) = create_redclaw_team_records(store, &plan, None)?;
        Ok(json!({
            "success": true,
            "runId": plan.run_id,
            "sessionId": session_id,
            "graph": plan.graph,
            "snapshot": snapshot
        }))
    })
}

fn redclaw_plan_role_ids(plan: &RedclawOrchestrationPlan) -> Vec<String> {
    let mut roles = Vec::new();
    for node in &plan.graph.nodes {
        let role_id = redclaw_agent_role_id(&node.agent_id).to_string();
        if !roles.iter().any(|existing| existing == &role_id) {
            roles.push(role_id);
        }
    }
    roles
}

fn create_redclaw_team_records(
    store: &mut crate::AppStore,
    plan: &RedclawOrchestrationPlan,
    source_task_id: Option<&str>,
) -> Result<(String, CollabSessionSnapshot), String> {
    let session = create_collab_session(
        store,
        &json!({
            "title": "RedClaw 临时创作团队",
            "objective": plan.graph.goal,
            "runtimeMode": "redclaw",
            "source": "redclaw-orchestrator",
            "metadata": {
                "runId": plan.run_id,
                "graphId": plan.graph.id,
                "sourceTaskId": source_task_id,
                "temporaryTeam": true,
                "releasePolicy": plan.release_policy
            }
        }),
    )?;

    let mut member_by_role = std::collections::HashMap::<String, String>::new();
    for spec in &plan.agent_specs {
        let role_id = redclaw_agent_role_id(&spec.id).to_string();
        if member_by_role.contains_key(&role_id) {
            continue;
        }
        let member = add_collab_member(
            store,
            &json!({
                "sessionId": session.id,
                "displayName": redclaw_agent_display_name(&spec.id),
                "roleId": role_id,
                "sourceKind": "ephemeral_subagent_spec",
                "backend": "redclaw-orchestrator",
                "adapterKind": "internal",
                "status": "idle",
                "capabilities": &spec.allowed_skills,
                "allowedTools": &spec.allowed_tools,
                "metadata": {
                    "temporary": true,
                    "memoryScopes": &spec.readable_memory_scopes,
                    "outputSchema": &spec.output_schema
                }
            }),
        )?;
        member_by_role.insert(role_id, member.id);
    }

    let mut task_by_node = std::collections::HashMap::<String, String>::new();
    for node in &plan.graph.nodes {
        let role_id = redclaw_agent_role_id(&node.agent_id);
        let member_id = member_by_role
            .get(role_id)
            .ok_or_else(|| format!("missing member for role {role_id}"))?;
        let depends_on_task_ids = plan
            .graph
            .edges
            .iter()
            .filter(|edge| edge.to == node.id)
            .filter_map(|edge| task_by_node.get(&edge.from).cloned())
            .collect::<Vec<_>>();
        let task = create_collab_task(
            store,
            &json!({
                "sessionId": session.id,
                "memberId": member_id,
                "title": node.title,
                "objective": format!("{}：{}", node.title, plan.graph.goal),
                "description": format!("使用 {} 输出 {}", node.skill_ids.join(", "), node.output_schema),
                "status": "todo",
                "priority": if role_id == "review_agent" { 1 } else { 0 },
                "taskType": "redclaw_orchestration_node",
                "dependsOnTaskIds": depends_on_task_ids,
                "runtimeTaskId": source_task_id,
                "metadata": {
                    "runId": plan.run_id,
                    "graphId": plan.graph.id,
                    "nodeId": node.id,
                    "agentId": role_id,
                    "skillIds": &node.skill_ids,
                    "requiredArtifacts": &node.required_artifacts,
                    "outputSchema": &node.output_schema,
                    "temporaryTeam": true
                }
            }),
        )?;
        task_by_node.insert(node.id.clone(), task.id);
    }

    let snapshot = collab_session_snapshot(store, &session.id, Some(100), Some(100))
        .ok_or_else(|| "created RedClaw team session could not be reloaded".to_string())?;
    Ok((session.id, snapshot))
}

fn create_redclaw_orchestration_run(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let plan = plan_redclaw_orchestration(payload)?;
    let owner_session_id = payload_string(payload, "sessionId");
    let project_id = payload_string(payload, "projectId")
        .unwrap_or_else(|| format!("redclaw-project:{}", plan.run_id));
    with_store_mut(state, |store| {
        let metadata = json!({
            "source": "redclaw-orchestrator",
            "intent": "redclaw_orchestration",
            "preferredRole": "ops-coordinator",
            "runId": plan.run_id,
            "graphId": plan.graph.id,
            "projectId": project_id,
            "redclawTaskGraph": &plan.graph,
            "subagentRoles": redclaw_plan_role_ids(&plan),
            "forceMultiAgent": true,
            "useRealSubagents": true,
            "temporaryTeam": true,
            "releasePolicy": plan.release_policy
        });
        let route = runtime_direct_route_record("redclaw", &plan.graph.goal, Some(&metadata));
        let task = store_runtime_task(
            store,
            "redclaw_orchestration",
            "pending",
            "redclaw".to_string(),
            owner_session_id,
            Some(plan.graph.goal.clone()),
            route,
            Some(metadata),
        );
        let (session_id, snapshot) = create_redclaw_team_records(store, &plan, Some(&task.id))?;
        Ok(json!({
            "success": true,
            "runId": plan.run_id,
            "runtimeTaskId": task.id,
            "sessionId": session_id,
            "graph": plan.graph,
            "snapshot": snapshot,
            "task": task
        }))
    })
}
