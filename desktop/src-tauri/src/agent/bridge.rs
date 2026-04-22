use crate::agent::ChatExchangeRequest;

pub struct PreparedSessionBridgeTurn<'a> {
    pub request: ChatExchangeRequest<'a>,
}

pub fn build_session_bridge_turn(
    session_id: String,
    message: String,
) -> PreparedSessionBridgeTurn<'static> {
    PreparedSessionBridgeTurn {
        request: ChatExchangeRequest::session_bridge(session_id, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::SessionAgentTurnKind;

    #[test]
    fn build_session_bridge_turn_preserves_session_and_message_contract() {
        let turn = build_session_bridge_turn("session-1".to_string(), "hello".to_string());

        assert_eq!(turn.request.session_id.as_deref(), Some("session-1"));
        assert_eq!(turn.request.message, "hello");
        assert_eq!(turn.request.display_content, "hello");
        assert_eq!(turn.request.turn_kind, SessionAgentTurnKind::SessionBridge);
    }
}
