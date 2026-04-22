use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent::{ChatExchangeContext, ChatExchangeResponseStage};
use crate::runtime::runtime_error_envelope_from_error;
use crate::{
    append_debug_log_state, provider_profile_from_config, resolve_chat_config,
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

    let app = app.ok_or_else(|| "App handle unavailable for runtime execution".to_string())?;
    let config = resolve_chat_config(&context.settings_snapshot, model_config)
        .ok_or_else(|| "当前未配置可用模型".to_string())?;
    if !matches!(config.protocol.as_str(), "openai" | "anthropic" | "gemini") {
        return Err(format!("unsupported runtime protocol: {}", config.protocol));
    }
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
        Ok(response) => Ok(ChatExchangeResponseStage {
            response,
            emitted_live_events: emits_live_events_for_runtime_mode(&context.runtime_mode),
        }),
        Err(error) => {
            let provider_profile = provider_profile_from_config(&config);
            let envelope = runtime_error_envelope_from_error(
                &error,
                Some(&provider_profile),
                Some(&config.model_name),
            );
            append_debug_log_state(
                state,
                format!(
                    "[runtime][{}][{}] interactive-runtime-failed | layer={} category={} retryable={} | {}",
                    context.runtime_mode,
                    context.working_session_id,
                    envelope.layer.as_key(),
                    envelope.category.as_key(),
                    envelope.retryable,
                    error
                ),
            );
            Err(error)
        }
    }
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
