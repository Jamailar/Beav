use serde_json::Value;

use super::types::AppStore;
use crate::runtime::{
    append_runtime_task_trace, cancel_runtime_task, get_runtime_task,
    get_runtime_task_value as runtime_task_lookup_value,
    list_runtime_task_traces_value as runtime_task_traces_lookup_value, list_runtime_tasks,
    resume_runtime_task_snapshot, store_runtime_task, RuntimeRouteRecord, RuntimeTaskRecord,
};

pub(crate) fn store_task(
    store: &mut AppStore,
    task_type: &str,
    status: &str,
    runtime_mode: String,
    owner_session_id: Option<String>,
    goal: Option<String>,
    route: RuntimeRouteRecord,
    metadata: Option<Value>,
) -> RuntimeTaskRecord {
    store_runtime_task(
        store,
        task_type,
        status,
        runtime_mode,
        owner_session_id,
        goal,
        route,
        metadata,
    )
}

pub(crate) fn list_tasks(store: &AppStore) -> Vec<RuntimeTaskRecord> {
    list_runtime_tasks(store)
}

pub(crate) fn get_task(store: &AppStore, task_id: &str) -> Option<RuntimeTaskRecord> {
    get_runtime_task(store, task_id)
}

pub(crate) fn push_task(store: &mut AppStore, task: RuntimeTaskRecord) {
    store.runtime_tasks.push(task);
}

pub(crate) fn update_task<R>(
    store: &mut AppStore,
    task_id: &str,
    update: impl FnOnce(&mut RuntimeTaskRecord) -> R,
) -> Option<R> {
    store
        .runtime_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
        .map(update)
}

pub(crate) fn resume_task_snapshot(
    store: &mut AppStore,
    task_id: &str,
    summary: &str,
) -> Option<RuntimeTaskRecord> {
    resume_runtime_task_snapshot(store, task_id, summary)
}

pub(crate) fn task_value(store: &AppStore, task_id: &str) -> Value {
    runtime_task_lookup_value(store, task_id)
}

pub(crate) fn cancel_task(store: &mut AppStore, task_id: &str) -> bool {
    cancel_runtime_task(store, task_id)
}

pub(crate) fn append_cancelled_trace(store: &mut AppStore, task_id: &str) {
    append_runtime_task_trace(store, task_id, "cancelled", None);
}

pub(crate) fn task_traces_value(
    store: &AppStore,
    task_id: &str,
    include_children: bool,
    limit: Option<usize>,
) -> Value {
    runtime_task_traces_lookup_value(store, task_id, include_children, limit)
}
