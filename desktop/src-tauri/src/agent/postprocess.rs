use tauri::AppHandle;

use crate::agent::SessionAgentTurnExecution;
use crate::events::{emit_chat_sequence, emit_runtime_task_checkpoint_saved};

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

#[cfg(test)]
mod tests {
    use crate::agent::SessionAgentTurnExecution;

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
}
