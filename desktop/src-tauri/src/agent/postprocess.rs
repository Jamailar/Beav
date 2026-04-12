use tauri::{AppHandle, State};

use crate::agent::{SessionAgentTurnExecution, SessionAgentTurnKind};
use crate::commands::chat_state::resolve_runtime_mode_for_session;
use crate::events::{emit_chat_sequence, emit_runtime_task_checkpoint_saved};
use crate::persistence::with_store;
use crate::AppState;

pub fn emit_session_agent_turn_postprocess(
    app: &AppHandle,
    execution: &SessionAgentTurnExecution,
    runtime_mode: &str,
    pending_label: &str,
) {
    if execution.emitted_live_events() {
        if let Some((sid, title)) = execution.title_update().cloned() {
            emit_runtime_task_checkpoint_saved(
                app,
                None,
                Some(&sid),
                "chat.session_title_updated",
                "session title updated",
                Some(serde_json::json!({ "sessionId": sid, "title": title })),
            );
        }
    } else {
        emit_chat_sequence(
            app,
            execution.session_id(),
            execution.response(),
            pending_label,
            runtime_mode,
            execution.title_update().cloned(),
        );
    }
}

pub fn emit_session_agent_completion(
    app: &AppHandle,
    state: &State<'_, AppState>,
    execution: &SessionAgentTurnExecution,
    turn_kind: SessionAgentTurnKind,
) -> Result<(), String> {
    let runtime_mode = with_store(state, |store| {
        Ok(resolve_runtime_mode_for_session(&store, execution.session_id()))
    })?;
    emit_session_agent_turn_postprocess(
        app,
        execution,
        &runtime_mode,
        pending_label_for_turn_kind(turn_kind),
    );
    Ok(())
}

fn pending_label_for_turn_kind(turn_kind: SessionAgentTurnKind) -> &'static str {
    match turn_kind {
        SessionAgentTurnKind::ChatSend => "正在分析输入并生成回答。",
        SessionAgentTurnKind::RuntimeQuery => "正在规划并调用模型生成响应。",
        SessionAgentTurnKind::SessionBridge => "正在处理会话桥接消息。",
        SessionAgentTurnKind::AssistantDaemon => "正在处理助手守护消息。",
        SessionAgentTurnKind::RedclawRun => "正在执行 RedClaw 运行。",
    }
}

#[cfg(test)]
mod tests {
    use crate::agent::{SessionAgentTurnExecution, SessionAgentTurnKind};
    use super::pending_label_for_turn_kind;

    #[test]
    fn postprocess_helper_leaves_execution_surface_intact() {
        let execution = SessionAgentTurnExecution {
            session_id: "session-1".to_string(),
            response: "done".to_string(),
            title_update: Some(("session-1".to_string(), "Title".to_string())),
            emitted_live_events: true,
        };

        assert_eq!(execution.session_id(), "session-1");
        assert_eq!(execution.response(), "done");
        assert!(execution.emitted_live_events());
    }

    #[test]
    fn pending_label_for_turn_kind_matches_current_entrypoint_copy() {
        assert_eq!(
            pending_label_for_turn_kind(SessionAgentTurnKind::ChatSend),
            "正在分析输入并生成回答。"
        );
        assert_eq!(
            pending_label_for_turn_kind(SessionAgentTurnKind::RuntimeQuery),
            "正在规划并调用模型生成响应。"
        );
        assert_eq!(
            pending_label_for_turn_kind(SessionAgentTurnKind::SessionBridge),
            "正在处理会话桥接消息。"
        );
    }
}
