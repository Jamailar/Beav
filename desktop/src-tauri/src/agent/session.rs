use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent::{ChatExchangeContext, ChatExchangeResponseStage, SessionAgentTurnKind};
use crate::commands::chat_state::{
    is_first_assistant_turn_for_session, resolve_runtime_mode_for_session,
    should_handle_redclaw_onboarding_for_session,
};
use crate::persistence::with_store;
use crate::{
    append_debug_log_state, generate_chat_response, make_id, resolve_chat_config,
    run_anthropic_interactive_chat_runtime, run_gemini_interactive_chat_runtime,
    run_openai_interactive_chat_runtime, AppState,
};

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
                        emitted_live_events: context.runtime_mode != "wander",
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
