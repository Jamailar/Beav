use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::redclaw_runtime::{
    append_redclaw_automation_user_message, ensure_redclaw_task_session_record,
};
use crate::persistence::{with_store, with_store_mut};
use crate::scheduler::task_policy::TaskIntentSchema;
use crate::scheduler::{
    clear_definition_cooldown, emit_scheduler_snapshot,
    enqueue_manual_job_execution_for_definition, run_job_queue_once, sync_redclaw_job_definitions,
};
use crate::store::redclaw as redclaw_store;
use crate::{now_iso, payload_field, payload_string, AppState};

pub(super) fn handle_redclaw_runner_task_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "redclaw:runner-list-scheduled" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_scheduled_tasks(&store)))
        }),
        "redclaw:runner-list-job-definitions" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_job_definitions(&store)))
        }),
        "redclaw:runner-list-job-executions" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_job_executions(&store)))
        }),
        "redclaw:runner-add-scheduled" => add_scheduled_task(app, state, payload),
        "redclaw:runner-remove-scheduled" => {
            remove_runner_task(app, state, payload, RunnerTaskKind::Scheduled)
        }
        "redclaw:runner-set-scheduled-enabled" => {
            set_runner_task_enabled(app, state, payload, RunnerTaskKind::Scheduled)
        }
        "redclaw:runner-run-scheduled-now" => {
            run_runner_task_now(app, state, payload, RunnerTaskKind::Scheduled)
        }
        "redclaw:runner-list-long-cycle" => with_store(state, |store| {
            Ok(json!(redclaw_store::list_long_cycle_tasks(&store)))
        }),
        "redclaw:runner-add-long-cycle" => add_long_cycle_task(app, state, payload),
        "redclaw:runner-remove-long-cycle" => {
            remove_runner_task(app, state, payload, RunnerTaskKind::LongCycle)
        }
        "redclaw:runner-set-long-cycle-enabled" => {
            set_runner_task_enabled(app, state, payload, RunnerTaskKind::LongCycle)
        }
        "redclaw:runner-run-long-cycle-now" => {
            run_runner_task_now(app, state, payload, RunnerTaskKind::LongCycle)
        }
        _ => return None,
    };
    Some(result)
}

#[derive(Clone, Copy)]
enum RunnerTaskKind {
    Scheduled,
    LongCycle,
}

impl RunnerTaskKind {
    fn source_kind(self) -> &'static str {
        match self {
            RunnerTaskKind::Scheduled => "scheduled",
            RunnerTaskKind::LongCycle => "long_cycle",
        }
    }

    fn manual_trigger(self) -> &'static str {
        match self {
            RunnerTaskKind::Scheduled => "manual-scheduled-now",
            RunnerTaskKind::LongCycle => "manual-long-cycle-now",
        }
    }

    fn missing_definition_message(self) -> &'static str {
        match self {
            RunnerTaskKind::Scheduled => "未找到定时任务定义",
            RunnerTaskKind::LongCycle => "未找到长期任务定义",
        }
    }

    fn checkpoint_message(self) -> &'static str {
        match self {
            RunnerTaskKind::Scheduled => "Manual scheduled task execution enqueued",
            RunnerTaskKind::LongCycle => "Manual long-cycle execution enqueued",
        }
    }

    fn manual_run_error_prefix(self) -> &'static str {
        match self {
            RunnerTaskKind::Scheduled => "scheduled",
            RunnerTaskKind::LongCycle => "long-cycle",
        }
    }
}

fn add_scheduled_task(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let enabled = payload_field(payload, "enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = super::redclaw_task_control::create_confirmed_task_from_intent(
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
            interval_minutes: payload_field(payload, "intervalMinutes").and_then(Value::as_i64),
            time: payload_string(payload, "time"),
            weekdays: payload_field(payload, "weekdays")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_i64).collect()),
            run_at: payload_string(payload, "runAt"),
            missed_run_policy: payload_string(payload, "missedRunPolicy"),
            metadata: payload_field(payload, "metadata").cloned(),
            ..TaskIntentSchema::default()
        },
    )?;
    let source_task_id = source_task_id_from_creation_result(&result)?;
    let task = with_store_mut(state, |store| {
        if !enabled {
            redclaw_store::set_scheduled_task_enabled(store, source_task_id, false, &now_iso());
            sync_redclaw_job_definitions(store);
        }
        redclaw_store::scheduled_task_by_id(store, source_task_id)
            .ok_or_else(|| "任务创建成功但源记录不存在".to_string())
    })?;
    emit_runner_status(app, state)?;
    Ok(json!({ "success": true, "task": task }))
}

fn add_long_cycle_task(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let enabled = payload_field(payload, "enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = super::redclaw_task_control::create_confirmed_task_from_intent(
        app,
        state,
        TaskIntentSchema {
            kind: "long_cycle".to_string(),
            intent: "legacy-ui-direct".to_string(),
            name: payload_string(payload, "name").unwrap_or_else(|| "长周期任务".to_string()),
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
            interval_minutes: payload_field(payload, "intervalMinutes").and_then(Value::as_i64),
            total_rounds: payload_field(payload, "totalRounds").and_then(Value::as_i64),
            missed_run_policy: payload_string(payload, "missedRunPolicy"),
            metadata: payload_field(payload, "metadata").cloned(),
            ..TaskIntentSchema::default()
        },
    )?;
    let source_task_id = source_task_id_from_creation_result(&result)?;
    let task = with_store_mut(state, |store| {
        if !enabled {
            redclaw_store::set_long_cycle_task_enabled(store, source_task_id, false, &now_iso());
            sync_redclaw_job_definitions(store);
        }
        redclaw_store::long_cycle_task_by_id(store, source_task_id)
            .ok_or_else(|| "任务创建成功但源记录不存在".to_string())
    })?;
    emit_runner_status(app, state)?;
    Ok(json!({ "success": true, "task": task }))
}

fn source_task_id_from_creation_result(result: &Value) -> Result<&str, String> {
    result
        .get("definition")
        .and_then(|value| value.get("sourceTaskId"))
        .and_then(Value::as_str)
        .ok_or_else(|| "任务创建成功但缺少 sourceTaskId".to_string())
}

fn remove_runner_task(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    kind: RunnerTaskKind,
) -> Result<Value, String> {
    let task_id = payload_string(payload, "taskId").unwrap_or_default();
    let result = with_store_mut(state, |store| {
        match kind {
            RunnerTaskKind::Scheduled => redclaw_store::remove_scheduled_task(store, &task_id),
            RunnerTaskKind::LongCycle => redclaw_store::remove_long_cycle_task(store, &task_id),
        }
        sync_redclaw_job_definitions(store);
        Ok(json!({ "success": true }))
    })?;
    emit_runner_status(app, state)?;
    Ok(result)
}

fn set_runner_task_enabled(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    kind: RunnerTaskKind,
) -> Result<Value, String> {
    let task_id = payload_string(payload, "taskId").unwrap_or_default();
    let enabled = payload_field(payload, "enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = with_store_mut(state, |store| {
        match kind {
            RunnerTaskKind::Scheduled => {
                redclaw_store::set_scheduled_task_enabled(store, &task_id, enabled, &now_iso());
            }
            RunnerTaskKind::LongCycle => {
                redclaw_store::set_long_cycle_task_enabled(store, &task_id, enabled, &now_iso());
            }
        }
        if enabled {
            redclaw_store::update_job_definition_by_source(
                store,
                kind.source_kind(),
                &task_id,
                clear_definition_cooldown,
            );
        }
        sync_redclaw_job_definitions(store);
        Ok(json!({ "success": true }))
    })?;
    emit_runner_status(app, state)?;
    Ok(result)
}

fn run_runner_task_now(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    kind: RunnerTaskKind,
) -> Result<Value, String> {
    let task_id = payload_string(payload, "taskId").unwrap_or_default();
    let (execution_id, resolved_definition_id, source_task_id, title, prompt) =
        enqueue_manual_execution(state, kind, &task_id)?;
    let session_id = ensure_redclaw_task_session_record(
        state,
        Some(kind.source_kind()),
        Some(&source_task_id),
        &title,
    )?;
    append_redclaw_automation_user_message(state, &session_id, &prompt, &execution_id)?;
    crate::events::emit_runtime_task_checkpoint_saved(
        app,
        Some(&execution_id),
        Some(&resolved_definition_id),
        "task.enqueued",
        kind.checkpoint_message(),
        Some(json!({
            "executionId": execution_id,
            "sourceTaskId": task_id,
            "definitionId": resolved_definition_id.clone(),
            "trigger": kind.manual_trigger(),
            "sessionId": session_id,
        })),
    );
    spawn_manual_execution(app, &execution_id, kind);
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
}

fn enqueue_manual_execution(
    state: &State<'_, AppState>,
    kind: RunnerTaskKind,
    task_id: &str,
) -> Result<(String, String, String, String, String), String> {
    with_store_mut(
        state,
        |store| -> Result<(String, String, String, String, String), String> {
            sync_redclaw_job_definitions(store);
            let definition_id =
                resolve_task_definition_id_for_manual_run(store, kind.source_kind(), task_id)?;
            let execution_id = enqueue_manual_job_execution_for_definition(
                store,
                &definition_id,
                kind.manual_trigger(),
            )?;
            let definition = redclaw_store::job_definition_by_id(store, &definition_id)
                .ok_or_else(|| kind.missing_definition_message().to_string())?;
            let prompt = match kind {
                RunnerTaskKind::Scheduled => definition
                    .payload
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                RunnerTaskKind::LongCycle => {
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
            };
            Ok((
                execution_id,
                definition_id,
                definition
                    .source_task_id
                    .clone()
                    .unwrap_or_else(|| task_id.to_string()),
                definition.title.clone(),
                prompt,
            ))
        },
    )
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

fn spawn_manual_execution(app: &AppHandle, execution_id: &str, kind: RunnerTaskKind) {
    let app_for_run = app.clone();
    let execution_id_for_run = execution_id.to_string();
    tauri::async_runtime::spawn(async move {
        let managed_state = app_for_run.state::<AppState>();
        if let Err(error) =
            run_job_queue_once(&app_for_run, &managed_state, Some(&execution_id_for_run))
        {
            eprintln!(
                "[redclaw][manual-run] {} execution failed: {error}",
                kind.manual_run_error_prefix()
            );
        }
        let _ = with_store_mut(&managed_state, |store| {
            sync_redclaw_job_definitions(store);
            Ok(())
        });
        emit_scheduler_snapshot(&app_for_run, &managed_state);
    });
}

fn emit_runner_status(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let status = with_store(state, |store| Ok(redclaw_store::state_value(&store)))?;
    let _ = app.emit("redclaw:runner-status", status);
    Ok(())
}
