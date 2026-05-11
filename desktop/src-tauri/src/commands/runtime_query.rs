use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::agent::{
    PreparedSessionAgentTurn, build_runtime_query_turn, emit_session_agent_completion,
    execute_prepared_session_agent_turn,
};
use crate::commands::runtime_orchestration::run_subagent_orchestration_for_task;
use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::events::emit_runtime_task_checkpoint_saved;
use crate::interactive_runtime_shared::interactive_runtime_system_prompt;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    RuntimeApprovalDetails, RuntimeApprovalRecord, RuntimeApprovalRequestPayload,
    persist_runtime_query_checkpoints, request_runtime_approval, runtime_query_checkpoint_events,
};
use crate::skills::active_skill_activation_items;
use crate::{
    AppState, RuntimeQueryMetric, log_timing_event, make_id, now_i64, now_ms, payload_field,
    payload_string, record_runtime_query_metric, resolve_runtime_mode_for_session,
};

pub fn handle_runtime_query(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let started_at = now_ms();
    let session_id = payload_string(payload, "sessionId");
    let message = payload_string(payload, "message").unwrap_or_default();
    let request_id = format!(
        "runtime:query:{}",
        session_id
            .clone()
            .unwrap_or_else(|| "new-session".to_string())
    );
    log_timing_event(
        state,
        "ai",
        &request_id,
        "runtime:query:start",
        started_at,
        Some(format!("chars={}", message.chars().count())),
    );
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let runtime_mode = with_store(state, |store| {
        Ok(session_id
            .as_deref()
            .map(|value| resolve_runtime_mode_for_session(&store, value))
            .unwrap_or_else(|| "redclaw".to_string()))
    })?;
    let route = route_runtime_intent_with_settings(
        &settings_snapshot,
        &runtime_mode,
        &message,
        payload_field(payload, "metadata"),
    );
    let orchestration = if route.requires_multi_agent || route.requires_long_running_task {
        Some(run_subagent_orchestration_for_task(
            Some(app),
            state,
            &settings_snapshot,
            &runtime_mode,
            session_id.as_deref().unwrap_or("runtime-query"),
            session_id.as_deref(),
            &route,
            &message,
            payload_field(payload, "metadata"),
            payload_field(payload, "modelConfig"),
        )?)
    } else {
        None
    };
    let prepared = build_runtime_query_turn(
        session_id.clone(),
        route,
        orchestration,
        &message,
        payload_field(payload, "modelConfig"),
    );
    if prepared.route.requires_human_approval {
        let approval_id = make_id("runtime-approval");
        let request = RuntimeApprovalRequestPayload::new(
            approval_id.clone(),
            "runtime.query",
            RuntimeApprovalDetails {
                r#type: "info".to_string(),
                title: "运行前需要人工确认".to_string(),
                description: format!(
                    "当前 runtime query 被标记为 requiresHumanApproval，需要先确认再继续执行。intent={} role={}",
                    prepared.route.intent, prepared.route.recommended_role
                ),
                impact: Some("确认后才会继续执行后续 runtime 链路。".to_string()),
            },
        );
        let approval = request_runtime_approval(
            state,
            RuntimeApprovalRecord::pending(
                approval_id.clone(),
                "runtime_query",
                format!(
                    "{}:{}",
                    session_id
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("new-session"),
                    prepared.route.intent
                ),
                request.name.clone(),
                request.details.clone(),
            )
            .with_scope(session_id.as_deref(), None, None, Some(&approval_id))
            .with_metadata(Some(json!({
                "message": message,
                "route": prepared.route.clone().into_value(),
            }))),
        )?;
        if let Some(session_id) = session_id.as_deref() {
            emit_runtime_task_checkpoint_saved(
                app,
                None,
                Some(session_id),
                "chat.tool_confirm_request",
                "runtime approval requested",
                serde_json::to_value(&request).ok(),
            );
        }
        log_timing_event(
            state,
            "ai",
            &request_id,
            "runtime:query:approval-required",
            started_at,
            Some(format!("approvalId={}", approval.approval_id)),
        );
        return Ok(json!({
            "success": true,
            "sessionId": session_id,
            "response": "",
            "route": prepared.route.clone().into_value(),
            "orchestration": prepared.orchestration,
            "pendingApproval": true,
            "approval": approval,
        }));
    }
    let turn = PreparedSessionAgentTurn::runtime_query(prepared);
    let checkpoint_bundle = turn.runtime_query_checkpoint_bundle();
    let execution = execute_prepared_session_agent_turn(Some(app), state, &turn)?;
    let (resolved_runtime_mode, activated_skills, advisor_id) = with_store(state, |store| {
        let runtime_mode = resolve_runtime_mode_for_session(&store, execution.session_id());
        let metadata = store
            .chat_sessions
            .iter()
            .find(|item| item.id == execution.session_id())
            .and_then(|item| item.metadata.as_ref());
        let items = active_skill_activation_items(&store.skills, &runtime_mode, metadata);
        let advisor_id = metadata.and_then(|value| {
            let advisor = payload_string(value, "advisorId");
            if advisor.is_some() {
                return advisor;
            }
            let context_type = payload_string(value, "contextType");
            if context_type.as_deref() == Some("advisor-discussion") {
                return payload_string(value, "contextId");
            }
            None
        });
        Ok((runtime_mode, items, advisor_id))
    })?;
    let prompt_chars = interactive_runtime_system_prompt(
        state,
        &resolved_runtime_mode,
        Some(execution.session_id()),
    )
    .chars()
    .count() as i64;
    let _ = record_runtime_query_metric(
        state,
        RuntimeQueryMetric {
            session_id: execution.session_id().to_string(),
            runtime_mode: resolved_runtime_mode.clone(),
            advisor_id,
            prompt_chars,
            active_skill_count: activated_skills.len() as i64,
            response_chars: execution.response().chars().count() as i64,
            elapsed_ms: now_ms().saturating_sub(started_at) as i64,
            created_at: now_i64(),
        },
    );
    for (name, description) in activated_skills {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(execution.session_id()),
            "chat.skill_activated",
            "skill activated",
            Some(json!({
                "name": name,
                "description": description,
                "runtimeMode": resolved_runtime_mode,
            })),
        );
    }
    let _ = with_store_mut(state, |store| {
        persist_runtime_query_checkpoints(
            store,
            execution.session_id(),
            checkpoint_bundle
                .as_ref()
                .map(|bundle| bundle.route_reasoning.as_str())
                .unwrap_or_default(),
            checkpoint_bundle
                .as_ref()
                .map(|bundle| bundle.route_value.clone())
                .unwrap_or(Value::Null),
            checkpoint_bundle
                .as_ref()
                .and_then(|bundle| bundle.orchestration.clone()),
        );
        Ok(())
    });
    for (checkpoint_type, summary, payload) in runtime_query_checkpoint_events(
        checkpoint_bundle
            .as_ref()
            .map(|bundle| bundle.route_reasoning.as_str())
            .unwrap_or_default(),
        checkpoint_bundle
            .as_ref()
            .map(|bundle| bundle.route_value.clone())
            .unwrap_or(Value::Null),
        checkpoint_bundle
            .as_ref()
            .and_then(|bundle| bundle.orchestration.clone()),
    ) {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(execution.session_id()),
            &checkpoint_type,
            &summary,
            payload,
        );
    }
    emit_session_agent_completion(
        app,
        state,
        &execution,
        crate::agent::SessionAgentTurnKind::RuntimeQuery,
    )?;
    log_timing_event(
        state,
        "ai",
        &request_id,
        "runtime:query:done",
        started_at,
        Some(format!(
            "responseChars={}",
            execution.response().chars().count()
        )),
    );
    Ok(json!({
        "success": true,
        "sessionId": execution.session_id(),
        "response": execution.response(),
        "route": checkpoint_bundle
            .as_ref()
            .map(|bundle| bundle.route_value.clone())
            .unwrap_or(Value::Null),
        "orchestration": checkpoint_bundle
            .as_ref()
            .and_then(|bundle| bundle.orchestration.clone())
    }))
}
