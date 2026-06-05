use super::types::AppStore;
use serde_json::Value;

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
