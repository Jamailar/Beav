use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent::{ChatExchangeContext, ChatExchangeResponseStage};
use crate::{
    append_debug_log_state, generate_chat_response, resolve_chat_config,
    run_anthropic_interactive_chat_runtime, run_gemini_interactive_chat_runtime,
    run_openai_interactive_chat_runtime, AppState,
};

pub fn resolve_chat_exchange_response_stage(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    message: &str,
    model_config: Option<&Value>,
    onboarding_response: Option<(String, bool)>,
) -> Result<ChatExchangeResponseStage, String> {
    if let Some((local_response, _completed)) = onboarding_response {
        return Ok(ChatExchangeResponseStage {
            response: local_response,
            emitted_live_events: false,
        });
    }

    if let (Some(app), Some(config)) =
        (app, resolve_chat_config(&context.settings_snapshot, model_config))
    {
        if matches!(config.protocol.as_str(), "openai" | "anthropic" | "gemini") {
            let interactive_result = match config.protocol.as_str() {
                "openai" => run_openai_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                ),
                "anthropic" => run_anthropic_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                ),
                "gemini" => run_gemini_interactive_chat_runtime(
                    app,
                    state,
                    Some(context.working_session_id.as_str()),
                    &config,
                    message,
                    &context.runtime_mode,
                ),
                _ => unreachable!(),
            };
            match interactive_result {
                Ok(response) => {
                    return Ok(ChatExchangeResponseStage {
                        response,
                        emitted_live_events: emits_live_events_for_runtime_mode(
                            &context.runtime_mode,
                        ),
                    });
                }
                Err(error) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-failed | {}",
                            context.runtime_mode, context.working_session_id, error
                        ),
                    );
                    if context.runtime_mode == "wander" {
                        return Err(error);
                    }
                }
            }
        }
    }

    Ok(ChatExchangeResponseStage {
        response: generate_chat_response(&context.settings_snapshot, model_config, message),
        emitted_live_events: false,
    })
}

fn emits_live_events_for_runtime_mode(runtime_mode: &str) -> bool {
    runtime_mode != "wander"
}

#[cfg(test)]
mod tests {
    use super::emits_live_events_for_runtime_mode;

    #[test]
    fn emits_live_events_for_runtime_mode_skips_wander_only() {
        assert!(emits_live_events_for_runtime_mode("chatroom"));
        assert!(emits_live_events_for_runtime_mode("redclaw"));
        assert!(!emits_live_events_for_runtime_mode("wander"));
    }
}
