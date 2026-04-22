use tauri::{AppHandle, Manager, State};

use crate::agent::{
    persist_chat_exchange, resolve_chat_exchange_context, resolve_chat_exchange_response_stage,
    update_post_exchange_maintenance, ChatExchangeRequest, PreparedSessionAgentTurn,
    SessionAgentTurnExecution,
};
use crate::commands::chat_state::{is_chat_runtime_cancel_requested, update_chat_runtime_state};
use crate::{
    ensure_redclaw_onboarding_completed_with_defaults, handle_redclaw_onboarding_turn, AppState,
};

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
    let checkpoint_summary = request.checkpoint_summary_text();
    let session_title_override = request
        .session_title_hint_override()
        .map(ToString::to_string);
    let ChatExchangeRequest {
        session_id,
        message,
        display_content,
        model_config,
        attachment,
        turn_kind,
        checkpoint_summary_override: _,
        session_title_override: _,
    } = request;
    let context = resolve_chat_exchange_context(state, session_id, turn_kind)?;
    let _ = update_chat_runtime_state(
        state,
        &context.working_session_id,
        true,
        String::new(),
        None,
    );

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
        checkpoint_summary,
        session_title_override,
    )?;
    let _ = update_chat_runtime_state(
        state,
        &persistence.final_session_id,
        false,
        response.clone(),
        None,
    );
    if let Some(app_handle) = app.cloned() {
        let response_for_maintenance = response.clone();
        std::thread::spawn(move || {
            let state = app_handle.state::<AppState>();
            let _ = update_post_exchange_maintenance(&state, &response_for_maintenance);
        });
    }

    Ok(SessionAgentTurnExecution {
        session_id: persistence.final_session_id,
        response,
        title_update: persistence.title_update,
        emitted_live_events: response_stage.emitted_live_events,
    })
}
