use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::agent::{ChatExchangeContext, ChatExchangeResponseStage};
use crate::runtime::runtime_error_envelope_from_error;
use crate::{
    AppState, append_debug_log_state, provider_profile_from_config, resolve_chat_config,
    run_anthropic_interactive_chat_runtime, run_gemini_interactive_chat_runtime,
    run_openai_interactive_chat_runtime,
};

pub fn resolve_chat_exchange_response_stage(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    message: &str,
    model_config: Option<&Value>,
    attachment: Option<&Value>,
    onboarding_response: Option<(String, bool)>,
) -> Result<ChatExchangeResponseStage, String> {
    if let Some((local_response, _completed)) = onboarding_response {
        return Ok(ChatExchangeResponseStage {
            response: local_response,
            emitted_live_events: false,
        });
    }

    let app = app.ok_or_else(|| "App handle unavailable for runtime execution".to_string())?;
    let scoped_model_config = if let Some(value) = model_config {
        value.clone()
    } else {
        json!({})
    };
    let scoped_model_config = if scoped_model_config
        .get("runtimeMode")
        .or_else(|| scoped_model_config.get("runtime_mode"))
        .is_some()
    {
        scoped_model_config
    } else {
        let mut next = scoped_model_config;
        if let Some(object) = next.as_object_mut() {
            object.insert("runtimeMode".to_string(), json!(context.runtime_mode));
        }
        next
    };
    let config = resolve_chat_config(&context.settings_snapshot, Some(&scoped_model_config))
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
            attachment,
            &context.runtime_mode,
        ),
        "anthropic" => run_anthropic_interactive_chat_runtime(
            app,
            state,
            Some(context.working_session_id.as_str()),
            &config,
            message,
            attachment,
            &context.runtime_mode,
        ),
        "gemini" => run_gemini_interactive_chat_runtime(
            app,
            state,
            Some(context.working_session_id.as_str()),
            &config,
            message,
            attachment,
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
            if should_retry_as_text_after_multimodal_error(&error, attachment) {
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][{}][{}] multimodal-direct-input-fallback | model={} | {}",
                        context.runtime_mode, context.working_session_id, config.model_name, error
                    ),
                );
                let downgraded_attachment = attachment.map(multimodal_text_fallback_attachment);
                let fallback_result = match config.protocol.as_str() {
                    "openai" => run_openai_interactive_chat_runtime(
                        app,
                        state,
                        Some(context.working_session_id.as_str()),
                        &config,
                        message,
                        downgraded_attachment.as_ref(),
                        &context.runtime_mode,
                    ),
                    "anthropic" => run_anthropic_interactive_chat_runtime(
                        app,
                        state,
                        Some(context.working_session_id.as_str()),
                        &config,
                        message,
                        downgraded_attachment.as_ref(),
                        &context.runtime_mode,
                    ),
                    "gemini" => run_gemini_interactive_chat_runtime(
                        app,
                        state,
                        Some(context.working_session_id.as_str()),
                        &config,
                        message,
                        downgraded_attachment.as_ref(),
                        &context.runtime_mode,
                    ),
                    _ => unreachable!(),
                };
                if let Ok(response) = fallback_result {
                    return Ok(ChatExchangeResponseStage {
                        response,
                        emitted_live_events: emits_live_events_for_runtime_mode(
                            &context.runtime_mode,
                        ),
                    });
                }
            }
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

fn attachment_requested_direct_multimodal(attachment: Option<&Value>) -> bool {
    let Some(attachment) = attachment else {
        return false;
    };
    if let Some(items) = attachment.as_array() {
        return items
            .iter()
            .any(|item| attachment_requested_direct_multimodal(Some(item)));
    }
    let mode = attachment
        .get("deliveryMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if mode != "direct-input" {
        return false;
    }
    let kind = attachment
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    matches!(kind, "image" | "audio" | "video")
        || attachment
            .get("requiresMultimodal")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn should_retry_as_text_after_multimodal_error(error: &str, attachment: Option<&Value>) -> bool {
    if !attachment_requested_direct_multimodal(attachment) {
        return false;
    }
    let lower = error.to_ascii_lowercase();
    [
        "multimodal",
        "multi-modal",
        "vision",
        "image input",
        "input_image",
        "image_url",
        "video input",
        "audio input",
        "media type",
        "unsupported content",
        "does not support image",
        "does not support video",
        "does not support audio",
        "only supports text",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn multimodal_text_fallback_attachment(attachment: &Value) -> Value {
    let mut downgraded = attachment.clone();
    if let Some(items) = downgraded.as_array_mut() {
        for item in items {
            if let Some(object) = item.as_object_mut() {
                object.insert(
                    "deliveryMode".to_string(),
                    Value::String("tool-read".to_string()),
                );
                object.insert(
                    "multimodalFallbackReason".to_string(),
                    Value::String("provider-rejected-direct-media-input".to_string()),
                );
            }
        }
        return downgraded;
    }
    if let Some(object) = downgraded.as_object_mut() {
        object.insert(
            "deliveryMode".to_string(),
            Value::String("tool-read".to_string()),
        );
        object.insert(
            "multimodalFallbackReason".to_string(),
            Value::String("provider-rejected-direct-media-input".to_string()),
        );
    }
    downgraded
}

fn emits_live_events_for_runtime_mode(runtime_mode: &str) -> bool {
    runtime_mode != "wander"
}

#[cfg(test)]
mod tests {
    use super::emits_live_events_for_runtime_mode;

    #[test]
    fn emits_live_events_for_runtime_mode_skips_wander_only() {
        assert!(emits_live_events_for_runtime_mode("team"));
        assert!(emits_live_events_for_runtime_mode("redclaw"));
        assert!(!emits_live_events_for_runtime_mode("wander"));
    }
}
