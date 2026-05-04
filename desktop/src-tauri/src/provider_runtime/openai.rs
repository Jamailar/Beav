use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::{ProviderError, ProviderErrorKind, ProviderTurnDelivery, ProviderTurnResult};
use crate::llm_transport::{
    run_openai_json_chat_completion_transport, run_openai_streaming_chat_completion_transport,
    LlmTransportError, TransportErrorKind,
};
use crate::provider_compat::InteractiveToolChoice;
use crate::{
    append_debug_log_state, provider_profile_from_config, AppState, InteractiveToolCall,
    ResolvedChatConfig,
};

pub(crate) fn should_prefer_non_streaming_openai_turn(
    runtime_mode: &str,
    config: &ResolvedChatConfig,
) -> bool {
    runtime_mode == "redclaw"
        && config
            .model_name
            .trim()
            .to_ascii_lowercase()
            .contains("qwen")
}

fn provider_error_from_transport(error: &LlmTransportError) -> ProviderError {
    if error.http_status == Some(401) || error.http_status == Some(403) {
        return ProviderError::new(ProviderErrorKind::Auth, false, error.to_string());
    }
    if error.http_status == Some(429) {
        return ProviderError::new(ProviderErrorKind::RateLimit, true, error.to_string());
    }
    match error.kind {
        TransportErrorKind::Connect
        | TransportErrorKind::Timeout
        | TransportErrorKind::PartialBody
        | TransportErrorKind::Http2Framing
        | TransportErrorKind::EmptyReply => {
            ProviderError::new(ProviderErrorKind::Transport, true, error.to_string())
        }
        TransportErrorKind::Parse => {
            ProviderError::new(ProviderErrorKind::Protocol, false, error.to_string())
        }
        TransportErrorKind::Status => {
            let lower = error.message.to_ascii_lowercase();
            if lower.contains("invalid_request_error") || lower.contains("invalidparameter") {
                ProviderError::new(ProviderErrorKind::InvalidRequest, false, error.to_string())
            } else {
                ProviderError::new(ProviderErrorKind::Unknown, false, error.to_string())
            }
        }
        TransportErrorKind::Cancelled => {
            ProviderError::new(ProviderErrorKind::Unknown, false, error.to_string())
        }
        TransportErrorKind::Unknown => {
            ProviderError::new(ProviderErrorKind::Unknown, false, error.to_string())
        }
    }
}

fn extract_openai_json_assistant_response(
    response: &Value,
) -> Result<(String, String, Vec<InteractiveToolCall>), ProviderError> {
    let choice = response
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .cloned()
        .ok_or_else(|| {
            ProviderError::new(
                ProviderErrorKind::Protocol,
                false,
                "interactive runtime returned no choices",
            )
        })?;
    let assistant_message = choice.get("message").cloned().ok_or_else(|| {
        ProviderError::new(
            ProviderErrorKind::Protocol,
            false,
            "interactive runtime returned no message",
        )
    })?;
    let assistant_content = assistant_message
        .get("content")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let reasoning_content = openai_json_reasoning_fragments(&assistant_message).join("");
    let tool_calls = assistant_message
        .get("tool_calls")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|raw| {
            let id = raw.get("id").and_then(|value| value.as_str())?.to_string();
            let function = raw.get("function")?;
            let name = function
                .get("name")
                .and_then(|value| value.as_str())?
                .to_string();
            let arguments =
                openai_tool_arguments_value(function.get("arguments")).unwrap_or_else(|| json!({}));
            Some(InteractiveToolCall {
                id,
                name,
                arguments,
            })
        })
        .collect::<Vec<_>>();
    Ok((assistant_content, reasoning_content, tool_calls))
}

fn openai_tool_arguments_value(value: Option<&Value>) -> Option<Value> {
    let raw = value?;
    match raw {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        Value::Object(_) | Value::Array(_) | Value::Bool(_) | Value::Number(_) | Value::Null => {
            Some(raw.clone())
        }
    }
}

fn openai_json_reasoning_fragments(message: &Value) -> Vec<String> {
    let mut fragments = Vec::new();
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = message
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            fragments.push(text.to_string());
        }
    }
    if let Some(items) = message.get("reasoning_details").and_then(Value::as_array) {
        for item in items {
            if let Some(text) = item
                .get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                fragments.push(text.to_string());
            }
        }
    }
    fragments
}

fn should_attempt_json_fallback(error: &LlmTransportError, allow_text_fallback: bool) -> bool {
    allow_text_fallback
        && !matches!(
            error.kind,
            TransportErrorKind::Cancelled | TransportErrorKind::Status
        )
}

pub(crate) fn run_openai_provider_turn(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
    allow_text_fallback: bool,
) -> Result<ProviderTurnResult, ProviderError> {
    let streaming_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if !streaming_requested {
        let response = run_openai_json_chat_completion_transport(
            state,
            config,
            body,
            max_time_seconds,
            allow_official_reauth_retry,
        )
        .map_err(|error| provider_error_from_transport(&error))?;
        let (content, reasoning_content, tool_calls) =
            extract_openai_json_assistant_response(&response)?;
        return Ok(ProviderTurnResult {
            content,
            reasoning_content,
            tool_calls,
            delivery: ProviderTurnDelivery::Streaming,
        });
    }

    match run_openai_streaming_chat_completion_transport(
        app,
        state,
        session_id,
        runtime_mode,
        config,
        body,
        max_time_seconds,
        allow_official_reauth_retry,
    ) {
        Ok(streamed) => Ok(ProviderTurnResult {
            content: streamed.content,
            reasoning_content: String::new(),
            tool_calls: streamed.tool_calls,
            delivery: ProviderTurnDelivery::Streaming,
        }),
        Err(stream_error) => {
            if !should_attempt_json_fallback(&stream_error, allow_text_fallback) {
                return Err(provider_error_from_transport(&stream_error));
            }
            append_debug_log_state(
                state,
                format!(
                    "[runtime][{}][{}] provider-fallback=openai-json | reason={}",
                    runtime_mode,
                    session_id.unwrap_or(runtime_mode),
                    stream_error
                ),
            );
            let mut fallback_body = body.clone();
            fallback_body["stream"] = json!(false);
            if provider_profile_from_config(config).supports_reasoning_split() {
                if let Some(object) = fallback_body.as_object_mut() {
                    object.remove("reasoning_split");
                }
            }
            let turn_policy = provider_profile_from_config(config).turn_policy(
                runtime_mode,
                InteractiveToolChoice::Auto,
                false,
            );
            if turn_policy.disable_thinking {
                provider_profile_from_config(config)
                    .apply_disable_thinking_parameter(&mut fallback_body);
            }
            let response = run_openai_json_chat_completion_transport(
                state,
                config,
                &fallback_body,
                max_time_seconds.or(Some(90)),
                allow_official_reauth_retry,
            )
            .map_err(|fallback_error| {
                let fallback = provider_error_from_transport(&fallback_error);
                ProviderError::new(
                    fallback.kind,
                    fallback.retryable,
                    format!(
                        "{stream_error}; provider fallback failed: {}",
                        fallback.message
                    ),
                )
            })?;
            let (content, reasoning_content, tool_calls) =
                extract_openai_json_assistant_response(&response)?;
            if !tool_calls.is_empty() {
                return Err(ProviderError::new(
                    ProviderErrorKind::Recovery,
                    false,
                    "interactive json fallback returned tool calls",
                ));
            }
            if content.trim().is_empty() {
                return Err(ProviderError::new(
                    ProviderErrorKind::Recovery,
                    false,
                    "interactive fallback returned an empty response",
                ));
            }
            Ok(ProviderTurnResult {
                content,
                reasoning_content,
                tool_calls,
                delivery: ProviderTurnDelivery::JsonFallback,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_openai_json_assistant_response, openai_tool_arguments_value,
        should_attempt_json_fallback, should_prefer_non_streaming_openai_turn,
    };
    use crate::llm_transport::{LlmTransportError, TransportErrorKind, TransportMode};
    use crate::runtime::ResolvedChatConfig;
    use serde_json::json;

    #[test]
    fn partial_body_allows_provider_json_fallback() {
        let error = LlmTransportError::new(
            TransportErrorKind::PartialBody,
            TransportMode::Http11,
            "error decoding response body",
        );
        assert!(should_attempt_json_fallback(&error, true));
    }

    #[test]
    fn status_errors_do_not_attempt_provider_json_fallback() {
        let error =
            LlmTransportError::with_status(TransportMode::Auto, 401, "invalid api key", None);
        assert!(!should_attempt_json_fallback(&error, true));
    }

    #[test]
    fn tool_arguments_parser_accepts_object_arguments() {
        assert_eq!(
            openai_tool_arguments_value(Some(&json!({ "path": "wander/a.redpost" }))),
            Some(json!({ "path": "wander/a.redpost" }))
        );
    }

    #[test]
    fn json_assistant_response_preserves_reasoning_content() {
        let (content, reasoning_content, tool_calls) =
            extract_openai_json_assistant_response(&json!({
                "choices": [{
                    "message": {
                        "content": "final",
                        "reasoning_content": "visible progress",
                        "tool_calls": []
                    }
                }]
            }))
            .unwrap();

        assert_eq!(content, "final");
        assert_eq!(reasoning_content, "visible progress");
        assert!(tool_calls.is_empty());
    }

    #[test]
    fn redclaw_qwen_turns_prefer_non_streaming() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            base_url: "https://api.ziz.hk/thrive/v1".to_string(),
            api_key: Some("rbx-live-1".to_string()),
            model_name: "qwen3.5-plus".to_string(),
            reasoning_effort: None,
        };

        assert!(should_prefer_non_streaming_openai_turn("redclaw", &config));
        assert!(!should_prefer_non_streaming_openai_turn("team", &config));
    }

    #[test]
    fn non_qwen_models_keep_streaming_behavior() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: Some("sk-test".to_string()),
            model_name: "gpt-5.4".to_string(),
            reasoning_effort: None,
        };

        assert!(!should_prefer_non_streaming_openai_turn("redclaw", &config));
    }
}
