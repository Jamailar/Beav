use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::runtime_orchestration::{
    run_reviewer_repair_for_task, run_subagent_orchestration_for_task, save_runtime_task_artifact,
};
use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_task_node_changed};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace, create_runtime_task, get_runtime_task, list_runtime_task_traces,
    list_runtime_tasks, mark_task_running, route_for_task_snapshot, runtime_task_value,
    set_runtime_graph_node, RuntimeArtifact, RuntimeCheckpointRecord,
};
use crate::{
    create_work_item, log_timing_event, now_i64, now_ms, payload_field, payload_string, AppState,
};

pub fn handle_runtime_task_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "tasks:create" | "tasks:list" | "tasks:get" | "tasks:resume" | "tasks:cancel"
        | "tasks:trace" => {}
        _ => return None,
    }

    let result: Result<Value, String> = (|| -> Result<Value, String> {
        match channel {
            "tasks:create" => {
                let runtime_mode =
                    payload_string(payload, "runtimeMode").unwrap_or_else(|| "default".to_string());
                let owner_session_id = payload_string(payload, "sessionId");
                let user_input = payload_string(payload, "userInput")
                    .unwrap_or_else(|| "开发者手动创建任务".to_string());
                let metadata = payload_field(payload, "metadata").cloned();
                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let route = route_runtime_intent_with_settings(
                    &settings_snapshot,
                    &runtime_mode,
                    &user_input,
                    metadata.as_ref(),
                );
                let route_value = route.clone().into_value();
                let created = with_store_mut(state, |store| {
                    let task = create_runtime_task(
                        "manual",
                        "pending",
                        runtime_mode,
                        owner_session_id,
                        Some(user_input.clone()),
                        route.clone(),
                        metadata,
                    );
                    append_runtime_task_trace(
                        store,
                        &task.id,
                        "created",
                        Some(json!({
                            "goal": task.goal.clone(),
                            "runtimeMode": task.runtime_mode,
                            "intent": task.intent,
                            "roleId": task.role_id,
                            "route": route_value
                        })),
                    );
                    store.runtime_tasks.push(task.clone());
                    Ok(task)
                })?;
                Ok(json!(created))
            }
            "tasks:list" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("tasks:list:{}", started_at);
                let tasks = list_runtime_tasks(&store);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "tasks:list",
                    started_at,
                    Some(format!("tasks={}", tasks.len())),
                );
                Ok(json!(tasks))
            }),
            "tasks:get" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                with_store(state, |store| {
                    Ok(get_runtime_task(&store, &task_id).map_or(Value::Null, |item| {
                        runtime_task_value(&item)
                    }))
                })
            }
            "tasks:resume" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                let task_snapshot = with_store_mut(state, |store| {
                    let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    else {
                        return Ok(None);
                    };
                    mark_task_running(task, "route and execution plan resumed");
                    Ok(Some(task.clone()))
                })?;
                let Some(task_snapshot) = task_snapshot else {
                    return Ok(json!({ "success": false, "error": "任务不存在" }));
                };

                let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                let route = route_for_task_snapshot(&task_snapshot).unwrap_or_else(|| {
                    crate::runtime::runtime_direct_route_record(
                        &task_snapshot.runtime_mode,
                        task_snapshot.goal.as_deref().unwrap_or(""),
                        task_snapshot.metadata.as_ref(),
                    )
                });
                let route_value = route.clone().into_value();
                let orchestration = if route.requires_multi_agent
                    || task_snapshot.runtime_mode == "background-maintenance"
                {
                    Some(run_subagent_orchestration_for_task(
                        Some(app),
                        &settings_snapshot,
                        &task_snapshot.runtime_mode,
                        &task_snapshot.id,
                        task_snapshot.owner_session_id.as_deref(),
                        &route,
                        task_snapshot.goal.as_deref().unwrap_or(""),
                    )?)
                } else {
                    None
                };
                let reviewer_blocked = reviewer_rejected(orchestration.as_ref()).unwrap_or(false);
                let repair_plan = if reviewer_blocked {
                    orchestration
                        .as_ref()
                        .map(|value| {
                            run_reviewer_repair_for_task(
                                &settings_snapshot,
                                &task_snapshot.id,
                                &route,
                                task_snapshot.goal.as_deref().unwrap_or(""),
                                value,
                            )
                        })
                        .transpose()?
                } else {
                    None
                };
                let repair_orchestration = if reviewer_blocked {
                    repair_plan
                        .as_ref()
                        .map(|repair| {
                            let repair_goal = format!(
                                "{}\n\nRepair instructions:\n{}",
                                task_snapshot.goal.as_deref().unwrap_or(""),
                                payload_string(repair, "summary")
                                    .unwrap_or_else(|| repair.to_string())
                            );
                            run_subagent_orchestration_for_task(
                                Some(app),
                                &settings_snapshot,
                                &task_snapshot.runtime_mode,
                                &format!("{}-repair", task_snapshot.id),
                                task_snapshot.owner_session_id.as_deref(),
                                &route,
                                &repair_goal,
                            )
                        })
                        .transpose()?
                } else {
                    None
                };
                let repair_pass_failed =
                    reviewer_rejected(repair_orchestration.as_ref()).unwrap_or(reviewer_blocked);
                let final_orchestration = repair_orchestration.as_ref().or(orchestration.as_ref());
                let saved_artifact = if reviewer_blocked && repair_pass_failed {
                    None
                } else {
                    Some(save_runtime_task_artifact(
                        state,
                        &task_snapshot.id,
                        &route,
                        task_snapshot.goal.as_deref().unwrap_or(""),
                        final_orchestration,
                    )?)
                };

                let mut runtime_node_events: Vec<(String, String, Option<String>, Option<String>)> =
                    Vec::new();
                let mut runtime_checkpoint_events: Vec<(String, String, Option<Value>)> =
                    Vec::new();
                let result = with_store_mut(state, |store| {
                    let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    else {
                        return Ok(json!({ "success": false, "error": "任务不存在" }));
                    };

                    task.intent = Some(route.intent.clone());
                    task.role_id = Some(route.recommended_role.clone());
                    task.route = Some(route.clone());
                    task.current_node = Some("execute_tools".to_string());

                    set_runtime_graph_node(
                        &mut task.graph,
                        "plan",
                        "completed",
                        Some(if route.reasoning.trim().is_empty() {
                            "route resolved".to_string()
                        } else {
                            route.reasoning.clone()
                        }),
                        None,
                    );
                    runtime_node_events.push((
                        "plan".to_string(),
                        "completed".to_string(),
                        Some(if route.reasoning.trim().is_empty() {
                            "route resolved".to_string()
                        } else {
                            route.reasoning.clone()
                        }),
                        None,
                    ));

                    set_runtime_graph_node(
                        &mut task.graph,
                        "retrieve",
                        "completed",
                        Some("runtime context prepared".to_string()),
                        None,
                    );
                    runtime_node_events.push((
                        "retrieve".to_string(),
                        "completed".to_string(),
                        Some("runtime context prepared".to_string()),
                        None,
                    ));

                    if let Some(orchestration_value) = orchestration.clone() {
                        set_runtime_graph_node(
                            &mut task.graph,
                            "spawn_agents",
                            "completed",
                            Some("subagent orchestration completed".to_string()),
                            None,
                        );
                        runtime_node_events.push((
                            "spawn_agents".to_string(),
                            "completed".to_string(),
                            Some("subagent orchestration completed".to_string()),
                            None,
                        ));
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
                        runtime_checkpoint_events.push((
                            "orchestration".to_string(),
                            checkpoint.summary.clone(),
                            checkpoint.payload.clone(),
                        ));
                        task.checkpoints.push(checkpoint);
                    }

                    if let Some(repair_value) = repair_plan.clone() {
                        set_runtime_graph_node(
                            &mut task.graph,
                            "review",
                            "failed",
                            Some("reviewer requested repair".to_string()),
                            Some("reviewer rejected execution".to_string()),
                        );
                        runtime_node_events.push((
                            "review".to_string(),
                            "failed".to_string(),
                            Some("reviewer requested repair".to_string()),
                            Some("reviewer rejected execution".to_string()),
                        ));
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
                        runtime_checkpoint_events.push((
                            "repair".to_string(),
                            checkpoint.summary.clone(),
                            checkpoint.payload.clone(),
                        ));
                        task.checkpoints.push(checkpoint);
                    }

                    if let Some(repair_value) = repair_orchestration.clone() {
                        set_runtime_graph_node(
                            &mut task.graph,
                            "handoff",
                            "completed",
                            Some("repair pass completed".to_string()),
                            None,
                        );
                        runtime_node_events.push((
                            "handoff".to_string(),
                            "completed".to_string(),
                            Some("repair pass completed".to_string()),
                            None,
                        ));
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
                        runtime_checkpoint_events.push((
                            "repair_pass".to_string(),
                            checkpoint.summary.clone(),
                            checkpoint.payload.clone(),
                        ));
                        task.checkpoints.push(checkpoint);
                    }

                    if let Some(artifact_value) = saved_artifact.clone() {
                        set_runtime_graph_node(
                            &mut task.graph,
                            "save_artifact",
                            "completed",
                            Some("artifact saved".to_string()),
                            None,
                        );
                        runtime_node_events.push((
                            "save_artifact".to_string(),
                            "completed".to_string(),
                            Some("artifact saved".to_string()),
                            None,
                        ));
                        task.artifacts
                            .push(runtime_artifact_from_value(&artifact_value));
                        let checkpoint = RuntimeCheckpointRecord::new(
                            "save_artifact",
                            "save_artifact",
                            "artifact saved",
                            Some(artifact_value.clone()),
                        );
                        runtime_checkpoint_events.push((
                            "save_artifact".to_string(),
                            checkpoint.summary.clone(),
                            checkpoint.payload.clone(),
                        ));
                        task.checkpoints.push(checkpoint);

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
                            Some(
                                payload_string(&artifact_value, "path").unwrap_or_default(),
                            ),
                            Some(json!({
                                "taskId": task_id,
                                "sessionId": task.owner_session_id.clone(),
                                "intent": route.intent.clone(),
                                "artifact": artifact_value.clone(),
                            })),
                            2,
                        );
                        work_item.refs.task_ids.push(task_id.clone());
                        if let Some(session_id) = task.owner_session_id.clone() {
                            work_item.refs.session_ids.push(session_id);
                        }
                        store.work_items.push(work_item);
                    }

                    if reviewer_blocked && repair_pass_failed {
                        task.status = "failed".to_string();
                        task.last_error = Some("reviewer rejected execution".to_string());
                        set_runtime_graph_node(
                            &mut task.graph,
                            "execute_tools",
                            "failed",
                            Some("execution blocked by reviewer".to_string()),
                            Some("reviewer rejected execution".to_string()),
                        );
                        runtime_node_events.push((
                            "execute_tools".to_string(),
                            "failed".to_string(),
                            Some("execution blocked by reviewer".to_string()),
                            Some("reviewer rejected execution".to_string()),
                        ));
                        if let Some(repair_value) = repair_plan.clone() {
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
                                    payload_string(&repair_value, "summary")
                                        .unwrap_or_else(|| "reviewer repair required".to_string()),
                                ),
                                Some(route.goal.clone()),
                                Some(json!({
                                    "taskId": task_id,
                                    "sessionId": task.owner_session_id.clone(),
                                    "intent": route.intent.clone(),
                                    "repair": repair_value,
                                })),
                                1,
                            );
                            work_item.refs.task_ids.push(task_id.clone());
                            if let Some(session_id) = task.owner_session_id.clone() {
                                work_item.refs.session_ids.push(session_id);
                            }
                            store.work_items.push(work_item);
                        }
                    } else {
                        task.status = "completed".to_string();
                        task.last_error = None;
                        set_runtime_graph_node(
                            &mut task.graph,
                            "review",
                            "completed",
                            Some("reviewer approved execution".to_string()),
                            None,
                        );
                        runtime_node_events.push((
                            "review".to_string(),
                            "completed".to_string(),
                            Some("reviewer approved execution".to_string()),
                            None,
                        ));
                        set_runtime_graph_node(
                            &mut task.graph,
                            "execute_tools",
                            "completed",
                            Some("execution completed".to_string()),
                            None,
                        );
                        runtime_node_events.push((
                            "execute_tools".to_string(),
                            "completed".to_string(),
                            Some("execution completed".to_string()),
                            None,
                        ));
                    }

                    task.completed_at = Some(now_i64());
                    task.updated_at = now_i64();
                    append_runtime_task_trace(
                        store,
                        &task_id,
                        "resumed",
                        Some(json!({ "route": route_value.clone() })),
                    );
                    if let Some(orchestration_value) = orchestration.clone() {
                        append_runtime_task_trace(
                            store,
                            &task_id,
                            "subagent.completed",
                            Some(orchestration_value),
                        );
                    }
                    if let Some(repair_value) = repair_plan.clone() {
                        append_runtime_task_trace(
                            store,
                            &task_id,
                            "repair.generated",
                            Some(repair_value),
                        );
                    }
                    if let Some(repair_value) = repair_orchestration.clone() {
                        append_runtime_task_trace(
                            store,
                            &task_id,
                            "repair.pass_completed",
                            Some(repair_value),
                        );
                    }
                    append_runtime_task_trace(
                        store,
                        &task_id,
                        if reviewer_blocked && repair_pass_failed {
                            "failed"
                        } else {
                            "completed"
                        },
                        None,
                    );

                    Ok(json!({
                        "success": !(reviewer_blocked && repair_pass_failed),
                        "taskId": task_id,
                        "error": if reviewer_blocked && repair_pass_failed {
                            Value::String("reviewer rejected execution".to_string())
                        } else {
                            Value::Null
                        }
                    }))
                })?;

                for (node_id, status, summary, error) in runtime_node_events {
                    emit_runtime_task_node_changed(
                        app,
                        &task_id,
                        task_snapshot.owner_session_id.as_deref(),
                        &node_id,
                        &status,
                        summary.as_deref(),
                        error.as_deref(),
                    );
                }
                for (checkpoint_type, summary, payload) in runtime_checkpoint_events {
                    emit_runtime_task_checkpoint_saved(
                        app,
                        Some(&task_id),
                        task_snapshot.owner_session_id.as_deref(),
                        &checkpoint_type,
                        &summary,
                        payload,
                    );
                }
                Ok(result)
            }
            "tasks:cancel" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                let result = with_store_mut(state, |store| {
                    let Some(task) = store
                        .runtime_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    else {
                        return Ok(json!({ "success": false, "error": "任务不存在" }));
                    };
                    task.status = "cancelled".to_string();
                    task.updated_at = now_i64();
                    task.completed_at = Some(now_i64());
                    append_runtime_task_trace(store, &task_id, "cancelled", None);
                    Ok(json!({ "success": true, "taskId": task_id }))
                })?;
                Ok(result)
            }
            "tasks:trace" => {
                let task_id = payload_string(payload, "taskId").unwrap_or_default();
                with_store(state, |store| Ok(json!(list_runtime_task_traces(&store, &task_id))))
            }
            _ => unreachable!("channel prefiltered"),
        }
    })();
    Some(result)
}

fn reviewer_rejected(orchestration: Option<&Value>) -> Option<bool> {
    orchestration
        .and_then(|value| value.get("outputs"))
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("roleId").and_then(|value| value.as_str()) == Some("reviewer")
            })
        })
        .map(|review| {
            let approved = review
                .get("approved")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            let issue_count = review
                .get("issues")
                .and_then(|value| value.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            !approved || issue_count > 0
        })
}

fn runtime_artifact_from_value(value: &Value) -> RuntimeArtifact {
    RuntimeArtifact::from_value(value).unwrap_or_else(|| {
        RuntimeArtifact::new(
            payload_string(value, "type").unwrap_or_else(|| "artifact".to_string()),
            payload_string(value, "label").unwrap_or_else(|| "Runtime Artifact".to_string()),
            payload_string(value, "path"),
            Some(value.clone()),
            None,
        )
    })
}
