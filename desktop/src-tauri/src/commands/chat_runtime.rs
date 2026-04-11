use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::chat_state::{
    ensure_chat_session, infer_context_type_from_session_id, is_chat_runtime_cancel_requested,
    is_first_assistant_turn_for_session, resolve_runtime_mode_for_session,
    should_handle_redclaw_onboarding_for_session, update_chat_runtime_state,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{append_session_checkpoint, ChatExecutionResult};
use crate::{
    append_debug_log_state, append_session_transcript, default_memory_maintenance_status,
    ensure_redclaw_onboarding_completed_with_defaults, generate_chat_response,
    handle_redclaw_onboarding_turn, make_id, memory_maintenance_status_from_workspace,
    next_memory_maintenance_at_ms, now_i64, now_iso, resolve_chat_config,
    resolve_runtime_mode_from_context_type, run_anthropic_interactive_chat_runtime,
    run_gemini_interactive_chat_runtime, run_openai_interactive_chat_runtime,
    session_title_from_message, value_to_i64_string, write_memory_maintenance_status_for_workspace,
    AppState, ChatMessageRecord,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionAgentTurnKind {
    ChatSend,
    RuntimeQuery,
    SessionBridge,
}

impl SessionAgentTurnKind {
    pub fn checkpoint_type(self) -> &'static str {
        match self {
            Self::ChatSend => "chat-send",
            Self::RuntimeQuery => "runtime-query",
            Self::SessionBridge => "session-bridge",
        }
    }

    pub fn checkpoint_summary(self) -> &'static str {
        match self {
            Self::ChatSend => "Chat response completed",
            Self::RuntimeQuery => "Runtime query completed",
            Self::SessionBridge => "Session bridge message completed",
        }
    }
}

pub struct ChatExchangeRequest<'a> {
    pub session_id: Option<String>,
    pub message: String,
    pub display_content: String,
    pub model_config: Option<&'a Value>,
    pub attachment: Option<Value>,
    pub turn_kind: SessionAgentTurnKind,
}

struct ChatExchangeContext {
    settings_snapshot: Value,
    working_session_id: String,
    runtime_mode: String,
    should_handle_redclaw_onboarding: bool,
    allow_redclaw_onboarding: bool,
}

struct ChatExchangeResponseStage {
    response: String,
    emitted_live_events: bool,
}

struct ChatExchangePersistenceStage {
    final_session_id: String,
    title_update: Option<(String, String)>,
}

impl<'a> ChatExchangeRequest<'a> {
    pub fn chat_send(
        session_id: Option<String>,
        message: String,
        display_content: String,
        model_config: Option<&'a Value>,
        attachment: Option<Value>,
    ) -> Self {
        Self {
            session_id,
            message,
            display_content,
            model_config,
            attachment,
            turn_kind: SessionAgentTurnKind::ChatSend,
        }
    }

    pub fn runtime_query(
        session_id: Option<String>,
        effective_message: String,
        display_content: String,
        model_config: Option<&'a Value>,
    ) -> Self {
        Self {
            session_id,
            message: effective_message,
            display_content,
            model_config,
            attachment: None,
            turn_kind: SessionAgentTurnKind::RuntimeQuery,
        }
    }

    pub fn session_bridge(session_id: String, message: String) -> Self {
        Self {
            session_id: Some(session_id),
            display_content: message.clone(),
            message,
            model_config: None,
            attachment: None,
            turn_kind: SessionAgentTurnKind::SessionBridge,
        }
    }
}

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

fn resolve_chat_exchange_context(
    state: &State<'_, AppState>,
    session_id: Option<String>,
    turn_kind: SessionAgentTurnKind,
) -> Result<ChatExchangeContext, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let working_session_id = session_id.unwrap_or_else(|| make_id("session"));
    let (runtime_mode, should_handle_redclaw_onboarding, is_first_assistant_turn) =
        with_store(state, |store| {
            Ok((
                resolve_runtime_mode_for_session(&store, &working_session_id),
                should_handle_redclaw_onboarding_for_session(&store, &working_session_id),
                is_first_assistant_turn_for_session(&store, &working_session_id),
            ))
        })?;
    let allow_redclaw_onboarding = runtime_mode == "redclaw"
        && should_handle_redclaw_onboarding
        && turn_kind == SessionAgentTurnKind::ChatSend
        && is_first_assistant_turn;
    Ok(ChatExchangeContext {
        settings_snapshot,
        working_session_id,
        runtime_mode,
        should_handle_redclaw_onboarding,
        allow_redclaw_onboarding,
    })
}

fn resolve_chat_exchange_response_stage(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    message: &str,
    model_config: Option<&Value>,
    onboarding_response: Option<(String, bool)>,
) -> Result<ChatExchangeResponseStage, String> {
    if let Some((local_response, _completed)) = onboarding_response {
        return Ok(ChatExchangeResponseStage {
            response: local_response,
            emitted_live_events: false,
        });
    }

    if let (Some(app), Some(config)) = (app, resolve_chat_config(&context.settings_snapshot, model_config)) {
        if matches!(config.protocol.as_str(), "openai" | "anthropic" | "gemini") {
            let interactive_result = match config.protocol.as_str() {
                "openai" => run_openai_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                ),
                "anthropic" => run_anthropic_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                ),
                "gemini" => run_gemini_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                ),
                _ => unreachable!(),
            };
            match interactive_result {
                Ok(response) => {
                    return Ok(ChatExchangeResponseStage {
                        response,
                        emitted_live_events: context.runtime_mode != "wander",
                    })
                }
                Err(error) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-failed | {}",
                            context.runtime_mode, context.working_session_id, error
                        ),
                    );
                    if context.runtime_mode == "wander" {
                        return Err(error);
                    }
                }
            }
        }
    }

    Ok(ChatExchangeResponseStage {
        response: generate_chat_response(&context.settings_snapshot, model_config, message),
        emitted_live_events: false,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_agent_turn_kind_maps_to_stable_checkpoint_contract() {
        assert_eq!(SessionAgentTurnKind::ChatSend.checkpoint_type(), "chat-send");
        assert_eq!(
            SessionAgentTurnKind::RuntimeQuery.checkpoint_summary(),
            "Runtime query completed"
        );
        assert_eq!(
            SessionAgentTurnKind::SessionBridge.checkpoint_type(),
            "session-bridge"
        );
    }

    #[test]
    fn chat_exchange_request_constructors_set_expected_turn_kinds() {
        assert_eq!(
            ChatExchangeRequest::chat_send(None, "m".to_string(), "d".to_string(), None, None)
                .turn_kind,
            SessionAgentTurnKind::ChatSend
        );
        assert_eq!(
            ChatExchangeRequest::runtime_query(
                None,
                "m".to_string(),
                "d".to_string(),
                None,
            )
            .turn_kind,
            SessionAgentTurnKind::RuntimeQuery
        );
        assert_eq!(
            ChatExchangeRequest::session_bridge("s".to_string(), "m".to_string()).turn_kind,
            SessionAgentTurnKind::SessionBridge
        );
    }
}
