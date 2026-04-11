use serde_json::Value;

use crate::agent::ChatExchangeRequest;

pub struct PreparedChatSendTurn<'a> {
    pub request: ChatExchangeRequest<'a>,
    pub is_redclaw_session: bool,
}

pub fn build_chat_send_turn<'a>(
    session_id: Option<String>,
    message: String,
    display_content: String,
    model_config: Option<&'a Value>,
    attachment: Option<Value>,
) -> PreparedChatSendTurn<'a> {
    let is_redclaw_session = session_id
        .as_deref()
        .map(|value| value.starts_with("context-session:redclaw:"))
        .unwrap_or(false);
    PreparedChatSendTurn {
        request: ChatExchangeRequest::chat_send(
            session_id,
            message.clone(),
            display_content.clone(),
            model_config,
            attachment,
        ),
        is_redclaw_session,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::SessionAgentTurnKind;
    use serde_json::json;

    #[test]
    fn build_chat_send_turn_preserves_request_and_redclaw_detection() {
        let model_config = json!({"modelName": "gpt"});
        let turn = build_chat_send_turn(
            Some("context-session:redclaw:test".to_string()),
            "hello".to_string(),
            "hello display".to_string(),
            Some(&model_config),
            Some(json!({"kind": "file"})),
        );

        assert!(turn.is_redclaw_session);
        assert_eq!(turn.request.turn_kind, SessionAgentTurnKind::ChatSend);
        assert_eq!(turn.request.display_content, "hello display");
    }

    #[test]
    fn build_chat_send_turn_defaults_non_redclaw_sessions() {
        let turn = build_chat_send_turn(None, "hello".to_string(), "hello".to_string(), None, None);
        assert!(!turn.is_redclaw_session);
    }
}
