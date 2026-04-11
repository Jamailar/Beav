use serde_json::Value;

use crate::runtime::{
    RuntimeCheckpointRecord, RuntimeRouteRecord, RuntimeTaskRecord, RuntimeTaskTraceRecord,
};
use crate::{make_id, now_i64, AppStore};

pub fn build_route_checkpoint(route: &RuntimeRouteRecord) -> RuntimeCheckpointRecord {
    RuntimeCheckpointRecord::new(
        "route",
        "plan",
        route.reasoning.clone(),
        Some(route.clone().into_value()),
    )
}

pub fn create_runtime_task(
    task_type: &str,
    status: &str,
    runtime_mode: String,
    owner_session_id: Option<String>,
    goal: Option<String>,
    route: RuntimeRouteRecord,
    metadata: Option<Value>,
) -> RuntimeTaskRecord {
    RuntimeTaskRecord {
        id: make_id("task"),
        task_type: task_type.to_string(),
        status: status.to_string(),
        runtime_mode,
        owner_session_id,
        intent: Some(route.intent.clone()),
        role_id: Some(route.recommended_role.clone()),
        goal,
        current_node: Some("plan".to_string()),
        route: Some(route.clone()),
        graph: crate::runtime::runtime_graph_for_route(&route.clone().into_value()),
        artifacts: Vec::new(),
        checkpoints: vec![build_route_checkpoint(&route)],
        metadata,
        last_error: None,
        created_at: now_i64(),
        updated_at: now_i64(),
        started_at: None,
        completed_at: None,
    }
}

pub fn list_runtime_tasks(store: &AppStore) -> Vec<RuntimeTaskRecord> {
    let mut tasks = store.runtime_tasks.clone();
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    tasks
}

pub fn get_runtime_task(store: &AppStore, task_id: &str) -> Option<RuntimeTaskRecord> {
    store
        .runtime_tasks
        .iter()
        .find(|item| item.id == task_id)
        .cloned()
}

pub fn list_runtime_task_traces(store: &AppStore, task_id: &str) -> Vec<RuntimeTaskTraceRecord> {
    let mut items: Vec<RuntimeTaskTraceRecord> = store
        .runtime_task_traces
        .iter()
        .filter(|item| item.task_id == task_id)
        .cloned()
        .collect();
    items.sort_by_key(|item| item.created_at);
    items
}

pub fn mark_task_running(task: &mut RuntimeTaskRecord, summary: &str) {
    task.status = "running".to_string();
    task.updated_at = now_i64();
    task.started_at.get_or_insert(now_i64());
    task.current_node = Some("plan".to_string());
    crate::runtime::set_runtime_graph_node(
        &mut task.graph,
        "plan",
        "running",
        Some(summary.to_string()),
        None,
    );
}
