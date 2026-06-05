use super::types::AppStore;
use serde_json::{json, Value};

use crate::redclaw_state_value;
use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawJobExecutionRecord, RedclawLongCycleTaskRecord,
    RedclawProjectRecord, RedclawScheduledTaskRecord,
};

pub(crate) fn state_value(store: &AppStore) -> Value {
    redclaw_state_value(&store.redclaw_state)
}

pub(crate) fn runtime_start_decision(store: &AppStore) -> (bool, bool) {
    let has_tasks = !store.redclaw_state.scheduled_tasks.is_empty()
        || !store.redclaw_state.long_cycle_tasks.is_empty();
    let should_run = store.redclaw_state.enabled
        && (store.redclaw_state.is_ticking || (!store.redclaw_state.is_ticking && has_tasks));
    let should_recover_tick =
        store.redclaw_state.enabled && !store.redclaw_state.is_ticking && has_tasks;
    (should_run, should_recover_tick)
}

pub(crate) fn recover_ticking_if_needed(store: &mut AppStore) {
    if store.redclaw_state.enabled && !store.redclaw_state.is_ticking {
        store.redclaw_state.is_ticking = true;
    }
}

#[derive(Default)]
pub(crate) struct RunnerConfigPatch {
    pub(crate) interval_minutes: Option<i64>,
    pub(crate) max_automation_per_tick: Option<i64>,
    pub(crate) heartbeat_enabled: Option<bool>,
    pub(crate) heartbeat_interval_minutes: Option<i64>,
    pub(crate) heartbeat_suppress_empty_report: Option<bool>,
    pub(crate) heartbeat_report_to_main_session: Option<bool>,
}

pub(crate) fn start_runner(
    store: &mut AppStore,
    now: String,
    default_next_maintenance_at: String,
    patch: RunnerConfigPatch,
) -> Value {
    store.redclaw_state.enabled = true;
    store.redclaw_state.is_ticking = true;
    store.redclaw_state.last_tick_at = Some(now.clone());
    store.redclaw_state.next_tick_at = Some(now);
    if store.redclaw_state.next_maintenance_at.is_none() {
        store.redclaw_state.next_maintenance_at = Some(default_next_maintenance_at);
    }
    apply_runner_config_patch(store, patch);
    state_value(store)
}

pub(crate) fn stop_runner(store: &mut AppStore) -> Value {
    store.redclaw_state.enabled = false;
    store.redclaw_state.is_ticking = false;
    state_value(store)
}

pub(crate) fn mark_runner_tick(store: &mut AppStore, now: String) -> Value {
    store.redclaw_state.last_tick_at = Some(now);
    state_value(store)
}

pub(crate) fn apply_runner_config(store: &mut AppStore, patch: RunnerConfigPatch) -> Value {
    apply_runner_config_patch(store, patch);
    state_value(store)
}

fn apply_runner_config_patch(store: &mut AppStore, patch: RunnerConfigPatch) {
    if let Some(interval) = patch.interval_minutes {
        store.redclaw_state.interval_minutes = interval;
    }
    if let Some(max_auto) = patch.max_automation_per_tick {
        store.redclaw_state.max_automation_per_tick = max_auto;
    }
    if let Some(object) = store.redclaw_state.heartbeat.as_object_mut() {
        if let Some(value) = patch.heartbeat_enabled {
            object.insert("enabled".to_string(), json!(value));
        }
        if let Some(value) = patch.heartbeat_interval_minutes {
            object.insert("intervalMinutes".to_string(), json!(value));
        }
        if let Some(value) = patch.heartbeat_suppress_empty_report {
            object.insert("suppressEmptyReport".to_string(), json!(value));
        }
        if let Some(value) = patch.heartbeat_report_to_main_session {
            object.insert("reportToMainSession".to_string(), json!(value));
        }
    }
}

pub(crate) fn list_projects_sorted(store: &AppStore) -> Vec<RedclawProjectRecord> {
    let mut projects = store.redclaw_state.projects.clone();
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    projects
}

pub(crate) fn project_by_id(store: &AppStore, project_id: &str) -> Option<RedclawProjectRecord> {
    store
        .redclaw_state
        .projects
        .iter()
        .find(|item| item.id == project_id)
        .cloned()
}

pub(crate) fn list_scheduled_tasks(store: &AppStore) -> Vec<RedclawScheduledTaskRecord> {
    store.redclaw_state.scheduled_tasks.clone()
}

pub(crate) fn list_long_cycle_tasks(store: &AppStore) -> Vec<RedclawLongCycleTaskRecord> {
    store.redclaw_state.long_cycle_tasks.clone()
}

pub(crate) fn list_job_definitions(store: &AppStore) -> Vec<RedclawJobDefinitionRecord> {
    store.redclaw_job_definitions.clone()
}

pub(crate) fn list_job_executions(store: &AppStore) -> Vec<RedclawJobExecutionRecord> {
    store.redclaw_job_executions.clone()
}
