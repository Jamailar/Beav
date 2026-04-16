use serde_json::Value;

use crate::agent::{
    build_runtime_query_checkpoint_bundle, PreparedChatSendTurn, PreparedRuntimeQueryTurn,
    PreparedSessionBridgeTurn, RuntimeQueryCheckpointBundle,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionAgentTurnKind {
    ChatSend,
    RuntimeQuery,
    SessionBridge,
    AssistantDaemon,
    RedclawRun,
    Wander,
}

impl SessionAgentTurnKind {
    pub fn checkpoint_type(self) -> &'static str {
        match self {
            Self::ChatSend => "chat-send",
            Self::RuntimeQuery => "runtime-query",
            Self::SessionBridge => "session-bridge",
            Self::AssistantDaemon => "assistant-daemon",
            Self::RedclawRun => "redclaw-run",
            Self::Wander => "wander-brainstorm",
        }
    }

    pub fn checkpoint_summary(self) -> &'static str {
        match self {
            Self::ChatSend => "Chat response completed",
            Self::RuntimeQuery => "Runtime query completed",
            Self::SessionBridge => "Session bridge message completed",
            Self::AssistantDaemon => "Assistant daemon handled request",
            Self::RedclawRun => "RedClaw run completed",
            Self::Wander => "Wander brainstorm completed",
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
    pub request_metadata: Option<Value>,
    pub turn_kind: SessionAgentTurnKind,
    pub checkpoint_summary_override: Option<String>,
    pub session_title_override: Option<String>,
}

impl<'a> ChatExchangeRequest<'a> {
    pub fn chat_send(
        session_id: Option<String>,
        message: String,
        display_content: String,
        model_config: Option<&'a Value>,
        attachment: Option<Value>,
        request_metadata: Option<Value>,
    ) -> Self {
        Self {
            session_id,
            message,
            display_content,
            model_config,
            attachment,
            request_metadata,
            turn_kind: SessionAgentTurnKind::ChatSend,
            checkpoint_summary_override: None,
            session_title_override: None,
        }
    }

    pub fn runtime_query(
        session_id: Option<String>,
        effective_message: String,
        display_content: String,
        model_config: Option<&'a Value>,
        request_metadata: Option<Value>,
    ) -> Self {
        Self {
            session_id,
            message: effective_message,
            display_content,
            model_config,
            attachment: None,
            request_metadata,
            turn_kind: SessionAgentTurnKind::RuntimeQuery,
            checkpoint_summary_override: None,
            session_title_override: None,
        }
    }

    pub fn session_bridge(session_id: String, message: String) -> Self {
        Self {
            session_id: Some(session_id),
            display_content: message.clone(),
            message,
            model_config: None,
            attachment: None,
            request_metadata: None,
            turn_kind: SessionAgentTurnKind::SessionBridge,
            checkpoint_summary_override: None,
            session_title_override: None,
        }
    }

    pub fn wander(session_id: String, prompt: String, model_config: Option<&'a Value>) -> Self {
        Self {
            session_id: Some(session_id),
            display_content: prompt.clone(),
            message: prompt,
            model_config,
            attachment: None,
            request_metadata: None,
            turn_kind: SessionAgentTurnKind::Wander,
            checkpoint_summary_override: Some("Wander brainstorm completed".to_string()),
            session_title_override: Some("Wander Deep Think".to_string()),
        }
    }

    pub fn assistant_daemon(session_id: String, prompt: String, route_kind: &str) -> Self {
        Self {
            session_id: Some(session_id),
            display_content: prompt.clone(),
            message: prompt,
            model_config: None,
            attachment: None,
            request_metadata: None,
            turn_kind: SessionAgentTurnKind::AssistantDaemon,
            checkpoint_summary_override: Some(format!("Assistant daemon handled {}", route_kind)),
            session_title_override: Some(format!("Assistant · {}", route_kind)),
        }
    }

    pub fn redclaw_run(session_id: String, prompt: String, source_label: &str) -> Self {
        Self {
            session_id: Some(session_id),
            display_content: prompt.clone(),
            message: prompt,
            model_config: None,
            attachment: None,
            request_metadata: None,
            turn_kind: SessionAgentTurnKind::RedclawRun,
            checkpoint_summary_override: Some(format!("RedClaw completed {}", source_label)),
            session_title_override: Some("RedClaw".to_string()),
        }
    }

    pub fn checkpoint_summary_text(&self) -> String {
        self.checkpoint_summary_override
            .clone()
            .unwrap_or_else(|| self.turn_kind.checkpoint_summary().to_string())
    }

    pub fn session_title_hint_override(&self) -> Option<&str> {
        self.session_title_override.as_deref()
    }
}

#[derive(Clone)]
pub struct AssistantDaemonTurn {
    pub request: ChatExchangeRequest<'static>,
}

#[derive(Clone)]
pub struct RedclawRunTurn {
    pub request: ChatExchangeRequest<'static>,
}

#[derive(Clone)]
pub struct PreparedWanderTurn<'a> {
    pub request: ChatExchangeRequest<'a>,
}

impl AssistantDaemonTurn {
    pub fn new(route_kind: &str, session_id: String, prompt: String) -> Self {
        Self {
            request: ChatExchangeRequest::assistant_daemon(session_id, prompt, route_kind),
        }
    }
}

impl RedclawRunTurn {
    pub fn new(source_label: &str, session_id: String, prompt: String) -> Self {
        Self {
            request: ChatExchangeRequest::redclaw_run(session_id, prompt, source_label),
        }
    }
}

impl<'a> PreparedWanderTurn<'a> {
    pub fn new(session_id: String, prompt: String, model_config: Option<&'a Value>) -> Self {
        Self {
            request: ChatExchangeRequest::wander(session_id, prompt, model_config),
        }
    }
}

pub struct ChatExchangeContext {
    pub settings_snapshot: Value,
    pub working_session_id: String,
    pub runtime_mode: String,
    pub request_metadata: Option<Value>,
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

pub struct SessionAgentTurnExecution {
    pub session_id: String,
    pub response: String,
    pub title_update: Option<(String, String)>,
    pub emitted_live_events: bool,
}

impl SessionAgentTurnExecution {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn response(&self) -> &str {
        &self.response
    }

    pub fn title_update(&self) -> Option<&(String, String)> {
        self.title_update.as_ref()
    }

    pub fn emitted_live_events(&self) -> bool {
        self.emitted_live_events
    }
}

pub enum PreparedSessionAgentTurn<'a> {
    ChatSend(PreparedChatSendTurn<'a>),
    RuntimeQuery(PreparedRuntimeQueryTurn<'a>),
    SessionBridge(PreparedSessionBridgeTurn<'a>),
    AssistantDaemon(AssistantDaemonTurn),
    RedclawRun(RedclawRunTurn),
    Wander(PreparedWanderTurn<'a>),
}

impl<'a> PreparedSessionAgentTurn<'a> {
    pub fn chat_send(turn: PreparedChatSendTurn<'a>) -> Self {
        Self::ChatSend(turn)
    }

    pub fn runtime_query(turn: PreparedRuntimeQueryTurn<'a>) -> Self {
        Self::RuntimeQuery(turn)
    }

    pub fn session_bridge(turn: PreparedSessionBridgeTurn<'a>) -> Self {
        Self::SessionBridge(turn)
    }

    pub fn assistant_daemon(turn: AssistantDaemonTurn) -> Self {
        Self::AssistantDaemon(turn)
    }

    pub fn redclaw_run(turn: RedclawRunTurn) -> Self {
        Self::RedclawRun(turn)
    }

    pub fn wander(turn: PreparedWanderTurn<'a>) -> Self {
        Self::Wander(turn)
    }

    pub fn request(&self) -> &ChatExchangeRequest<'a> {
        match self {
            Self::ChatSend(turn) => &turn.request,
            Self::RuntimeQuery(turn) => &turn.request,
            Self::SessionBridge(turn) => &turn.request,
            Self::AssistantDaemon(turn) => &turn.request,
            Self::RedclawRun(turn) => &turn.request,
            Self::Wander(turn) => &turn.request,
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

    pub fn runtime_query_checkpoint_bundle(&self) -> Option<RuntimeQueryCheckpointBundle> {
        match self {
            Self::RuntimeQuery(turn) => Some(build_runtime_query_checkpoint_bundle(turn)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_agent_turn_kind_maps_to_stable_checkpoint_contract() {
        assert_eq!(
            SessionAgentTurnKind::ChatSend.checkpoint_type(),
            "chat-send"
        );
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
            ChatExchangeRequest::chat_send(
                None,
                "m".to_string(),
                "d".to_string(),
                None,
                None,
                None,
            )
                .turn_kind,
            SessionAgentTurnKind::ChatSend
        );
        assert_eq!(
            ChatExchangeRequest::runtime_query(None, "m".to_string(), "d".to_string(), None, None,)
                .turn_kind,
            SessionAgentTurnKind::RuntimeQuery
        );
        assert_eq!(
            ChatExchangeRequest::session_bridge("s".to_string(), "m".to_string()).turn_kind,
            SessionAgentTurnKind::SessionBridge
        );
        assert_eq!(
            ChatExchangeRequest::assistant_daemon("s".to_string(), "m".to_string(), "feishu")
                .turn_kind,
            SessionAgentTurnKind::AssistantDaemon
        );
        assert_eq!(
            ChatExchangeRequest::redclaw_run("s".to_string(), "m".to_string(), "scheduler")
                .turn_kind,
            SessionAgentTurnKind::RedclawRun
        );
        assert_eq!(
            ChatExchangeRequest::wander("s".to_string(), "m".to_string(), None).turn_kind,
            SessionAgentTurnKind::Wander
        );
    }

    #[test]
    fn prepared_session_agent_turn_exposes_common_request_surface() {
        let turn = PreparedSessionAgentTurn::session_bridge(PreparedSessionBridgeTurn {
            request: ChatExchangeRequest::session_bridge("s".to_string(), "m".to_string()),
        });
        assert_eq!(turn.request().session_id.as_deref(), Some("s"));
        assert_eq!(turn.request_cloned().message, "m");
        assert_eq!(turn.display_content(), "m");
        assert!(!turn.is_redclaw_session());
        assert!(turn.runtime_query_checkpoint_bundle().is_none());
    }

    #[test]
    fn request_overrides_are_available_for_special_turns() {
        let assistant = ChatExchangeRequest::assistant_daemon(
            "session-a".to_string(),
            "prompt".to_string(),
            "feishu",
        );
        assert_eq!(
            assistant.checkpoint_summary_text(),
            "Assistant daemon handled feishu"
        );
        assert_eq!(
            assistant.session_title_hint_override(),
            Some("Assistant · feishu")
        );

        let redclaw =
            ChatExchangeRequest::redclaw_run("session-r".to_string(), "prompt".to_string(), "cron");
        assert_eq!(redclaw.checkpoint_summary_text(), "RedClaw completed cron");
        assert_eq!(redclaw.session_title_hint_override(), Some("RedClaw"));
    }

    #[test]
    fn prepared_runtime_query_turn_exposes_query_specific_accessors() {
        let turn = PreparedSessionAgentTurn::runtime_query(PreparedRuntimeQueryTurn {
            route: crate::runtime::runtime_direct_route_record("default", "draft", None),
            route_value: serde_json::json!({ "intent": "direct_answer" }),
            orchestration: Some(serde_json::json!({ "outputs": [] })),
            context_bundle_snapshot: Some(serde_json::json!({ "fingerprint": "ctx-1" })),
            request: ChatExchangeRequest::runtime_query(
                Some("session-1".to_string()),
                "effective".to_string(),
                "display".to_string(),
                None,
                None,
            ),
        });

        assert_eq!(
            turn.runtime_query_checkpoint_bundle()
                .as_ref()
                .and_then(|bundle| bundle.route_value.get("intent"))
                .and_then(Value::as_str),
            Some("direct_answer")
        );
        assert!(turn.runtime_query_checkpoint_bundle().is_some());
    }

    #[test]
    fn prepared_chat_send_turn_reports_redclaw_flag_through_shared_surface() {
        let turn = PreparedSessionAgentTurn::chat_send(PreparedChatSendTurn {
            request: ChatExchangeRequest::chat_send(
                Some("context-session:redclaw:test".to_string()),
                "message".to_string(),
                "display".to_string(),
                None,
                None,
                None,
            ),
            is_redclaw_session: true,
        });
        assert!(turn.is_redclaw_session());
    }

    #[test]
    fn session_agent_turn_execution_exposes_expected_fields() {
        let execution = SessionAgentTurnExecution {
            session_id: "session-1".to_string(),
            response: "done".to_string(),
            title_update: Some(("session-1".to_string(), "Title".to_string())),
            emitted_live_events: true,
        };
        assert_eq!(execution.session_id, "session-1");
        assert_eq!(execution.response, "done");
        assert!(execution.emitted_live_events);
        assert_eq!(
            execution
                .title_update
                .as_ref()
                .map(|(_, title)| title.as_str()),
            Some("Title")
        );
        assert_eq!(execution.session_id(), "session-1");
        assert_eq!(execution.response(), "done");
        assert!(execution.emitted_live_events());
        assert_eq!(
            execution.title_update().map(|(_, title)| title.as_str()),
            Some("Title")
        );
    }
}
