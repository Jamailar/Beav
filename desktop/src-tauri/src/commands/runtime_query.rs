use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::agent::{
    build_runtime_query_turn, emit_session_agent_turn_postprocess,
    execute_prepared_session_agent_turn, PreparedSessionAgentTurn,
};
use crate::commands::runtime_orchestration::run_subagent_orchestration_for_task;
use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::events::emit_runtime_task_checkpoint_saved;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{persist_runtime_query_checkpoints, runtime_query_checkpoint_events};
use crate::{
    payload_field, payload_string, resolve_runtime_mode_for_session, AppState,
};

pub fn handle_runtime_query(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId");
    let message = payload_string(payload, "message").unwrap_or_default();
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
            &settings_snapshot,
            &runtime_mode,
            session_id.as_deref().unwrap_or("runtime-query"),
            session_id.as_deref(),
            &route,
            &message,
        )?)
    } else {
        None
    };
    let prepared = build_runtime_query_turn(
        session_id,
        route,
        orchestration,
        &message,
        payload_field(payload, "modelConfig"),
    );
    let turn = PreparedSessionAgentTurn::runtime_query(prepared);
    let checkpoint_bundle = turn.runtime_query_checkpoint_bundle();
    let execution = execute_prepared_session_agent_turn(Some(app), state, &turn)?;
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
    emit_session_agent_turn_postprocess(
        app,
        &execution,
        &runtime_mode,
        "正在规划并调用模型生成响应。",
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
