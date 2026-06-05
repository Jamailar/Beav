#[path = "redclaw_task_control.rs"]
pub(crate) mod redclaw_task_control;

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::redclaw_runtime::{
    append_redclaw_automation_user_message, ensure_redclaw_task_session_record, execute_redclaw_run,
};
use crate::persistence::{ensure_store_hydrated_for_redclaw, with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, collab_session_snapshot, create_collab_session, create_collab_task,
    plan_redclaw_orchestration, redclaw_orchestration_registry_value, runtime_direct_route_record,
    store_runtime_task, CollabSessionSnapshot, RedclawAgentId, RedclawOrchestrationPlan,
    RedclawRuntime,
};
use crate::scheduler::task_policy::TaskIntentSchema;
use crate::scheduler::{
    clear_definition_cooldown, emit_scheduler_snapshot,
    enqueue_manual_job_execution_for_definition, run_job_queue_once, run_redclaw_job_runner,
    run_redclaw_scheduler, sync_redclaw_job_definitions,
};
use crate::store::{redclaw as redclaw_store, spaces as spaces_store};
use crate::{
    complete_redclaw_mvp_onboarding, complete_redclaw_style_definition_from_interview,
    ffmpeg_executable, handle_redclaw_onboarding_turn, load_redbox_prompt_or_embedded,
    load_redclaw_onboarding_state, load_redclaw_profile_prompt_bundle, load_redclaw_style_profile,
    mark_redclaw_style_definition_started, now_i64, now_iso, parse_json_value_from_text,
    payload_field, payload_string, save_redclaw_mvp_onboarding_progress,
    update_redclaw_profile_doc, workspace_root, write_text_file, AppState,
};
use redclaw_task_control::{
    create_confirmed_task_from_intent, handle_task_cancel, handle_task_confirm, handle_task_create,
    handle_task_list, handle_task_preview, handle_task_stats, handle_task_update,
};

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn runner_config_patch_from_payload(payload: &Value) -> redclaw_store::RunnerConfigPatch {
    redclaw_store::RunnerConfigPatch {
        interval_minutes: payload_field(payload, "intervalMinutes").and_then(|v| v.as_i64()),
        max_automation_per_tick: payload_field(payload, "maxAutomationPerTick")
            .and_then(|v| v.as_i64()),
        heartbeat_enabled: payload_field(payload, "heartbeatEnabled").and_then(|v| v.as_bool()),
        heartbeat_interval_minutes: payload_field(payload, "heartbeatIntervalMinutes")
            .and_then(|v| v.as_i64()),
        heartbeat_suppress_empty_report: payload_field(payload, "heartbeatSuppressEmptyReport")
            .and_then(|v| v.as_bool()),
        heartbeat_report_to_main_session: payload_field(payload, "heartbeatReportToMainSession")
            .and_then(|v| v.as_bool()),
    }
}

fn require_confirmed_redclaw_team_plan(payload: &Value) -> Result<(), String> {
    if payload_bool(payload, "userConfirmedTeamPlan")
        || payload
            .get("metadata")
            .map(|metadata| payload_bool(metadata, "userConfirmedTeamPlan"))
            .unwrap_or(false)
    {
        return Ok(());
    }
    Err("创建 team 前必须先向用户列出团队成员和分工，并等待用户明确确认。确认后再传入 userConfirmedTeamPlan=true。".to_string())
}

pub(crate) fn redclaw_runner_status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_redclaw(state);
    with_store(state, |store| Ok(redclaw_store::state_value(&store)))
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
    let (should_run, should_recover_tick) = with_store(state, |store| {
        Ok(redclaw_store::runtime_start_decision(&store))
    })?;

    if should_recover_tick {
        let _ = with_store_mut(state, |store| {
            redclaw_store::recover_ticking_if_needed(store);
            Ok(())
        });
    }

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

fn resolve_task_definition_id_for_manual_run(
    store: &crate::AppStore,
    source_kind: &str,
    task_id: &str,
) -> Result<String, String> {
    let definitions = redclaw_store::list_job_definitions(store);
    if let Some(definition) = definitions
        .iter()
        .find(|item| item.id == task_id && item.source_kind.as_deref() == Some(source_kind))
    {
        return Ok(definition.id.clone());
    }

    if let Some(definition) = definitions.iter().find(|item| {
        item.source_kind.as_deref() == Some(source_kind)
            && item.source_task_id.as_deref() == Some(task_id)
    }) {
        return Ok(definition.id.clone());
    }

    Err("任务未找到".to_string())
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
            let projects = redclaw_store::list_projects_sorted(&store);
            Ok(json!({ "success": true, "items": projects, "count": projects.len() }))
        }),
        "redclaw:orchestration-plan" => plan_redclaw_orchestration(payload).map(|plan| json!(plan)),
        "redclaw:orchestration-registry" => Ok(redclaw_orchestration_registry_value()),
        "redclaw:orchestration-create-run" => create_redclaw_orchestration_run(state, payload),
        "redclaw:learning-candidate-update" => update_redclaw_learning_candidate(state, payload),
        "redclaw:project-section-update" => update_redclaw_project_section(state, payload),
        "redclaw:media-plan-export" => export_redclaw_media_plan(state, payload),
        "redclaw:media-plan-render" => render_redclaw_rough_cut(app, state, payload),
        "redclaw:publish-package-export" => export_redclaw_publish_package(state, payload),
        "redclaw:review-report-export" => export_redclaw_review_report(state, payload),
        "redclaw:xhs-package-export" => export_redclaw_xhs_package(state, payload),
        "redclaw:profile:get-bundle" => (|| {
            let bundle = load_redclaw_profile_prompt_bundle(state)?;
            let active_space_id =
                crate::with_store(state, |store| Ok(spaces_store::active_space_id(&store)))?;
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
        "redclaw:profile:start-style-definition" => (|| {
            let force_restart = payload_field(payload, "forceRestart")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let source = payload_string(payload, "source").unwrap_or_else(|| "manual".to_string());
            let session_id = payload_string(payload, "sessionId");
            let onboarding_state = mark_redclaw_style_definition_started(
                state,
                session_id.as_deref(),
                &source,
                force_restart,
            )?;
            Ok(json!({
                "success": true,
                "state": onboarding_state
            }))
        })(),
        "redclaw:profile:complete-style-definition" => {
            complete_redclaw_style_definition_from_interview(state, payload)
        }
        "redclaw:runner-start" => (|| {
            let patch = runner_config_patch_from_payload(payload);
            let status = with_store_mut(state, |store| {
                Ok(redclaw_store::start_runner(
                    store,
                    now_iso(),
                    (now_i64() + 10 * 60 * 1000).to_string(),
                    patch,
                ))
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
            let status = with_store_mut(state, |store| Ok(redclaw_store::stop_runner(store)))?;
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
                Ok(redclaw_store::mark_runner_tick(store, now_iso()))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(json!({ "success": true, "status": status, "run": run_result }))
        })(),
        "redclaw:runner-set-project" => Ok(json!({ "success": true, "deprecated": true })),
        "redclaw:runner-set-config" => (|| {
            let patch = runner_config_patch_from_payload(payload);
            let status = with_store_mut(state, |store| {
                Ok(redclaw_store::apply_runner_config(store, patch))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })(),
        "redclaw:runner-list-scheduled" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_scheduled_tasks(&store)))
        }),
        "redclaw:runner-list-job-definitions" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_job_definitions(&store)))
        }),
        "redclaw:runner-list-job-executions" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_job_executions(&store)))
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
                    redclaw_store::set_scheduled_task_enabled(
                        store,
                        source_task_id,
                        false,
                        &now_iso(),
                    );
                    sync_redclaw_job_definitions(store);
                }
                redclaw_store::scheduled_task_by_id(store, source_task_id)
                    .ok_or_else(|| "任务创建成功但源记录不存在".to_string())
            })?;
            let status = with_store(state, |store| Ok(redclaw_store::state_value(&store)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(json!({ "success": true, "task": task }))
        })(),
        "redclaw:runner-remove-scheduled" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                redclaw_store::remove_scheduled_task(store, &task_id);
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_store::state_value(&store))) {
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
                redclaw_store::set_scheduled_task_enabled(store, &task_id, enabled, &now_iso());
                if enabled {
                    redclaw_store::update_job_definition_by_source(
                        store,
                        "scheduled",
                        &task_id,
                        |definition| {
                            clear_definition_cooldown(definition);
                        },
                    );
                }
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_store::state_value(&store))) {
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
            let (execution_id, resolved_definition_id, source_task_id, title, prompt): (
                String,
                String,
                String,
                String,
                String,
            ) = with_store_mut(
                state,
                |store| -> Result<(String, String, String, String, String), String> {
                    sync_redclaw_job_definitions(store);
                    let definition_id =
                        resolve_task_definition_id_for_manual_run(store, "scheduled", &task_id)?;
                    let execution_id = enqueue_manual_job_execution_for_definition(
                        store,
                        &definition_id,
                        "manual-scheduled-now",
                    )?;
                    let definition = redclaw_store::job_definition_by_id(store, &definition_id)
                        .ok_or_else(|| "未找到定时任务定义".to_string())?;
                    Ok((
                        execution_id,
                        definition_id,
                        definition
                            .source_task_id
                            .clone()
                            .unwrap_or_else(|| task_id.clone()),
                        definition.title.clone(),
                        definition
                            .payload
                            .get("prompt")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    ))
                },
            )?;
            let session_id = ensure_redclaw_task_session_record(
                state,
                Some("scheduled"),
                Some(&source_task_id),
                &title,
            )?;
            append_redclaw_automation_user_message(state, &session_id, &prompt, &execution_id)?;
            crate::events::emit_runtime_task_checkpoint_saved(
                app,
                Some(&execution_id),
                Some(&resolved_definition_id),
                "task.enqueued",
                "Manual scheduled task execution enqueued",
                Some(json!({
                    "executionId": execution_id,
                    "sourceTaskId": task_id,
                    "definitionId": resolved_definition_id.clone(),
                    "trigger": "manual-scheduled-now",
                    "sessionId": session_id,
                })),
            );
            let app_for_run = app.clone();
            let execution_id_for_run = execution_id.clone();
            tauri::async_runtime::spawn(async move {
                let managed_state = app_for_run.state::<AppState>();
                if let Err(error) =
                    run_job_queue_once(&app_for_run, &managed_state, Some(&execution_id_for_run))
                {
                    eprintln!("[redclaw][manual-run] scheduled execution failed: {error}");
                }
                let _ = with_store_mut(&managed_state, |store| {
                    sync_redclaw_job_definitions(store);
                    Ok(())
                });
                emit_scheduler_snapshot(&app_for_run, &managed_state);
            });
            emit_scheduler_snapshot(app, state);
            Ok(json!({
                "success": true,
                "executionId": execution_id,
                "sessionId": session_id.clone(),
                "run": {
                    "queued": true,
                    "sessionId": session_id,
                }
            }))
        })(),
        "redclaw:runner-run-long-cycle-now" => (|| {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let (execution_id, resolved_definition_id, source_task_id, title, prompt): (
                String,
                String,
                String,
                String,
                String,
            ) = with_store_mut(
                state,
                |store| -> Result<(String, String, String, String, String), String> {
                    sync_redclaw_job_definitions(store);
                    let definition_id =
                        resolve_task_definition_id_for_manual_run(store, "long_cycle", &task_id)?;
                    let execution_id = enqueue_manual_job_execution_for_definition(
                        store,
                        &definition_id,
                        "manual-long-cycle-now",
                    )?;
                    let definition = redclaw_store::job_definition_by_id(store, &definition_id)
                        .ok_or_else(|| "未找到长期任务定义".to_string())?;
                    Ok((
                        execution_id,
                        definition_id,
                        definition
                            .source_task_id
                            .clone()
                            .unwrap_or_else(|| task_id.clone()),
                        definition.title.clone(),
                        {
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
                        },
                    ))
                },
            )?;
            let session_id = ensure_redclaw_task_session_record(
                state,
                Some("long_cycle"),
                Some(&source_task_id),
                &title,
            )?;
            append_redclaw_automation_user_message(state, &session_id, &prompt, &execution_id)?;
            crate::events::emit_runtime_task_checkpoint_saved(
                app,
                Some(&execution_id),
                Some(&resolved_definition_id),
                "task.enqueued",
                "Manual long-cycle execution enqueued",
                Some(json!({
                    "executionId": execution_id,
                    "sourceTaskId": task_id,
                    "definitionId": resolved_definition_id.clone(),
                    "trigger": "manual-long-cycle-now",
                    "sessionId": session_id,
                })),
            );
            let app_for_run = app.clone();
            let execution_id_for_run = execution_id.clone();
            tauri::async_runtime::spawn(async move {
                let managed_state = app_for_run.state::<AppState>();
                if let Err(error) =
                    run_job_queue_once(&app_for_run, &managed_state, Some(&execution_id_for_run))
                {
                    eprintln!("[redclaw][manual-run] long-cycle execution failed: {error}");
                }
                let _ = with_store_mut(&managed_state, |store| {
                    sync_redclaw_job_definitions(store);
                    Ok(())
                });
                emit_scheduler_snapshot(&app_for_run, &managed_state);
            });
            emit_scheduler_snapshot(app, state);
            Ok(json!({
                "success": true,
                "executionId": execution_id,
                "sessionId": session_id.clone(),
                "run": {
                    "queued": true,
                    "sessionId": session_id,
                }
            }))
        })(),
        "redclaw:runner-list-long-cycle" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_long_cycle_tasks(&store)))
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
                    redclaw_store::set_long_cycle_task_enabled(
                        store,
                        source_task_id,
                        false,
                        &now_iso(),
                    );
                    sync_redclaw_job_definitions(store);
                }
                redclaw_store::long_cycle_task_by_id(store, source_task_id)
                    .ok_or_else(|| "任务创建成功但源记录不存在".to_string())
            })?;
            let status = with_store(state, |store| Ok(redclaw_store::state_value(&store)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(json!({ "success": true, "task": task }))
        })(),
        "redclaw:runner-remove-long-cycle" => {
            let task_id = payload_string(payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                redclaw_store::remove_long_cycle_task(store, &task_id);
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_store::state_value(&store))) {
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
                redclaw_store::set_long_cycle_task_enabled(store, &task_id, enabled, &now_iso());
                if enabled {
                    redclaw_store::update_job_definition_by_source(
                        store,
                        "long_cycle",
                        &task_id,
                        |definition| {
                            clear_definition_cooldown(definition);
                        },
                    );
                }
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true }))
            });
            match result {
                Ok(result) => {
                    match with_store(state, |store| Ok(redclaw_store::state_value(&store))) {
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
        let active_space_id = spaces_store::active_space_id(store);
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
                space_id: Some(active_space_id),
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

fn safe_export_slug(value: &str) -> String {
    let mut slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "redclaw-project".to_string()
    } else {
        slug
    }
}

fn output_for_role(outputs: &[Value], role_id: &str) -> Option<Value> {
    outputs
        .iter()
        .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
        .cloned()
}

fn parsed_output_artifact(output: Option<&Value>) -> Value {
    let Some(output) = output else {
        return Value::Null;
    };
    let artifact = output
        .get("artifact")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if artifact.is_empty() {
        return Value::Null;
    }
    parse_json_value_from_text(artifact).unwrap_or_else(|| json!({ "raw": artifact }))
}

fn redclaw_output_summary(output: Option<&Value>) -> Value {
    let Some(output) = output else {
        return Value::Null;
    };
    json!({
        "roleId": output.get("roleId").cloned().unwrap_or(Value::Null),
        "summary": output.get("summary").cloned().unwrap_or(Value::Null),
        "artifact": output.get("artifact").cloned().unwrap_or(Value::Null),
        "handoff": output.get("handoff").cloned().unwrap_or(Value::Null),
        "risks": output.get("risks").cloned().unwrap_or_else(|| json!([])),
        "issues": output.get("issues").cloned().unwrap_or_else(|| json!([])),
    })
}

fn orchestration_outputs_for_project(project: &crate::runtime::RedclawProjectRecord) -> Vec<Value> {
    project
        .metadata
        .as_ref()
        .and_then(|value| value.get("orchestrationOutputs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    if item.is_object() {
                        Some(item.to_string())
                    } else {
                        None
                    }
                })
        })
        .collect()
}

fn first_string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

fn publish_package_from_project(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let publish = output_for_role(&outputs, "publish_agent");
    let publish_artifact = parsed_output_artifact(publish.as_ref());
    let raw_artifact = publish
        .as_ref()
        .and_then(|value| value.get("artifact"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let title_options = publish_artifact
        .get("titleOptions")
        .or_else(|| publish_artifact.get("titles"))
        .or_else(|| publish_artifact.get("title_options"));
    let cover_options = publish_artifact
        .get("coverOptions")
        .or_else(|| publish_artifact.get("coverCopy"))
        .or_else(|| publish_artifact.get("cover"))
        .or_else(|| publish_artifact.get("cover_options"));
    let body = first_string_field(
        &publish_artifact,
        &["body", "caption", "postBody", "正文", "copy"],
    )
    .or_else(|| {
        publish
            .as_ref()
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
    .unwrap_or_else(|| raw_artifact.to_string());
    json!({
        "schema": "redclaw.publishPackage.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
        },
        "generatedAt": now_iso(),
        "titleOptions": value_string_list(title_options),
        "coverOptions": value_string_list(cover_options),
        "body": body,
        "hashtags": value_string_list(
            publish_artifact.get("hashtags")
                .or_else(|| publish_artifact.get("tags"))
        ),
        "checklist": value_string_list(publish_artifact.get("checklist")),
        "raw": publish_artifact,
        "source": redclaw_output_summary(publish.as_ref()),
    })
}

fn markdown_list(items: &[String], empty: &str) -> String {
    if items.is_empty() {
        format!("- {empty}\n")
    } else {
        items
            .iter()
            .map(|item| format!("- {item}\n"))
            .collect::<String>()
    }
}

fn build_publish_package_markdown(package: &Value) -> String {
    let titles = value_string_list(package.get("titleOptions"));
    let covers = value_string_list(package.get("coverOptions"));
    let hashtags = value_string_list(package.get("hashtags"));
    let checklist = value_string_list(package.get("checklist"));
    let body = package
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let project = package.get("project").cloned().unwrap_or_else(|| json!({}));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw Publish Package\n\n");
    markdown.push_str(&format!(
        "Project: `{}`\n\n",
        project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    ));
    markdown.push_str("## Titles\n\n");
    markdown.push_str(&markdown_list(&titles, "No title options generated."));
    markdown.push_str("\n## Cover Copy\n\n");
    markdown.push_str(&markdown_list(&covers, "No cover copy generated."));
    markdown.push_str("\n## Body\n\n");
    markdown.push_str(if body.is_empty() {
        "No body generated."
    } else {
        body
    });
    markdown.push_str("\n\n## Hashtags\n\n");
    markdown.push_str(&markdown_list(&hashtags, "No hashtags generated."));
    markdown.push_str("\n## Checklist\n\n");
    markdown.push_str(&markdown_list(&checklist, "No checklist generated."));
    markdown
}

fn build_cover_brief_markdown(package: &Value) -> String {
    let titles = value_string_list(package.get("titleOptions"));
    let covers = value_string_list(package.get("coverOptions"));
    let project = package.get("project").cloned().unwrap_or_else(|| json!({}));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw Cover Brief\n\n");
    markdown.push_str(&format!(
        "Platform: {}\n\n",
        project
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("auto")
    ));
    markdown.push_str("## Primary Title Candidates\n\n");
    markdown.push_str(&markdown_list(&titles, "No title options generated."));
    markdown.push_str("\n## Cover Text Candidates\n\n");
    markdown.push_str(&markdown_list(&covers, "No cover copy generated."));
    markdown.push_str("\n## Visual Direction\n\nUse the creator profile, platform fit, and selected title to generate a clean cover image. Keep text legible on mobile.\n");
    markdown
}

fn review_report_from_project(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let editor = output_for_role(&outputs, "editor_agent");
    let review = output_for_role(&outputs, "review_agent");
    let review_artifact = parsed_output_artifact(review.as_ref());
    let quality_score = review_artifact
        .get("qualityScore")
        .or_else(|| review_artifact.get("score"))
        .cloned()
        .unwrap_or(Value::Null);
    let blocking_issues = value_string_list(
        review_artifact
            .get("blockingIssues")
            .or_else(|| review_artifact.get("issues"))
            .or_else(|| review.as_ref().and_then(|value| value.get("issues"))),
    );
    let suggested_patches = review_artifact
        .get("suggestedPatches")
        .or_else(|| review_artifact.get("patches"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let learning_candidates = review
        .as_ref()
        .and_then(|value| value.get("learningCandidates"))
        .or_else(|| review_artifact.get("learningCandidates"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let summary = first_string_field(
        &review_artifact,
        &["summary", "conclusion", "overall", "reviewSummary"],
    )
    .or_else(|| {
        review
            .as_ref()
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
    .unwrap_or_default();
    json!({
        "schema": "redclaw.reviewReport.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
        },
        "generatedAt": now_iso(),
        "summary": summary,
        "qualityScore": quality_score,
        "blockingIssues": blocking_issues,
        "suggestedPatches": suggested_patches,
        "learningCandidates": learning_candidates,
        "sources": {
            "editor": redclaw_output_summary(editor.as_ref()),
            "review": redclaw_output_summary(review.as_ref()),
        },
        "raw": review_artifact,
    })
}

fn markdown_json_block(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn build_review_report_markdown(report: &Value) -> String {
    let issues = value_string_list(report.get("blockingIssues"));
    let summary = report
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let project = report.get("project").cloned().unwrap_or_else(|| json!({}));
    let quality_score = report.get("qualityScore").cloned().unwrap_or(Value::Null);
    let suggested_patches = report
        .get("suggestedPatches")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let learning_candidates = report
        .get("learningCandidates")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw Review Report\n\n");
    markdown.push_str(&format!(
        "Project: `{}`\n\n",
        project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    ));
    markdown.push_str("## Summary\n\n");
    markdown.push_str(if summary.is_empty() {
        "No review summary generated."
    } else {
        summary
    });
    markdown.push_str("\n\n## Quality Score\n\n```json\n");
    markdown.push_str(&markdown_json_block(&quality_score));
    markdown.push_str("\n```\n\n## Blocking Issues\n\n");
    markdown.push_str(&markdown_list(&issues, "No blocking issues generated."));
    markdown.push_str("\n## Suggested Patches\n\n```json\n");
    markdown.push_str(&markdown_json_block(&suggested_patches));
    markdown.push_str("\n```\n\n## Learning Candidates\n\n```json\n");
    markdown.push_str(&markdown_json_block(&learning_candidates));
    markdown.push_str("\n```\n");
    markdown
}

fn artifact_for_role(outputs: &[Value], role_id: &str) -> Value {
    parsed_output_artifact(output_for_role(outputs, role_id).as_ref())
}

fn xhs_text_sources_for_compliance(package: &Value) -> Vec<(String, String)> {
    let mut sources = Vec::new();
    if let Some(copy) = package.get("copyPackage") {
        for title in value_string_list(copy.get("titles")) {
            sources.push(("title".to_string(), title));
        }
        for key in ["coverTitle", "openingHook", "body", "cta", "commentPrompt"] {
            if let Some(value) = copy
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                sources.push((key.to_string(), value.to_string()));
            }
        }
    }
    if let Some(publish) = package.get("publishPackage") {
        for title in value_string_list(publish.get("titleOptions")) {
            sources.push(("publishTitle".to_string(), title));
        }
        for key in ["body", "caption", "postBody"] {
            if let Some(value) = publish
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                sources.push((format!("publish.{key}"), value.to_string()));
            }
        }
    }
    sources
}

fn contains_any_term(text: &str, terms: &[&str]) -> Vec<String> {
    terms
        .iter()
        .filter(|term| text.contains(**term))
        .map(|term| term.to_string())
        .collect()
}

fn deterministic_xhs_compliance(package: &Value) -> Value {
    let absolute_terms = [
        "最强",
        "最佳",
        "最好",
        "最全",
        "最高",
        "第一",
        "顶级",
        "唯一",
        "永久",
        "100%",
        "百分百",
        "保证",
        "必看",
    ];
    let medical_terms = ["治愈", "根治", "疗效", "药到病除", "无副作用"];
    let finance_terms = ["稳赚", "保本", "暴富", "翻倍收益", "稳赚不赔"];
    let legal_terms = ["合法保证", "绝对合规", "零风险"];
    let commercial_terms = ["广告", "赞助", "合作", "佣金"];
    let mut sensitive_terms = Vec::<Value>::new();
    let mut blocking_issues = Vec::<Value>::new();
    let mut suggested_rewrites = Vec::<Value>::new();

    for (field, text) in xhs_text_sources_for_compliance(package) {
        let mut field_terms = Vec::new();
        for term in contains_any_term(&text, &absolute_terms) {
            field_terms.push(term.clone());
            suggested_rewrites.push(json!({
                "field": field,
                "term": term,
                "suggestion": "Replace absolute wording with evidence-backed, conditional wording."
            }));
        }
        for term in contains_any_term(&text, &medical_terms) {
            field_terms.push(term.clone());
            blocking_issues.push(json!({
                "field": field,
                "term": term,
                "risk": "medical_claim",
                "message": "Medical efficacy claims need evidence and careful wording before publishing."
            }));
        }
        for term in contains_any_term(&text, &finance_terms) {
            field_terms.push(term.clone());
            blocking_issues.push(json!({
                "field": field,
                "term": term,
                "risk": "financial_claim",
                "message": "Financial return guarantees are high-risk and should be rewritten."
            }));
        }
        for term in contains_any_term(&text, &legal_terms) {
            field_terms.push(term.clone());
            blocking_issues.push(json!({
                "field": field,
                "term": term,
                "risk": "legal_claim",
                "message": "Legal certainty claims are high-risk and should be rewritten."
            }));
        }
        for term in contains_any_term(&text, &commercial_terms) {
            field_terms.push(term.clone());
            suggested_rewrites.push(json!({
                "field": field,
                "term": term,
                "suggestion": "If this is commercial content, keep disclosure explicit and platform-compliant."
            }));
        }
        for term in field_terms {
            sensitive_terms.push(json!({ "field": field, "term": term }));
        }
    }
    let risk_level = if !blocking_issues.is_empty() {
        "high"
    } else if !sensitive_terms.is_empty() {
        "medium"
    } else {
        "low"
    };
    json!({
        "schema": "redclaw.xhsDeterministicCompliance.v1",
        "riskLevel": risk_level,
        "approved": blocking_issues.is_empty(),
        "sensitiveTerms": sensitive_terms,
        "blockingIssues": blocking_issues,
        "suggestedRewrites": suggested_rewrites,
    })
}

fn xhs_package_from_project(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let topic = artifact_for_role(&outputs, "topic_agent");
    let architecture = artifact_for_role(&outputs, "note_architect_agent");
    let copy = artifact_for_role(&outputs, "copy_agent");
    let visual = artifact_for_role(&outputs, "visual_director_agent");
    let images = artifact_for_role(&outputs, "image_agent");
    let layout = artifact_for_role(&outputs, "layout_agent");
    let compliance = artifact_for_role(&outputs, "compliance_agent");
    let publish = publish_package_from_project(project);
    let review = review_report_from_project(project);
    let mut package = json!({
        "schema": "redclaw.xhsPackage.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
        },
        "generatedAt": now_iso(),
        "topic": topic,
        "noteArchitecture": architecture,
        "copyPackage": copy,
        "visualBrief": visual,
        "imageAssets": images,
        "carouselLayout": layout,
        "publishPackage": publish,
        "complianceReport": compliance,
        "reviewReport": review,
        "sources": {
            "topic": redclaw_output_summary(output_for_role(&outputs, "topic_agent").as_ref()),
            "noteArchitecture": redclaw_output_summary(output_for_role(&outputs, "note_architect_agent").as_ref()),
            "copy": redclaw_output_summary(output_for_role(&outputs, "copy_agent").as_ref()),
            "visual": redclaw_output_summary(output_for_role(&outputs, "visual_director_agent").as_ref()),
            "image": redclaw_output_summary(output_for_role(&outputs, "image_agent").as_ref()),
            "layout": redclaw_output_summary(output_for_role(&outputs, "layout_agent").as_ref()),
            "compliance": redclaw_output_summary(output_for_role(&outputs, "compliance_agent").as_ref())
        }
    });
    let deterministic_compliance = deterministic_xhs_compliance(&package);
    if let Some(object) = package.as_object_mut() {
        object.insert(
            "deterministicCompliance".to_string(),
            deterministic_compliance,
        );
    }
    package
}

fn xhs_copy_titles(package: &Value) -> Vec<String> {
    value_string_list(
        package
            .get("copyPackage")
            .and_then(|copy| copy.get("titles"))
            .or_else(|| {
                package
                    .get("publishPackage")
                    .and_then(|publish| publish.get("titleOptions"))
            }),
    )
}

fn build_xhs_package_markdown(package: &Value) -> String {
    let titles = xhs_copy_titles(package);
    let copy = package
        .get("copyPackage")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let body = first_string_field(&copy, &["body", "正文"]).unwrap_or_default();
    let cover_title = first_string_field(&copy, &["coverTitle", "cover_title"]).unwrap_or_default();
    let hashtags = value_string_list(copy.get("hashtags").or_else(|| {
        package
            .get("publishPackage")
            .and_then(|publish| publish.get("hashtags"))
    }));
    let project = package.get("project").cloned().unwrap_or_else(|| json!({}));
    let layout = package
        .get("carouselLayout")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let images = package
        .get("imageAssets")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let compliance = package
        .get("complianceReport")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let deterministic_compliance = package
        .get("deterministicCompliance")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw XHS Package\n\n");
    markdown.push_str(&format!(
        "Project: `{}`\n\n",
        project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    ));
    markdown.push_str("## Titles\n\n");
    markdown.push_str(&markdown_list(&titles, "No title options generated."));
    markdown.push_str("\n## Cover Title\n\n");
    markdown.push_str(if cover_title.is_empty() {
        "No cover title generated."
    } else {
        &cover_title
    });
    markdown.push_str("\n\n## Body\n\n");
    markdown.push_str(if body.is_empty() {
        "No body generated."
    } else {
        &body
    });
    markdown.push_str("\n\n## Hashtags\n\n");
    markdown.push_str(&markdown_list(&hashtags, "No hashtags generated."));
    markdown.push_str("\n## Carousel Layout\n\n```json\n");
    markdown.push_str(&markdown_json_block(&layout));
    markdown.push_str("\n```\n\n## Image Assets\n\n```json\n");
    markdown.push_str(&markdown_json_block(&images));
    markdown.push_str("\n```\n\n## Compliance\n\n```json\n");
    markdown.push_str(&markdown_json_block(&compliance));
    markdown.push_str("\n```\n\n## Deterministic Compliance\n\n```json\n");
    markdown.push_str(&markdown_json_block(&deterministic_compliance));
    markdown.push_str("\n```\n");
    markdown
}

fn build_redclaw_media_plan_export(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let script = output_for_role(&outputs, "script_agent");
    let storyboard = output_for_role(&outputs, "storyboard_agent");
    let media = output_for_role(&outputs, "media_agent");
    let publish = output_for_role(&outputs, "publish_agent");
    let media_artifact = parsed_output_artifact(media.as_ref());
    json!({
        "schema": "redclaw.mediaPlan.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
            "artifactPath": project.artifact_path,
        },
        "generatedAt": now_iso(),
        "mediaPlan": media_artifact,
        "timelinePlan": media_artifact.get("timelinePlan").cloned()
            .or_else(|| media_artifact.get("timeline").cloned())
            .unwrap_or_else(|| json!([])),
        "matchedAssets": media_artifact.get("matchedAssets").cloned().unwrap_or_else(|| json!([])),
        "missingAssets": media_artifact.get("missingAssets").cloned().unwrap_or_else(|| json!([])),
        "productionRisks": media_artifact.get("productionRisks").cloned().unwrap_or_else(|| json!([])),
        "sections": {
            "script": redclaw_output_summary(script.as_ref()),
            "storyboard": redclaw_output_summary(storyboard.as_ref()),
            "media": redclaw_output_summary(media.as_ref()),
            "publish": redclaw_output_summary(publish.as_ref()),
        }
    })
}

fn media_plan_asset_path(item: &Value) -> Option<String> {
    for key in [
        "path",
        "absolutePath",
        "absolute_path",
        "filePath",
        "file",
        "source",
        "src",
        "url",
    ] {
        if let Some(value) = item
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

fn media_plan_duration_seconds(item: &Value) -> Option<f64> {
    for key in ["duration", "durationSeconds", "seconds"] {
        if let Some(value) = item.get(key).and_then(Value::as_f64) {
            return Some(value.max(0.0));
        }
        if let Some(value) = item.get(key).and_then(Value::as_i64) {
            return Some((value as f64).max(0.0));
        }
    }
    let start = item
        .get("startAt")
        .or_else(|| item.get("start"))
        .and_then(Value::as_f64);
    let end = item
        .get("endAt")
        .or_else(|| item.get("end"))
        .and_then(Value::as_f64);
    match (start, end) {
        (Some(start), Some(end)) if end > start => Some(end - start),
        _ => None,
    }
}

fn media_plan_concat_items(plan: &Value) -> Vec<(String, Option<f64>)> {
    let mut items = Vec::new();
    for key in ["timelinePlan", "matchedAssets"] {
        for item in plan
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(path) = media_plan_asset_path(item) {
                items.push((path, media_plan_duration_seconds(item)));
            }
        }
    }
    items
}

fn ffconcat_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "'\\''")
}

fn build_ffconcat(items: &[(String, Option<f64>)]) -> String {
    let mut body = String::from("ffconcat version 1.0\n");
    for (path, duration) in items {
        body.push_str(&format!("file '{}'\n", ffconcat_escape(path)));
        if let Some(duration) = duration.filter(|value| *value > 0.0) {
            body.push_str(&format!("duration {:.3}\n", duration));
        }
    }
    body
}

fn build_media_plan_readme(project_id: &str, items: &[(String, Option<f64>)]) -> String {
    let mut body = String::new();
    body.push_str(&format!(
        "# RedClaw Media Plan\n\nProject: `{project_id}`\n\n"
    ));
    body.push_str("- `media-plan.json`: structured RedClaw media plan export.\n");
    body.push_str("- `rough-cut.ffconcat`: ffmpeg concat input generated from matched timeline assets when paths are available.\n\n");
    if items.is_empty() {
        body.push_str("No concrete media file paths were found in the current MediaPlan. Ask Media Agent to match local assets before rendering a rough cut.\n");
    } else {
        body.push_str("Preview command:\n\n```bash\nffmpeg -safe 0 -f concat -i rough-cut.ffconcat -c copy rough-cut.mp4\n```\n");
    }
    body
}

fn ffconcat_file_entries(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let raw = trimmed.strip_prefix("file ")?;
            let value = raw
                .trim()
                .trim_matches('\'')
                .replace("'\\''", "'")
                .replace("\\\\", "\\");
            if value.trim().is_empty() {
                None
            } else {
                Some(value)
            }
        })
        .collect()
}

fn validate_ffconcat_inputs(package_dir: &Path, concat_path: &Path) -> Result<Vec<String>, String> {
    let body = std::fs::read_to_string(concat_path).map_err(|error| error.to_string())?;
    let entries = ffconcat_file_entries(&body);
    if entries.is_empty() {
        return Err("rough-cut.ffconcat has no media file entries".to_string());
    }
    let missing = entries
        .iter()
        .filter(|entry| !entry.starts_with("http://") && !entry.starts_with("https://"))
        .filter(|entry| {
            let path = Path::new(entry);
            let resolved = if path.is_absolute() {
                path.to_path_buf()
            } else {
                package_dir.join(path)
            };
            !resolved.exists()
        })
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "rough-cut.ffconcat references missing files: {}",
            missing.join(", ")
        ));
    }
    Ok(entries)
}

fn run_ffmpeg_concat(
    ffmpeg_path: &Path,
    package_dir: &Path,
    concat_path: &Path,
    output_path: &Path,
) -> Result<Value, String> {
    let output = crate::background_command(ffmpeg_path)
        .current_dir(package_dir)
        .arg("-y")
        .arg("-safe")
        .arg("0")
        .arg("-f")
        .arg("concat")
        .arg("-i")
        .arg(concat_path)
        .arg("-c")
        .arg("copy")
        .arg(output_path)
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "ffmpeg rough cut render failed: {}",
            stderr.trim().chars().take(1200).collect::<String>()
        ));
    }
    Ok(json!({
        "status": output.status.code(),
        "stdout": stdout,
        "stderr": stderr,
    }))
}

#[cfg(test)]
mod redclaw_media_plan_tests {
    use super::*;

    #[test]
    fn ffconcat_includes_asset_paths_and_durations() {
        let plan = json!({
            "timelinePlan": [
                { "path": "/tmp/a.mp4", "durationSeconds": 2.5 },
                { "filePath": "/tmp/b.mp4", "start": 1.0, "end": 4.0 }
            ]
        });
        let items = media_plan_concat_items(&plan);
        let body = build_ffconcat(&items);

        assert!(body.contains("ffconcat version 1.0"));
        assert!(body.contains("file '/tmp/a.mp4'"));
        assert!(body.contains("duration 2.500"));
        assert!(body.contains("file '/tmp/b.mp4'"));
        assert!(body.contains("duration 3.000"));
    }

    #[test]
    fn ffconcat_file_entries_parses_exported_paths() {
        let entries = ffconcat_file_entries(
            "ffconcat version 1.0\nfile '/tmp/a.mp4'\nduration 1.000\nfile 'relative/b.mp4'\n",
        );

        assert_eq!(entries, vec!["/tmp/a.mp4", "relative/b.mp4"]);
    }

    #[test]
    fn publish_package_markdown_includes_titles_body_and_cover_copy() {
        let package = json!({
            "schema": "redclaw.publishPackage.v1",
            "project": { "id": "project-1", "platform": "xiaohongshu" },
            "titleOptions": ["Title A", "Title B"],
            "coverOptions": ["Cover line"],
            "body": "Post body",
            "hashtags": ["#redclaw"],
            "checklist": ["Fact checked"]
        });
        let markdown = build_publish_package_markdown(&package);
        let cover = build_cover_brief_markdown(&package);

        assert!(markdown.contains("Title A"));
        assert!(markdown.contains("Cover line"));
        assert!(markdown.contains("Post body"));
        assert!(markdown.contains("#redclaw"));
        assert!(cover.contains("Cover line"));
        assert!(cover.contains("Platform: xiaohongshu"));
    }

    #[test]
    fn review_report_markdown_includes_score_issues_and_learnings() {
        let report = json!({
            "schema": "redclaw.reviewReport.v1",
            "project": { "id": "project-1" },
            "summary": "Ready after one patch",
            "qualityScore": { "overall": 82, "platformFit": 90 },
            "blockingIssues": ["Missing source citation"],
            "suggestedPatches": [{ "sectionId": "script", "reason": "Add citation" }],
            "learningCandidates": [{ "statement": "Prefer stronger source links" }]
        });
        let markdown = build_review_report_markdown(&report);

        assert!(markdown.contains("Ready after one patch"));
        assert!(markdown.contains("Missing source citation"));
        assert!(markdown.contains("\"overall\": 82"));
        assert!(markdown.contains("Prefer stronger source links"));
    }

    #[test]
    fn xhs_package_markdown_includes_copy_layout_and_compliance() {
        let package = json!({
            "schema": "redclaw.xhsPackage.v1",
            "project": { "id": "project-1", "platform": "xiaohongshu" },
            "copyPackage": {
                "titles": ["Title A"],
                "coverTitle": "Cover A",
                "body": "XHS body",
                "hashtags": ["#xhs"]
            },
            "carouselLayout": {
                "aspectRatio": "3:4",
                "pages": [{ "index": 1, "role": "cover", "headline": "Cover A", "layout": "title_card" }]
            },
            "imageAssets": {
                "pages": [{ "index": 1, "path": "/tmp/cover.png", "source": "generated" }],
                "missingAssets": []
            },
            "complianceReport": {
                "riskLevel": "low",
                "approved": true
            },
            "deterministicCompliance": {
                "schema": "redclaw.xhsDeterministicCompliance.v1",
                "riskLevel": "low",
                "approved": true
            }
        });
        let markdown = build_xhs_package_markdown(&package);

        assert!(markdown.contains("Title A"));
        assert!(markdown.contains("Cover A"));
        assert!(markdown.contains("XHS body"));
        assert!(markdown.contains("aspectRatio"));
        assert!(markdown.contains("riskLevel"));
        assert!(markdown.contains("redclaw.xhsDeterministicCompliance.v1"));
    }

    #[test]
    fn deterministic_xhs_compliance_flags_high_risk_terms() {
        let package = json!({
            "schema": "redclaw.xhsPackage.v1",
            "copyPackage": {
                "titles": ["7天治愈焦虑的最好方法"],
                "body": "这个方法保证有效，稳赚不赔。"
            }
        });

        let report = deterministic_xhs_compliance(&package);

        assert_eq!(
            report.get("riskLevel").and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(report.get("approved").and_then(Value::as_bool), Some(false));
        assert!(report
            .get("blockingIssues")
            .and_then(Value::as_array)
            .is_some_and(|items| items
                .iter()
                .any(|item| item.get("term").and_then(Value::as_str) == Some("治愈"))));
        assert!(report
            .get("suggestedRewrites")
            .and_then(Value::as_array)
            .is_some_and(|items| items
                .iter()
                .any(|item| item.get("term").and_then(Value::as_str) == Some("最好"))));
    }
}

fn export_redclaw_media_plan(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root.join("redclaw").join("media-plans");
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;

    let export_value = build_redclaw_media_plan_export(&project_snapshot);
    let package_dir = export_dir.join(safe_export_slug(&project_snapshot.id));
    std::fs::create_dir_all(&package_dir).map_err(|error| error.to_string())?;
    let path = package_dir.join("media-plan.json");
    let concat_path = package_dir.join("rough-cut.ffconcat");
    let readme_path = package_dir.join("README.md");
    let body = serde_json::to_string_pretty(&export_value).map_err(|error| error.to_string())?;
    write_text_file(&path, &body)?;
    let concat_items = media_plan_concat_items(&export_value);
    write_text_file(&concat_path, &build_ffconcat(&concat_items))?;
    write_text_file(
        &readme_path,
        &build_media_plan_readme(&project_snapshot.id, &concat_items),
    )?;

    let updated_project = with_store_mut(state, |store| {
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
        let mut exports = metadata
            .get("mediaPlanExports")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        exports.push(json!({
            "path": path.display().to_string(),
            "packagePath": package_dir.display().to_string(),
            "concatPath": concat_path.display().to_string(),
            "readmePath": readme_path.display().to_string(),
            "schema": "redclaw.mediaPlan.v1",
            "createdAt": now,
        }));
        metadata.insert("mediaPlanExports".to_string(), Value::Array(exports));
        project.metadata = Some(Value::Object(metadata));
        project.updated_at = now;
        Ok(project.clone())
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "path": path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "concatPath": concat_path.display().to_string(),
        "readmePath": readme_path.display().to_string(),
        "plan": export_value
    }))
}

fn render_redclaw_rough_cut(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let export_result = export_redclaw_media_plan(state, payload)?;
    let package_path = payload_string(&export_result, "packagePath")
        .ok_or_else(|| "media plan packagePath missing".to_string())?;
    let concat_path = payload_string(&export_result, "concatPath")
        .ok_or_else(|| "media plan concatPath missing".to_string())?;
    let package_dir = PathBuf::from(package_path);
    let concat_path = PathBuf::from(concat_path);
    let output_path = package_dir.join("rough-cut.mp4");
    let ffmpeg_path = ffmpeg_executable(Some(app))?;
    let inputs = validate_ffconcat_inputs(&package_dir, &concat_path)?;
    let ffmpeg = run_ffmpeg_concat(&ffmpeg_path, &package_dir, &concat_path, &output_path)?;
    let output_size = std::fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let now = now_iso();
    let render_record = json!({
        "path": output_path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "concatPath": concat_path.display().to_string(),
        "inputCount": inputs.len(),
        "sizeBytes": output_size,
        "createdAt": now,
        "renderer": "ffmpeg.concat.copy",
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_record_and_artifact(
            store,
            &project_id,
            "mediaPlanRenders",
            render_record.clone(),
            json!({
                "artifactType": "redclaw-rough-cut",
                "title": "RedClaw Rough Cut",
                "path": output_path.display().to_string(),
                "payload": render_record,
                "createdAt": now,
            }),
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "path": output_path.display().to_string(),
        "packagePath": package_dir.display().to_string(),
        "inputCount": inputs.len(),
        "sizeBytes": output_size,
        "ffmpeg": ffmpeg,
    }))
}

fn export_redclaw_publish_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root
        .join("redclaw")
        .join("publish-packages")
        .join(safe_export_slug(&project_id));
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;
    let package = publish_package_from_project(&project_snapshot);
    let package_path = export_dir.join("publish-package.json");
    let markdown_path = export_dir.join("publish-package.md");
    let cover_brief_path = export_dir.join("cover-brief.md");
    write_text_file(
        &package_path,
        &serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?,
    )?;
    write_text_file(&markdown_path, &build_publish_package_markdown(&package))?;
    write_text_file(&cover_brief_path, &build_cover_brief_markdown(&package))?;

    let now = now_iso();
    let export_record = json!({
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "coverBriefPath": cover_brief_path.display().to_string(),
        "schema": "redclaw.publishPackage.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "publishPackageExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "coverBriefPath": cover_brief_path.display().to_string(),
        "package": package,
    }))
}

fn export_redclaw_review_report(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root
        .join("redclaw")
        .join("review-reports")
        .join(safe_export_slug(&project_id));
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;
    let report = review_report_from_project(&project_snapshot);
    let report_path = export_dir.join("review-report.json");
    let markdown_path = export_dir.join("review-report.md");
    write_text_file(
        &report_path,
        &serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?,
    )?;
    write_text_file(&markdown_path, &build_review_report_markdown(&report))?;

    let now = now_iso();
    let export_record = json!({
        "packagePath": export_dir.display().to_string(),
        "jsonPath": report_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "schema": "redclaw.reviewReport.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "reviewReportExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "packagePath": export_dir.display().to_string(),
        "jsonPath": report_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "report": report,
    }))
}

fn export_redclaw_xhs_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let root = workspace_root(state)?;
    let export_dir = root
        .join("redclaw")
        .join("xhs-packages")
        .join(safe_export_slug(&project_id));
    std::fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let project_snapshot = with_store(state, |store| {
        redclaw_store::project_by_id(&store, &project_id)
            .ok_or_else(|| "RedClaw project not found".to_string())
    })?;
    let package = xhs_package_from_project(&project_snapshot);
    let package_path = export_dir.join("xhs-package.json");
    let markdown_path = export_dir.join("xhs-package.md");
    let layout_path = export_dir.join("carousel-layout.json");
    let image_manifest_path = export_dir.join("image-manifest.json");
    write_text_file(
        &package_path,
        &serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?,
    )?;
    write_text_file(&markdown_path, &build_xhs_package_markdown(&package))?;
    write_text_file(
        &layout_path,
        &serde_json::to_string_pretty(package.get("carouselLayout").unwrap_or(&Value::Null))
            .map_err(|error| error.to_string())?,
    )?;
    write_text_file(
        &image_manifest_path,
        &serde_json::to_string_pretty(package.get("imageAssets").unwrap_or(&Value::Null))
            .map_err(|error| error.to_string())?,
    )?;

    let now = now_iso();
    let export_record = json!({
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "layoutPath": layout_path.display().to_string(),
        "imageManifestPath": image_manifest_path.display().to_string(),
        "schema": "redclaw.xhsPackage.v1",
        "createdAt": now,
    });
    let updated_project = with_store_mut(state, |store| {
        redclaw_store::append_project_metadata_array_record(
            store,
            &project_id,
            "xhsPackageExports",
            export_record,
            &now,
        )
    })?;

    Ok(json!({
        "success": true,
        "project": updated_project,
        "packagePath": export_dir.display().to_string(),
        "jsonPath": package_path.display().to_string(),
        "markdownPath": markdown_path.display().to_string(),
        "layoutPath": layout_path.display().to_string(),
        "imageManifestPath": image_manifest_path.display().to_string(),
        "package": package,
    }))
}

fn redclaw_agent_role_id(agent_id: &RedclawAgentId) -> &'static str {
    match agent_id {
        RedclawAgentId::ResearchAgent => "research_agent",
        RedclawAgentId::InsightAgent => "insight_agent",
        RedclawAgentId::TopicAgent => "topic_agent",
        RedclawAgentId::NoteArchitectAgent => "note_architect_agent",
        RedclawAgentId::ScriptAgent => "script_agent",
        RedclawAgentId::CopyAgent => "copy_agent",
        RedclawAgentId::StoryboardAgent => "storyboard_agent",
        RedclawAgentId::VisualDirectorAgent => "visual_director_agent",
        RedclawAgentId::MediaAgent => "media_agent",
        RedclawAgentId::ImageAgent => "image_agent",
        RedclawAgentId::LayoutAgent => "layout_agent",
        RedclawAgentId::EditorAgent => "editor_agent",
        RedclawAgentId::PublishAgent => "publish_agent",
        RedclawAgentId::ComplianceAgent => "compliance_agent",
        RedclawAgentId::ReviewAgent => "review_agent",
    }
}

fn redclaw_agent_display_name(agent_id: &RedclawAgentId) -> &'static str {
    match agent_id {
        RedclawAgentId::ResearchAgent => "Research Agent",
        RedclawAgentId::InsightAgent => "Insight Agent",
        RedclawAgentId::TopicAgent => "Topic Agent",
        RedclawAgentId::NoteArchitectAgent => "Note Architect Agent",
        RedclawAgentId::ScriptAgent => "Script Agent",
        RedclawAgentId::CopyAgent => "Copy Agent",
        RedclawAgentId::StoryboardAgent => "Storyboard Agent",
        RedclawAgentId::VisualDirectorAgent => "Visual Director Agent",
        RedclawAgentId::MediaAgent => "Media Agent",
        RedclawAgentId::ImageAgent => "Image Agent",
        RedclawAgentId::LayoutAgent => "Layout Agent",
        RedclawAgentId::EditorAgent => "Editor Agent",
        RedclawAgentId::PublishAgent => "Publish Agent",
        RedclawAgentId::ComplianceAgent => "Compliance Agent",
        RedclawAgentId::ReviewAgent => "Review Agent",
    }
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
    let selected_agent_ids = plan
        .graph
        .nodes
        .iter()
        .map(|node| node.agent_id.clone())
        .collect::<Vec<_>>();
    for spec in plan.agent_specs.iter().filter(|spec| {
        selected_agent_ids
            .iter()
            .any(|agent_id| agent_id == &spec.id)
    }) {
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
    require_confirmed_redclaw_team_plan(payload)?;
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
            "redclawAgentSpecs": &plan.agent_specs,
            "redclawSkillProfiles": &plan.skill_profiles,
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
