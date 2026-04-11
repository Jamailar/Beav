use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::chat_runtime::{execute_chat_exchange_request, ChatExchangeRequest};
use crate::commands::runtime_orchestration::run_subagent_orchestration_for_task;
use crate::commands::runtime_routing::route_runtime_intent_with_settings;
use crate::events::{emit_chat_sequence, emit_runtime_task_checkpoint_saved};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    persist_runtime_query_checkpoints, prepare_runtime_query_execution,
    runtime_query_checkpoint_events,
};
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
    let prepared = prepare_runtime_query_execution(route.clone(), orchestration.clone(), &message);
    let route_value = prepared.route.clone().into_value();
    let execution = execute_chat_exchange_request(
        Some(app),
        state,
        ChatExchangeRequest {
            session_id,
            message: prepared.effective_message,
            display_content: message.clone(),
            model_config: payload_field(payload, "modelConfig"),
            attachment: None,
            checkpoint_type: "runtime-query",
            checkpoint_summary: "Runtime query completed",
        },
    )?;
    let _ = with_store_mut(state, |store| {
        persist_runtime_query_checkpoints(
            store,
            &execution.session_id,
            &prepared.route.reasoning,
            route_value.clone(),
            prepared.orchestration.clone(),
        );
        Ok(())
    });
    for (checkpoint_type, summary, payload) in runtime_query_checkpoint_events(
        &prepared.route.reasoning,
        route_value.clone(),
        prepared.orchestration.clone(),
    ) {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(&execution.session_id),
            &checkpoint_type,
            &summary,
            payload,
        );
    }
    emit_chat_sequence(
        app,
        &execution.session_id,
        &execution.response,
        "正在规划并调用模型生成响应。",
        &runtime_mode,
        execution.title_update,
    );
    Ok(json!({
        "success": true,
        "sessionId": execution.session_id,
        "response": execution.response,
        "route": route_value,
        "orchestration": prepared.orchestration
    }))
}
