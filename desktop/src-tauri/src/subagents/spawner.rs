use std::collections::BTreeMap;
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::agent::{
    build_runtime_query_turn, execute_prepared_session_agent_turn, PreparedSessionAgentTurn,
};
use crate::events::{
    emit_runtime_subagent_finished, emit_runtime_subagent_spawned,
    emit_runtime_task_checkpoint_saved, emit_runtime_task_node_changed,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace_scoped, append_session_checkpoint_scoped, create_runtime_task,
    record_runtime_node, RuntimeArtifact, RuntimeCheckpointRecord, RuntimeRouteRecord,
};
use crate::subagents::{
    build_orchestration_value, build_subagent_configs, SubAgentConfig, SubAgentOutput,
    SubAgentSpawnResult,
};
use crate::{
    append_debug_log_state, make_id, now_i64, now_iso, parse_json_value_from_text,
    payload_string, AppState, AppStore, ChatSessionRecord,
};

fn snippet(value: &str, limit: usize) -> String {
    let text = value.replace('\n', "\\n");
    if text.chars().count() <= limit {
        text
    } else {
        let preview = text.chars().take(limit).collect::<String>();
        format!("{preview}...")
    }
}

fn model_config_summary(config: Option<&Value>) -> String {
    config
        .and_then(Value::as_object)
        .map(|object| {
            format!(
                "baseURL={} | modelName={} | protocol={} | apiKeyPresent={} | reasoningEffort={}",
                object.get("baseURL").and_then(Value::as_str).unwrap_or(""),
                object.get("modelName").and_then(Value::as_str).unwrap_or(""),
                object.get("protocol").and_then(Value::as_str).unwrap_or(""),
                object
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false),
                object
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            )
        })
        .unwrap_or_else(|| "none".to_string())
}

fn log_subagent_state(state: &State<'_, AppState>, line: String) {
    eprintln!("{}", line);
    append_debug_log_state(state, line);
}

fn context_type_for_runtime_mode(runtime_mode: &str) -> &'static str {
    match runtime_mode {
        "wander" => "wander",
        "knowledge" => "knowledge",
        "redclaw" => "redclaw",
        "advisor-discussion" => "advisor-discussion",
        "background-maintenance" => "background-maintenance",
        _ => "chat",
    }
}

fn merge_metadata(base: Option<&Value>, overlay: Option<&Value>) -> Option<Value> {
    let mut object = base.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(overlay) = overlay.and_then(Value::as_object) {
        for (key, value) in overlay {
            object.insert(key.clone(), value.clone());
        }
    }
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object))
    }
}

fn build_child_route(
    parent_route: &RuntimeRouteRecord,
    role_id: &str,
    parent_task_id: &str,
) -> RuntimeRouteRecord {
    let mut route = parent_route.clone();
    route.recommended_role = role_id.to_string();
    route.requires_multi_agent = false;
    route.requires_long_running_task = false;
    route.reasoning = format!("child-runtime:{}; parentTask={}", role_id, parent_task_id);
    route.source = "subagent-runtime".to_string();
    route
}

fn build_child_prompt(
    config: &SubAgentConfig,
    route: &RuntimeRouteRecord,
    user_input: &str,
    prior_outputs: &[SubAgentOutput],
) -> String {
    let prior_summary = if prior_outputs.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string_pretty(prior_outputs).unwrap_or_else(|_| "[]".to_string())
    };
    let allowed_tools = if config.fork_overrides.allowed_tools.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&config.fork_overrides.allowed_tools)
            .unwrap_or_else(|_| "[]".to_string())
    };
    let system_patch = config
        .fork_overrides
        .system_prompt_patch
        .clone()
        .unwrap_or_default();
    format!(
        "You are a RedBox child runtime.\nRole: {}\nGoal: {}\nUser input: {}\nAllowed tools: {}\nPrior outputs: {}\n{}\nReturn strict JSON only with fields summary, artifact, handoff, risks, issues, approved.",
        config.role_id,
        route.goal,
        user_input,
        allowed_tools,
        prior_summary,
        system_patch,
    )
}

fn parse_child_output(
    response: &str,
    role_id: &str,
    child_task_id: &str,
    child_session_id: &str,
) -> SubAgentOutput {
    let parsed = parse_json_value_from_text(response).unwrap_or_else(|| {
        json!({
            "summary": response,
            "artifact": "",
            "handoff": "",
            "risks": [],
            "issues": [],
            "approved": true
        })
    });
    SubAgentOutput {
        role_id: role_id.to_string(),
        summary: payload_string(&parsed, "summary").unwrap_or_else(|| response.to_string()),
        artifact: payload_string(&parsed, "artifact"),
        handoff: payload_string(&parsed, "handoff"),
        risks: parsed
            .get("risks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        issues: parsed
            .get("issues")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        approved: parsed
            .get("approved")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        child_task_id: Some(child_task_id.to_string()),
        child_session_id: Some(child_session_id.to_string()),
        status: "completed".to_string(),
    }
}

fn ensure_parent_runtime_id(
    state: &State<'_, AppState>,
    parent_task_id: &str,
    parent_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    with_store_mut(state, |store| {
        if let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == parent_task_id)
        {
            if task.runtime_id.is_none() {
                task.runtime_id = Some(make_id("runtime"));
            }
            return Ok(task.runtime_id.clone());
        }
        if let Some(session_id) = parent_session_id {
            if let Some(session) = store
                .chat_sessions
                .iter_mut()
                .find(|item| item.id == session_id)
            {
                let mut metadata = session
                    .metadata
                    .as_ref()
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let runtime_id = metadata
                    .get("runtimeId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| make_id("runtime"));
                metadata.insert("runtimeId".to_string(), json!(runtime_id.clone()));
                session.metadata = Some(Value::Object(metadata));
                return Ok(Some(runtime_id));
            }
        }
        Ok(None)
    })
}

fn create_child_runtime_records_in_store(
    store: &mut AppStore,
    parent_task_id: &str,
    parent_runtime_id: Option<&str>,
    config: &SubAgentConfig,
    route: &RuntimeRouteRecord,
) -> SubAgentSpawnResult {
    let child_runtime_id = make_id("runtime");
    let child_session_id = make_id("session");
    let child_task_id = make_id("task");
    let parent_session = config
        .parent_session_id
        .as_deref()
        .and_then(|session_id| {
            store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
        })
        .cloned();
    let root_session_id = parent_session
        .as_ref()
        .and_then(|session| session.metadata.as_ref())
        .and_then(|metadata| payload_string(metadata, "rootSessionId"))
        .or_else(|| config.parent_session_id.clone());
    let session_metadata = merge_metadata(
        parent_session
            .as_ref()
            .and_then(|session| session.metadata.as_ref()),
        config.fork_overrides.metadata.as_ref(),
    );
    let mut session_metadata_object = session_metadata
        .and_then(|item| item.as_object().cloned())
        .unwrap_or_default();
    session_metadata_object.insert(
        "contextType".to_string(),
        json!(context_type_for_runtime_mode(&config.runtime_mode)),
    );
    session_metadata_object.insert("runtimeId".to_string(), json!(child_runtime_id.clone()));
    session_metadata_object.insert("parentRuntimeId".to_string(), json!(parent_runtime_id));
    session_metadata_object.insert(
        "parentSessionId".to_string(),
        json!(config.parent_session_id.clone()),
    );
    session_metadata_object.insert("rootSessionId".to_string(), json!(root_session_id));
    session_metadata_object.insert("sourceTaskId".to_string(), json!(parent_task_id));
    session_metadata_object.insert("isSubagentSession".to_string(), json!(true));
    session_metadata_object.insert("roleId".to_string(), json!(config.role_id.clone()));
    session_metadata_object.insert(
        "allowedTools".to_string(),
        json!(config.fork_overrides.allowed_tools.clone()),
    );
    let timestamp = now_iso();
    store.chat_sessions.push(ChatSessionRecord {
        id: child_session_id.clone(),
        title: format!("{} · {}", config.role_id, parent_task_id),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        metadata: Some(Value::Object(session_metadata_object)),
    });

    let mut task = create_runtime_task(
        "subagent",
        "pending",
        config.runtime_mode.clone(),
        Some(child_session_id.clone()),
        Some(route.goal.clone()),
        route.clone(),
        Some(json!({
            "roleId": config.role_id,
            "useRealSubagents": true,
            "allowedTools": config.fork_overrides.allowed_tools,
            "modelConfig": config.model_config,
        })),
    );
    task.id = child_task_id.clone();
    task.runtime_id = Some(child_runtime_id.clone());
    task.parent_runtime_id = parent_runtime_id.map(ToString::to_string);
    task.parent_task_id = Some(parent_task_id.to_string());
    task.root_task_id = Some(parent_task_id.to_string());
    task.aggregation_status = Some("spawned".to_string());
    task.current_node = Some("spawn_agents".to_string());
    store.runtime_tasks.push(task.clone());
    append_runtime_task_trace_scoped(
        store,
        &child_task_id,
        task.runtime_id.clone(),
        task.parent_runtime_id.clone(),
        Some(parent_task_id.to_string()),
        Some("spawn_agents".to_string()),
        "created",
        Some(json!({
            "roleId": config.role_id,
            "runtimeMode": config.runtime_mode,
        })),
    );
    if let Some(parent) = store
        .runtime_tasks
        .iter_mut()
        .find(|item| item.id == parent_task_id)
    {
        parent.child_task_ids.push(child_task_id.clone());
        parent.aggregation_status = Some("running".to_string());
    }
    SubAgentSpawnResult {
        child_task_id,
        child_session_id,
        child_runtime_id,
        role_id: config.role_id.clone(),
    }
}

fn create_child_runtime_records(
    state: &State<'_, AppState>,
    parent_task_id: &str,
    parent_runtime_id: Option<&str>,
    config: &SubAgentConfig,
    route: &RuntimeRouteRecord,
) -> Result<SubAgentSpawnResult, String> {
    with_store_mut(state, |store| {
        Ok(create_child_runtime_records_in_store(
            store,
            parent_task_id,
            parent_runtime_id,
            config,
            route,
        ))
    })
}

fn persist_child_execution(
    state: &State<'_, AppState>,
    spawn: &SubAgentSpawnResult,
    config: &SubAgentConfig,
    route: &RuntimeRouteRecord,
    output: &SubAgentOutput,
    raw_response: &str,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        append_session_checkpoint_scoped(
            store,
            &spawn.child_session_id,
            Some(spawn.child_runtime_id.clone()),
            None,
            Some(spawn.child_task_id.clone()),
            "runtime.route",
            route.reasoning.clone(),
            Some(route.clone().into_value()),
        );
        if let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == spawn.child_task_id)
        {
            task.status = "completed".to_string();
            task.updated_at = now_i64();
            task.completed_at = Some(now_i64());
            task.current_node = Some("review".to_string());
            task.aggregation_status = Some("completed".to_string());
            record_runtime_node(
                task,
                &mut Vec::new(),
                "plan",
                "completed",
                Some(route.reasoning.clone()),
                None,
            );
            task.artifacts.push(RuntimeArtifact::new(
                "subagent-output",
                format!("Subagent Output · {}", config.role_id),
                None,
                Some(json!({
                    "roleId": config.role_id,
                    "runtimeId": spawn.child_runtime_id,
                })),
                Some(json!({
                    "summary": output.summary,
                    "artifact": output.artifact,
                    "handoff": output.handoff,
                    "risks": output.risks,
                    "issues": output.issues,
                    "approved": output.approved,
                    "rawResponse": raw_response,
                })),
            ));
            let checkpoint = RuntimeCheckpointRecord::new(
                "subagent.output",
                "review",
                output.summary.clone(),
                Some(json!({
                    "roleId": config.role_id,
                    "childTaskId": spawn.child_task_id,
                    "childSessionId": spawn.child_session_id,
                    "approved": output.approved,
                })),
            );
            task.checkpoints.push(checkpoint);
        }
        append_runtime_task_trace_scoped(
            store,
            &spawn.child_task_id,
            Some(spawn.child_runtime_id.clone()),
            None,
            Some(config.parent_task_id.clone()),
            Some("review".to_string()),
            "completed",
            Some(json!({
                "roleId": config.role_id,
                "summary": output.summary,
                "childSessionId": spawn.child_session_id,
            })),
        );
        Ok(())
    })
}

fn mark_child_failure(
    state: &State<'_, AppState>,
    spawn: &SubAgentSpawnResult,
    config: &SubAgentConfig,
    error: &str,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        if let Some(task) = store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == spawn.child_task_id)
        {
            task.status = "failed".to_string();
            task.last_error = Some(error.to_string());
            task.updated_at = now_i64();
            task.completed_at = Some(now_i64());
            task.aggregation_status = Some("failed".to_string());
        }
        append_runtime_task_trace_scoped(
            store,
            &spawn.child_task_id,
            Some(spawn.child_runtime_id.clone()),
            None,
            Some(config.parent_task_id.clone()),
            Some("review".to_string()),
            "failed",
            Some(json!({
                "roleId": config.role_id,
                "error": error,
            })),
        );
        Ok(())
    })
}

fn execute_subagent_config(
    app: AppHandle,
    spawn: SubAgentSpawnResult,
    config: SubAgentConfig,
    route: RuntimeRouteRecord,
    user_input: String,
    prior_outputs: Vec<SubAgentOutput>,
) -> Result<SubAgentOutput, String> {
    let state = app.state::<AppState>();
    let child_prompt = build_child_prompt(&config, &route, &user_input, &prior_outputs);
    log_subagent_state(
        &state,
        format!(
            "[subagent][start] role={} | parentTaskId={} | childTaskId={} | childSessionId={} | runtimeMode={} | modelConfig={} | userInputChars={} | priorOutputs={} | goal={} ",
            config.role_id,
            config.parent_task_id,
            spawn.child_task_id,
            spawn.child_session_id,
            config.runtime_mode,
            model_config_summary(config.model_config.as_ref()),
            user_input.chars().count(),
            prior_outputs.len(),
            snippet(&route.goal, 220)
        ),
    );
    log_subagent_state(
        &state,
        format!(
            "[subagent][prompt] role={} | childTaskId={} | promptChars={} | preview={}",
            config.role_id,
            spawn.child_task_id,
            child_prompt.chars().count(),
            snippet(&child_prompt, 800)
        ),
    );
    let turn = PreparedSessionAgentTurn::runtime_query(build_runtime_query_turn(
        Some(spawn.child_session_id.clone()),
        route.clone(),
        None,
        &child_prompt,
        config.model_config.as_ref(),
    ));
    emit_runtime_task_node_changed(
        &app,
        &spawn.child_task_id,
        Some(&spawn.child_session_id),
        "spawn_agents",
        "running",
        Some("subagent child runtime running"),
        None,
    );
    let execution = execute_prepared_session_agent_turn(Some(&app), &state, &turn)?;
    log_subagent_state(
        &state,
        format!(
            "[subagent][response] role={} | childTaskId={} | responseChars={} | preview={}",
            config.role_id,
            spawn.child_task_id,
            execution.response().chars().count(),
            snippet(execution.response(), 1200)
        ),
    );
    let output = parse_child_output(
        execution.response(),
        &config.role_id,
        &spawn.child_task_id,
        &spawn.child_session_id,
    );
    log_subagent_state(
        &state,
        format!(
            "[subagent][parsed] role={} | childTaskId={} | approved={} | summary={} | artifactChars={} | artifactPreview={}",
            config.role_id,
            spawn.child_task_id,
            output.approved,
            snippet(&output.summary, 280),
            output.artifact.as_ref().map(|value| value.chars().count()).unwrap_or(0),
            output
                .artifact
                .as_ref()
                .map(|value| snippet(value, 800))
                .unwrap_or_default()
        ),
    );
    persist_child_execution(
        &state,
        &spawn,
        &config,
        &route,
        &output,
        execution.response(),
    )?;
    emit_runtime_task_checkpoint_saved(
        &app,
        Some(&spawn.child_task_id),
        Some(&spawn.child_session_id),
        "subagent.output",
        &output.summary,
        Some(json!({
            "roleId": output.role_id,
            "childTaskId": output.child_task_id,
            "childSessionId": output.child_session_id,
            "approved": output.approved,
        })),
    );
    log_subagent_state(
        &state,
        format!(
            "[subagent][finished] role={} | childTaskId={} | childSessionId={} | status=completed",
            config.role_id,
            spawn.child_task_id,
            spawn.child_session_id
        ),
    );
    Ok(output)
}

pub fn run_real_subagent_orchestration_for_task(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &Value,
    runtime_mode: &str,
    task_id: &str,
    session_id: Option<&str>,
    route: &RuntimeRouteRecord,
    user_input: &str,
    metadata: Option<&Value>,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    let _ = settings;
    let parent_runtime_id = ensure_parent_runtime_id(state, task_id, session_id)?;
    let configs = build_subagent_configs(
        route,
        runtime_mode,
        task_id,
        session_id,
        metadata,
        model_config,
    );
    let mut grouped = BTreeMap::<usize, Vec<SubAgentConfig>>::new();
    for config in configs {
        grouped
            .entry(config.parallel_group)
            .or_default()
            .push(config);
    }
    let mut completed_outputs = Vec::<SubAgentOutput>::new();
    for wave in grouped.into_values() {
        let mut handles = Vec::new();
        for config in wave.into_iter().take(4) {
            let child_route = build_child_route(route, &config.role_id, task_id);
            let spawn = create_child_runtime_records(
                state,
                task_id,
                parent_runtime_id.as_deref(),
                &config,
                &child_route,
            )?;
            emit_runtime_subagent_spawned(
                app,
                Some(task_id),
                session_id,
                &config.role_id,
                runtime_mode,
                Some(&spawn.child_runtime_id),
                Some(&spawn.child_task_id),
                Some(&spawn.child_session_id),
                parent_runtime_id.as_deref(),
            );
            let app_handle = app.clone();
            let prior_outputs = completed_outputs.clone();
            let config_clone = config.clone();
            let spawn_clone = spawn.clone();
            let user_input_owned = user_input.to_string();
            handles.push(thread::spawn(move || {
                let result = execute_subagent_config(
                    app_handle.clone(),
                    spawn_clone.clone(),
                    config_clone.clone(),
                    child_route,
                    user_input_owned,
                    prior_outputs,
                );
                (spawn_clone, config_clone, result, app_handle)
            }));
        }
        for handle in handles {
            let (spawn, config, result, app_handle) = handle
                .join()
                .map_err(|_| "subagent thread panicked".to_string())?;
            match result {
                Ok(output) => {
                    emit_runtime_subagent_finished(
                        &app_handle,
                        Some(task_id),
                        session_id,
                        &config.role_id,
                        runtime_mode,
                        Some(&spawn.child_runtime_id),
                        Some(&spawn.child_task_id),
                        Some(&spawn.child_session_id),
                        parent_runtime_id.as_deref(),
                        "completed",
                        Some(&output.summary),
                        None,
                    );
                    completed_outputs.push(output);
                }
                Err(error) => {
                    let child_state = app_handle.state::<AppState>();
                    log_subagent_state(
                        &child_state,
                        format!(
                            "[subagent][failed] role={} | parentTaskId={} | childTaskId={} | childSessionId={} | error={}",
                            config.role_id,
                            config.parent_task_id,
                            spawn.child_task_id,
                            spawn.child_session_id,
                            snippet(&error, 1200)
                        ),
                    );
                    let _ = mark_child_failure(&child_state, &spawn, &config, &error);
                    emit_runtime_subagent_finished(
                        &app_handle,
                        Some(task_id),
                        session_id,
                        &config.role_id,
                        runtime_mode,
                        Some(&spawn.child_runtime_id),
                        Some(&spawn.child_task_id),
                        Some(&spawn.child_session_id),
                        parent_runtime_id.as_deref(),
                        "failed",
                        None,
                        Some(&error),
                    );
                    completed_outputs.push(SubAgentOutput {
                        role_id: config.role_id.clone(),
                        summary: error.clone(),
                        issues: vec![json!({ "message": error })],
                        approved: false,
                        child_task_id: Some(spawn.child_task_id.clone()),
                        child_session_id: Some(spawn.child_session_id.clone()),
                        status: "failed".to_string(),
                        ..SubAgentOutput::default()
                    });
                }
            }
        }
    }
    let value = with_store(state, |store| {
        Ok(build_orchestration_value(&store, completed_outputs))
    })?;
    if let Some(parent_task) = with_store_mut(state, |store| {
        Ok(store
            .runtime_tasks
            .iter_mut()
            .find(|item| item.id == task_id)
            .map(|task| {
                task.aggregation_status = Some(
                    if value
                        .get("outputs")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items.iter().any(|item| {
                                item.get("status").and_then(Value::as_str) == Some("failed")
                            })
                        })
                        .unwrap_or(false)
                    {
                        "failed".to_string()
                    } else {
                        "completed".to_string()
                    },
                );
                task.clone()
            }))
    })? {
        let _ = parent_task;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{create_runtime_task, runtime_direct_route_record};

    #[test]
    fn subagent_spawn_creates_child_task_and_session_links() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-parent".to_string(),
            title: "Parent".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({"contextType": "chat", "runtimeId": "runtime-parent"})),
        });
        let route = runtime_direct_route_record("default", "draft", None);
        store.runtime_tasks.push(create_runtime_task(
            "manual",
            "pending",
            "chatroom".to_string(),
            Some("session-parent".to_string()),
            Some("draft".to_string()),
            route.clone(),
            None,
        ));
        let parent_task_id = store
            .runtime_tasks
            .first()
            .map(|item| item.id.clone())
            .unwrap_or_default();
        let config = SubAgentConfig {
            role_id: "planner".to_string(),
            runtime_mode: "chatroom".to_string(),
            parent_task_id: parent_task_id.clone(),
            parent_session_id: Some("session-parent".to_string()),
            parallel_group: 0,
            model_config: Some(json!({"modelName": "gpt"})),
            ..SubAgentConfig::default()
        };
        let spawn = create_child_runtime_records_in_store(
            &mut store,
            &parent_task_id,
            Some("runtime-parent"),
            &config,
            &route,
        );
        assert_eq!(spawn.role_id, "planner");
        assert_eq!(store.runtime_tasks.len(), 2);
        assert_eq!(store.chat_sessions.len(), 2);
        assert!(store.runtime_tasks.iter().any(|item| {
            item.parent_task_id.as_deref() == Some(parent_task_id.as_str())
                && item.runtime_id.is_some()
        }));
    }
}
