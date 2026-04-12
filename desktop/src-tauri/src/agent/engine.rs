use serde_json::Value;

use crate::agent::{PreparedChatSendTurn, PreparedRuntimeQueryTurn, PreparedSessionBridgeTurn};

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

#[derive(Clone)]
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

pub enum PreparedSessionAgentTurn<'a> {
    ChatSend(PreparedChatSendTurn<'a>),
    RuntimeQuery(PreparedRuntimeQueryTurn<'a>),
    SessionBridge(PreparedSessionBridgeTurn<'a>),
}

impl<'a> PreparedSessionAgentTurn<'a> {
    pub fn request(&self) -> &ChatExchangeRequest<'a> {
        match self {
            Self::ChatSend(turn) => &turn.request,
            Self::RuntimeQuery(turn) => &turn.request,
            Self::SessionBridge(turn) => &turn.request,
        }
    }

    pub fn request_cloned(&self) -> ChatExchangeRequest<'a> {
        self.request().clone()
    }

    pub fn display_content(&self) -> &str {
        self.request().display_content.as_str()
    }

    pub fn is_redclaw_session(&self) -> bool {
        matches!(self, Self::ChatSend(turn) if turn.is_redclaw_session)
    }

    pub fn route_value(&self) -> Option<&Value> {
        match self {
            Self::RuntimeQuery(turn) => Some(&turn.route_value),
            _ => None,
        }
    }

    pub fn orchestration(&self) -> Option<&Value> {
        match self {
            Self::RuntimeQuery(turn) => turn.orchestration.as_ref(),
            _ => None,
        }
    }

    pub fn route_reasoning(&self) -> Option<&str> {
        match self {
            Self::RuntimeQuery(turn) => Some(turn.route.reasoning.as_str()),
            _ => None,
        }
    }
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

    #[test]
    fn prepared_session_agent_turn_exposes_common_request_surface() {
        let turn = PreparedSessionAgentTurn::SessionBridge(PreparedSessionBridgeTurn {
            request: ChatExchangeRequest::session_bridge("s".to_string(), "m".to_string()),
        });
        assert_eq!(turn.request().session_id.as_deref(), Some("s"));
        assert_eq!(turn.request_cloned().message, "m");
        assert_eq!(turn.display_content(), "m");
        assert!(!turn.is_redclaw_session());
        assert!(turn.route_value().is_none());
        assert!(turn.orchestration().is_none());
        assert!(turn.route_reasoning().is_none());
    }

    #[test]
    fn prepared_runtime_query_turn_exposes_query_specific_accessors() {
        let turn = PreparedSessionAgentTurn::RuntimeQuery(PreparedRuntimeQueryTurn {
            route: crate::runtime::runtime_direct_route_record("default", "draft", None),
            route_value: serde_json::json!({ "intent": "direct_answer" }),
            orchestration: Some(serde_json::json!({ "outputs": [] })),
            request: ChatExchangeRequest::runtime_query(
                Some("session-1".to_string()),
                "effective".to_string(),
                "display".to_string(),
                None,
            ),
        });

        assert_eq!(
            turn.route_value()
                .and_then(|value| value.get("intent"))
                .and_then(Value::as_str),
            Some("direct_answer")
        );
        assert!(turn.orchestration().is_some());
        assert!(turn.route_reasoning().is_some());
    }

    #[test]
    fn prepared_chat_send_turn_reports_redclaw_flag_through_shared_surface() {
        let turn = PreparedSessionAgentTurn::ChatSend(PreparedChatSendTurn {
            request: ChatExchangeRequest::chat_send(
                Some("context-session:redclaw:test".to_string()),
                "message".to_string(),
                "display".to_string(),
                None,
                None,
            ),
            is_redclaw_session: true,
        });
        assert!(turn.is_redclaw_session());
    }
}
