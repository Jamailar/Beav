use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::commands::redclaw_runtime::execute_redclaw_run;
use crate::persistence::{ensure_store_hydrated_for_redclaw, with_store, with_store_mut};
use crate::runtime::RedclawRuntime;
use crate::scheduler::{run_redclaw_job_runner, run_redclaw_scheduler};
use crate::store::redclaw as redclaw_store;
use crate::{load_redbox_prompt_or_embedded, now_i64, now_iso, payload_field, AppState};

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

pub(crate) fn redclaw_runner_status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = ensure_store_hydrated_for_redclaw(state);
    with_store(state, |store| Ok(redclaw_store::state_value(&store)))
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

pub(super) fn handle_redclaw_runner_lifecycle_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "redclaw:runner-status" => Some(redclaw_runner_status_value(state)),
        "redclaw:runner-start" => Some((|| {
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
        })()),
        "redclaw:runner-stop" => Some((|| {
            if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
                if let Some(mut runtime) = runtime_guard.take() {
                    stop_redclaw_runtime(&mut runtime);
                }
            }
            let status = with_store_mut(state, |store| Ok(redclaw_store::stop_runner(store)))?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })()),
        "redclaw:runner-run-now" => Some((|| {
            let prompt = load_redbox_prompt_or_embedded(
                "runtime/redclaw/runner_run_now_default.txt",
                include_str!(
                    "../../../../prompts/library/runtime/redclaw/runner_run_now_default.txt"
                ),
            );
            let run_result = execute_redclaw_run(app, state, prompt, "runner-run-now")?;
            let status = with_store_mut(state, |store| {
                Ok(redclaw_store::mark_runner_tick(store, now_iso()))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(json!({ "success": true, "status": status, "run": run_result }))
        })()),
        "redclaw:runner-set-project" => Some(Ok(json!({ "success": true, "deprecated": true }))),
        "redclaw:runner-set-config" => Some((|| {
            let patch = runner_config_patch_from_payload(payload);
            let status = with_store_mut(state, |store| {
                Ok(redclaw_store::apply_runner_config(store, patch))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        })()),
        _ => None,
    }
}
