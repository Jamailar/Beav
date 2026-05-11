use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, State};

use super::{ProviderError, ProviderErrorKind, ProviderTurnDelivery, ProviderTurnResult};
use crate::llm_transport::{
    LlmTransportError, TransportErrorKind, run_openai_json_chat_completion_transport,
    run_openai_streaming_chat_completion_transport,
};
use crate::provider_compat::InteractiveToolChoice;
use crate::{
    AppState, InteractiveToolCall, ResolvedChatConfig, append_debug_log_state, normalize_base_url,
    now_ms, provider_profile_from_config,
};

static OPENAI_STREAM_DEGRADES: OnceLock<Mutex<HashMap<String, StreamDegradeState>>> =
    OnceLock::new();
const OPENAI_STREAM_DEGRADE_FAILURE_THRESHOLD: u32 = 2;
const OPENAI_STREAM_DEGRADE_WINDOW_MS: u128 = 10 * 60 * 1000;
const OPENAI_STREAM_DEGRADE_COOLDOWN_MS: u128 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy)]
struct StreamDegradeState {
    failures: u32,
    first_failure_at: u128,
    disabled_until: u128,
}

pub(crate) fn should_prefer_non_streaming_openai_turn(
    runtime_mode: &str,
    config: &ResolvedChatConfig,
) -> bool {
    let Some(key) = openai_stream_degrade_key(runtime_mode, config) else {
        return false;
    };
    openai_stream_degrade_store()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&key).copied())
        .map(|entry| entry.disabled_until > now_ms())
        .unwrap_or(false)
}

fn openai_stream_degrade_store() -> &'static Mutex<HashMap<String, StreamDegradeState>> {
    OPENAI_STREAM_DEGRADES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn openai_stream_degrade_key(runtime_mode: &str, config: &ResolvedChatConfig) -> Option<String> {
    let mode = runtime_mode.trim();
    if !matches!(mode, "redclaw" | "team" | "chatroom") {
        return None;
    }
    let model_name = config.model_name.trim().to_ascii_lowercase();
    let base_url = config.base_url.trim().to_ascii_lowercase();
    let is_fragile_stream_provider = model_name.contains("qwen")
        || base_url.contains("dashscope")
        || base_url.contains("api.ziz.hk");
    if !is_fragile_stream_provider {
        return None;
    }
    Some(format!(
        "{}::{}::{}",
        mode,
        normalize_base_url(&config.base_url).to_ascii_lowercase(),
        model_name,
    ))
}

fn record_openai_stream_success(runtime_mode: &str, config: &ResolvedChatConfig) {
    let Some(key) = openai_stream_degrade_key(runtime_mode, config) else {
        return;
    };
    if let Ok(mut guard) = openai_stream_degrade_store().lock() {
        guard.remove(&key);
    }
}

fn record_openai_stream_failure(runtime_mode: &str, config: &ResolvedChatConfig) {
    let Some(key) = openai_stream_degrade_key(runtime_mode, config) else {
        return;
    };
    let now = now_ms();
    if let Ok(mut guard) = openai_stream_degrade_store().lock() {
        let entry = guard.entry(key).or_insert(StreamDegradeState {
            failures: 0,
            first_failure_at: now,
            disabled_until: 0,
        });
        if now.saturating_sub(entry.first_failure_at) > OPENAI_STREAM_DEGRADE_WINDOW_MS {
            entry.failures = 0;
            entry.first_failure_at = now;
            entry.disabled_until = 0;
        }
        entry.failures = entry.failures.saturating_add(1);
        if entry.failures >= OPENAI_STREAM_DEGRADE_FAILURE_THRESHOLD {
            entry.disabled_until = now.saturating_add(OPENAI_STREAM_DEGRADE_COOLDOWN_MS);
        }
    }
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
        Ok(streamed) => {
            record_openai_stream_success(runtime_mode, config);
            Ok(ProviderTurnResult {
                content: streamed.content,
                reasoning_content: String::new(),
                tool_calls: streamed.tool_calls,
                delivery: ProviderTurnDelivery::Streaming,
            })
        }
        Err(stream_error) => {
            if !should_attempt_json_fallback(&stream_error, allow_text_fallback) {
                return Err(provider_error_from_transport(&stream_error));
            }
            if is_stream_degrade_error(&stream_error) {
                record_openai_stream_failure(runtime_mode, config);
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
            if content.trim().is_empty() && tool_calls.is_empty() {
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

fn is_stream_degrade_error(error: &LlmTransportError) -> bool {
    if matches!(error.http_status, Some(429) | Some(500..=599)) {
        return true;
    }
    matches!(
        error.kind,
        TransportErrorKind::Connect
            | TransportErrorKind::Timeout
            | TransportErrorKind::PartialBody
            | TransportErrorKind::Http2Framing
            | TransportErrorKind::EmptyReply
            | TransportErrorKind::Unknown
    )
}

#[cfg(test)]
mod tests {
    use super::{
        extract_openai_json_assistant_response, openai_tool_arguments_value,
        record_openai_stream_failure, record_openai_stream_success, should_attempt_json_fallback,
        should_prefer_non_streaming_openai_turn,
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
            openai_tool_arguments_value(Some(&json!({ "path": "wander/a" }))),
            Some(json!({ "path": "wander/a" }))
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
    fn json_assistant_response_preserves_tool_calls() {
        let (content, reasoning_content, tool_calls) =
            extract_openai_json_assistant_response(&json!({
                "choices": [{
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "Read",
                                "arguments": "{\"path\":\"knowledge://item\"}"
                            }
                        }]
                    }
                }]
            }))
            .unwrap();

        assert!(content.is_empty());
        assert!(reasoning_content.is_empty());
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].name, "Read");
        assert_eq!(
            tool_calls[0].arguments,
            json!({ "path": "knowledge://item" })
        );
    }

    #[test]
    fn redclaw_qwen_turns_start_streaming_until_circuit_breaker_opens() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            base_url: "https://api.ziz.hk/thrive/v1".to_string(),
            api_key: Some("rbx-live-1".to_string()),
            model_name: "qwen3.5-plus".to_string(),
            reasoning_effort: None,
        };

        record_openai_stream_success("redclaw", &config);
        assert!(!should_prefer_non_streaming_openai_turn("redclaw", &config));
        record_openai_stream_failure("redclaw", &config);
        assert!(!should_prefer_non_streaming_openai_turn("redclaw", &config));
        record_openai_stream_failure("redclaw", &config);
        assert!(should_prefer_non_streaming_openai_turn("redclaw", &config));
        record_openai_stream_failure("team", &config);
        record_openai_stream_failure("team", &config);
        assert!(should_prefer_non_streaming_openai_turn("team", &config));
        assert!(!should_prefer_non_streaming_openai_turn("wander", &config));
        record_openai_stream_success("redclaw", &config);
        assert!(!should_prefer_non_streaming_openai_turn("redclaw", &config));
    }

    #[test]
    fn non_qwen_redclaw_models_keep_streaming_behavior() {
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
