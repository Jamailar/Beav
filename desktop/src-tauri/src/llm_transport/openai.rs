use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::runtime::Handle;
use tokio::task;

use super::{LlmTransportError, TransportErrorKind, TransportMode};
use crate::events::{
    emit_runtime_stream_start, emit_runtime_task_checkpoint_saved, emit_runtime_text_delta,
};
use crate::{
    append_debug_trace_state, format_http_error_message, http_error_debug_line,
    http_error_details_from_text, is_chat_runtime_cancel_requested, normalize_base_url, now_ms,
    text_snippet, try_refresh_official_auth_for_ai_request, update_chat_runtime_state, AppState,
    InteractiveToolCall, ResolvedChatConfig, StreamingChatCompletion, StreamingToolDelta,
};

static OPENAI_TRANSPORT_CLIENT_AUTO: OnceLock<Client> = OnceLock::new();
static OPENAI_TRANSPORT_CLIENT_HTTP11: OnceLock<Client> = OnceLock::new();
static OPENAI_TRANSPORT_PREFERENCES: OnceLock<Mutex<HashMap<String, TransportMode>>> =
    OnceLock::new();

fn openai_client(mode: TransportMode) -> Result<&'static Client, String> {
    let slot = match mode {
        TransportMode::Auto => &OPENAI_TRANSPORT_CLIENT_AUTO,
        TransportMode::Http11 => &OPENAI_TRANSPORT_CLIENT_HTTP11,
    };
    if let Some(client) = slot.get() {
        return Ok(client);
    }
    let client = {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30));
        if mode == TransportMode::Http11 {
            builder = builder.http1_only();
        }
        builder.build().map_err(|error| error.to_string())?
    };
    let _ = slot.set(client);
    slot.get()
        .ok_or_else(|| "openai transport client initialization failed".to_string())
}

fn preference_store() -> &'static Mutex<HashMap<String, TransportMode>> {
    OPENAI_TRANSPORT_PREFERENCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn transport_preference_key(config: &ResolvedChatConfig) -> String {
    format!(
        "{}::{}",
        normalize_base_url(&config.base_url).to_ascii_lowercase(),
        config.model_name.trim().to_ascii_lowercase()
    )
}

fn preferred_transport_mode(config: &ResolvedChatConfig) -> TransportMode {
    preference_store()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&transport_preference_key(config)).copied())
        .unwrap_or(TransportMode::Auto)
}

fn remember_transport_mode(config: &ResolvedChatConfig, mode: TransportMode) {
    if let Ok(mut guard) = preference_store().lock() {
        guard.insert(transport_preference_key(config), mode);
    }
}

fn run_transport_future<F, T>(future: F) -> T
where
    F: Future<Output = T>,
{
    if let Ok(handle) = Handle::try_current() {
        return task::block_in_place(|| handle.block_on(future));
    }
    tauri::async_runtime::block_on(future)
}

async fn send_openai_request(
    config: &ResolvedChatConfig,
    body: &Value,
    transport_mode: TransportMode,
    max_time_seconds: Option<u64>,
) -> Result<reqwest::Response, LlmTransportError> {
    let url = format!("{}/chat/completions", normalize_base_url(&config.base_url));
    let client = openai_client(transport_mode).map_err(|error| {
        LlmTransportError::new(TransportErrorKind::Unknown, transport_mode, error)
    })?;
    let mut request = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .json(body);
    if let Some(api_key) = config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
    }
    if let Some(seconds) = max_time_seconds.filter(|value| *value > 0) {
        request = request.timeout(Duration::from_secs(seconds));
    }
    request
        .send()
        .await
        .map_err(|error| (transport_mode, error).into())
}

async fn parse_error_response(
    response: reqwest::Response,
    transport_mode: TransportMode,
    config: &ResolvedChatConfig,
    runtime_mode: &str,
    state: &State<'_, AppState>,
) -> LlmTransportError {
    let status = response.status().as_u16();
    let raw = response.text().await.unwrap_or_default();
    let details = http_error_details_from_text(status, &raw);
    append_debug_trace_state(
        state,
        format!(
            "{} | runtimeMode={} model={} transport={}",
            http_error_debug_line(
                "ai-http",
                "POST",
                &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                &details
            ),
            runtime_mode,
            config.model_name,
            transport_mode.as_str(),
        ),
    );
    LlmTransportError::with_status(
        transport_mode,
        status,
        format_http_error_message("AI request", &details),
        if raw.trim().is_empty() {
            None
        } else {
            Some(raw)
        },
    )
}

fn finalize_thought_phase(app: &AppHandle, session_id: &str) {
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        Some(session_id),
        "chat.thought_end",
        "thought stream completed",
        None,
    );
}

fn process_openai_sse_event(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    data: &str,
    result: &mut StreamingChatCompletion,
    tool_deltas: &mut Vec<StreamingToolDelta>,
    saw_tool_calls: &mut bool,
    responding_started: &mut bool,
    thought_closed: &mut bool,
) -> Result<bool, String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    if trimmed == "[DONE]" {
        result.saw_done = true;
        if result.terminal_reason.is_none() {
            result.terminal_reason = Some("done".to_string());
        }
        return Ok(true);
    }
    let payload = serde_json::from_str::<Value>(trimmed)
        .map_err(|error| format!("Invalid SSE JSON: {error}"))?;
    let choice = payload
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let delta = choice
        .get("delta")
        .cloned()
        .or_else(|| choice.get("message").cloned())
        .unwrap_or_else(|| json!({}));
    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !finish_reason.is_empty() {
        result.terminal_reason = Some(finish_reason.to_string());
    }

    if let Some(items) = delta.get("tool_calls").and_then(|value| value.as_array()) {
        *saw_tool_calls = true;
        for item in items {
            let index = item
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(tool_deltas.len() as u64) as usize;
            while tool_deltas.len() <= index {
                tool_deltas.push(StreamingToolDelta::default());
            }
            let entry = &mut tool_deltas[index];
            if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
                entry.id = id.to_string();
            }
            if let Some(function) = item.get("function") {
                if let Some(name_piece) = function.get("name").and_then(|value| value.as_str()) {
                    entry.name.push_str(name_piece);
                }
                if let Some(arguments_piece) =
                    function.get("arguments").and_then(|value| value.as_str())
                {
                    entry.arguments.push_str(arguments_piece);
                }
            }
        }
    }

    if let Some(content_piece) = delta.get("content").and_then(|value| value.as_str()) {
        if !content_piece.is_empty() {
            result.content.push_str(content_piece);
            if let Some(current_session_id) = session_id {
                let _ = update_chat_runtime_state(
                    state,
                    current_session_id,
                    true,
                    result.content.clone(),
                    None,
                );
            }
            if !*saw_tool_calls {
                if let Some(current_session_id) = session_id {
                    if !*thought_closed {
                        finalize_thought_phase(app, current_session_id);
                        *thought_closed = true;
                    }
                    if !*responding_started {
                        emit_runtime_stream_start(
                            app,
                            current_session_id,
                            "responding",
                            Some(runtime_mode),
                        );
                        *responding_started = true;
                    }
                    emit_runtime_text_delta(app, current_session_id, "response", content_piece);
                }
            }
        }
    }
    if matches!(
        finish_reason,
        "stop" | "tool_calls" | "length" | "content_filter"
    ) {
        return Ok(true);
    }
    Ok(false)
}

fn finalize_tool_calls(
    result: &mut StreamingChatCompletion,
    tool_deltas: Vec<StreamingToolDelta>,
    session_id: Option<&str>,
    runtime_mode: &str,
) {
    result.tool_calls = tool_deltas
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if item.name.trim().is_empty() {
                return None;
            }
            let tool_name = item.name.clone();
            let raw_arguments = item.arguments.trim().to_string();
            let parsed_arguments =
                serde_json::from_str::<Value>(&raw_arguments).unwrap_or_else(|_| json!({}));
            let call_id = if item.id.trim().is_empty() {
                format!("call-{}-{}", session_id.unwrap_or(runtime_mode), index + 1)
            } else {
                item.id
            };
            Some(InteractiveToolCall {
                id: call_id.clone(),
                name: tool_name.clone(),
                arguments: parsed_arguments,
                raw: json!({
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": raw_arguments,
                    }
                }),
            })
        })
        .collect::<Vec<_>>();
}

async fn run_stream_attempt(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
    transport_mode: TransportMode,
) -> Result<StreamingChatCompletion, LlmTransportError> {
    let mut config = config.clone();
    let response = send_openai_request(&config, body, transport_mode, max_time_seconds).await?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        if allow_official_reauth_retry && status == 401 {
            if let Some(refreshed_api_key) = try_refresh_official_auth_for_ai_request(
                &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                config.api_key.as_deref(),
                "streaming-http-401",
            )
            .map_err(|error| {
                LlmTransportError::new(TransportErrorKind::Unknown, transport_mode, error)
            })? {
                config.api_key = Some(refreshed_api_key);
                return Box::pin(run_stream_attempt(
                    app,
                    state,
                    session_id,
                    runtime_mode,
                    &config,
                    body,
                    max_time_seconds,
                    false,
                    transport_mode,
                ))
                .await;
            }
        }
        return Err(
            parse_error_response(response, transport_mode, &config, runtime_mode, state).await,
        );
    }

    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut event_data_lines = Vec::<String>::new();
    let mut result = StreamingChatCompletion::default();
    let mut tool_deltas = Vec::<StreamingToolDelta>::new();
    let mut saw_tool_calls = false;
    let mut responding_started = false;
    let mut thought_closed = false;

    loop {
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err(LlmTransportError::new(
                TransportErrorKind::Cancelled,
                transport_mode,
                "chat generation cancelled",
            ));
        }
        match tokio::time::timeout(Duration::from_millis(250), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                pending.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(index) = pending.find('\n') {
                    let mut line = pending.drain(..=index).collect::<String>();
                    line.truncate(line.trim_end_matches(['\r', '\n']).len());
                    if line.is_empty() {
                        if !event_data_lines.is_empty() {
                            let should_stop = process_openai_sse_event(
                                app,
                                state,
                                session_id,
                                runtime_mode,
                                &event_data_lines.join("\n"),
                                &mut result,
                                &mut tool_deltas,
                                &mut saw_tool_calls,
                                &mut responding_started,
                                &mut thought_closed,
                            )
                            .map_err(|error| {
                                LlmTransportError::new(
                                    TransportErrorKind::Parse,
                                    transport_mode,
                                    error,
                                )
                            })?;
                            event_data_lines.clear();
                            if should_stop {
                                result.saw_eof = false;
                                finalize_tool_calls(
                                    &mut result,
                                    tool_deltas,
                                    session_id,
                                    runtime_mode,
                                );
                                if saw_tool_calls && !thought_closed {
                                    if let Some(current_session_id) = session_id {
                                        if !result.content.trim().is_empty() {
                                            emit_runtime_text_delta(
                                                app,
                                                current_session_id,
                                                "thought",
                                                &result.content,
                                            );
                                        }
                                        finalize_thought_phase(app, current_session_id);
                                    }
                                }
                                return Ok(result);
                            }
                        }
                        continue;
                    }
                    if let Some(value) = line.strip_prefix("data:") {
                        event_data_lines.push(value.trim().to_string());
                    }
                }
            }
            Ok(Some(Err(error))) => {
                return Err((transport_mode, error).into());
            }
            Ok(None) => {
                result.saw_eof = true;
                break;
            }
            Err(_) => {
                continue;
            }
        }
    }

    if !pending.trim().is_empty() {
        if let Some(value) = pending.trim().strip_prefix("data:") {
            event_data_lines.push(value.trim().to_string());
        }
    }
    if !event_data_lines.is_empty() {
        let _ = process_openai_sse_event(
            app,
            state,
            session_id,
            runtime_mode,
            &event_data_lines.join("\n"),
            &mut result,
            &mut tool_deltas,
            &mut saw_tool_calls,
            &mut responding_started,
            &mut thought_closed,
        )
        .map_err(|error| {
            LlmTransportError::new(TransportErrorKind::Parse, transport_mode, error)
        })?;
    }

    if saw_tool_calls && !thought_closed {
        if let Some(current_session_id) = session_id {
            if !result.content.trim().is_empty() {
                emit_runtime_text_delta(app, current_session_id, "thought", &result.content);
            }
            finalize_thought_phase(app, current_session_id);
        }
    }
    finalize_tool_calls(&mut result, tool_deltas, session_id, runtime_mode);
    Ok(result)
}

async fn run_json_attempt(
    state: &State<'_, AppState>,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
    transport_mode: TransportMode,
) -> Result<Value, LlmTransportError> {
    let mut config = config.clone();
    let response = send_openai_request(&config, body, transport_mode, max_time_seconds).await?;
    let status = response.status().as_u16();
    let raw = response
        .text()
        .await
        .map_err(|error| LlmTransportError::from((transport_mode, error)))?;
    if allow_official_reauth_retry && status == 401 {
        if let Some(refreshed_api_key) = try_refresh_official_auth_for_ai_request(
            &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
            config.api_key.as_deref(),
            "json-http-401",
        )
        .map_err(|error| {
            LlmTransportError::new(TransportErrorKind::Unknown, transport_mode, error)
        })? {
            config.api_key = Some(refreshed_api_key);
            return Box::pin(run_json_attempt(
                state,
                &config,
                body,
                max_time_seconds,
                false,
                transport_mode,
            ))
            .await;
        }
    }
    if !(200..300).contains(&status) {
        let details = http_error_details_from_text(status, &raw);
        append_debug_trace_state(
            state,
            format!(
                "{} | transport={}",
                http_error_debug_line(
                    "ai-http",
                    "POST",
                    &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                    &details
                ),
                transport_mode.as_str(),
            ),
        );
        return Err(LlmTransportError::with_status(
            transport_mode,
            status,
            format_http_error_message("AI request", &details),
            Some(raw),
        ));
    }
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(&raw).map_err(|error| {
        LlmTransportError::new(
            TransportErrorKind::Parse,
            transport_mode,
            format!("Invalid JSON response: {error}"),
        )
    })
}

pub(crate) fn run_openai_streaming_chat_completion_transport(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
) -> Result<StreamingChatCompletion, LlmTransportError> {
    let trace_session_id = session_id.unwrap_or("no-session");
    let attempt = |mode| {
        run_transport_future(run_stream_attempt(
            app,
            state,
            session_id,
            runtime_mode,
            config,
            body,
            max_time_seconds,
            allow_official_reauth_retry,
            mode,
        ))
    };

    let preferred_mode = preferred_transport_mode(config);
    match attempt(preferred_mode) {
        Ok(result) => {
            if preferred_mode == TransportMode::Http11 {
                remember_transport_mode(config, TransportMode::Http11);
            }
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][stream][openai][{}] terminal_reason={} done={} eof={} content_chars={} tool_calls={} transport={} elapsed={}ms",
                    trace_session_id,
                    result.terminal_reason.as_deref().unwrap_or("none"),
                    result.saw_done,
                    result.saw_eof,
                    result.content.chars().count(),
                    result.tool_calls.len(),
                    preferred_mode.as_str(),
                    now_ms()
                ),
            );
            Ok(result)
        }
        Err(error)
            if error.should_retry_with_http1()
                && matches!(preferred_mode, TransportMode::Auto)
                && error.kind != TransportErrorKind::Cancelled =>
        {
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][transport][openai][{}] retry upgrade=http1.1 reason={}",
                    trace_session_id,
                    text_snippet(&error.to_string(), 200),
                ),
            );
            let retry_result = attempt(TransportMode::Http11).map_err(|retry_error| {
                LlmTransportError::new(
                    retry_error.kind,
                    retry_error.transport_mode,
                    format!("{error}; fallback failed: {retry_error}"),
                )
            })?;
            remember_transport_mode(config, TransportMode::Http11);
            Ok(retry_result)
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn run_openai_json_chat_completion_transport(
    state: &State<'_, AppState>,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
) -> Result<Value, LlmTransportError> {
    let attempt = |mode| {
        run_transport_future(run_json_attempt(
            state,
            config,
            body,
            max_time_seconds,
            allow_official_reauth_retry,
            mode,
        ))
    };

    let preferred_mode = preferred_transport_mode(config);
    match attempt(preferred_mode) {
        Ok(value) => {
            if preferred_mode == TransportMode::Http11 {
                remember_transport_mode(config, TransportMode::Http11);
            }
            Ok(value)
        }
        Err(error) if error.should_retry_with_http1() && preferred_mode == TransportMode::Auto => {
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][transport][openai][json] retry upgrade=http1.1 reason={}",
                    text_snippet(&error.to_string(), 200),
                ),
            );
            let value = attempt(TransportMode::Http11).map_err(|retry_error| {
                LlmTransportError::new(
                    retry_error.kind,
                    retry_error.transport_mode,
                    format!("{error}; fallback failed: {retry_error}"),
                )
            })?;
            remember_transport_mode(config, TransportMode::Http11);
            Ok(value)
        }
        Err(error) => Err(error),
    }
}
