use futures_util::StreamExt;
use reqwest::header::{ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONNECTION, CONTENT_TYPE};
use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::runtime::Handle;
use tokio::task;

use super::{LlmTransportError, TransportErrorKind, TransportMode};
use crate::events::{
    emit_runtime_stream_start, emit_runtime_task_checkpoint_saved, emit_runtime_text_delta,
    emit_runtime_tool_partial,
};
use crate::{
    append_debug_trace_state, format_http_error_message, http_error_debug_line,
    http_error_details_from_text, is_chat_runtime_cancel_requested, normalize_base_url, now_ms,
    provider_profile_from_config, run_curl_json_response, text_snippet,
    try_refresh_official_auth_for_ai_request, update_chat_runtime_state, AppState,
    InteractiveToolCall, ResolvedChatConfig, StreamingChatCompletion, StreamingToolDelta,
};

static OPENAI_TRANSPORT_CLIENT_AUTO: OnceLock<Client> = OnceLock::new();
static OPENAI_TRANSPORT_CLIENT_HTTP11: OnceLock<Client> = OnceLock::new();
static OPENAI_TRANSPORT_PREFERENCES: OnceLock<Mutex<HashMap<String, TransportMode>>> =
    OnceLock::new();
static QWEN_PROMPT_CACHE_REGISTRY: OnceLock<Mutex<HashMap<String, QwenPromptCacheEntry>>> =
    OnceLock::new();
const OPENAI_JSON_MAX_ATTEMPTS: usize = 3;
const OPENAI_STREAM_MAX_ATTEMPTS: usize = 3;
const QWEN_PROMPT_CACHE_TTL_MS: u128 = 5 * 60 * 1000;
const QWEN_PROMPT_CACHE_GC_GRACE_MS: u128 = 10 * 60 * 1000;
const PROMPT_CACHE_STABLE_PREFIX_MIN_CHARS: usize = 1200;
const TOOL_ARGUMENT_PREVIEW_INTERVAL_MS: u128 = 500;
const TOOL_ARGUMENT_PREVIEW_MIN_CONTENT_CHARS: usize = 1200;

struct OpenaiStreamAttemptError {
    error: LlmTransportError,
    had_visible_output: bool,
}

impl OpenaiStreamAttemptError {
    fn new(error: LlmTransportError, had_visible_output: bool) -> Self {
        Self {
            error,
            had_visible_output,
        }
    }
}

#[derive(Clone, Debug)]
struct QwenPromptCacheEntry {
    marker_count: usize,
    cacheable_chars: usize,
    created_at_ms: u128,
    last_seen_at_ms: u128,
    expires_at_ms: u128,
}

#[derive(Clone, Debug, Default)]
struct QwenPromptCachePlan {
    marker_count: usize,
    system_marked: bool,
    rolling_user_marked: bool,
    cacheable_chars: usize,
    scope_hash: String,
}

fn qwen_prompt_cache_registry() -> &'static Mutex<HashMap<String, QwenPromptCacheEntry>> {
    QWEN_PROMPT_CACHE_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn short_sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut output = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn qwen_prompt_cache_enabled(config: &ResolvedChatConfig) -> bool {
    config.wire_api == crate::runtime::ProviderWireApi::ChatCompat
        && config
            .model_name
            .trim()
            .to_ascii_lowercase()
            .contains("qwen")
}

fn official_openai_chat_prompt_cache_enabled(config: &ResolvedChatConfig) -> bool {
    if config.wire_api != crate::runtime::ProviderWireApi::ChatCompat {
        return false;
    }
    let base_url = normalize_base_url(&config.base_url).to_ascii_lowercase();
    base_url.contains("api.openai.com")
        && !base_url.contains("azure")
        && !base_url.contains("openrouter")
        && !base_url.contains("deepseek")
}

fn value_contains_cache_control(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key("cache_control") || map.values().any(value_contains_cache_control)
        }
        Value::Array(items) => items.iter().any(value_contains_cache_control),
        _ => false,
    }
}

fn message_text_char_count(message: &Value) -> usize {
    match message.get("content") {
        Some(Value::String(text)) => text.chars().count(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .map(|text| text.chars().count())
            .sum(),
        _ => 0,
    }
}

fn mark_string_content_for_prompt_cache(message: &mut Value) -> Option<usize> {
    let text = message.get("content")?.as_str()?.to_string();
    let chars = text.chars().count();
    message["content"] = json!([{
        "type": "text",
        "text": text,
        "cache_control": { "type": "ephemeral" }
    }]);
    Some(chars)
}

fn mark_text_array_content_for_prompt_cache(message: &mut Value) -> Option<usize> {
    let items = message.get_mut("content")?.as_array_mut()?;
    if items.iter().any(value_contains_cache_control) {
        return None;
    }
    let text_indexes = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("text");
            let has_text = item.get("text").and_then(Value::as_str).is_some();
            (item_type == "text" && has_text).then_some(index)
        })
        .collect::<Vec<_>>();
    if text_indexes.is_empty() || text_indexes.len() != items.len() {
        return None;
    }
    let last_index = *text_indexes.last()?;
    let chars = items
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(|text| text.chars().count())
        .sum();
    if let Some(object) = items.get_mut(last_index).and_then(Value::as_object_mut) {
        object.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
        return Some(chars);
    }
    None
}

fn mark_message_for_prompt_cache(message: &mut Value) -> Option<usize> {
    if value_contains_cache_control(message) {
        return None;
    }
    mark_string_content_for_prompt_cache(message)
        .or_else(|| mark_text_array_content_for_prompt_cache(message))
}

fn qwen_prompt_cache_scope_hash(config: &ResolvedChatConfig, body: &Value) -> String {
    let mut seed = format!(
        "{}\n{}\n{}",
        normalize_base_url(&config.base_url).to_ascii_lowercase(),
        config.model_name.trim().to_ascii_lowercase(),
        config.wire_api.as_str()
    );
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        if let Some(system) = messages
            .iter()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        {
            seed.push_str("\nsystem:");
            seed.push_str(&message_text_char_count(system).to_string());
            seed.push(':');
            seed.push_str(
                &system
                    .get("content")
                    .cloned()
                    .unwrap_or(Value::Null)
                    .to_string(),
            );
        }
    }
    if let Some(tools) = body.get("tools") {
        seed.push_str("\ntools:");
        seed.push_str(&tools.to_string());
    }
    short_sha256_hex(&seed)
}

fn prompt_cache_prefix_char_count(body: &Value) -> usize {
    let mut chars = 0;
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        if let Some(system) = messages
            .iter()
            .find(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        {
            chars += message_text_char_count(system);
        }
    }
    if let Some(tools) = body.get("tools") {
        chars += tools.to_string().chars().count();
    }
    chars
}

fn qwen_prompt_cache_body(
    config: &ResolvedChatConfig,
    body: &Value,
) -> Option<(Value, QwenPromptCachePlan)> {
    if !qwen_prompt_cache_enabled(config) || value_contains_cache_control(body) {
        return None;
    }
    let messages = body.get("messages").and_then(Value::as_array)?;
    if messages.is_empty() {
        return None;
    }

    let mut next = body.clone();
    let Some(next_messages) = next.get_mut("messages").and_then(Value::as_array_mut) else {
        return None;
    };

    let mut plan = QwenPromptCachePlan {
        scope_hash: qwen_prompt_cache_scope_hash(config, body),
        ..QwenPromptCachePlan::default()
    };

    if let Some(system_index) = next_messages
        .iter()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("system"))
    {
        if let Some(chars) = mark_message_for_prompt_cache(&mut next_messages[system_index]) {
            plan.marker_count += 1;
            plan.system_marked = true;
            plan.cacheable_chars += chars;
        }
    }

    if plan.marker_count < 4 {
        if let Some(user_index) = next_messages
            .iter()
            .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        {
            if let Some(chars) = mark_message_for_prompt_cache(&mut next_messages[user_index]) {
                plan.marker_count += 1;
                plan.rolling_user_marked = true;
                plan.cacheable_chars += chars;
            }
        }
    }

    (plan.marker_count > 0).then_some((next, plan))
}

fn openai_prompt_cache_body(config: &ResolvedChatConfig, body: &Value) -> Option<Value> {
    if !official_openai_chat_prompt_cache_enabled(config)
        || body.get("prompt_cache_key").is_some()
        || body.get("prompt_cache_retention").is_some()
        || prompt_cache_prefix_char_count(body) < PROMPT_CACHE_STABLE_PREFIX_MIN_CHARS
    {
        return None;
    }
    let scope_hash = qwen_prompt_cache_scope_hash(config, body);
    let mut next = body.clone();
    let object = next.as_object_mut()?;
    object.insert(
        "prompt_cache_key".to_string(),
        json!(format!("app:redconvert:{scope_hash}")),
    );
    object.insert("prompt_cache_retention".to_string(), json!("in_memory"));
    Some(next)
}

fn remember_qwen_prompt_cache_plan(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    plan: &QwenPromptCachePlan,
) {
    let now = now_ms();
    let expires_at = now.saturating_add(QWEN_PROMPT_CACHE_TTL_MS);
    if let Ok(mut registry) = qwen_prompt_cache_registry().lock() {
        registry.retain(|_, entry| {
            now <= entry
                .expires_at_ms
                .saturating_add(QWEN_PROMPT_CACHE_GC_GRACE_MS)
        });
        registry
            .entry(plan.scope_hash.clone())
            .and_modify(|entry| {
                entry.marker_count = plan.marker_count;
                entry.cacheable_chars = plan.cacheable_chars;
                entry.last_seen_at_ms = now;
                entry.expires_at_ms = expires_at;
            })
            .or_insert(QwenPromptCacheEntry {
                marker_count: plan.marker_count,
                cacheable_chars: plan.cacheable_chars,
                created_at_ms: now,
                last_seen_at_ms: now,
                expires_at_ms: expires_at,
            });
        let scope_age_ms = registry
            .get(&plan.scope_hash)
            .map(|entry| now.saturating_sub(entry.created_at_ms))
            .unwrap_or(0);
        append_debug_trace_state(
            state,
            format!(
                "[runtime][prompt-cache][qwen][{}] markers={} system={} rollingUser={} chars={} scope={} activeScopes={} ageMs={} ttlMs={} model={}",
                trace_label,
                plan.marker_count,
                plan.system_marked,
                plan.rolling_user_marked,
                plan.cacheable_chars,
                plan.scope_hash,
                registry.len(),
                scope_age_ms,
                QWEN_PROMPT_CACHE_TTL_MS,
                config.model_name,
            ),
        );
    }
}

fn prompt_cache_chat_body<'a>(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    body: &'a Value,
) -> std::borrow::Cow<'a, Value> {
    if let Some((next, plan)) = qwen_prompt_cache_body(config, body) {
        remember_qwen_prompt_cache_plan(state, trace_label, config, &plan);
        std::borrow::Cow::Owned(next)
    } else if let Some(next) = openai_prompt_cache_body(config, body) {
        append_debug_trace_state(
            state,
            format!(
                "[runtime][prompt-cache][openai][{}] prefixChars={} model={}",
                trace_label,
                prompt_cache_prefix_char_count(body),
                config.model_name,
            ),
        );
        std::borrow::Cow::Owned(next)
    } else {
        std::borrow::Cow::Borrowed(body)
    }
}

fn qwen_usage_integer(value: &Value, paths: &[&[&str]]) -> u64 {
    paths
        .iter()
        .find_map(|path| {
            let mut current = value;
            for segment in *path {
                current = current.get(*segment)?;
            }
            current.as_u64()
        })
        .unwrap_or(0)
}

fn record_qwen_prompt_cache_usage(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    response: &Value,
) {
    if !qwen_prompt_cache_enabled(config) {
        return;
    }
    let Some(usage) = response.get("usage") else {
        return;
    };
    let cached_tokens = qwen_usage_integer(
        usage,
        &[
            &["prompt_tokens_details", "cached_tokens"],
            &["input_tokens_details", "cached_tokens"],
        ],
    );
    let created_tokens = qwen_usage_integer(
        usage,
        &[
            &[
                "prompt_tokens_details",
                "cache_creation",
                "cache_creation_input_tokens",
            ],
            &[
                "prompt_tokens_details",
                "cache_creation",
                "ephemeral_5m_input_tokens",
            ],
            &["prompt_tokens_details", "cache_creation_input_tokens"],
            &[
                "input_tokens_details",
                "cache_creation",
                "cache_creation_input_tokens",
            ],
        ],
    );
    if cached_tokens == 0 && created_tokens == 0 {
        return;
    }
    append_debug_trace_state(
        state,
        format!(
            "[runtime][prompt-cache][qwen][{}] usage createdTokens={} cachedTokens={} promptTokens={} model={}",
            trace_label,
            created_tokens,
            cached_tokens,
            usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
            config.model_name,
        ),
    );
}

fn record_openai_prompt_cache_usage(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    response: &Value,
) {
    if !official_openai_chat_prompt_cache_enabled(config) {
        return;
    }
    let Some(usage) = response.get("usage") else {
        return;
    };
    let cached_tokens = qwen_usage_integer(usage, &[&["prompt_tokens_details", "cached_tokens"]]);
    if cached_tokens == 0 {
        return;
    }
    append_debug_trace_state(
        state,
        format!(
            "[runtime][prompt-cache][openai][{}] cachedTokens={} promptTokens={} model={}",
            trace_label,
            cached_tokens,
            usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            config.model_name,
        ),
    );
}

fn record_prompt_cache_usage(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    response: &Value,
) {
    record_qwen_prompt_cache_usage(state, trace_label, config, response);
    record_openai_prompt_cache_usage(state, trace_label, config, response);
}

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

fn openai_provider_profile(config: &ResolvedChatConfig) -> crate::provider_compat::ProviderProfile {
    provider_profile_from_config(config)
}

fn preferred_transport_mode(config: &ResolvedChatConfig) -> TransportMode {
    let provider_profile = openai_provider_profile(config);
    preference_store()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&transport_preference_key(config)).copied())
        .unwrap_or_else(|| {
            if provider_profile.prefers_http11_transport() {
                TransportMode::Http11
            } else {
                TransportMode::Auto
            }
        })
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

fn is_retryable_json_error(error: &LlmTransportError) -> bool {
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

fn is_retryable_stream_error(error: &LlmTransportError) -> bool {
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

fn json_retry_delay(attempt: usize) -> Duration {
    let exponent = attempt.saturating_sub(1).min(4) as u32;
    let base_ms = 350u64.saturating_mul(2u64.saturating_pow(exponent));
    let jitter_ms = (now_ms() as u64) % 120;
    Duration::from_millis(base_ms.saturating_add(jitter_ms))
}

fn stream_retry_delay(attempt: usize) -> Duration {
    let exponent = attempt.saturating_sub(1).min(3) as u32;
    let base_ms = 450u64.saturating_mul(2u64.saturating_pow(exponent));
    let jitter_ms = (now_ms() as u64) % 160;
    Duration::from_millis(base_ms.saturating_add(jitter_ms))
}

fn run_json_attempt_with_retry<F>(
    state: &State<'_, AppState>,
    trace_label: &str,
    transport_mode: TransportMode,
    mut attempt: F,
) -> Result<Value, LlmTransportError>
where
    F: FnMut() -> Result<Value, LlmTransportError>,
{
    let mut current_attempt = 1usize;
    loop {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error)
                if current_attempt < OPENAI_JSON_MAX_ATTEMPTS
                    && is_retryable_json_error(&error) =>
            {
                let delay = json_retry_delay(current_attempt);
                append_debug_trace_state(
                    state,
                    format!(
                        "[runtime][transport][openai][json] retry attempt={}/{} transport={} delay_ms={} label={} reason={}",
                        current_attempt + 1,
                        OPENAI_JSON_MAX_ATTEMPTS,
                        transport_mode.as_str(),
                        delay.as_millis(),
                        trace_label,
                        text_snippet(&error.to_string(), 240),
                    ),
                );
                std::thread::sleep(delay);
                current_attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn send_openai_request(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    body: &Value,
    transport_mode: TransportMode,
    max_time_seconds: Option<u64>,
) -> Result<reqwest::Response, LlmTransportError> {
    send_openai_request_to_path(
        state,
        trace_label,
        config,
        "/chat/completions",
        body,
        transport_mode,
        max_time_seconds,
    )
    .await
}

async fn send_openai_request_to_path(
    state: &State<'_, AppState>,
    trace_label: &str,
    config: &ResolvedChatConfig,
    endpoint_path: &str,
    body: &Value,
    transport_mode: TransportMode,
    max_time_seconds: Option<u64>,
) -> Result<reqwest::Response, LlmTransportError> {
    let url = format!("{}{}", normalize_base_url(&config.base_url), endpoint_path);
    let provider_profile = openai_provider_profile(config);
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let timeout_label = max_time_seconds
        .filter(|value| *value > 0)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "client-default".to_string());
    let started_at = now_ms();
    let client = openai_client(transport_mode).map_err(|error| {
        LlmTransportError::new(TransportErrorKind::Unknown, transport_mode, error)
    })?;
    let mut request = client
        .post(url.clone())
        .header(CONTENT_TYPE, "application/json")
        .json(body);
    request = request.header(
        ACCEPT,
        if streaming {
            "text/event-stream"
        } else {
            "application/json"
        },
    );
    if provider_profile.prefers_identity_encoding_for_streaming() {
        request = request
            .header(ACCEPT_ENCODING, "identity")
            .header(CONNECTION, "keep-alive");
    }
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
        .map_err(|error| {
            let diagnostic = LlmTransportError::reqwest_diagnostic(&error);
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][transport][openai][{}] request-error model={} transport={} stream={} elapsed={}ms timeout={} url={} diagnostic={}",
                    trace_label,
                    config.model_name,
                    transport_mode.as_str(),
                    streaming,
                    now_ms().saturating_sub(started_at),
                    timeout_label,
                    url,
                    text_snippet(&diagnostic, 1200)
                ),
            );
            (transport_mode, error).into()
        })
}

fn curl_headers_for_openai_request(
    config: &ResolvedChatConfig,
    body: &Value,
) -> Vec<(&'static str, String)> {
    let provider_profile = openai_provider_profile(config);
    let mut headers = Vec::new();
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    headers.push((
        "Accept",
        if streaming {
            "text/event-stream".to_string()
        } else {
            "application/json".to_string()
        },
    ));
    if provider_profile.prefers_identity_encoding_for_streaming() {
        headers.push(("Accept-Encoding", "identity".to_string()));
        headers.push(("Connection", "keep-alive".to_string()));
    }
    headers
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

fn openai_reasoning_fragments(delta: &Value) -> Vec<String> {
    let mut fragments = Vec::new();
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = delta
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            fragments.push(text.to_string());
        }
    }
    if let Some(items) = delta.get("reasoning_details").and_then(Value::as_array) {
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

fn openai_tool_arguments_text(value: Option<&Value>) -> Option<String> {
    let raw = value?;
    match raw {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) | Value::Array(_) | Value::Bool(_) | Value::Number(_) | Value::Null => {
            serde_json::to_string(raw).ok()
        }
    }
}

#[derive(Debug, Default)]
struct ToolArgumentPreviewState {
    last_sent_at: Option<Instant>,
    last_sent_content_chars: usize,
}

#[derive(Debug, Clone)]
struct ToolWritePreview {
    target: Option<String>,
    content_chars: usize,
    complete: bool,
}

impl ToolArgumentPreviewState {
    fn maybe_emit(
        &mut self,
        app: &AppHandle,
        session_id: Option<&str>,
        call_id: &str,
        tool_name: &str,
        arguments: &str,
    ) {
        let Some(preview) = write_preview_from_partial_tool_arguments(tool_name, arguments) else {
            return;
        };
        if preview.content_chars < TOOL_ARGUMENT_PREVIEW_MIN_CONTENT_CHARS {
            return;
        }
        let now = Instant::now();
        if let Some(last_sent_at) = self.last_sent_at {
            let since_last = now.duration_since(last_sent_at).as_millis();
            let char_delta = preview
                .content_chars
                .saturating_sub(self.last_sent_content_chars);
            if since_last < TOOL_ARGUMENT_PREVIEW_INTERVAL_MS && char_delta < 1200 {
                return;
            }
        }
        self.last_sent_at = Some(now);
        self.last_sent_content_chars = preview.content_chars;
        let target = preview
            .target
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("待确定目标");
        let suffix = if preview.complete {
            "，等待执行写入"
        } else {
            ""
        };
        emit_runtime_tool_partial(
            app,
            session_id,
            call_id,
            tool_name,
            &format!(
                "正在生成写入内容：{} 字，目标：{}{}",
                preview.content_chars, target, suffix
            ),
        );
    }
}

fn write_preview_from_partial_tool_arguments(
    tool_name: &str,
    arguments: &str,
) -> Option<ToolWritePreview> {
    let normalized_name = tool_name.trim();
    if matches!(
        normalized_name,
        "Write" | "workflow" | "app_cli" | "Operate"
    ) {
        if let Ok(value) = serde_json::from_str::<Value>(arguments) {
            return write_preview_from_complete_tool_arguments(normalized_name, &value);
        }
    }
    let path = partial_json_string_field(arguments, "path").and_then(|item| item.value);
    let content = partial_json_string_field(arguments, "content")?;
    if matches!(
        normalized_name,
        "Write" | "workflow" | "app_cli" | "Operate"
    ) && content.char_count > 0
    {
        return Some(ToolWritePreview {
            target: path,
            content_chars: content.char_count,
            complete: content.complete,
        });
    }
    None
}

fn write_preview_from_complete_tool_arguments(
    tool_name: &str,
    value: &Value,
) -> Option<ToolWritePreview> {
    if tool_name == "Write" {
        let content = value.get("content").and_then(Value::as_str)?;
        return Some(ToolWritePreview {
            target: value
                .get("path")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            content_chars: content.chars().count(),
            complete: true,
        });
    }
    let action = value
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = value
        .get("payload")
        .or_else(|| value.get("input"))
        .unwrap_or(value);
    let resource = value
        .get("resource")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let operation = value
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let is_write = action == "workspace.write"
        || action == "manuscripts.writeCurrent"
        || (resource == "workspace" && operation == "write")
        || payload.get("content").and_then(Value::as_str).is_some();
    if !is_write {
        return None;
    }
    let content = payload.get("content").and_then(Value::as_str)?;
    Some(ToolWritePreview {
        target: payload
            .get("path")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        content_chars: content.chars().count(),
        complete: true,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PartialJsonStringField {
    value: Option<String>,
    char_count: usize,
    complete: bool,
}

fn partial_json_string_field(source: &str, key: &str) -> Option<PartialJsonStringField> {
    let key_start = find_json_key_outside_string(source, key)?;
    let key_pattern = format!("\"{}\"", key);
    let after_key = &source[key_start + key_pattern.len()..];
    let colon_offset = after_key.find(':')?;
    let mut chars = after_key[colon_offset + 1..].char_indices().peekable();
    while let Some((_, ch)) = chars.peek().copied() {
        if !ch.is_whitespace() {
            break;
        }
        chars.next();
    }
    let (_, first) = chars.next()?;
    if first != '"' {
        return None;
    }
    let mut value = String::new();
    let mut escape = false;
    let mut unicode_escape_remaining = 0usize;
    let mut complete = false;
    for (_, ch) in chars {
        if unicode_escape_remaining > 0 {
            unicode_escape_remaining -= 1;
            if unicode_escape_remaining == 0 {
                value.push('?');
            }
            continue;
        }
        if escape {
            match ch {
                '"' => value.push('"'),
                '\\' => value.push('\\'),
                '/' => value.push('/'),
                'b' => value.push('\u{0008}'),
                'f' => value.push('\u{000c}'),
                'n' => value.push('\n'),
                'r' => value.push('\r'),
                't' => value.push('\t'),
                'u' => unicode_escape_remaining = 4,
                other => value.push(other),
            }
            escape = false;
            continue;
        }
        match ch {
            '\\' => escape = true,
            '"' => {
                complete = true;
                break;
            }
            other => value.push(other),
        }
    }
    let char_count = value.chars().count();
    Some(PartialJsonStringField {
        value: Some(value),
        char_count,
        complete,
    })
}

fn find_json_key_outside_string(source: &str, key: &str) -> Option<usize> {
    let key_pattern = format!("\"{}\"", key);
    let mut in_string = false;
    let mut escape = false;
    let mut last_match = None;
    for (index, ch) in source.char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if source[index..].starts_with(&key_pattern) {
            last_match = Some(index);
            in_string = true;
            continue;
        }
        if ch == '"' {
            in_string = true;
        }
    }
    last_match
}

fn process_openai_sse_event(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    data: &str,
    result: &mut StreamingChatCompletion,
    tool_deltas: &mut Vec<StreamingToolDelta>,
    tool_preview_states: &mut Vec<ToolArgumentPreviewState>,
    saw_tool_calls: &mut bool,
    saw_reasoning: &mut bool,
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

    for fragment in openai_reasoning_fragments(&delta) {
        *saw_reasoning = true;
        if let Some(current_session_id) = session_id {
            emit_runtime_text_delta(app, current_session_id, "thought", &fragment);
        }
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
            while tool_preview_states.len() <= index {
                tool_preview_states.push(ToolArgumentPreviewState::default());
            }
            let entry = &mut tool_deltas[index];
            if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
                entry.id = id.to_string();
            }
            if let Some(function) = item.get("function") {
                if let Some(name_piece) = function.get("name").and_then(|value| value.as_str()) {
                    entry.name.push_str(name_piece);
                }
                if let Some(arguments_piece) = openai_tool_arguments_text(function.get("arguments"))
                {
                    entry.arguments.push_str(&arguments_piece);
                    let preview_call_id = if entry.id.trim().is_empty() {
                        format!("call-{}-{}", session_id.unwrap_or(runtime_mode), index + 1)
                    } else {
                        entry.id.clone()
                    };
                    tool_preview_states[index].maybe_emit(
                        app,
                        session_id,
                        &preview_call_id,
                        &entry.name,
                        &entry.arguments,
                    );
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
) -> Result<StreamingChatCompletion, OpenaiStreamAttemptError> {
    let mut config = config.clone();
    let response = send_openai_request(
        state,
        session_id.unwrap_or("no-session"),
        &config,
        body,
        transport_mode,
        max_time_seconds,
    )
    .await
    .map_err(|error| OpenaiStreamAttemptError::new(error, false))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        if allow_official_reauth_retry && status == 401 {
            if let Some(refreshed_api_key) = try_refresh_official_auth_for_ai_request(
                &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                config.api_key.as_deref(),
                "streaming-http-401",
            )
            .map_err(|error| {
                OpenaiStreamAttemptError::new(
                    LlmTransportError::new(TransportErrorKind::Unknown, transport_mode, error),
                    false,
                )
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
        return Err(OpenaiStreamAttemptError::new(
            parse_error_response(response, transport_mode, &config, runtime_mode, state).await,
            false,
        ));
    }

    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut event_data_lines = Vec::<String>::new();
    let mut result = StreamingChatCompletion::default();
    let mut tool_deltas = Vec::<StreamingToolDelta>::new();
    let mut tool_preview_states = Vec::<ToolArgumentPreviewState>::new();
    let mut saw_tool_calls = false;
    let mut saw_reasoning = false;
    let mut responding_started = false;
    let mut thought_closed = false;
    let stream_started_at = now_ms();
    let mut first_chunk_at_ms = None::<u128>;
    let mut chunk_count = 0usize;
    let mut chunk_bytes = 0usize;

    loop {
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err(OpenaiStreamAttemptError::new(
                LlmTransportError::new(
                    TransportErrorKind::Cancelled,
                    transport_mode,
                    "chat generation cancelled",
                ),
                responding_started || saw_reasoning,
            ));
        }
        match tokio::time::timeout(Duration::from_millis(250), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                if first_chunk_at_ms.is_none() {
                    first_chunk_at_ms = Some(now_ms());
                }
                chunk_count += 1;
                chunk_bytes += chunk.len();
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
                                &mut tool_preview_states,
                                &mut saw_tool_calls,
                                &mut saw_reasoning,
                                &mut responding_started,
                                &mut thought_closed,
                            )
                            .map_err(|error| {
                                append_debug_trace_state(
                                    state,
                                    format!(
                                        "[ai-http] invalid_sse_event method=POST url={} runtimeMode={} model={} transport={} error={} raw={}",
                                        format!(
                                            "{}/chat/completions",
                                            normalize_base_url(&config.base_url)
                                        ),
                                        runtime_mode,
                                        config.model_name,
                                        transport_mode.as_str(),
                                        error,
                                        event_data_lines.join("\n"),
                                    ),
                                );
                                OpenaiStreamAttemptError::new(
                                    LlmTransportError::new(
                                        TransportErrorKind::Parse,
                                        transport_mode,
                                        error,
                                    ),
                                    responding_started || saw_reasoning,
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
                                if saw_reasoning && !thought_closed {
                                    if let Some(current_session_id) = session_id {
                                        finalize_thought_phase(app, current_session_id);
                                    }
                                }
                                append_debug_trace_state(
                                    state,
                                    format!(
                                        "[runtime][stream][openai][{}] attempt_complete transport={} first_chunk_ms={} chunk_count={} chunk_bytes={} content_chars={} reasoning_seen={} tool_calls={} elapsed={}ms",
                                        session_id.unwrap_or("no-session"),
                                        transport_mode.as_str(),
                                        first_chunk_at_ms
                                            .map(|ts| (ts - stream_started_at).to_string())
                                            .unwrap_or_else(|| "none".to_string()),
                                        chunk_count,
                                        chunk_bytes,
                                        result.content.chars().count(),
                                        saw_reasoning,
                                        result.tool_calls.len(),
                                        now_ms() - stream_started_at,
                                    ),
                                );
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
                let had_visible_output = responding_started || saw_reasoning;
                append_debug_trace_state(
                    state,
                    format!(
                        "[runtime][stream][openai][{}] chunk_error transport={} first_chunk_ms={} chunk_count={} chunk_bytes={} content_chars={} reasoning_seen={} error={}",
                        session_id.unwrap_or("no-session"),
                        transport_mode.as_str(),
                        first_chunk_at_ms
                            .map(|ts| (ts - stream_started_at).to_string())
                            .unwrap_or_else(|| "none".to_string()),
                        chunk_count,
                        chunk_bytes,
                        result.content.chars().count(),
                        saw_reasoning,
                        text_snippet(&error.to_string(), 240),
                    ),
                );
                return Err(OpenaiStreamAttemptError::new(
                    (transport_mode, error).into(),
                    had_visible_output,
                ));
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
            &mut tool_preview_states,
            &mut saw_tool_calls,
            &mut saw_reasoning,
            &mut responding_started,
            &mut thought_closed,
        )
        .map_err(|error| {
            append_debug_trace_state(
                state,
                format!(
                    "[ai-http] invalid_sse_event method=POST url={} runtimeMode={} model={} transport={} error={} raw={}",
                    format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                    runtime_mode,
                    config.model_name,
                    transport_mode.as_str(),
                    error,
                    event_data_lines.join("\n"),
                ),
            );
            OpenaiStreamAttemptError::new(
                LlmTransportError::new(TransportErrorKind::Parse, transport_mode, error),
                responding_started || saw_reasoning,
            )
        })?;
    }

    if result.terminal_reason.is_none() && !result.saw_done {
        let had_visible_output = responding_started || saw_reasoning;
        append_debug_trace_state(
            state,
            format!(
                "[runtime][stream][openai][{}] incomplete_eof transport={} first_chunk_ms={} chunk_count={} chunk_bytes={} content_chars={} reasoning_seen={} elapsed={}ms",
                session_id.unwrap_or("no-session"),
                transport_mode.as_str(),
                first_chunk_at_ms
                    .map(|ts| (ts - stream_started_at).to_string())
                    .unwrap_or_else(|| "none".to_string()),
                chunk_count,
                chunk_bytes,
                result.content.chars().count(),
                saw_reasoning,
                now_ms() - stream_started_at,
            ),
        );
        return Err(OpenaiStreamAttemptError::new(
            LlmTransportError::new(
                TransportErrorKind::PartialBody,
                transport_mode,
                "stream closed before a terminal chat completion event",
            ),
            had_visible_output,
        ));
    }

    if saw_tool_calls && !thought_closed {
        if let Some(current_session_id) = session_id {
            if !result.content.trim().is_empty() {
                emit_runtime_text_delta(app, current_session_id, "thought", &result.content);
            }
            finalize_thought_phase(app, current_session_id);
        }
    }
    if saw_reasoning && !thought_closed {
        if let Some(current_session_id) = session_id {
            finalize_thought_phase(app, current_session_id);
        }
    }
    finalize_tool_calls(&mut result, tool_deltas, session_id, runtime_mode);
    append_debug_trace_state(
        state,
        format!(
            "[runtime][stream][openai][{}] attempt_eof transport={} first_chunk_ms={} chunk_count={} chunk_bytes={} content_chars={} reasoning_seen={} tool_calls={} elapsed={}ms",
            session_id.unwrap_or("no-session"),
            transport_mode.as_str(),
            first_chunk_at_ms
                .map(|ts| (ts - stream_started_at).to_string())
                .unwrap_or_else(|| "none".to_string()),
            chunk_count,
            chunk_bytes,
            result.content.chars().count(),
            saw_reasoning,
            result.tool_calls.len(),
            now_ms() - stream_started_at,
        ),
    );
    Ok(result)
}

fn run_openai_json_attempt_via_curl(
    state: &State<'_, AppState>,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
) -> Result<Value, LlmTransportError> {
    let url = format!("{}/chat/completions", normalize_base_url(&config.base_url));
    let headers = curl_headers_for_openai_request(config, body);
    let response = run_curl_json_response(
        "POST",
        &url,
        config.api_key.as_deref(),
        &headers,
        Some(body.clone()),
        max_time_seconds,
    )
    .map_err(|error| LlmTransportError::from_message(TransportMode::Http11, error))?;
    if !(200..300).contains(&response.status) {
        let raw =
            serde_json::to_string(&response.body).unwrap_or_else(|_| response.body.to_string());
        let details = http_error_details_from_text(response.status, &raw);
        append_debug_trace_state(
            state,
            format!(
                "{} | transport=curl-http1.1",
                http_error_debug_line("ai-http", "POST", &url, &details),
            ),
        );
        return Err(LlmTransportError::with_status(
            TransportMode::Http11,
            response.status,
            format_http_error_message("AI request", &details),
            Some(raw),
        ));
    }
    Ok(response.body)
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
    let response = send_openai_request(
        state,
        "json",
        &config,
        body,
        transport_mode,
        max_time_seconds,
    )
    .await?;
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
        append_debug_trace_state(
            state,
            format!(
                "[ai-http] invalid_json method=POST url={} status={} transport={} model={} error={} raw={}",
                format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                status,
                transport_mode.as_str(),
                config.model_name,
                error,
                raw,
            ),
        );
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
    let body = prompt_cache_chat_body(state, trace_session_id, config, body);
    let body = body.as_ref();
    let attempt_once = |mode| {
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
    let attempt = |mode| {
        let mut current_attempt = 1usize;
        loop {
            match attempt_once(mode) {
                Ok(result) => return Ok(result),
                Err(error)
                    if current_attempt < OPENAI_STREAM_MAX_ATTEMPTS
                        && !error.had_visible_output
                        && is_retryable_stream_error(&error.error) =>
                {
                    let delay = stream_retry_delay(current_attempt);
                    append_debug_trace_state(
                        state,
                        format!(
                            "[runtime][stream][openai][{}] retry attempt={}/{} transport={} delay_ms={} reason={}",
                            trace_session_id,
                            current_attempt + 1,
                            OPENAI_STREAM_MAX_ATTEMPTS,
                            mode.as_str(),
                            delay.as_millis(),
                            text_snippet(&error.error.to_string(), 240),
                        ),
                    );
                    if let Some(current_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(current_session_id),
                            "chat.stream_retry",
                            "stream interrupted; retrying model turn",
                            Some(json!({
                                "attempt": current_attempt + 1,
                                "maxAttempts": OPENAI_STREAM_MAX_ATTEMPTS,
                                "transport": mode.as_str(),
                                "reason": error.error.kind.as_str(),
                            })),
                        );
                    }
                    std::thread::sleep(delay);
                    current_attempt += 1;
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
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
            if error.error.should_retry_with_http1()
                && matches!(preferred_mode, TransportMode::Auto)
                && error.error.kind != TransportErrorKind::Cancelled
                && !error.had_visible_output =>
        {
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][transport][openai][{}] retry upgrade=http1.1 reason={}",
                    trace_session_id,
                    text_snippet(&error.error.to_string(), 200),
                ),
            );
            let retry_result = attempt(TransportMode::Http11).map_err(|retry_error| {
                LlmTransportError::new(
                    retry_error.error.kind,
                    retry_error.error.transport_mode,
                    format!("{}; fallback failed: {}", error.error, retry_error.error),
                )
            })?;
            remember_transport_mode(config, TransportMode::Http11);
            Ok(retry_result)
        }
        Err(error) => Err(error.error),
    }
}

fn response_text_from_message_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn chat_messages_to_responses_input(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut instructions = Vec::<String>::new();
    let mut input = Vec::<Value>::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match role {
            "system" | "developer" => {
                let text = response_text_from_message_content(message.get("content"));
                if !text.trim().is_empty() {
                    instructions.push(text);
                }
            }
            "tool" => {
                let call_id = message
                    .get("tool_call_id")
                    .or_else(|| message.get("call_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !call_id.is_empty() {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": response_text_from_message_content(message.get("content")),
                    }));
                }
            }
            "assistant" => {
                let text = response_text_from_message_content(message.get("content"));
                if !text.trim().is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": text,
                    }));
                }
                if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for tool_call in tool_calls {
                        let Some(function) = tool_call.get("function") else {
                            continue;
                        };
                        let name = function
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let call_id = tool_call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if name.is_empty() || call_id.is_empty() {
                            continue;
                        }
                        let arguments = match function.get("arguments") {
                            Some(Value::String(text)) => text.clone(),
                            Some(value) => value.to_string(),
                            None => "{}".to_string(),
                        };
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments,
                        }));
                    }
                }
            }
            _ => {
                input.push(json!({
                    "role": if role == "assistant" { "assistant" } else { "user" },
                    "content": response_text_from_message_content(message.get("content")),
                }));
            }
        }
    }
    let instructions = if instructions.is_empty() {
        None
    } else {
        Some(instructions.join("\n\n"))
    };
    (instructions, input)
}

fn chat_tools_to_responses_tools(tools: Option<&Value>) -> Option<Value> {
    let items = tools?.as_array()?;
    let converted = items
        .iter()
        .filter_map(|tool| {
            if tool.get("type").and_then(Value::as_str) != Some("function") {
                return None;
            }
            let function = tool.get("function")?;
            let name = function.get("name").and_then(Value::as_str)?;
            Some(json!({
                "type": "function",
                "name": name,
                "description": function
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                "parameters": function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            }))
        })
        .collect::<Vec<_>>();
    (!converted.is_empty()).then(|| Value::Array(converted))
}

pub(crate) fn openai_chat_body_to_responses_body(body: &Value) -> Value {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (instructions, input) = chat_messages_to_responses_input(&messages);
    let mut output = json!({
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "input": input,
    });
    if let Some(instructions) = instructions {
        output["instructions"] = json!(instructions);
    }
    if let Some(tools) = chat_tools_to_responses_tools(body.get("tools")) {
        output["tools"] = tools;
    }
    if let Some(tool_choice) = body.get("tool_choice") {
        output["tool_choice"] = tool_choice.clone();
    }
    if let Some(temperature) = body.get("temperature") {
        output["temperature"] = temperature.clone();
    }
    if let Some(max_tokens) = body
        .get("max_tokens")
        .or_else(|| body.get("max_completion_tokens"))
    {
        output["max_output_tokens"] = max_tokens.clone();
    }
    if let Some(effort) = body.get("reasoning_effort").and_then(Value::as_str) {
        output["reasoning"] = json!({ "effort": effort });
    }
    output
}

async fn run_responses_json_attempt(
    state: &State<'_, AppState>,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
    transport_mode: TransportMode,
) -> Result<Value, LlmTransportError> {
    let mut config = config.clone();
    let endpoint = format!("{}/responses", normalize_base_url(&config.base_url));
    let response = send_openai_request_to_path(
        state,
        "responses-json",
        &config,
        "/responses",
        body,
        transport_mode,
        max_time_seconds,
    )
    .await?;
    let status = response.status().as_u16();
    let raw = response
        .text()
        .await
        .map_err(|error| LlmTransportError::from((transport_mode, error)))?;
    if allow_official_reauth_retry && status == 401 {
        if let Some(refreshed_api_key) = try_refresh_official_auth_for_ai_request(
            &endpoint,
            config.api_key.as_deref(),
            "responses-json-http-401",
        )
        .map_err(|error| {
            LlmTransportError::new(TransportErrorKind::Unknown, transport_mode, error)
        })? {
            config.api_key = Some(refreshed_api_key);
            return Box::pin(run_responses_json_attempt(
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
                http_error_debug_line("ai-http", "POST", &endpoint, &details),
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
        append_debug_trace_state(
            state,
            format!(
                "[ai-http] invalid_json method=POST url={} status={} transport={} model={} error={} raw={}",
                endpoint,
                status,
                transport_mode.as_str(),
                config.model_name,
                error,
                raw,
            ),
        );
        LlmTransportError::new(
            TransportErrorKind::Parse,
            transport_mode,
            format!("Invalid JSON response: {error}"),
        )
    })
}

pub(crate) fn run_openai_responses_json_transport(
    state: &State<'_, AppState>,
    config: &ResolvedChatConfig,
    chat_body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
) -> Result<Value, LlmTransportError> {
    let body = openai_chat_body_to_responses_body(chat_body);
    let attempt_once = |mode| {
        run_transport_future(run_responses_json_attempt(
            state,
            config,
            &body,
            max_time_seconds,
            allow_official_reauth_retry,
            mode,
        ))
    };
    let attempt =
        |mode| run_json_attempt_with_retry(state, "responses-json", mode, || attempt_once(mode));

    let preferred_mode = preferred_transport_mode(config);
    match attempt(preferred_mode) {
        Ok(value) => Ok(value),
        Err(error) if error.should_retry_with_http1() && preferred_mode == TransportMode::Auto => {
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][transport][openai][responses-json] retry upgrade=http1.1 reason={}",
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

pub(crate) fn run_openai_json_chat_completion_transport(
    state: &State<'_, AppState>,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
    allow_official_reauth_retry: bool,
) -> Result<Value, LlmTransportError> {
    let body = prompt_cache_chat_body(state, "json", config, body);
    let body = body.as_ref();
    let provider_profile = openai_provider_profile(config);
    if provider_profile.prefers_curl_json_transport() {
        return run_openai_json_attempt_via_curl(state, config, body, max_time_seconds);
    }
    let attempt_once = |mode| {
        run_transport_future(run_json_attempt(
            state,
            config,
            body,
            max_time_seconds,
            allow_official_reauth_retry,
            mode,
        ))
    };
    let attempt = |mode| run_json_attempt_with_retry(state, "json", mode, || attempt_once(mode));

    let preferred_mode = preferred_transport_mode(config);
    match attempt(preferred_mode) {
        Ok(value) => {
            if preferred_mode == TransportMode::Http11 {
                remember_transport_mode(config, TransportMode::Http11);
            }
            record_prompt_cache_usage(state, "json", config, &value);
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
            record_prompt_cache_usage(state, "json", config, &value);
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_retryable_json_error, openai_chat_body_to_responses_body, openai_prompt_cache_body,
        openai_provider_profile, openai_reasoning_fragments, partial_json_string_field,
        preferred_transport_mode, qwen_prompt_cache_body, value_contains_cache_control,
        write_preview_from_partial_tool_arguments,
    };
    use crate::llm_transport::{LlmTransportError, TransportErrorKind, TransportMode};
    use crate::provider_compat::ProviderFamily;
    use crate::runtime::ResolvedChatConfig;
    use serde_json::{json, Value};

    #[test]
    fn minimax_defaults_to_http11_transport() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://api.minimaxi.com/v1".to_string(),
            api_key: None,
            model_name: "MiniMax-M2.7".to_string(),
            reasoning_effort: None,
        };
        assert_eq!(preferred_transport_mode(&config), TransportMode::Http11);
        assert_eq!(
            openai_provider_profile(&config).provider_family,
            ProviderFamily::MiniMax
        );
    }

    fn qwen_chat_config() -> ResolvedChatConfig {
        ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://api.ziz.hk/thrive/v1".to_string(),
            api_key: None,
            model_name: "qwen3.7-plus".to_string(),
            reasoning_effort: None,
        }
    }

    fn official_openai_chat_config() -> ResolvedChatConfig {
        ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: None,
            model_name: "gpt-5".to_string(),
            reasoning_effort: None,
        }
    }

    #[test]
    fn qwen_prompt_cache_marks_system_and_latest_user_messages() {
        let body = json!({
            "model": "qwen3.7-plus",
            "messages": [
                { "role": "system", "content": "stable runtime prompt" },
                { "role": "user", "content": "first request" },
                { "role": "assistant", "content": "ok" },
                { "role": "user", "content": "next request" }
            ],
            "stream": true
        });

        let (cached_body, plan) =
            qwen_prompt_cache_body(&qwen_chat_config(), &body).expect("qwen body should be marked");

        assert_eq!(plan.marker_count, 2);
        assert!(plan.system_marked);
        assert!(plan.rolling_user_marked);
        assert!(value_contains_cache_control(
            &cached_body["messages"][0]["content"]
        ));
        assert!(value_contains_cache_control(
            &cached_body["messages"][3]["content"]
        ));
        assert!(!value_contains_cache_control(
            &cached_body["messages"][1]["content"]
        ));
    }

    #[test]
    fn qwen_prompt_cache_does_not_double_mark_existing_cache_control() {
        let body = json!({
            "model": "qwen3.7-plus",
            "messages": [{
                "role": "system",
                "content": [{
                    "type": "text",
                    "text": "already marked",
                    "cache_control": { "type": "ephemeral" }
                }]
            }]
        });

        assert!(qwen_prompt_cache_body(&qwen_chat_config(), &body).is_none());
    }

    #[test]
    fn openai_prompt_cache_adds_app_scoped_cache_key_for_stable_prefix() {
        let stable_prompt = "stable app prompt ".repeat(90);
        let body = json!({
            "model": "gpt-5",
            "messages": [
                { "role": "system", "content": stable_prompt },
                { "role": "user", "content": "next request" }
            ]
        });

        let cached_body = openai_prompt_cache_body(&official_openai_chat_config(), &body)
            .expect("official OpenAI body should get prompt cache key");

        assert!(cached_body["prompt_cache_key"]
            .as_str()
            .unwrap_or_default()
            .starts_with("app:redconvert:"));
        assert_eq!(cached_body["prompt_cache_retention"], json!("in_memory"));
    }

    #[test]
    fn openai_prompt_cache_skips_non_official_compatible_sources() {
        let mut config = official_openai_chat_config();
        config.base_url = "https://openrouter.ai/api/v1".to_string();
        let body = json!({
            "model": "gpt-5",
            "messages": [
                { "role": "system", "content": "stable app prompt ".repeat(90) },
                { "role": "user", "content": "next request" }
            ]
        });

        assert!(openai_prompt_cache_body(&config, &body).is_none());
    }

    #[test]
    fn non_qwen_prompt_cache_body_is_unchanged() {
        let mut config = qwen_chat_config();
        config.model_name = "gpt-5".to_string();
        let body = json!({
            "model": "gpt-5",
            "messages": [{ "role": "system", "content": "stable" }]
        });

        assert!(qwen_prompt_cache_body(&config, &body).is_none());
    }

    #[test]
    fn qwen_prompt_cache_skips_multimodal_user_array_marker() {
        let body = json!({
            "model": "qwen3.7-plus",
            "messages": [
                { "role": "system", "content": "stable runtime prompt" },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "describe this image" },
                        { "type": "image_url", "image_url": { "url": "data:image/png;base64,abc" } }
                    ]
                }
            ]
        });

        let (cached_body, plan) =
            qwen_prompt_cache_body(&qwen_chat_config(), &body).expect("system should be marked");

        assert_eq!(plan.marker_count, 1);
        assert!(plan.system_marked);
        assert!(!plan.rolling_user_marked);
        assert!(value_contains_cache_control(
            &cached_body["messages"][0]["content"]
        ));
        assert!(!value_contains_cache_control(
            &cached_body["messages"][1]["content"]
        ));
    }

    #[test]
    fn responses_body_conversion_maps_messages_and_function_tools() {
        let body = json!({
            "model": "gpt-5",
            "messages": [
                { "role": "system", "content": "Be precise." },
                { "role": "user", "content": "Read it" },
                {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "Read",
                            "arguments": "{\"path\":\"workspace://a.md\"}"
                        }
                    }]
                },
                { "role": "tool", "tool_call_id": "call_1", "content": "file body" }
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "Read",
                    "description": "Read a resource",
                    "parameters": { "type": "object" }
                }
            }],
            "tool_choice": "auto",
            "reasoning_effort": "low"
        });

        let converted = openai_chat_body_to_responses_body(&body);

        assert_eq!(
            converted.get("instructions").and_then(Value::as_str),
            Some("Be precise.")
        );
        assert_eq!(
            converted.pointer("/tools/0/name").and_then(Value::as_str),
            Some("Read")
        );
        assert_eq!(
            converted.pointer("/input/1/type").and_then(Value::as_str),
            Some("function_call")
        );
        assert_eq!(
            converted.pointer("/input/2/type").and_then(Value::as_str),
            Some("function_call_output")
        );
        assert_eq!(
            converted
                .pointer("/reasoning/effort")
                .and_then(Value::as_str),
            Some("low")
        );
    }

    #[test]
    fn extracts_reasoning_fragments_from_minimax_delta() {
        let fragments = openai_reasoning_fragments(&json!({
            "reasoning_details": [
                { "type": "text", "text": "step one" },
                { "text": "step two" }
            ],
            "reasoning_content": "step zero"
        }));
        assert_eq!(fragments, vec!["step zero", "step one", "step two"]);
    }

    #[test]
    fn partial_json_string_field_counts_incomplete_content() {
        let parsed = partial_json_string_field(
            r#"{"path":"manuscripts://current","content":"hello\nworld"#,
            "content",
        )
        .expect("content field should be detected");

        assert_eq!(parsed.char_count, "hello\nworld".chars().count());
        assert!(!parsed.complete);
    }

    #[test]
    fn partial_json_string_field_ignores_key_like_text_inside_content() {
        let parsed = partial_json_string_field(
            r#"{"content":"<meta name=\"content\" value=\"demo\">tail"#,
            "content",
        )
        .expect("outer content key should be detected");

        assert_eq!(
            parsed.char_count,
            "<meta name=\"content\" value=\"demo\">tail".chars().count()
        );
        assert!(!parsed.complete);
    }

    #[test]
    fn write_preview_detects_streaming_write_arguments() {
        let preview = write_preview_from_partial_tool_arguments(
            "Write",
            r#"{"path":"manuscripts://current","content":"hello"#,
        )
        .expect("write preview should be detected");

        assert_eq!(preview.target.as_deref(), Some("manuscripts://current"));
        assert_eq!(preview.content_chars, 5);
        assert!(!preview.complete);
    }

    #[test]
    fn write_preview_detects_complete_workspace_write_arguments() {
        let preview = write_preview_from_partial_tool_arguments(
            "workflow",
            r#"{"action":"workspace.write","payload":{"path":"manuscripts/demo.html","content":"<html></html>"}}"#,
        )
        .expect("workspace write preview should be detected");

        assert_eq!(preview.target.as_deref(), Some("manuscripts/demo.html"));
        assert_eq!(preview.content_chars, "<html></html>".chars().count());
        assert!(preview.complete);
    }

    #[test]
    fn json_retry_policy_keeps_protocol_errors_terminal() {
        assert!(is_retryable_json_error(&LlmTransportError::new(
            TransportErrorKind::PartialBody,
            TransportMode::Http11,
            "error decoding response body",
        )));
        assert!(is_retryable_json_error(&LlmTransportError::with_status(
            TransportMode::Http11,
            429,
            "rate limited",
            None,
        )));
        assert!(is_retryable_json_error(&LlmTransportError::with_status(
            TransportMode::Http11,
            502,
            "bad gateway",
            None,
        )));
        assert!(!is_retryable_json_error(&LlmTransportError::with_status(
            TransportMode::Http11,
            400,
            "invalid request",
            None,
        )));
        assert!(!is_retryable_json_error(&LlmTransportError::with_status(
            TransportMode::Http11,
            401,
            "unauthorized",
            None,
        )));
    }
}
