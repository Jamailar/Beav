use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::agent::{
    resolve_chat_exchange_context, resolve_chat_exchange_response_stage, ChatExchangeContext,
    ChatExchangePersistenceStage, ChatExchangeRequest, SessionAgentTurnKind,
};
use crate::commands::chat_state::{
    ensure_chat_session, infer_context_type_from_session_id, is_chat_runtime_cancel_requested,
    update_chat_runtime_state,
};
use crate::persistence::with_store_mut;
use crate::runtime::{append_session_checkpoint, ChatExecutionResult};
use crate::{
    append_session_transcript, default_memory_maintenance_status,
    ensure_redclaw_onboarding_completed_with_defaults,
    handle_redclaw_onboarding_turn, make_id, memory_maintenance_status_from_workspace,
    next_memory_maintenance_at_ms, now_i64, now_iso, resolve_runtime_mode_from_context_type,
    session_title_from_message, value_to_i64_string, write_memory_maintenance_status_for_workspace,
    AppState, ChatMessageRecord,
};

pub fn execute_chat_exchange_request(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: ChatExchangeRequest<'_>,
) -> Result<ChatExecutionResult, String> {
    execute_chat_exchange(app, state, request)
}

pub fn execute_chat_exchange(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: ChatExchangeRequest<'_>,
) -> Result<ChatExecutionResult, String> {
    let ChatExchangeRequest {
        session_id,
        message,
        display_content,
        model_config,
        attachment,
        turn_kind,
    } = request;
    let context = resolve_chat_exchange_context(state, session_id, turn_kind)?;
    let _ = update_chat_runtime_state(state, &context.working_session_id, true, String::new(), None);

    if context.runtime_mode == "redclaw"
        && context.should_handle_redclaw_onboarding
        && !context.allow_redclaw_onboarding
    {
        let _ = ensure_redclaw_onboarding_completed_with_defaults(state);
    }
    let onboarding_response = if context.allow_redclaw_onboarding {
        handle_redclaw_onboarding_turn(state, &message)?
    } else {
        None
    };
    let response_stage = resolve_chat_exchange_response_stage(
        app,
        state,
        &context,
        &message,
        model_config,
        onboarding_response,
    )?;
    let response = response_stage.response;
    if is_chat_runtime_cancel_requested(state, &context.working_session_id) {
        let _ = update_chat_runtime_state(
            state,
            &context.working_session_id,
            false,
            String::new(),
            Some("cancelled".to_string()),
        );
        return Err("chat generation cancelled".to_string());
    }
    let persistence = persist_chat_exchange(
        state,
        &context,
        &message,
        &display_content,
        attachment.clone(),
        &response,
        turn_kind,
    )?;
    let _ = update_chat_runtime_state(
        state,
        &persistence.final_session_id,
        false,
        response.clone(),
        None,
    );
    let _ = update_post_exchange_maintenance(state, &response);

    Ok(ChatExecutionResult {
        session_id: persistence.final_session_id,
        response,
        title_update: persistence.title_update,
        emitted_live_events: response_stage.emitted_live_events,
    })
}


fn persist_chat_exchange(
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    message: &str,
    display_content: &str,
    attachment: Option<Value>,
    response: &str,
    turn_kind: SessionAgentTurnKind,
) -> Result<ChatExchangePersistenceStage, String> {
    let title_hint = Some(session_title_from_message(display_content));
    let mut title_update: Option<(String, String)> = None;
    let mut final_session_id = String::new();

    with_store_mut(state, |store| {
        let (session, is_new) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(context.working_session_id.clone()),
            title_hint.clone(),
        );
        final_session_id = session.id.clone();
        let next_title = title_hint.clone().unwrap_or_else(|| "New Chat".to_string());
        if is_new || session.title == "New Chat" || session.title.trim().is_empty() {
            session.title = next_title.clone();
            title_update = Some((session.id.clone(), next_title));
        }
        session.updated_at = now_iso();
        let runtime_mode = session_runtime_mode(session);

        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "user".to_string(),
            content: message.to_string(),
            display_content: if display_content.trim().is_empty()
                || display_content.trim() == message.trim()
            {
                None
            } else {
                Some(display_content.to_string())
            },
            attachment: attachment.clone(),
            created_at: now_iso(),
        });
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "assistant".to_string(),
            content: response.to_string(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "user",
            message.to_string(),
            Some(json!({
                "displayContent": display_content,
                "attachment": attachment,
                "runtimeMode": runtime_mode.clone(),
            })),
        );
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "assistant",
            response.to_string(),
            Some(json!({ "runtimeMode": runtime_mode.clone() })),
        );
        append_session_checkpoint(
            store,
            &final_session_id,
            turn_kind.checkpoint_type(),
            turn_kind.checkpoint_summary().to_string(),
            Some(json!({
                "responsePreview": response.chars().take(80).collect::<String>(),
                "runtimeMode": runtime_mode,
            })),
        );
        Ok(())
    })?;

    Ok(ChatExchangePersistenceStage {
        final_session_id,
        title_update,
    })
}

fn update_post_exchange_maintenance(
    state: &State<'_, AppState>,
    response: &str,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        let next_scheduled_at = next_memory_maintenance_at_ms(response, now_i64());
        let current = memory_maintenance_status_from_workspace(state)?
            .or_else(|| crate::memory_maintenance_status_from_settings(&store.settings))
            .unwrap_or_else(default_memory_maintenance_status);
        let status = json!({
            "started": true,
            "running": false,
            "lockState": current.get("lockState").cloned().unwrap_or_else(|| json!("owner")),
            "blockedBy": current.get("blockedBy").cloned().unwrap_or(Value::Null),
            "pendingMutations": current.get("pendingMutations").cloned().unwrap_or_else(|| json!(0)),
            "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
            "lastScanAt": now_i64(),
            "lastReason": "query-after",
            "lastSummary": current.get("lastSummary").cloned().unwrap_or_else(|| json!("RedBox memory maintenance has not run yet.")),
            "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
            "nextScheduledAt": next_scheduled_at,
        });
        write_memory_maintenance_status_for_workspace(state, &status)?;
        if let Some(object) = store.settings.as_object_mut() {
            object.remove("redbox_memory_maintenance_status_json");
        }
        store.redclaw_state.next_maintenance_at =
            value_to_i64_string(status.get("nextScheduledAt"));
        Ok(())
    })
}

fn session_runtime_mode(session: &crate::ChatSessionRecord) -> String {
    session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("agentProfile"))
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "video-editor" | "audio-editor"))
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            let context_type = session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("contextType"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| infer_context_type_from_session_id(&session.id))
                .unwrap_or_else(|| "chat".to_string());
            resolve_runtime_mode_from_context_type(Some(&context_type)).to_string()
        })
}
