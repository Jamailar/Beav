use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::{
    emit_session_agent_completion, execute_prepared_session_agent_turn, ChatExchangeRequest,
    PreparedSessionAgentTurn, SessionAgentTurnKind,
};
use crate::commands::chat_state::resolve_runtime_mode_for_session;
use crate::commands::redclaw_runtime::{detect_redclaw_artifact_kind, save_redclaw_outputs};
use crate::persistence::with_store;
use crate::AppState;

pub struct PreparedChatSendTurn<'a> {
    pub request: ChatExchangeRequest<'a>,
    pub is_redclaw_session: bool,
}

pub struct RedclawChatPostprocess {
    pub runner_payload: Value,
}

pub struct CompletedChatSendTurn {
    pub redclaw_postprocess: Option<RedclawChatPostprocess>,
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
        runner_payload: json!({
            "sessionId": session_id,
            "displayContent": display_content,
            "artifactKind": artifact_kind,
            "artifacts": artifacts,
        }),
    }
}

fn spawn_redclaw_chat_postprocess(
    app: AppHandle,
    session_id: String,
    display_content: String,
    response: String,
    message: String,
) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let artifact_kind = detect_redclaw_artifact_kind(&message, "chat-session");
        let artifacts = save_redclaw_outputs(
            &state,
            artifact_kind,
            &session_id,
            &message,
            &response,
            "chat-session",
        );
        let Ok(artifacts) = artifacts else {
            eprintln!("[RedClaw chat postprocess] failed to save outputs");
            return;
        };
        let postprocess =
            build_redclaw_chat_postprocess(artifact_kind, &session_id, &display_content, artifacts);
        let _ = app.emit("redclaw:runner-message", postprocess.runner_payload);
    });
}

pub fn run_chat_send_turn(
    app: &AppHandle,
    state: &State<'_, AppState>,
    prepared_turn: &PreparedSessionAgentTurn<'_>,
    message: &str,
) -> Result<CompletedChatSendTurn, String> {
    let execution = execute_prepared_session_agent_turn(Some(app), state, prepared_turn)?;
    emit_session_agent_completion(app, state, &execution, SessionAgentTurnKind::ChatSend)?;
    let is_redclaw_session = with_store(state, |store| {
        Ok(resolve_runtime_mode_for_session(&store, execution.session_id()) == "redclaw")
    })?;
    if is_redclaw_session {
        spawn_redclaw_chat_postprocess(
            app.clone(),
            execution.session_id().to_string(),
            prepared_turn.display_content().to_string(),
            execution.response().to_string(),
            message.to_string(),
        );
        return Ok(CompletedChatSendTurn {
            redclaw_postprocess: None,
        });
    }
    Ok(CompletedChatSendTurn {
        redclaw_postprocess: None,
    })
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
        let postprocess =
            build_redclaw_chat_postprocess("run", "session-1", "display body", artifacts.clone());

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

    #[test]
    fn build_redclaw_chat_postprocess_runner_payload_matches_work_item_metadata() {
        let postprocess = build_redclaw_chat_postprocess(
            "run",
            "session-1",
            "display body",
            vec![json!({ "kind": "run-log", "path": "/tmp/run.md" })],
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
                .get("displayContent")
                .and_then(Value::as_str),
            Some("display body")
        );
    }

    #[test]
    fn completed_chat_send_turn_can_carry_optional_redclaw_postprocess() {
        let completed = CompletedChatSendTurn {
            redclaw_postprocess: Some(build_redclaw_chat_postprocess(
                "run",
                "session-1",
                "display body",
                vec![json!({ "kind": "run-log" })],
            )),
        };
        assert!(completed.redclaw_postprocess.is_some());
    }
}
