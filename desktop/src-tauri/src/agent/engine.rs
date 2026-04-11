use serde_json::Value;

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

pub struct ChatExchangeContext {
    pub settings_snapshot: Value,
    pub working_session_id: String,
    pub runtime_mode: String,
    pub should_handle_redclaw_onboarding: bool,
    pub allow_redclaw_onboarding: bool,
}

pub struct ChatExchangeResponseStage {
    pub response: String,
    pub emitted_live_events: bool,
}

pub struct ChatExchangePersistenceStage {
    pub final_session_id: String,
    pub title_update: Option<(String, String)>,
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
