use serde_json::{json, Value};

use crate::agent::ChatExchangeRequest;

pub struct PreparedChatSendTurn<'a> {
    pub request: ChatExchangeRequest<'a>,
    pub is_redclaw_session: bool,
}

pub struct RedclawChatPostprocess {
    pub work_item_title: String,
    pub work_item_summary: String,
    pub work_item_description: String,
    pub work_item_metadata: Value,
    pub runner_payload: Value,
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

pub fn build_redclaw_chat_postprocess(
    artifact_kind: &str,
    session_id: &str,
    display_content: &str,
    artifacts: Vec<Value>,
) -> RedclawChatPostprocess {
    RedclawChatPostprocess {
        work_item_title: format!("RedClaw Chat {}", artifact_kind),
        work_item_summary: "RedClaw fixed session generated a persisted artifact.".to_string(),
        work_item_description: display_content.to_string(),
        work_item_metadata: json!({
            "sessionId": session_id,
            "artifactKind": artifact_kind,
            "artifacts": artifacts,
        }),
        runner_payload: json!({
            "sessionId": session_id,
            "artifactKind": artifact_kind,
            "artifacts": artifacts,
        }),
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

    #[test]
    fn build_redclaw_chat_postprocess_shapes_work_item_and_runner_payloads() {
        let artifacts = vec![json!({ "kind": "run-log", "path": "/tmp/run.md" })];
        let postprocess = build_redclaw_chat_postprocess(
            "run",
            "session-1",
            "display body",
            artifacts.clone(),
        );

        assert_eq!(postprocess.work_item_title, "RedClaw Chat run");
        assert_eq!(
            postprocess.work_item_summary,
            "RedClaw fixed session generated a persisted artifact."
        );
        assert_eq!(postprocess.work_item_description, "display body");
        assert_eq!(
            postprocess
                .work_item_metadata
                .get("sessionId")
                .and_then(Value::as_str),
            Some("session-1")
        );
        assert_eq!(
            postprocess
                .runner_payload
                .get("artifactKind")
                .and_then(Value::as_str),
            Some("run")
        );
        assert_eq!(
            postprocess
                .runner_payload
                .get("artifacts")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
    }
}
