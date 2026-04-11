use serde_json::Value;

use crate::runtime::{
    RuntimeCheckpointRecord, RuntimeGraph, RuntimeGraphNodeRecord, RuntimeRouteRecord,
    RuntimeTaskRecord, RuntimeTaskTraceRecord,
};
use crate::{make_id, now_i64, payload_string, AppStore};

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

pub fn runtime_graph_for_route(route: &Value) -> RuntimeGraph {
    runtime_graph_for_route_record(route)
}

pub fn runtime_graph_for_route_record(route: &Value) -> Vec<RuntimeGraphNodeRecord> {
    let typed_route = RuntimeRouteRecord::from_value(route);
    let requires_multi_agent = typed_route
        .as_ref()
        .map(|item| item.requires_multi_agent)
        .unwrap_or_else(|| {
            route
                .get("requiresMultiAgent")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    let requires_long_running = if let Some(route) = typed_route.as_ref() {
        route.requires_long_running_task
    } else {
        route
            .get("requiresLongRunningTask")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let mut nodes = vec![
        pending_node("plan", "plan", "Plan"),
        pending_node("retrieve", "retrieve", "Retrieve"),
    ];
    if requires_multi_agent || requires_long_running {
        nodes.push(pending_node("spawn_agents", "spawn_agents", "Spawn Agents"));
        nodes.push(pending_node("handoff", "handoff", "Handoff"));
        nodes.push(pending_node("review", "review", "Review"));
    }
    nodes.push(pending_node("execute_tools", "execute_tools", "Execute"));
    nodes.push(pending_node("save_artifact", "save_artifact", "Save Artifact"));
    nodes
}

pub fn role_sequence_for_route(route: &Value) -> Vec<String> {
    let intent = payload_string(route, "intent").unwrap_or_default();
    match intent.as_str() {
        "manuscript_creation" | "advisor_persona" => vec![
            "planner".to_string(),
            "researcher".to_string(),
            "copywriter".to_string(),
            "reviewer".to_string(),
        ],
        "cover_generation" | "image_creation" => vec![
            "planner".to_string(),
            "researcher".to_string(),
            "image-director".to_string(),
            "reviewer".to_string(),
        ],
        "knowledge_retrieval" => vec![
            "planner".to_string(),
            "researcher".to_string(),
            "reviewer".to_string(),
        ],
        "automation" | "long_running_task" | "memory_maintenance" => vec![
            "planner".to_string(),
            "ops-coordinator".to_string(),
            "reviewer".to_string(),
        ],
        _ => {
            vec![payload_string(route, "recommendedRole").unwrap_or_else(|| "planner".to_string())]
        }
    }
}

fn pending_node(id: &str, node_type: &str, title: &str) -> RuntimeGraphNodeRecord {
    RuntimeGraphNodeRecord {
        id: id.to_string(),
        node_type: node_type.to_string(),
        status: "pending".to_string(),
        title: title.to_string(),
        started_at: None,
        completed_at: None,
        summary: None,
        error: None,
    }
}
