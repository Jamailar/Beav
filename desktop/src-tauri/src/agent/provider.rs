use serde_json::Value;
use tauri::{AppHandle, State};

use crate::agent::{ChatExchangeContext, ChatExchangeResponseStage};
use crate::runtime::{
    interactive_recovery_plan, InteractiveFallbackMode, InteractiveRecoveryContext,
};
use crate::{
    append_debug_log_state, provider_profile_from_config, resolve_chat_config,
    run_anthropic_interactive_chat_runtime, run_gemini_interactive_chat_runtime,
    run_openai_interactive_chat_runtime, run_openai_prompted_json_fallback, with_store, AppState,
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
            let tool_loop_started =
                session_has_interactive_tool_results(state, context.working_session_id.as_str());
            let recovery_plan = interactive_recovery_plan(
                InteractiveRecoveryContext {
                    runtime_mode: &context.runtime_mode,
                    protocol: &config.protocol,
                    provider_profile: &provider_profile,
                    tool_loop_started,
                },
                &error,
            );
            append_debug_log_state(
                state,
                format!(
                    "[runtime][{}][{}] interactive-runtime-failed | layer={} category={} retryInteractive={} fallbackMode={:?} toolLoopStarted={} | {}",
                    context.runtime_mode,
                    context.working_session_id,
                    recovery_plan.envelope.layer.as_key(),
                    recovery_plan.envelope.category.as_key(),
                    recovery_plan.retry_interactive,
                    recovery_plan.fallback_mode,
                    tool_loop_started,
                    error
                ),
            );
            if !recovery_plan.retry_interactive || config.protocol != "openai" {
                return Err(error);
            }
            let retry_error = match run_openai_interactive_chat_runtime(
                app,
                state,
                Some(context.working_session_id.as_str()),
                &config,
                message,
                &context.runtime_mode,
            ) {
                Ok(response) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-fallback=openai-interactive-retry",
                            context.runtime_mode, context.working_session_id
                        ),
                    );
                    return Ok(ChatExchangeResponseStage {
                        response,
                        emitted_live_events: emits_live_events_for_runtime_mode(
                            &context.runtime_mode,
                        ),
                    });
                }
                Err(retry_error) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-retry-failed | {}",
                            context.runtime_mode, context.working_session_id, retry_error
                        ),
                    );
                    retry_error
                }
            };
            if !recovery_plan.allow_text_fallback() {
                return Err(format!(
                    "interactive runtime failed: {}; interactive retry failed: {}",
                    error, retry_error
                ));
            }
            match recovery_plan.fallback_mode {
                InteractiveFallbackMode::JsonTextCompletion => {
                    match run_openai_prompted_json_fallback(
                        app,
                        state,
                        Some(context.working_session_id.as_str()),
                        &config,
                        message,
                        &context.runtime_mode,
                    ) {
                        Ok(response) => {
                            append_debug_log_state(
                            state,
                            format!(
                                "[runtime][{}][{}] interactive-runtime-fallback=openai-prompted-json",
                                context.runtime_mode, context.working_session_id
                            ),
                        );
                            Ok(ChatExchangeResponseStage {
                                response,
                                emitted_live_events: false,
                            })
                        }
                        Err(fallback_error) => {
                            append_debug_log_state(
                                state,
                                format!(
                                    "[runtime][{}][{}] interactive-runtime-fallback-failed | {}",
                                    context.runtime_mode,
                                    context.working_session_id,
                                    fallback_error
                                ),
                            );
                            Err(format!(
                            "interactive runtime failed: {}; interactive retry failed: {}; fallback failed: {}",
                            error, retry_error, fallback_error
                        ))
                        }
                    }
                }
                InteractiveFallbackMode::None => Err(format!(
                    "interactive runtime failed: {}; interactive retry failed: {}",
                    error, retry_error
                )),
            }
        }
    }
}

fn emits_live_events_for_runtime_mode(runtime_mode: &str) -> bool {
    runtime_mode != "wander"
}

fn session_has_interactive_tool_results(state: &State<'_, AppState>, session_id: &str) -> bool {
    with_store(state, |store| {
        Ok(store
            .session_tool_results
            .iter()
            .any(|record| record.session_id == session_id))
    })
    .unwrap_or(false)
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
