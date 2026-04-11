use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::runtime_orchestration::{
    run_reviewer_repair_for_task, run_subagent_orchestration_for_task, save_runtime_task_artifact,
};
use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_task_node_changed};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_resume_traces, append_runtime_task_trace, build_repair_goal,
    build_runtime_artifact_work_item, build_runtime_repair_work_item, create_runtime_task,
    get_runtime_task, list_runtime_task_traces, list_runtime_tasks, mark_task_running,
    record_runtime_checkpoint, record_runtime_node, reviewer_rejected, route_for_task_snapshot,
    runtime_task_value, PreparedTaskResumeExecution, RuntimeArtifact,
    RuntimeCheckpointEvent, RuntimeCheckpointRecord, RuntimeNodeEvent,
};
use crate::{log_timing_event, now_i64, now_ms, payload_field, payload_string, AppState};

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
                let prepared = prepare_task_resume_execution(
                    app,
                    &settings_snapshot,
                    &task_snapshot,
                )?;
                let final_orchestration = prepared
                    .repair_orchestration
                    .as_ref()
                    .or(prepared.orchestration.as_ref());
                let saved_artifact = if prepared.reviewer_blocked && prepared.repair_pass_failed {
                    None
                } else {
                    Some(save_runtime_task_artifact(
                        state,
                        &task_snapshot.id,
                        &prepared.route,
                        task_snapshot.goal.as_deref().unwrap_or(""),
                        final_orchestration,
                    )?)
                };

                let mut runtime_node_events: Vec<RuntimeNodeEvent> = Vec::new();
                let mut runtime_checkpoint_events: Vec<RuntimeCheckpointEvent> = Vec::new();
                let result = with_store_mut(state, |store| {
                    apply_task_resume_execution(
                        store,
                        &task_id,
                        &prepared,
                        saved_artifact.clone(),
                        &mut runtime_node_events,
                        &mut runtime_checkpoint_events,
                    )
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

fn prepare_task_resume_execution(
    app: &AppHandle,
    settings_snapshot: &Value,
    task_snapshot: &crate::runtime::RuntimeTaskRecord,
) -> Result<PreparedTaskResumeExecution, String> {
    let route = route_for_task_snapshot(task_snapshot).unwrap_or_else(|| {
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
            settings_snapshot,
            &task_snapshot.runtime_mode,
            &task_snapshot.id,
            task_snapshot.owner_session_id.as_deref(),
            &route,
            task_snapshot.goal.as_deref().unwrap_or(""),
        )?)
    } else {
        None
    };
    let reviewer_blocked = reviewer_rejected(orchestration.as_ref());
    let repair_plan = if reviewer_blocked {
        orchestration
            .as_ref()
            .map(|value| {
                run_reviewer_repair_for_task(
                    settings_snapshot,
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
                let repair_goal =
                    build_repair_goal(task_snapshot.goal.as_deref().unwrap_or(""), repair);
                run_subagent_orchestration_for_task(
                    Some(app),
                    settings_snapshot,
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
    let repair_pass_failed = reviewer_rejected(repair_orchestration.as_ref());
    Ok(PreparedTaskResumeExecution {
        route,
        route_value,
        orchestration,
        repair_plan,
        repair_orchestration,
        reviewer_blocked,
        repair_pass_failed,
    })
}

fn apply_task_resume_execution(
    store: &mut crate::AppStore,
    task_id: &str,
    prepared: &PreparedTaskResumeExecution,
    saved_artifact: Option<RuntimeArtifact>,
    runtime_node_events: &mut Vec<RuntimeNodeEvent>,
    runtime_checkpoint_events: &mut Vec<RuntimeCheckpointEvent>,
) -> Result<Value, String> {
    let mut work_items_to_push = Vec::new();
    {
        let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task_id)
        else {
            return Ok(json!({ "success": false, "error": "任务不存在" }));
        };

        task.intent = Some(prepared.route.intent.clone());
        task.role_id = Some(prepared.route.recommended_role.clone());
        task.route = Some(prepared.route.clone());
        task.current_node = Some("execute_tools".to_string());

        record_runtime_node(
            task,
            runtime_node_events,
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
            runtime_node_events,
            "retrieve",
            "completed",
            Some("runtime context prepared".to_string()),
            None,
        );

        if let Some(orchestration_value) = prepared.orchestration.clone() {
            record_runtime_node(
                task,
                runtime_node_events,
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
            record_runtime_checkpoint(task, runtime_checkpoint_events, checkpoint);
        }

        if let Some(repair_value) = prepared.repair_plan.clone() {
            record_runtime_node(
                task,
                runtime_node_events,
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
            record_runtime_checkpoint(task, runtime_checkpoint_events, checkpoint);
        }

        if let Some(repair_value) = prepared.repair_orchestration.clone() {
            record_runtime_node(
                task,
                runtime_node_events,
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
            record_runtime_checkpoint(task, runtime_checkpoint_events, checkpoint);
        }

        if let Some(artifact) = saved_artifact.clone() {
            record_runtime_node(
                task,
                runtime_node_events,
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
            record_runtime_checkpoint(task, runtime_checkpoint_events, checkpoint);
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
                runtime_node_events,
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
                runtime_node_events,
                "review",
                "completed",
                Some("reviewer approved execution".to_string()),
                None,
            );
            record_runtime_node(
                task,
                runtime_node_events,
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

    Ok(json!({
        "success": !(prepared.reviewer_blocked && prepared.repair_pass_failed),
        "taskId": task_id,
        "error": if prepared.reviewer_blocked && prepared.repair_pass_failed {
            Value::String("reviewer rejected execution".to_string())
        } else {
            Value::Null
        }
    }))
}
