use tauri::State;

use crate::agent::{ChatExchangeContext, SessionAgentTurnKind};
use crate::commands::chat_state::{
    is_first_assistant_turn_for_session, resolve_runtime_mode_for_session,
};
use crate::persistence::with_store;
use crate::{AppState, make_id};

pub fn resolve_chat_exchange_context(
    state: &State<'_, AppState>,
    session_id: Option<String>,
    turn_kind: SessionAgentTurnKind,
) -> Result<ChatExchangeContext, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let working_session_id = session_id.unwrap_or_else(|| make_id("session"));
    let (runtime_mode, is_first_assistant_turn) = with_store(state, |store| {
        Ok((
            resolve_runtime_mode_for_session(&store, &working_session_id),
            is_first_assistant_turn_for_session(&store, &working_session_id),
        ))
    })?;
    let allow_redclaw_onboarding =
        should_allow_redclaw_onboarding(&runtime_mode, is_first_assistant_turn, turn_kind);
    Ok(ChatExchangeContext {
        settings_snapshot,
        working_session_id,
        runtime_mode,
        allow_redclaw_onboarding,
    })
}

fn should_allow_redclaw_onboarding(
    runtime_mode: &str,
    is_first_assistant_turn: bool,
    turn_kind: SessionAgentTurnKind,
) -> bool {
    let _ = runtime_mode;
    let _ = is_first_assistant_turn;
    let _ = turn_kind;
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_redclaw_onboarding_requires_redclaw_chat_first_turn() {
        assert!(!should_allow_redclaw_onboarding(
            "redclaw",
            true,
            SessionAgentTurnKind::ChatSend,
        ));
        assert!(!should_allow_redclaw_onboarding(
            "team",
            true,
            SessionAgentTurnKind::ChatSend,
        ));
        assert!(!should_allow_redclaw_onboarding(
            "redclaw",
            false,
            SessionAgentTurnKind::ChatSend,
        ));
        assert!(!should_allow_redclaw_onboarding(
            "redclaw",
            true,
            SessionAgentTurnKind::RuntimeQuery,
        ));
    }
}
