use tauri::{AppHandle, State};
use crate::agent::{
    resolve_chat_exchange_context, resolve_chat_exchange_response_stage, ChatExchangeRequest,
    persist_chat_exchange,
    update_post_exchange_maintenance,
};
use crate::commands::chat_state::{
    is_chat_runtime_cancel_requested, update_chat_runtime_state,
};
use crate::runtime::ChatExecutionResult;
use crate::{
    ensure_redclaw_onboarding_completed_with_defaults,
    handle_redclaw_onboarding_turn, AppState,
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
