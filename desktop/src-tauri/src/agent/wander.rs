use tauri::State;

use crate::agent::{
    resolve_chat_exchange_context, resolve_chat_exchange_response_stage, PreparedSessionAgentTurn,
    PreparedWanderTurn, SessionAgentTurnExecution,
};
use crate::commands::chat_state::{is_chat_runtime_cancel_requested, update_chat_runtime_state};
use crate::AppState;

pub fn execute_prepared_wander_turn(
    state: &State<'_, AppState>,
    turn: &PreparedWanderTurn<'_>,
) -> Result<SessionAgentTurnExecution, String> {
    let turn = PreparedSessionAgentTurn::wander(turn.clone());
    let request = turn.request_cloned();
    let context =
        resolve_chat_exchange_context(state, request.session_id.clone(), request.turn_kind)?;
    let _ = update_chat_runtime_state(
        state,
        &context.working_session_id,
        true,
        String::new(),
        None,
    );
    let response_stage = resolve_chat_exchange_response_stage(
        None,
        state,
        &context,
        &request.message,
        request.model_config,
        None,
    )?;
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
    let _ = update_chat_runtime_state(
        state,
        &context.working_session_id,
        false,
        response_stage.response.clone(),
        None,
    );
    Ok(SessionAgentTurnExecution {
        session_id: context.working_session_id,
        response: response_stage.response,
        title_update: None,
        emitted_live_events: response_stage.emitted_live_events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::SessionAgentTurnKind;
    use serde_json::json;

    #[test]
    fn prepared_wander_turn_builds_wander_request() {
        let model_config = json!({"modelName": "gpt"});
        let turn = PreparedWanderTurn::new(
            "session-wander".to_string(),
            "prompt".to_string(),
            Some(&model_config),
        );
        assert_eq!(turn.request.session_id.as_deref(), Some("session-wander"));
        assert_eq!(turn.request.turn_kind, SessionAgentTurnKind::Wander);
    }
}
