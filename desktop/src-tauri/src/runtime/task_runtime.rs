use serde_json::Value;

use crate::runtime::{
    AppliedTaskResumeExecution, PreparedTaskResumeExecution, RuntimeArtifact,
    RuntimeCheckpointRecord, RuntimeGraph, RuntimeGraphNodeRecord, RuntimeRouteRecord,
    RuntimeTaskRecord, RuntimeTaskTraceRecord, append_runtime_task_trace,
};
use crate::{AppStore, WorkItemRecord, create_work_item, make_id, now_i64, payload_string};

pub type RuntimeNodeEvent = (String, String, Option<String>, Option<String>);
pub type RuntimeCheckpointEvent = (String, String, Option<Value>);

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
        runtime_id: None,
        parent_runtime_id: None,
        parent_task_id: None,
        root_task_id: None,
        child_task_ids: Vec::new(),
        aggregation_status: None,
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

pub fn store_runtime_task(
    store: &mut AppStore,
    task_type: &str,
    status: &str,
    runtime_mode: String,
    owner_session_id: Option<String>,
    goal: Option<String>,
    route: RuntimeRouteRecord,
    metadata: Option<Value>,
) -> RuntimeTaskRecord {
    let route_value = route.clone().into_value();
    let task = create_runtime_task(
        task_type,
        status,
        runtime_mode,
        owner_session_id,
        goal,
        route,
        metadata,
    );
    append_runtime_task_trace(
        store,
        &task.id,
        "created",
        Some(serde_json::json!({
            "goal": task.goal.clone(),
            "runtimeMode": task.runtime_mode,
            "intent": task.intent,
            "roleId": task.role_id,
            "route": route_value
        })),
    );
    store.runtime_tasks.push(task.clone());
    task
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

pub fn get_runtime_task_value(store: &AppStore, task_id: &str) -> Value {
    get_runtime_task(store, task_id).map_or(Value::Null, |item| runtime_task_value(&item))
}

pub fn child_task_ids_for_parent(store: &AppStore, task_id: &str) -> Vec<String> {
    store
        .runtime_tasks
        .iter()
        .filter(|item| item.parent_task_id.as_deref() == Some(task_id))
        .map(|item| item.id.clone())
        .collect()
}

pub fn list_runtime_task_traces(
    store: &AppStore,
    task_id: &str,
    include_children: bool,
) -> Vec<RuntimeTaskTraceRecord> {
    let mut task_ids = vec![task_id.to_string()];
    if include_children {
        task_ids.extend(child_task_ids_for_parent(store, task_id));
    }
    let mut items: Vec<RuntimeTaskTraceRecord> = store
        .runtime_task_traces
        .iter()
        .filter(|item| task_ids.iter().any(|candidate| candidate == &item.task_id))
        .cloned()
        .collect();
    items.sort_by_key(|item| item.created_at);
    items
}

pub fn list_runtime_task_traces_value(
    store: &AppStore,
    task_id: &str,
    include_children: bool,
    limit: Option<usize>,
) -> Value {
    let mut items = list_runtime_task_traces(store, task_id, include_children);
    if let Some(limit) = limit.filter(|value| *value > 0) {
        if items.len() > limit {
            let split_at = items.len().saturating_sub(limit);
            items.drain(..split_at);
        }
    }
    serde_json::json!(items)
}

pub fn mark_task_running(task: &mut RuntimeTaskRecord, summary: &str) {
    task.status = "running".to_string();
    task.updated_at = now_i64();
    task.started_at.get_or_insert(now_i64());
    task.current_node = Some("plan".to_string());
    set_runtime_graph_node(
        &mut task.graph,
        "plan",
        "running",
        Some(summary.to_string()),
        None,
    );
}

pub fn resume_runtime_task_snapshot(
    store: &mut AppStore,
    task_id: &str,
    summary: &str,
) -> Option<RuntimeTaskRecord> {
    let task = store
        .runtime_tasks
        .iter_mut()
        .find(|item| item.id == task_id)?;
    mark_task_running(task, summary);
    Some(task.clone())
}

pub fn cancel_runtime_task(store: &mut AppStore, task_id: &str) -> bool {
    let Some(task) = store
        .runtime_tasks
        .iter_mut()
        .find(|item| item.id == task_id)
    else {
        return false;
    };
    task.status = "cancelled".to_string();
    task.updated_at = now_i64();
    task.completed_at = Some(now_i64());
    true
}

pub fn set_runtime_graph_node(
    graph: &mut [RuntimeGraphNodeRecord],
    node_id: &str,
    status: &str,
    summary: Option<String>,
    error: Option<String>,
) {
    if let Some(node) = graph.iter_mut().find(|item| item.id == node_id) {
        node.status = status.to_string();
        if status == "running" && node.started_at.is_none() {
            node.started_at = Some(crate::now_i64());
        }
        if matches!(status, "completed" | "failed" | "skipped") {
            node.completed_at = Some(crate::now_i64());
        }
        if let Some(summary) = summary {
            node.summary = Some(summary);
        }
        if let Some(error) = error {
            node.error = Some(error);
        }
    }
}

pub fn runtime_task_value(task: &RuntimeTaskRecord) -> Value {
    serde_json::json!(task)
}

pub fn record_runtime_node(
    task: &mut RuntimeTaskRecord,
    runtime_node_events: &mut Vec<RuntimeNodeEvent>,
    node_id: &str,
    status: &str,
    summary: Option<String>,
    error: Option<String>,
) {
    set_runtime_graph_node(
        &mut task.graph,
        node_id,
        status,
        summary.clone(),
        error.clone(),
    );
    runtime_node_events.push((node_id.to_string(), status.to_string(), summary, error));
}

pub fn record_runtime_checkpoint(
    task: &mut RuntimeTaskRecord,
    runtime_checkpoint_events: &mut Vec<RuntimeCheckpointEvent>,
    checkpoint: RuntimeCheckpointRecord,
) {
    runtime_checkpoint_events.push((
        checkpoint.checkpoint_type.clone(),
        checkpoint.summary.clone(),
        checkpoint.payload.clone(),
    ));
    task.checkpoints.push(checkpoint);
}

pub fn build_runtime_artifact_work_item(
    task_id: &str,
    owner_session_id: Option<&str>,
    route: &RuntimeRouteRecord,
    artifact: &RuntimeArtifact,
) -> WorkItemRecord {
    let mut work_item = create_work_item(
        "runtime-artifact",
        format!(
            "Runtime Artifact · {}",
            if route.intent.trim().is_empty() {
                "task".to_string()
            } else {
                route.intent.clone()
            }
        ),
        Some(route.goal.clone()),
        Some(artifact.path.clone().unwrap_or_default()),
        Some(serde_json::json!({
            "taskId": task_id,
            "sessionId": owner_session_id,
            "intent": route.intent.clone(),
            "artifact": artifact,
        })),
        2,
    );
    work_item.refs.task_ids.push(task_id.to_string());
    if let Some(session_id) = owner_session_id {
        work_item.refs.session_ids.push(session_id.to_string());
    }
    work_item
}

pub fn build_runtime_repair_work_item(
    task_id: &str,
    owner_session_id: Option<&str>,
    route: &RuntimeRouteRecord,
    repair_value: &Value,
) -> WorkItemRecord {
    let mut work_item = create_work_item(
        "runtime-repair",
        format!(
            "Runtime Repair · {}",
            if route.intent.trim().is_empty() {
                "task".to_string()
            } else {
                route.intent.clone()
            }
        ),
        Some(
            payload_string(repair_value, "summary")
                .unwrap_or_else(|| "reviewer repair required".to_string()),
        ),
        Some(route.goal.clone()),
        Some(serde_json::json!({
            "taskId": task_id,
            "sessionId": owner_session_id,
            "intent": route.intent.clone(),
            "repair": repair_value,
        })),
        1,
    );
    work_item.refs.task_ids.push(task_id.to_string());
    if let Some(session_id) = owner_session_id {
        work_item.refs.session_ids.push(session_id.to_string());
    }
    work_item
}

pub fn apply_task_resume_execution(
    store: &mut AppStore,
    task_id: &str,
    prepared: &PreparedTaskResumeExecution,
    saved_artifact: Option<RuntimeArtifact>,
) -> Result<AppliedTaskResumeExecution, String> {
    let mut runtime_node_events = Vec::new();
    let mut runtime_checkpoint_events = Vec::new();
    let mut work_items_to_push = Vec::new();
    {
        let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task_id)
        else {
            return Ok(AppliedTaskResumeExecution {
                response: serde_json::json!({ "success": false, "error": "任务不存在" }),
                runtime_node_events,
                runtime_checkpoint_events,
            });
        };

        task.intent = Some(prepared.route.intent.clone());
        task.role_id = Some(prepared.route.recommended_role.clone());
        task.route = Some(prepared.route.clone());
        task.current_node = Some("execute_tools".to_string());

        record_runtime_node(
            task,
            &mut runtime_node_events,
            "plan",
            "completed",
            Some(if prepared.route.reasoning.trim().is_empty() {
                "route resolved".to_string()
            } else {
                prepared.route.reasoning.clone()
            }),
            None,
        );

        record_runtime_node(
            task,
            &mut runtime_node_events,
            "retrieve",
            "completed",
            Some("runtime context prepared".to_string()),
            None,
        );

        if let Some(orchestration_value) = prepared.orchestration.clone() {
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "spawn_agents",
                "completed",
                Some("subagent orchestration completed".to_string()),
                None,
            );
            task.artifacts.push(RuntimeArtifact::new(
                "subagent-orchestration",
                "Subagent Orchestration",
                None,
                None,
                Some(orchestration_value.clone()),
            ));
            let checkpoint = RuntimeCheckpointRecord::new(
                "orchestration",
                "spawn_agents",
                "subagent orchestration completed",
                Some(orchestration_value),
            );
            record_runtime_checkpoint(task, &mut runtime_checkpoint_events, checkpoint);
        }

        if let Some(repair_value) = prepared.repair_plan.clone() {
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "review",
                "failed",
                Some("reviewer requested repair".to_string()),
                Some("reviewer rejected execution".to_string()),
            );
            task.artifacts.push(RuntimeArtifact::new(
                "repair-plan",
                "Repair Plan",
                None,
                None,
                Some(repair_value.clone()),
            ));
            let checkpoint = RuntimeCheckpointRecord::new(
                "repair",
                "review",
                payload_string(&repair_value, "summary")
                    .unwrap_or_else(|| "review repair plan generated".to_string()),
                Some(repair_value.clone()),
            );
            record_runtime_checkpoint(task, &mut runtime_checkpoint_events, checkpoint);
        }

        if let Some(repair_value) = prepared.repair_orchestration.clone() {
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "handoff",
                "completed",
                Some("repair pass completed".to_string()),
                None,
            );
            task.artifacts.push(RuntimeArtifact::new(
                "repair-pass",
                "Repair Pass",
                None,
                None,
                Some(repair_value.clone()),
            ));
            let checkpoint = RuntimeCheckpointRecord::new(
                "repair_pass",
                "handoff",
                "repair pass completed",
                Some(repair_value),
            );
            record_runtime_checkpoint(task, &mut runtime_checkpoint_events, checkpoint);
        }

        if let Some(artifact) = saved_artifact.clone() {
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "save_artifact",
                "completed",
                Some("artifact saved".to_string()),
                None,
            );
            task.artifacts.push(artifact.clone());
            let checkpoint = RuntimeCheckpointRecord::new(
                "save_artifact",
                "save_artifact",
                "artifact saved",
                Some(serde_json::to_value(&artifact).unwrap_or_else(|_| Value::Null)),
            );
            record_runtime_checkpoint(task, &mut runtime_checkpoint_events, checkpoint);
            work_items_to_push.push(build_runtime_artifact_work_item(
                task_id,
                task.owner_session_id.as_deref(),
                &prepared.route,
                &artifact,
            ));
        }

        if prepared.reviewer_blocked && prepared.repair_pass_failed {
            task.status = "failed".to_string();
            task.last_error = Some("reviewer rejected execution".to_string());
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "execute_tools",
                "failed",
                Some("execution blocked by reviewer".to_string()),
                Some("reviewer rejected execution".to_string()),
            );
            if let Some(repair_value) = prepared.repair_plan.clone() {
                work_items_to_push.push(build_runtime_repair_work_item(
                    task_id,
                    task.owner_session_id.as_deref(),
                    &prepared.route,
                    &repair_value,
                ));
            }
        } else {
            task.status = "completed".to_string();
            task.last_error = None;
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "review",
                "completed",
                Some("reviewer approved execution".to_string()),
                None,
            );
            record_runtime_node(
                task,
                &mut runtime_node_events,
                "execute_tools",
                "completed",
                Some("execution completed".to_string()),
                None,
            );
        }

        task.completed_at = Some(now_i64());
        task.updated_at = now_i64();
    }
    store.work_items.extend(work_items_to_push);
    append_resume_traces(
        store,
        task_id,
        prepared.route_value.clone(),
        prepared.orchestration.clone(),
        prepared.repair_plan.clone(),
        prepared.repair_orchestration.clone(),
        prepared.reviewer_blocked && prepared.repair_pass_failed,
    );

    Ok(AppliedTaskResumeExecution {
        response: serde_json::json!({
            "success": !(prepared.reviewer_blocked && prepared.repair_pass_failed),
            "taskId": task_id,
            "error": if prepared.reviewer_blocked && prepared.repair_pass_failed {
                Value::String("reviewer rejected execution".to_string())
            } else {
                Value::Null
            }
        }),
        runtime_node_events,
        runtime_checkpoint_events,
    })
}

pub fn append_resume_traces(
    store: &mut AppStore,
    task_id: &str,
    route_value: Value,
    orchestration: Option<Value>,
    repair_plan: Option<Value>,
    repair_orchestration: Option<Value>,
    failed: bool,
) {
    append_runtime_task_trace(
        store,
        task_id,
        "resumed",
        Some(serde_json::json!({ "route": route_value })),
    );
    if let Some(orchestration_value) = orchestration {
        append_runtime_task_trace(
            store,
            task_id,
            "subagent.completed",
            Some(orchestration_value),
        );
    }
    if let Some(repair_value) = repair_plan {
        append_runtime_task_trace(store, task_id, "repair.generated", Some(repair_value));
    }
    if let Some(repair_value) = repair_orchestration {
        append_runtime_task_trace(store, task_id, "repair.pass_completed", Some(repair_value));
    }
    append_runtime_task_trace(
        store,
        task_id,
        if failed { "failed" } else { "completed" },
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
    nodes.push(pending_node(
        "save_artifact",
        "save_artifact",
        "Save Artifact",
    ));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::runtime_direct_route_record;

    #[test]
    fn resume_runtime_task_snapshot_marks_task_running_and_returns_clone() {
        let route = runtime_direct_route_record("default", "draft", None);
        let task = create_runtime_task(
            "manual",
            "pending",
            "default".to_string(),
            Some("session-1".to_string()),
            Some("draft".to_string()),
            route,
            None,
        );
        let task_id = task.id.clone();
        let mut store = crate::AppStore::default();
        store.runtime_tasks.push(task);

        let snapshot =
            resume_runtime_task_snapshot(&mut store, &task_id, "resumed from test").unwrap();

        assert_eq!(snapshot.status, "running");
        assert_eq!(store.runtime_tasks[0].status, "running");
        assert_eq!(store.runtime_tasks[0].current_node.as_deref(), Some("plan"));
        let plan = store.runtime_tasks[0]
            .graph
            .iter()
            .find(|node| node.id == "plan")
            .unwrap();
        assert_eq!(plan.status, "running");
        assert_eq!(plan.summary.as_deref(), Some("resumed from test"));
    }

    #[test]
    fn cancel_runtime_task_marks_completed_and_returns_true() {
        let route = runtime_direct_route_record("default", "draft", None);
        let task = create_runtime_task(
            "manual",
            "running",
            "default".to_string(),
            None,
            Some("draft".to_string()),
            route,
            None,
        );
        let task_id = task.id.clone();
        let mut store = crate::AppStore::default();
        store.runtime_tasks.push(task);

        assert!(cancel_runtime_task(&mut store, &task_id));
        assert_eq!(store.runtime_tasks[0].status, "cancelled");
        assert!(store.runtime_tasks[0].completed_at.is_some());
    }

    #[test]
    fn cancel_runtime_task_returns_false_for_unknown_task() {
        let mut store = crate::AppStore::default();
        assert!(!cancel_runtime_task(&mut store, "missing-task"));
    }

    #[test]
    fn store_runtime_task_persists_task_and_created_trace() {
        let route = runtime_direct_route_record("default", "draft", None);
        let mut store = crate::AppStore::default();

        let task = store_runtime_task(
            &mut store,
            "manual",
            "pending",
            "default".to_string(),
            Some("session-1".to_string()),
            Some("draft".to_string()),
            route,
            Some(serde_json::json!({ "source": "test" })),
        );

        assert_eq!(store.runtime_tasks.len(), 1);
        assert_eq!(store.runtime_tasks[0].id, task.id);
        assert_eq!(store.runtime_task_traces.len(), 1);
        assert_eq!(store.runtime_task_traces[0].event_type, "created");
        assert_eq!(
            store.runtime_task_traces[0]
                .payload
                .as_ref()
                .and_then(|value| value.get("runtimeMode"))
                .and_then(Value::as_str),
            Some("default")
        );
    }

    #[test]
    fn list_runtime_task_traces_can_include_children() {
        let route = runtime_direct_route_record("default", "draft", None);
        let mut parent = create_runtime_task(
            "manual",
            "pending",
            "default".to_string(),
            Some("session-parent".to_string()),
            Some("draft".to_string()),
            route.clone(),
            None,
        );
        let parent_id = parent.id.clone();
        parent.runtime_id = Some("runtime-parent".to_string());
        let mut child = create_runtime_task(
            "subagent",
            "pending",
            "default".to_string(),
            Some("session-child".to_string()),
            Some("draft".to_string()),
            route,
            None,
        );
        child.parent_task_id = Some(parent_id.clone());
        child.id = "task-child".to_string();
        let mut store = crate::AppStore::default();
        store.runtime_tasks.push(parent.clone());
        store.runtime_tasks.push(child.clone());
        append_runtime_task_trace(&mut store, &parent_id, "created", None);
        append_runtime_task_trace(&mut store, &child.id, "completed", None);

        assert_eq!(list_runtime_task_traces(&store, &parent_id, false).len(), 1);
        assert_eq!(list_runtime_task_traces(&store, &parent_id, true).len(), 2);
    }
}
