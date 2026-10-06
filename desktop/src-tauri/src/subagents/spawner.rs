use std::collections::BTreeMap;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::agent::{
    build_runtime_query_turn, execute_prepared_session_agent_turn, PreparedSessionAgentTurn,
};
use crate::events::{
    emit_runtime_event, emit_runtime_subagent_finished, emit_runtime_subagent_spawned,
    emit_runtime_task_checkpoint_saved, emit_runtime_task_node_changed,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, append_runtime_task_trace_scoped, append_session_checkpoint_scoped,
    create_collab_session, create_collab_task, create_review_docket, create_runtime_task,
    ensure_collab_session_coordinator, record_runtime_node, runtime_subagent_role_spec,
    submit_collab_report, update_collab_task, CollabSessionRecord, RuntimeArtifact,
    RuntimeCheckpointRecord, RuntimeRouteRecord,
};
use crate::store::runtime_tasks as runtime_task_store;
use crate::subagents::{
    build_orchestration_value, build_subagent_configs, SubAgentConfig, SubAgentOutput,
    SubAgentSpawnResult,
};
use crate::{
    append_debug_log_state, make_id, now_i64, now_iso, parse_json_value_from_text, payload_string,
    AppState, AppStore, ChatSessionRecord,
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
                object
                    .get("modelName")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
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
    let task_context = config
        .task_context
        .as_ref()
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string()))
        .unwrap_or_else(|| "{}".to_string());
    format!(
        "Use your Subagent Role Overlay for role scope, allowed tools, handoff contract, and output schema.\nGoal: {}\nUser input: {}\nTask context JSON: {}\nPrior outputs: {}\nReturn strict JSON only with fields summary, artifact, handoff, risks, issues, approved, learningCandidates.\nFor RedClaw tasks, follow the node outputSchema and requiredArtifacts exactly; put the user-facing deliverable in artifact, keep handoff concise, and propose learningCandidates only when your role contract asks for them.",
        route.goal, user_input, task_context, prior_summary,
    )
}

fn contract_type_matches(value: &Value, expected: &str) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => {
            value.as_f64().is_some() || value.as_i64().is_some() || value.as_u64().is_some()
        }
        "boolean" => value.is_boolean(),
        _ => true,
    }
}

fn validate_contract_value(value: &Value, contract: &Value, path: &str, errors: &mut Vec<String>) {
    if let Some(expected_type) = contract.get("type").and_then(Value::as_str) {
        if !contract_type_matches(value, expected_type) {
            errors.push(format!("{path} expected {expected_type}"));
            return;
        }
    }
    if let Some(enum_values) = contract.get("enum").and_then(Value::as_array) {
        if !enum_values.iter().any(|item| item == value) {
            errors.push(format!("{path} is not one of the allowed enum values"));
        }
    }
    if let Some(required) = contract.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if value.get(key).is_none() {
                errors.push(format!("{path}.{key} is required"));
            }
        }
    }
    if let (Some(properties), Some(object)) = (
        contract.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) {
        for (key, property_contract) in properties {
            if let Some(property_value) = object.get(key) {
                validate_contract_value(
                    property_value,
                    property_contract,
                    &format!("{path}.{key}"),
                    errors,
                );
            }
        }
    }
    if let (Some(item_contract), Some(items)) = (contract.get("items"), value.as_array()) {
        for (index, item) in items.iter().enumerate() {
            validate_contract_value(item, item_contract, &format!("{path}[{index}]"), errors);
        }
    }
}

fn output_contracts_for_context(task_context: Option<&Value>) -> Vec<Value> {
    let Some(context) = task_context else {
        return Vec::new();
    };
    let node_output_schema = context
        .get("node")
        .and_then(|node| node.get("outputSchema"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    context
        .get("skillProfiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|profile| {
            node_output_schema.is_empty()
                || profile
                    .get("outputSchema")
                    .and_then(Value::as_str)
                    .map(|schema| schema == node_output_schema)
                    .unwrap_or(false)
        })
        .filter_map(|profile| profile.get("outputContract").cloned())
        .collect()
}

fn artifact_contract_issues(artifact: Option<&str>, task_context: Option<&Value>) -> Vec<Value> {
    let contracts = output_contracts_for_context(task_context);
    if contracts.is_empty() {
        return Vec::new();
    }
    let Some(artifact) = artifact.map(str::trim).filter(|value| !value.is_empty()) else {
        return vec![json!({
            "code": "artifact_missing",
            "message": "artifact is required for this RedClaw node output contract"
        })];
    };
    let Some(parsed_artifact) = parse_json_value_from_text(artifact) else {
        return vec![json!({
            "code": "artifact_not_json",
            "message": "artifact must be a JSON string matching the RedClaw output contract"
        })];
    };
    let mut issues = Vec::new();
    for contract in contracts {
        let mut errors = Vec::new();
        validate_contract_value(&parsed_artifact, &contract, "artifact", &mut errors);
        if !errors.is_empty() {
            issues.push(json!({
                "code": "artifact_contract_violation",
                "message": "artifact does not match the RedClaw output contract",
                "errors": errors
            }));
        }
    }
    issues
}

fn parse_child_output(
    response: &str,
    role_id: &str,
    child_task_id: &str,
    child_session_id: &str,
    task_context: Option<&Value>,
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
    let artifact = payload_string(&parsed, "artifact");
    let mut issues = parsed
        .get("issues")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let contract_issues = artifact_contract_issues(artifact.as_deref(), task_context);
    let contract_passed = contract_issues.is_empty();
    issues.extend(contract_issues);
    SubAgentOutput {
        role_id: role_id.to_string(),
        summary: payload_string(&parsed, "summary").unwrap_or_else(|| response.to_string()),
        artifact,
        handoff: payload_string(&parsed, "handoff"),
        risks: parsed
            .get("risks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        issues,
        learning_candidates: parsed
            .get("learningCandidates")
            .or_else(|| parsed.get("learning_candidates"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        approved: parsed
            .get("approved")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            && contract_passed,
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

fn metadata_with_collab_session_id(
    metadata: Option<&Value>,
    collab_session_id: &str,
) -> Option<Value> {
    let mut object = metadata
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    object.insert(
        "collabSessionId".to_string(),
        json!(collab_session_id.to_string()),
    );
    Some(Value::Object(object))
}

fn ensure_collab_session_for_parent_task(
    store: &mut AppStore,
    parent_task_id: &str,
    parent_session_id: Option<&str>,
    runtime_mode: &str,
    route: &RuntimeRouteRecord,
) -> Result<String, String> {
    if let Some(existing) = store
        .collab_sessions
        .iter()
        .find(|session| {
            session
                .metadata
                .as_ref()
                .and_then(|metadata| payload_string(metadata, "sourceTaskId"))
                .as_deref()
                == Some(parent_task_id)
        })
        .cloned()
    {
        return Ok(existing.id);
    }
    let session = create_collab_session(
        store,
        &json!({
            "ownerSessionId": parent_session_id,
            "title": route.goal.chars().take(48).collect::<String>(),
            "objective": route.goal,
            "runtimeMode": runtime_mode,
            "source": "real-subagent-orchestration",
            "metadata": {
                "sourceTaskId": parent_task_id,
                "intent": route.intent,
                "recommendedRole": route.recommended_role
            }
        }),
    )?;
    let _ = ensure_collab_session_coordinator(store, &session.id)?;
    Ok(session.id)
}

fn collab_session_by_id(store: &AppStore, session_id: &str) -> Option<CollabSessionRecord> {
    store
        .collab_sessions
        .iter()
        .find(|session| session.id == session_id)
        .cloned()
}

fn ensure_collab_records_for_child_runtime(
    store: &mut AppStore,
    config: &SubAgentConfig,
    spawn: &mut SubAgentSpawnResult,
    route: &RuntimeRouteRecord,
) -> Result<(), String> {
    let Some(collab_session_id) = config.collab_session_id.as_deref() else {
        return Ok(());
    };
    let member_metadata = merge_metadata(
        config.fork_overrides.metadata.as_ref(),
        Some(&json!({
            "parentTaskId": config.parent_task_id,
            "childTaskId": spawn.child_task_id,
            "childSessionId": spawn.child_session_id,
            "childRuntimeId": spawn.child_runtime_id
        })),
    )
    .unwrap_or_else(|| json!({}));
    let member = add_collab_member(
        store,
        &json!({
            "sessionId": collab_session_id,
            "displayName": config.role_id,
            "roleId": config.role_id,
            "sourceKind": "internal_runtime",
            "adapterKind": "internal",
            "backend": "redbox-real-subagent",
            "status": "working",
            "conversationId": spawn.child_session_id,
            "runtimeId": spawn.child_runtime_id,
            "capabilities": config.fork_overrides.allowed_tools,
            "allowedTools": config.fork_overrides.allowed_tools,
            "desiredModelConfig": config.model_config,
            "currentModelConfig": config.model_config,
            "metadata": member_metadata
        }),
    )?;
    let task = create_collab_task(
        store,
        &json!({
            "sessionId": collab_session_id,
            "memberId": member.id,
            "title": format!("{}: {}", config.role_id, route.goal),
            "objective": route.goal,
            "description": route.reasoning,
            "status": "running",
            "taskType": "subagent",
            "runtimeTaskId": spawn.child_task_id,
            "priority": if config.role_id == "reviewer" { 1 } else { 0 },
            "metadata": {
                "roleId": config.role_id,
                "parentTaskId": config.parent_task_id,
                "childTaskId": spawn.child_task_id,
                "childSessionId": spawn.child_session_id,
                "childRuntimeId": spawn.child_runtime_id
            }
        }),
    )?;
    if let Some(member_record) = store
        .collab_members
        .iter_mut()
        .find(|item| item.id == member.id)
    {
        member_record.current_task_id = Some(task.id.clone());
        member_record.last_seen_at = Some(now_i64());
        member_record.last_activity_at = Some(now_i64());
    }
    if let Some(session) = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == spawn.child_session_id)
    {
        let mut metadata = session
            .metadata
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        metadata.insert("collabMemberId".to_string(), json!(member.id.clone()));
        metadata.insert("memberId".to_string(), json!(member.id.clone()));
        session.metadata = Some(Value::Object(metadata));
    }
    spawn.collab_member_id = Some(member.id);
    spawn.collab_task_id = Some(task.id);
    Ok(())
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
    let role_spec = runtime_subagent_role_spec(&config.role_id);
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
        "subagentRolePurpose".to_string(),
        json!(role_spec.purpose.clone()),
    );
    session_metadata_object.insert(
        "subagentRoleHandoffContract".to_string(),
        json!(role_spec.handoff_contract.clone()),
    );
    session_metadata_object.insert(
        "subagentRoleOutputSchema".to_string(),
        json!(role_spec.output_schema.clone()),
    );
    session_metadata_object.insert(
        "subagentRoleDirective".to_string(),
        json!(role_spec.system_prompt.clone()),
    );
    if let Some(system_prompt_patch) = config
        .fork_overrides
        .system_prompt_patch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        session_metadata_object.insert(
            "subagentSystemPromptPatch".to_string(),
            json!(system_prompt_patch),
        );
    }
    if let Some(task_context) = config.task_context.as_ref() {
        session_metadata_object.insert("subagentTaskContext".to_string(), task_context.clone());
    }
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
        starred: false,
        archived: false,
        archived_at: None,
        deleted_at: None,
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
            "subagentRoleSpec": role_spec,
            "systemPromptPatch": config.fork_overrides.system_prompt_patch,
            "taskContext": config.task_context,
        })),
    );
    task.id = child_task_id.clone();
    task.runtime_id = Some(child_runtime_id.clone());
    task.parent_runtime_id = parent_runtime_id.map(ToString::to_string);
    task.parent_task_id = Some(parent_task_id.to_string());
    task.root_task_id = Some(parent_task_id.to_string());
    task.aggregation_status = Some("spawned".to_string());
    task.current_node = Some("spawn_agents".to_string());
    runtime_task_store::push_task(store, task.clone());
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
    let mut spawn = SubAgentSpawnResult {
        child_task_id,
        child_session_id,
        child_runtime_id,
        role_id: config.role_id.clone(),
        collab_member_id: None,
        collab_task_id: None,
    };
    let _ = ensure_collab_records_for_child_runtime(store, config, &mut spawn, route);
    spawn
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
    app: &AppHandle,
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
                    "learningCandidates": output.learning_candidates,
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
                    "learningCandidates": output.learning_candidates,
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
        if let (Some(member_id), Some(collab_task_id), Some(collab_session_id)) = (
            spawn.collab_member_id.as_deref(),
            spawn.collab_task_id.as_deref(),
            config.collab_session_id.as_deref(),
        ) {
            let handoff = output.handoff.clone().unwrap_or_default();
            let artifacts = output
                .artifact
                .as_ref()
                .map(|value| {
                    vec![json!({
                        "type": "text",
                        "label": format!("{} output", config.role_id),
                        "content": value
                    })]
                })
                .unwrap_or_default();
            let report = submit_collab_report(
                store,
                &json!({
                    "sessionId": collab_session_id,
                    "memberId": member_id,
                    "taskId": collab_task_id,
                    "status": "waiting_for_review",
                    "reportType": "completion",
                    "summary": output.summary,
                    "nextAction": handoff,
                    "artifacts": artifacts,
                    "memberStatus": "review",
                    "payload": {
                        "roleId": config.role_id,
                        "childTaskId": spawn.child_task_id,
                        "childSessionId": spawn.child_session_id,
                        "approved": output.approved,
                        "risks": output.risks,
                        "issues": output.issues,
                        "completionClaim": {
                            "sessionId": collab_session_id,
                            "taskId": collab_task_id,
                            "memberId": member_id,
                            "status": "completed",
                            "summary": output.summary,
                            "handoff": handoff,
                            "risks": output.risks
                        }
                    }
                }),
            );
            if report.is_ok() {
                if let Ok(docket) = create_review_docket(
                    store,
                    &json!({
                        "sourceKind": "subagent_completion",
                        "sourceId": spawn.child_task_id,
                        "sessionId": collab_session_id,
                        "taskId": collab_task_id,
                        "title": format!("验收 {} 的完成声明", config.role_id),
                        "summary": output.summary,
                        "body": format!("{}\n\nhandoff: {}", output.summary, handoff),
                        "decisionType": "completion_review",
                        "priority": if output.approved { "normal" } else { "high" },
                        "riskLevel": if output.risks.is_empty() { "normal" } else { "medium" },
                        "artifactRefs": output.artifact.as_ref().map(|_| vec![format!("subagent-output:{}", spawn.child_task_id)]).unwrap_or_default(),
                        "evidenceRefs": [{
                            "kind": "subagent_output",
                            "roleId": config.role_id,
                            "childTaskId": spawn.child_task_id,
                            "childSessionId": spawn.child_session_id,
                            "issues": output.issues,
                            "risks": output.risks
                        }],
                        "createdByAgentId": config.role_id,
                        "proposedAction": {
                            "kind": "collab_task_completion",
                            "onDecisionTaskStatus": {
                                "approved": "completed",
                                "rejected": "failed",
                                "changes_requested": "claimed"
                            }
                        }
                    }),
                ) {
                    emit_runtime_event(
                        app,
                        "runtime:review-docket-changed",
                        Some(collab_session_id),
                        Some(collab_task_id),
                        json!({ "docketId": docket.id, "sourceKind": "subagent_completion" }),
                    );
                }
            }
        }
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
        if let (Some(member_id), Some(collab_task_id), Some(collab_session_id)) = (
            spawn.collab_member_id.as_deref(),
            spawn.collab_task_id.as_deref(),
            config.collab_session_id.as_deref(),
        ) {
            let _ = submit_collab_report(
                store,
                &json!({
                    "sessionId": collab_session_id,
                    "memberId": member_id,
                    "taskId": collab_task_id,
                    "status": "failed",
                    "reportType": "failure",
                    "summary": error,
                    "blockers": ["subagent_execution_failed"],
                    "payload": {
                        "roleId": config.role_id,
                        "childTaskId": spawn.child_task_id,
                        "childSessionId": spawn.child_session_id
                    }
                }),
            );
            let _ = update_collab_task(
                store,
                &json!({
                    "taskId": collab_task_id,
                    "status": "failed",
                    "resultSummary": error
                }),
            );
        }
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
        config.task_context.as_ref(),
    );
    log_subagent_state(
        &state,
        format!(
            "[subagent][parsed] role={} | childTaskId={} | approved={} | summary={} | artifactChars={} | artifactPreview={}",
            config.role_id,
            spawn.child_task_id,
            output.approved,
            snippet(&output.summary, 280),
            output
                .artifact
                .as_ref()
                .map(|value| value.chars().count())
                .unwrap_or(0),
            output
                .artifact
                .as_ref()
                .map(|value| snippet(value, 800))
                .unwrap_or_default()
        ),
    );
    persist_child_execution(
        &app,
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
            config.role_id, spawn.child_task_id, spawn.child_session_id
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
    let (collab_session_id, collab_session) = with_store_mut(state, |store| {
        let collab_session_id =
            ensure_collab_session_for_parent_task(store, task_id, session_id, runtime_mode, route)?;
        let collab_session = collab_session_by_id(store, &collab_session_id);
        Ok((collab_session_id, collab_session))
    })?;
    if let Some(collab_session) = collab_session {
        emit_runtime_event(
            app,
            "runtime:collab-session-changed",
            collab_session.owner_session_id.as_deref(),
            None,
            json!({ "collabSessionId": collab_session.id, "session": collab_session }),
        );
    }
    let metadata_with_collab = metadata_with_collab_session_id(metadata, &collab_session_id);
    let mut configs = build_subagent_configs(
        route,
        runtime_mode,
        task_id,
        session_id,
        metadata_with_collab.as_ref(),
        model_config,
    );
    for config in configs.iter_mut() {
        config.collab_session_id = Some(collab_session_id.clone());
    }
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
            handles.push(tauri::async_runtime::spawn_blocking(move || {
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
            let (spawn, config, result, app_handle) = tauri::async_runtime::block_on(handle)
                .map_err(|error| format!("subagent worker failed: {error}"))?;
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
    use crate::runtime::{create_collab_session, create_runtime_task, runtime_direct_route_record};
    use crate::subagents::ForkOverrides;

    #[test]
    fn child_prompt_keeps_role_contract_out_of_user_message() {
        let route = runtime_direct_route_record("default", "draft", None);
        let config = SubAgentConfig {
            role_id: "planner".to_string(),
            fork_overrides: ForkOverrides {
                allowed_tools: vec!["workflow".to_string()],
                system_prompt_patch: Some("Never expose this patch in the user task.".to_string()),
                ..ForkOverrides::default()
            },
            ..SubAgentConfig::default()
        };
        let prompt = build_child_prompt(&config, &route, "write plan", &[]);
        assert!(prompt.contains("Goal: draft"));
        assert!(prompt.contains("User input: write plan"));
        assert!(prompt.contains("Use your Subagent Role Overlay"));
        assert!(!prompt.contains("Role: planner"));
        assert!(!prompt.contains("Allowed tools:"));
        assert!(!prompt.contains("Never expose this patch"));
    }

    #[test]
    fn child_prompt_includes_redclaw_task_context() {
        let route = runtime_direct_route_record("redclaw", "make a short video package", None);
        let config = SubAgentConfig {
            role_id: "script_agent".to_string(),
            task_context: Some(json!({
                "node": {
                    "id": "script",
                    "skillIds": ["script.short_video_script"],
                    "requiredArtifacts": ["ScriptDocument"],
                    "outputSchema": "ScriptDocument"
                },
                "upstreamNodeIds": ["insight"]
            })),
            ..SubAgentConfig::default()
        };
        let prompt = build_child_prompt(&config, &route, "write script", &[]);
        assert!(prompt.contains("Task context JSON"));
        assert!(prompt.contains("script.short_video_script"));
        assert!(prompt.contains("ScriptDocument"));
        assert!(prompt.contains("follow the node outputSchema"));
    }

    #[test]
    fn child_output_preserves_learning_candidates() {
        let output = parse_child_output(
            r#"{
                "summary": "review complete",
                "learningCandidates": [
                    {
                        "scope": "creator",
                        "statement": "Prefer tighter hooks",
                        "confidence": 0.8
                    }
                ],
                "approved": true
            }"#,
            "review_agent",
            "task-child",
            "session-child",
            None,
        );

        assert_eq!(output.role_id, "review_agent");
        assert_eq!(output.learning_candidates.len(), 1);
        assert_eq!(
            output.learning_candidates[0]
                .get("statement")
                .and_then(Value::as_str),
            Some("Prefer tighter hooks")
        );
    }

    #[test]
    fn redclaw_child_output_rejects_contract_violations() {
        let task_context = json!({
            "node": {
                "id": "copy",
                "agentId": "copy_agent",
                "skillIds": ["xhs.copy_package"],
                "outputSchema": "XhsCopyPackage"
            },
            "skillProfiles": [
                {
                    "id": "xhs.copy_package",
                    "outputSchema": "XhsCopyPackage",
                    "outputContract": {
                        "type": "object",
                        "required": ["titles", "body"],
                        "properties": {
                            "titles": { "type": "array", "items": { "type": "string" } },
                            "body": { "type": "string" }
                        }
                    }
                }
            ]
        });
        let output = parse_child_output(
            r#"{
                "summary": "copy ready",
                "artifact": "{\"titles\":[\"Title A\"]}",
                "approved": true
            }"#,
            "copy_agent",
            "task-child",
            "session-child",
            Some(&task_context),
        );

        assert!(!output.approved);
        assert!(output.issues.iter().any(|issue| {
            issue.get("code").and_then(Value::as_str) == Some("artifact_contract_violation")
        }));
    }

    #[test]
    fn redclaw_child_output_accepts_contract_match() {
        let task_context = json!({
            "node": {
                "id": "copy",
                "agentId": "copy_agent",
                "skillIds": ["xhs.copy_package"],
                "outputSchema": "XhsCopyPackage"
            },
            "skillProfiles": [
                {
                    "id": "xhs.copy_package",
                    "outputSchema": "XhsCopyPackage",
                    "outputContract": {
                        "type": "object",
                        "required": ["titles", "body"],
                        "properties": {
                            "titles": { "type": "array", "items": { "type": "string" } },
                            "body": { "type": "string" }
                        }
                    }
                }
            ]
        });
        let output = parse_child_output(
            r#"{
                "summary": "copy ready",
                "artifact": "{\"titles\":[\"Title A\"],\"body\":\"Body\"}",
                "approved": true
            }"#,
            "copy_agent",
            "task-child",
            "session-child",
            Some(&task_context),
        );

        assert!(output.approved);
        assert!(output.issues.is_empty());
    }

    #[test]
    fn subagent_spawn_creates_child_task_and_session_links() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-parent".to_string(),
            title: "Parent".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({"contextType": "chat", "runtimeId": "runtime-parent"})),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        let route = runtime_direct_route_record("default", "draft", None);
        store.runtime_tasks.push(create_runtime_task(
            "manual",
            "pending",
            "team".to_string(),
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
        let collab_session_id = create_collab_session(
            &mut store,
            &json!({
                "ownerSessionId": "session-parent",
                "title": "Parent collaboration",
                "objective": "draft"
            }),
        )
        .expect("collab session")
        .id;
        let config = SubAgentConfig {
            role_id: "planner".to_string(),
            runtime_mode: "team".to_string(),
            parent_task_id: parent_task_id.clone(),
            parent_session_id: Some("session-parent".to_string()),
            collab_session_id: Some(collab_session_id.clone()),
            parallel_group: 0,
            model_config: Some(json!({"modelName": "gpt"})),
            fork_overrides: ForkOverrides {
                metadata: Some(json!({
                    "advisorId": "advisor-planner",
                    "sourceId": "advisor:advisor-planner"
                })),
                ..ForkOverrides::default()
            },
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
        assert!(spawn.collab_member_id.is_some());
        assert!(spawn.collab_task_id.is_some());
        assert!(store.collab_members.iter().any(|item| {
            item.session_id == collab_session_id && item.current_task_id == spawn.collab_task_id
        }));
        let member = store
            .collab_members
            .iter()
            .find(|item| spawn.collab_member_id.as_deref() == Some(item.id.as_str()))
            .expect("collab member");
        let member_metadata = member.metadata.as_ref().expect("member metadata");
        assert_eq!(
            member_metadata.get("advisorId").and_then(Value::as_str),
            Some("advisor-planner")
        );
        let child_session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == spawn.child_session_id)
            .expect("child session");
        assert_eq!(
            child_session
                .metadata
                .as_ref()
                .and_then(|value| value.get("collabMemberId"))
                .and_then(Value::as_str),
            spawn.collab_member_id.as_deref()
        );
        assert!(store.collab_tasks.iter().any(|item| {
            item.session_id == collab_session_id
                && item.member_id == spawn.collab_member_id
                && item.runtime_task_id.as_deref() == Some(spawn.child_task_id.as_str())
        }));
        let child_session = store
            .chat_sessions
            .iter()
            .find(|item| item.id == spawn.child_session_id)
            .expect("child session");
        let child_metadata = child_session.metadata.as_ref().expect("child metadata");
        assert_eq!(
            payload_string(child_metadata, "subagentRolePurpose").as_deref(),
            Some("负责拆解目标、确定阶段顺序、把任务转成明确执行步骤。")
        );
        assert_eq!(
            payload_string(child_metadata, "subagentRoleOutputSchema").as_deref(),
            Some("阶段计划、执行建议、关键依赖、保存策略")
        );
        assert!(payload_string(child_metadata, "subagentRoleDirective")
            .unwrap_or_default()
            .contains("任务规划者"));
        let child_task = store
            .runtime_tasks
            .iter()
            .find(|item| item.id == spawn.child_task_id)
            .expect("child task");
        assert!(child_task
            .metadata
            .as_ref()
            .and_then(|value| value.get("subagentRoleSpec"))
            .and_then(|value| value.get("systemPrompt"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("任务规划者"));
    }
}
