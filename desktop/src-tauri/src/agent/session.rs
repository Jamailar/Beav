use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent::{
    ChatExchangeContext, ChatExchangeRequest, ChatExchangeResponseStage,
    PreparedSessionAgentTurn, SessionAgentTurnExecution, SessionAgentTurnKind,
};
use crate::commands::chat_state::{
    is_chat_runtime_cancel_requested, is_first_assistant_turn_for_session,
    resolve_runtime_mode_for_session, should_handle_redclaw_onboarding_for_session,
    update_chat_runtime_state,
};
use crate::persistence::with_store;
use crate::{
    append_debug_log_state, ensure_redclaw_onboarding_completed_with_defaults,
    generate_chat_response, make_id, resolve_chat_config,
    run_anthropic_interactive_chat_runtime, run_gemini_interactive_chat_runtime,
    run_openai_interactive_chat_runtime, AppState,
};
use crate::{handle_redclaw_onboarding_turn};
use crate::agent::{persist_chat_exchange, update_post_exchange_maintenance};

pub fn resolve_chat_exchange_context(
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
    let allow_redclaw_onboarding = should_allow_redclaw_onboarding(
        &runtime_mode,
        should_handle_redclaw_onboarding,
        is_first_assistant_turn,
        turn_kind,
    );
    Ok(ChatExchangeContext {
        settings_snapshot,
        working_session_id,
        runtime_mode,
        should_handle_redclaw_onboarding,
        allow_redclaw_onboarding,
    })
}

pub fn resolve_chat_exchange_response_stage(
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

    if let (Some(app), Some(config)) =
        (app, resolve_chat_config(&context.settings_snapshot, model_config))
    {
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
                        emitted_live_events: emits_live_events_for_runtime_mode(
                            &context.runtime_mode,
                        ),
                    });
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

pub fn execute_prepared_session_agent_turn(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    turn: &PreparedSessionAgentTurn<'_>,
) -> Result<SessionAgentTurnExecution, String> {
    execute_session_agent_turn(app, state, turn.request_cloned())
}

pub fn execute_session_agent_turn(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: ChatExchangeRequest<'_>,
) -> Result<SessionAgentTurnExecution, String> {
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

    Ok(SessionAgentTurnExecution {
        session_id: persistence.final_session_id,
        response,
        title_update: persistence.title_update,
        emitted_live_events: response_stage.emitted_live_events,
    })
}

fn should_allow_redclaw_onboarding(
    runtime_mode: &str,
    should_handle_redclaw_onboarding: bool,
    is_first_assistant_turn: bool,
    turn_kind: SessionAgentTurnKind,
) -> bool {
    runtime_mode == "redclaw"
        && should_handle_redclaw_onboarding
        && turn_kind == SessionAgentTurnKind::ChatSend
        && is_first_assistant_turn
}

fn emits_live_events_for_runtime_mode(runtime_mode: &str) -> bool {
    runtime_mode != "wander"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_redclaw_onboarding_requires_redclaw_chat_first_turn() {
        assert!(should_allow_redclaw_onboarding(
            "redclaw",
            true,
            true,
            SessionAgentTurnKind::ChatSend,
        ));
        assert!(!should_allow_redclaw_onboarding(
            "chatroom",
            true,
            true,
            SessionAgentTurnKind::ChatSend,
        ));
        assert!(!should_allow_redclaw_onboarding(
            "redclaw",
            true,
            false,
            SessionAgentTurnKind::ChatSend,
        ));
        assert!(!should_allow_redclaw_onboarding(
            "redclaw",
            true,
            true,
            SessionAgentTurnKind::RuntimeQuery,
        ));
    }

    #[test]
    fn emits_live_events_for_runtime_mode_skips_wander_only() {
        assert!(emits_live_events_for_runtime_mode("chatroom"));
        assert!(emits_live_events_for_runtime_mode("redclaw"));
        assert!(!emits_live_events_for_runtime_mode("wander"));
    }
}
