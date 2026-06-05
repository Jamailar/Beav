use super::types::AppStore;
use crate::runtime::{
    RedclawJobDefinitionRecord, RedclawJobExecutionRecord, RedclawLongCycleTaskRecord,
    RedclawProjectRecord, RedclawScheduledTaskRecord, RedclawStateRecord,
};

pub(crate) fn state_snapshot(store: &AppStore) -> RedclawStateRecord {
    store.redclaw_state.clone()
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
