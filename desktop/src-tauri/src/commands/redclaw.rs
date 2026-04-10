use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};

use crate::persistence::{ensure_store_hydrated_for_redclaw, with_store, with_store_mut};
use crate::runtime::{
    RedclawLongCycleTaskRecord, RedclawProjectRecord, RedclawRuntime, RedclawScheduledTaskRecord,
};
use crate::scheduler::sync_redclaw_job_definitions;
use crate::{
    execute_redclaw_run, handle_redclaw_onboarding_turn, load_redclaw_onboarding_state,
    load_redclaw_profile_prompt_bundle, make_id, normalize_optional_string, now_i64, now_iso,
    payload_field, payload_string, redclaw_state_value, run_redclaw_scheduler,
    update_redclaw_profile_doc, AppState,
};

pub fn handle_redclaw_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result: Result<Value, String> = match channel {
        "redclaw:runner-status" => {
            let _ = ensure_store_hydrated_for_redclaw(state);
            with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))
        }
        "redclaw:list-projects" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.projects.clone()))
        }),
        "redclaw:profile:get-bundle" => (|| {
            let bundle = load_redclaw_profile_prompt_bundle(state)?;
            Ok(json!({
                "success": true,
                "profileRoot": bundle.profile_root.display().to_string(),
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
            if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
                if runtime_guard.is_none() {
                    let stop = Arc::new(AtomicBool::new(false));
                    let join = run_redclaw_scheduler(app.clone(), stop.clone());
                    *runtime_guard = Some(RedclawRuntime {
                        stop,
                        join: Some(join),
                    });
                }
            }
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })(),
        "redclaw:runner-stop" => (|| {
            if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
                if let Some(mut runtime) = runtime_guard.take() {
                    runtime.stop.store(true, Ordering::Relaxed);
                    if let Some(join) = runtime.join.take() {
                        let _ = join.join();
                    }
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
            let (project_id, prompt) = with_store(state, |store| {
                let project = store.redclaw_state.projects.first().cloned();
                let project_id = project.as_ref().map(|item| item.id.clone());
                let prompt = project
                    .as_ref()
                    .map(|item| format!("请推进当前 RedClaw 项目：{}\n\n输出最小下一步行动、内容策略和执行建议。", item.goal))
                    .unwrap_or_else(|| "请为当前空间执行一次 RedClaw 巡检，给出内容生产的下一步建议。".to_string());
                Ok((project_id, prompt))
            })?;
            let run_result = execute_redclaw_run(app, state, prompt, project_id, "runner-run-now")?;
            let status = with_store_mut(state, |store| {
                store.redclaw_state.last_tick_at = Some(now_iso());
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(json!({ "success": true, "status": status, "run": run_result }))
        })(),
        "redclaw:runner-set-project" => {
            let project_id = payload_string(payload, "projectId").unwrap_or_default();
            let enabled = payload_field(payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let prompt = normalize_optional_string(payload_string(payload, "prompt"));
            with_store_mut(state, |store| {
                if enabled {
                    if let Some(project) = store
                        .redclaw_state
                        .projects
                        .iter_mut()
                        .find(|item| item.id == project_id)
                    {
                        project.status = "active".to_string();
                        project.updated_at = now_iso();
                    } else {
                        store.redclaw_state.projects.push(RedclawProjectRecord {
                            id: if project_id.is_empty() {
                                make_id("redclaw-project")
                            } else {
                                project_id.clone()
                            },
                            goal: prompt
                                .clone()
                                .unwrap_or_else(|| "RedClaw Project".to_string()),
                            platform: Some("generic".to_string()),
                            task_type: Some("manual".to_string()),
                            status: "active".to_string(),
                            updated_at: now_iso(),
                        });
                    }
                } else {
                    store
                        .redclaw_state
                        .projects
                        .retain(|item| item.id != project_id);
                }
                Ok(json!({ "success": true }))
            })
        }
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
        "redclaw:runner-add-scheduled" => (|| {
            let task = with_store_mut(state, |store| {
                let item = RedclawScheduledTaskRecord {
                    id: make_id("scheduled"),
                    name: payload_string(payload, "name").unwrap_or_else(|| "定时任务".to_string()),
                    enabled: payload_field(payload, "enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    mode: payload_string(payload, "mode").unwrap_or_else(|| "daily".to_string()),
                    prompt: payload_string(payload, "prompt").unwrap_or_default(),
                    project_id: normalize_optional_string(payload_string(payload, "projectId")),
                    interval_minutes: payload_field(payload, "intervalMinutes")
                        .and_then(|v| v.as_i64()),
                    time: normalize_optional_string(payload_string(payload, "time")),
                    weekdays: payload_field(payload, "weekdays")
                        .and_then(|v| v.as_array())
                        .map(|items| items.iter().filter_map(|i| i.as_i64()).collect()),
                    run_at: normalize_optional_string(payload_string(payload, "runAt")),
                    created_at: now_iso(),
                    updated_at: now_iso(),
                    last_run_at: None,
                    last_result: None,
                    last_error: None,
                    next_run_at: Some(now_iso()),
                };
                store.redclaw_state.scheduled_tasks.push(item.clone());
                sync_redclaw_job_definitions(store);
                Ok(item)
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
                    task.updated_at = now_iso();
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
            let (project_id, prompt) = with_store(state, |store| {
                let task = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter()
                    .find(|item| item.id == task_id)
                    .cloned();
                let prompt = task
                    .as_ref()
                    .map(|item| item.prompt.clone())
                    .unwrap_or_else(|| "请执行一次 RedClaw 定时任务。".to_string());
                let project_id = task.and_then(|item| item.project_id);
                Ok((project_id, prompt))
            })?;
            let run_result = execute_redclaw_run(app, state, prompt, project_id, "scheduled-task")?;
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.last_run_at = Some(now_iso());
                    task.last_result = Some("success".to_string());
                    task.updated_at = now_iso();
                }
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true, "run": run_result }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        })(),
        "redclaw:runner-list-long-cycle" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.long_cycle_tasks.clone()))
        }),
        "redclaw:runner-add-long-cycle" => (|| {
            let task = with_store_mut(state, |store| {
                let item = RedclawLongCycleTaskRecord {
                    id: make_id("long-cycle"),
                    name: payload_string(payload, "name")
                        .unwrap_or_else(|| "长周期任务".to_string()),
                    enabled: payload_field(payload, "enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    status: "paused".to_string(),
                    objective: payload_string(payload, "objective").unwrap_or_default(),
                    step_prompt: payload_string(payload, "stepPrompt").unwrap_or_default(),
                    project_id: normalize_optional_string(payload_string(payload, "projectId")),
                    interval_minutes: payload_field(payload, "intervalMinutes")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(720),
                    total_rounds: payload_field(payload, "totalRounds")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(12),
                    completed_rounds: 0,
                    created_at: now_iso(),
                    updated_at: now_iso(),
                    last_run_at: None,
                    last_result: None,
                    last_error: None,
                    next_run_at: Some(now_iso()),
                };
                store.redclaw_state.long_cycle_tasks.push(item.clone());
                sync_redclaw_job_definitions(store);
                Ok(item)
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
                    task.updated_at = now_iso();
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
            let (project_id, prompt) = with_store(state, |store| {
                let task = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter()
                    .find(|item| item.id == task_id)
                    .cloned();
                let prompt = task
                    .as_ref()
                    .map(|item| {
                        format!(
                            "目标：{}\n\n当前轮执行指令：{}",
                            item.objective, item.step_prompt
                        )
                    })
                    .unwrap_or_else(|| "请执行一次 RedClaw 长周期任务。".to_string());
                let project_id = task.and_then(|item| item.project_id);
                Ok((project_id, prompt))
            })?;
            let run_result =
                execute_redclaw_run(app, state, prompt, project_id, "long-cycle-task")?;
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.completed_rounds += 1;
                    task.last_run_at = Some(now_iso());
                    task.last_result = Some("success".to_string());
                    task.status = if task.completed_rounds >= task.total_rounds {
                        "completed".to_string()
                    } else {
                        "running".to_string()
                    };
                    task.updated_at = now_iso();
                }
                sync_redclaw_job_definitions(store);
                Ok(json!({ "success": true, "run": run_result }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        })(),
        _ => return None,
    };
    Some(result)
}
