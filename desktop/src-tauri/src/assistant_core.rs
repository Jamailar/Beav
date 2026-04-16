use crate::agent::{
    execute_prepared_session_agent_turn, AssistantDaemonTurn, PreparedSessionAgentTurn,
};
use crate::knowledge;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    now_iso, payload_string, run_curl_json, url_encode_component, with_store, AppState,
    AssistantSidecarRuntime, AssistantStateRecord,
};

pub(crate) fn value_to_i64_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|item| {
        item.as_i64()
            .map(|number| number.to_string())
            .or_else(|| item.as_str().map(ToString::to_string))
    })
}

fn normalize_endpoint_path(path: Option<&str>, fallback: &str) -> String {
    let candidate = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    let with_leading_slash = if candidate.starts_with('/') {
        candidate.to_string()
    } else {
        format!("/{candidate}")
    };
    if with_leading_slash.len() > 1 {
        with_leading_slash.trim_end_matches('/').to_string()
    } else {
        with_leading_slash
    }
}

fn assistant_base_url(state: &AssistantStateRecord) -> String {
    let host = state.host.trim();
    if host.is_empty() || state.port <= 0 {
        return String::new();
    }
    format!("http://{}:{}", host, state.port)
}

fn assistant_channel_public_value(channel: &Value, base_url: &str, fallback_path: &str) -> Value {
    let mut value = channel.clone();
    let endpoint_path = normalize_endpoint_path(
        value.get("endpointPath").and_then(|item| item.as_str()),
        fallback_path,
    );
    if let Some(object) = value.as_object_mut() {
        object.insert("endpointPath".to_string(), json!(endpoint_path.clone()));
        object.insert(
            "webhookUrl".to_string(),
            json!(if base_url.is_empty() {
                String::new()
            } else {
                format!("{base_url}{endpoint_path}")
            }),
        );
    }
    value
}

fn normalize_request_path(path: &str) -> String {
    let without_query = path.split_once('?').map(|(head, _)| head).unwrap_or(path);
    let clean = without_query
        .split_once('#')
        .map(|(head, _)| head)
        .unwrap_or(without_query);
    normalize_endpoint_path(Some(clean), "/")
}

fn assistant_route_kind_for_path(path: &str, state: &AssistantStateRecord) -> &'static str {
    let normalized = normalize_request_path(path);
    let feishu_path = normalize_endpoint_path(
        state
            .feishu
            .get("endpointPath")
            .and_then(|item| item.as_str()),
        "/hooks/feishu/events",
    );
    if state
        .feishu
        .get("enabled")
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
        && normalized == feishu_path
    {
        return "feishu";
    }
    let weixin_path = normalize_endpoint_path(
        state
            .weixin
            .get("endpointPath")
            .and_then(|item| item.as_str()),
        "/hooks/weixin/relay",
    );
    if state
        .weixin
        .get("enabled")
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
        && normalized == weixin_path
    {
        return "weixin";
    }
    let relay_path = normalize_endpoint_path(
        state
            .relay
            .get("endpointPath")
            .and_then(|item| item.as_str()),
        "/hooks/channel/relay",
    );
    if state
        .relay
        .get("enabled")
        .and_then(|item| item.as_bool())
        .unwrap_or(true)
        && normalized == relay_path
    {
        return "relay";
    }
    "generic"
}

fn knowledge_api_endpoint_path(state: &AssistantStateRecord) -> String {
    normalize_endpoint_path(
        state
            .knowledge_api
            .get("endpointPath")
            .and_then(|item| item.as_str()),
        "/api/knowledge",
    )
}

fn is_knowledge_api_path(path: &str, state: &AssistantStateRecord) -> bool {
    let normalized = normalize_request_path(path);
    let base_path = knowledge_api_endpoint_path(state);
    normalized == base_path || normalized.starts_with(&format!("{base_path}/"))
}

fn extract_bearer_or_token(headers: &HashMap<String, String>) -> String {
    let auth = headers
        .get("authorization")
        .or_else(|| headers.get("x-auth-token"))
        .cloned()
        .unwrap_or_default();
    auth.strip_prefix("Bearer ")
        .unwrap_or(&auth)
        .trim()
        .to_string()
}

fn extract_json_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return payload_string(&value, "text")
            .or_else(|| payload_string(&value, "content"))
            .or_else(|| value.as_str().map(ToString::to_string))
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty());
    }
    Some(trimmed.to_string())
}

fn extract_feishu_prompt(parsed: &Value) -> Option<String> {
    parsed
        .pointer("/event/text")
        .and_then(|value| value.as_str())
        .and_then(extract_json_text)
        .or_else(|| {
            parsed
                .pointer("/event/message/content")
                .and_then(|value| value.as_str())
                .and_then(extract_json_text)
        })
        .or_else(|| {
            parsed
                .get("text")
                .and_then(|value| value.as_str())
                .and_then(extract_json_text)
        })
}

fn resolve_feishu_receive_target(
    body: &Value,
    prefer_chat_id: bool,
) -> Option<(&'static str, String)> {
    let chat_id = body
        .pointer("/event/message/chat_id")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty());
    let open_id = body
        .pointer("/event/sender/sender_id/open_id")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty());
    let user_id = body
        .pointer("/event/sender/sender_id/user_id")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty());

    if prefer_chat_id {
        chat_id
            .map(|value| ("chat_id", value))
            .or_else(|| open_id.map(|value| ("open_id", value)))
            .or_else(|| user_id.map(|value| ("user_id", value)))
    } else {
        open_id
            .map(|value| ("open_id", value))
            .or_else(|| user_id.map(|value| ("user_id", value)))
            .or_else(|| chat_id.map(|value| ("chat_id", value)))
    }
}

fn fetch_feishu_tenant_access_token(app_id: &str, app_secret: &str) -> Result<String, String> {
    let response = run_curl_json(
        "POST",
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        None,
        &[],
        Some(json!({
            "app_id": app_id,
            "app_secret": app_secret
        })),
    )?;
    if response
        .get("code")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        != 0
    {
        let code = response.get("code").cloned().unwrap_or(Value::Null);
        let message = response
            .get("msg")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Feishu token error {code}: {message}"));
    }
    response
        .get("tenant_access_token")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Feishu token missing tenant_access_token".to_string())
}

fn send_feishu_text_reply(
    assistant_state: &AssistantStateRecord,
    body: &Value,
    reply: &str,
) -> Result<Value, String> {
    let app_id = assistant_state
        .feishu
        .get("appId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Feishu appId 未配置，无法回消息".to_string())?;
    let app_secret = assistant_state
        .feishu
        .get("appSecret")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Feishu appSecret 未配置，无法回消息".to_string())?;
    let prefer_chat_id = assistant_state
        .feishu
        .get("replyUsingChatId")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let (receive_id_type, receive_id) = resolve_feishu_receive_target(body, prefer_chat_id)
        .ok_or_else(|| "Feishu 事件里缺少可回复的 receive_id".to_string())?;
    let tenant_access_token = fetch_feishu_tenant_access_token(app_id, app_secret)?;
    let response = run_curl_json(
        "POST",
        &format!(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={}",
            url_encode_component(receive_id_type)
        ),
        Some(tenant_access_token.as_str()),
        &[],
        Some(json!({
            "receive_id": receive_id,
            "msg_type": "text",
            "content": serde_json::to_string(&json!({ "text": reply }))
                .map_err(|error| error.to_string())?,
        })),
    )?;
    if response
        .get("code")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        != 0
    {
        let code = response.get("code").cloned().unwrap_or(Value::Null);
        let message = response
            .get("msg")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Feishu send message error {code}: {message}"));
    }
    Ok(json!({
        "receiveIdType": receive_id_type,
        "receiveId": receive_id,
        "messageId": response.pointer("/data/message_id").cloned().unwrap_or(Value::Null)
    }))
}

pub(crate) fn assistant_state_value(state: &AssistantStateRecord) -> Value {
    let base_url = assistant_base_url(state);
    json!({
        "enabled": state.enabled,
        "autoStart": state.auto_start,
        "keepAliveWhenNoWindow": state.keep_alive_when_no_window,
        "host": state.host,
        "port": state.port,
        "listening": state.listening,
        "lockState": state.lock_state,
        "blockedBy": state.blocked_by,
        "lastError": state.last_error,
        "activeTaskCount": state.active_task_count,
        "queuedPeerCount": state.queued_peer_count,
        "inFlightKeys": state.in_flight_keys,
        "feishu": assistant_channel_public_value(&state.feishu, &base_url, "/hooks/feishu/events"),
        "relay": assistant_channel_public_value(&state.relay, &base_url, "/hooks/channel/relay"),
        "weixin": assistant_channel_public_value(&state.weixin, &base_url, "/hooks/weixin/relay"),
        "knowledgeApi": assistant_channel_public_value(&state.knowledge_api, &base_url, "/api/knowledge"),
    })
}

pub(crate) fn emit_assistant_log(app: &AppHandle, line: &str) {
    let _ = app.emit(
        "assistant:daemon-log",
        json!({
            "at": now_iso(),
            "level": "info",
            "message": line,
        }),
    );
}

pub(crate) fn emit_assistant_status(app: &AppHandle, state: &AssistantStateRecord) {
    let _ = app.emit("assistant:daemon-status", assistant_state_value(state));
}

pub(crate) fn http_json_response(
    stream: &mut TcpStream,
    status_code: u16,
    status_text: &str,
    body: Value,
) -> Result<(), String> {
    let payload = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code,
        status_text,
        payload.len(),
        payload
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())
}

pub(crate) fn http_ok_json(stream: &mut TcpStream, body: Value) -> Result<(), String> {
    http_json_response(stream, 200, "OK", body)
}

pub(crate) fn parse_http_request_parts(raw: &str) -> (String, String) {
    let normalized = raw.replace("\r\n", "\n");
    let mut parts = normalized.splitn(2, "\n\n");
    let headers = parts.next().unwrap_or_default().to_string();
    let body = parts.next().unwrap_or_default().to_string();
    (headers, body)
}

pub(crate) fn parse_http_request_meta(
    raw_headers: &str,
) -> (String, String, HashMap<String, String>) {
    let mut lines = raw_headers.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("GET").to_string();
    let path = request_parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }
    (method, path, headers)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| index + 2)
        })
}

fn read_http_request(stream: &mut TcpStream, max_body_bytes: usize) -> Result<String, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut header_end = None;
    let mut content_length = 0_usize;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(bytes_read) => {
                buffer.extend_from_slice(&chunk[..bytes_read]);
                if header_end.is_none() {
                    header_end = find_header_end(&buffer);
                    if let Some(end) = header_end {
                        let raw_headers = String::from_utf8_lossy(&buffer[..end]).to_string();
                        let (_, _, headers) = parse_http_request_meta(raw_headers.trim_end());
                        content_length = headers
                            .get("content-length")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(0);
                        if content_length > max_body_bytes {
                            return Err(format!(
                                "HTTP body 超过限制: {} > {}",
                                content_length, max_body_bytes
                            ));
                        }
                    }
                }
                if let Some(end) = header_end {
                    if buffer.len() >= end + content_length {
                        break;
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if header_end.is_some() {
                    break;
                }
                return Err("HTTP request 读取超时".to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    String::from_utf8(buffer).map_err(|error| error.to_string())
}

pub(crate) fn assistant_session_id_for_route(route_kind: &str) -> String {
    format!(
        "assistant-session:{}",
        crate::slug_from_relative_path(route_kind)
    )
}

pub(crate) fn extract_assistant_prompt(
    route_kind: &str,
    body: &str,
) -> Result<Option<String>, String> {
    let parsed = serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({}));

    if let Some(challenge) = parsed.get("challenge").and_then(|value| value.as_str()) {
        return Ok(Some(challenge.to_string()));
    }

    let text = match route_kind {
        "feishu" => extract_feishu_prompt(&parsed),
        "weixin" => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("content").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("message").and_then(|value| value.as_str()))
            .map(ToString::to_string),
        "relay" => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("message").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("prompt").and_then(|value| value.as_str()))
            .map(ToString::to_string),
        _ => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("message").and_then(|value| value.as_str()))
            .map(ToString::to_string),
    };

    Ok(text
        .map(|value: String| value.trim().to_string())
        .filter(|value: &String| !value.is_empty()))
}

pub(crate) fn validate_assistant_request(
    route_kind: &str,
    headers: &HashMap<String, String>,
    body: &Value,
    assistant_state: &AssistantStateRecord,
) -> Result<Option<Value>, String> {
    match route_kind {
        "feishu" => {
            if body.get("encrypt").is_some() {
                return Err(
                    "Feishu 加密事件当前未实现解密，请先关闭 encrypt 或改走明文校验".to_string(),
                );
            }
            if let Some(expected) = assistant_state
                .feishu
                .get("verificationToken")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                let provided = body
                    .get("token")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if provided != expected {
                    return Err("Feishu verification token mismatch".to_string());
                }
            }
            if body.get("type").and_then(|value| value.as_str()) == Some("url_verification") {
                let challenge = body
                    .get("challenge")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                return Ok(Some(json!({ "challenge": challenge })));
            }
        }
        "relay" => {
            if let Some(expected) = assistant_state
                .relay
                .get("authToken")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                if extract_bearer_or_token(headers) != expected {
                    return Err("Relay auth token mismatch".to_string());
                }
            }
        }
        "weixin" => {
            if let Some(expected) = assistant_state
                .weixin
                .get("authToken")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                if extract_bearer_or_token(headers) != expected {
                    return Err("Weixin auth token mismatch".to_string());
                }
            }
        }
        _ => {}
    }
    Ok(None)
}

fn validate_knowledge_api_request(
    headers: &HashMap<String, String>,
    assistant_state: &AssistantStateRecord,
) -> Result<(), String> {
    let enabled = assistant_state
        .knowledge_api
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    if !enabled {
        return Err("Knowledge API 当前未启用".to_string());
    }
    if let Some(expected) = assistant_state
        .knowledge_api
        .get("authToken")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        if extract_bearer_or_token(headers) != expected {
            return Err("Knowledge API auth token mismatch".to_string());
        }
    }
    Ok(())
}

fn handle_knowledge_http_request(
    app: &AppHandle,
    assistant_state: &AssistantStateRecord,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<(u16, &'static str, Value), String> {
    validate_knowledge_api_request(headers, assistant_state)?;
    let base_path = knowledge_api_endpoint_path(assistant_state);
    let normalized_path = normalize_request_path(path);
    let subpath = normalized_path
        .strip_prefix(&base_path)
        .unwrap_or("")
        .trim_start_matches('/');
    let state = app.state::<AppState>();

    match (method, subpath) {
        ("GET", "") | ("GET", "health") => Ok((
            200,
            "OK",
            knowledge::knowledge_http_health(
                &state,
                knowledge::knowledge_http_body_limit(),
                knowledge::knowledge_http_batch_limit(),
            )?,
        )),
        ("POST", "entries") => {
            let request: knowledge::KnowledgeEntryIngestRequest = serde_json::from_str(body)
                .map_err(|error| format!("knowledge entry request 无法解析: {error}"))?;
            let response = knowledge::ingest_entry(Some(app), &state, &request)?;
            Ok((200, "OK", response))
        }
        ("POST", "document-sources") => {
            let request: knowledge::KnowledgeDocumentSourceIngestRequest =
                serde_json::from_str(body).map_err(|error| {
                    format!("knowledge document source request 无法解析: {error}")
                })?;
            let response = knowledge::ingest_document_source(Some(app), &state, &request)?;
            Ok((200, "OK", response))
        }
        ("POST", "batch-ingest") => {
            let request: knowledge::KnowledgeBatchIngestRequest = serde_json::from_str(body)
                .map_err(|error| format!("knowledge batch request 无法解析: {error}"))?;
            let response = knowledge::batch_ingest(Some(app), &state, &request)?;
            Ok((200, "OK", response))
        }
        _ => Ok((
            404,
            "Not Found",
            json!({
                "success": false,
                "error": "Knowledge API route not found",
                "path": normalized_path,
                "basePath": base_path,
            }),
        )),
    }
}

pub(crate) fn execute_assistant_message(
    app: &AppHandle,
    route_kind: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let assistant_snapshot = with_store(&state, |store| Ok(store.assistant_state.clone()))?;
    let parsed_body = serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({}));
    if let Some(response) =
        validate_assistant_request(route_kind, headers, &parsed_body, &assistant_snapshot)?
    {
        return Ok(response);
    }
    let prompt = extract_assistant_prompt(route_kind, body)?;
    let Some(prompt) = prompt else {
        return Ok(json!({
            "success": true,
            "message": "No actionable text found in request body.",
            "routeKind": route_kind
        }));
    };

    let session_id = assistant_session_id_for_route(route_kind);
    let turn = PreparedSessionAgentTurn::assistant_daemon(AssistantDaemonTurn::new(
        route_kind,
        session_id.clone(),
        prompt.clone(),
    ));
    let execution = execute_prepared_session_agent_turn(Some(app), &state, &turn)?;
    let delivery = if route_kind == "feishu" {
        Some(send_feishu_text_reply(
            &assistant_snapshot,
            &parsed_body,
            execution.response(),
        )?)
    } else {
        None
    };
    emit_assistant_log(
        app,
        &format!("assistant daemon completed {} request", route_kind),
    );
    Ok(json!({
        "success": true,
        "routeKind": route_kind,
        "reply": execution.response(),
        "sessionId": execution.session_id(),
        "delivery": delivery
    }))
}

pub(crate) fn run_assistant_listener(
    app: AppHandle,
    host: String,
    port: i64,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    let listener =
        TcpListener::bind(format!("{}:{}", host, port)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    emit_assistant_log(
        &app,
        &format!("assistant daemon listening on http://{}:{}", host, port),
    );
    let join = thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, addr)) => {
                    let request = match read_http_request(
                        &mut stream,
                        knowledge::knowledge_http_body_limit(),
                    ) {
                        Ok(request) => request,
                        Err(error) => {
                            emit_assistant_log(
                                &app,
                                &format!(
                                    "assistant daemon request read failed from {}: {}",
                                    addr, error
                                ),
                            );
                            let _ = http_json_response(
                                &mut stream,
                                400,
                                "Bad Request",
                                json!({ "success": false, "error": error }),
                            );
                            continue;
                        }
                    };
                    let first_line = request.lines().next().unwrap_or_default().to_string();
                    let path = first_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon request from {}: {}", addr, first_line),
                    );
                    let assistant_snapshot = with_store(&app.state::<AppState>(), |store| {
                        Ok(store.assistant_state.clone())
                    })
                    .unwrap_or_else(|_| AssistantStateRecord::default());
                    let (raw_headers, body) = parse_http_request_parts(&request);
                    let (method, _path, headers) = parse_http_request_meta(&raw_headers);
                    if is_knowledge_api_path(&path, &assistant_snapshot) {
                        emit_assistant_log(
                            &app,
                            "assistant daemon matched route kind: knowledge-api",
                        );
                        let response = match handle_knowledge_http_request(
                            &app,
                            &assistant_snapshot,
                            &method,
                            &path,
                            &headers,
                            &body,
                        ) {
                            Ok((status, status_text, body)) => {
                                http_json_response(&mut stream, status, status_text, body)
                            }
                            Err(error) => http_json_response(
                                &mut stream,
                                400,
                                "Bad Request",
                                json!({ "success": false, "error": error }),
                            ),
                        };
                        if let Err(error) = response {
                            emit_assistant_log(
                                &app,
                                &format!(
                                    "assistant daemon failed to write knowledge response: {}",
                                    error
                                ),
                            );
                        }
                        continue;
                    }
                    let route_kind = assistant_route_kind_for_path(&path, &assistant_snapshot);
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon matched route kind: {}", route_kind),
                    );
                    let result = execute_assistant_message(&app, route_kind, &headers, &body)
                        .unwrap_or_else(|error| {
                            json!({
                                "success": false,
                                "routeKind": route_kind,
                                "error": error
                            })
                        });
                    let _ = http_ok_json(
                        &mut stream,
                        json!({
                            "endpoint": first_line,
                            "path": path,
                            "routeKind": route_kind,
                            "result": result
                        }),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(200));
                }
                Err(error) => {
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon listener error: {}", error),
                    );
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }
        emit_assistant_log(&app, "assistant daemon stopped");
    });
    Ok(join)
}

pub(crate) fn spawn_weixin_sidecar(
    weixin: &Value,
) -> Result<Option<AssistantSidecarRuntime>, String> {
    let enabled = weixin
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let auto_start = weixin
        .get("autoStartSidecar")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let command = weixin
        .get("sidecarCommand")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if !enabled || !auto_start || command.is_none() {
        return Ok(None);
    }
    let command = command.unwrap();
    let args = weixin
        .get("sidecarArgs")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut child_command = std::process::Command::new(command);
    child_command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = weixin
        .get("sidecarCwd")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        child_command.current_dir(cwd);
    }
    if let Some(env) = weixin.get("sidecarEnv").and_then(|value| value.as_object()) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                child_command.env(key, value);
            }
        }
    }
    let child = child_command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    Ok(Some(AssistantSidecarRuntime { child, pid }))
}

pub(crate) fn stop_assistant_sidecar(state: &State<'_, AppState>) -> Result<Option<u32>, String> {
    let mut guard = state
        .assistant_sidecar
        .lock()
        .map_err(|_| "assistant sidecar lock 已损坏".to_string())?;
    if let Some(mut runtime) = guard.take() {
        let pid = runtime.pid;
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
        return Ok(Some(pid));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_assistant_state() -> AssistantStateRecord {
        AssistantStateRecord {
            enabled: true,
            auto_start: true,
            keep_alive_when_no_window: true,
            host: "127.0.0.1".to_string(),
            port: 31937,
            listening: true,
            lock_state: "owner".to_string(),
            blocked_by: None,
            last_error: None,
            active_task_count: 0,
            queued_peer_count: 0,
            in_flight_keys: Vec::new(),
            feishu: json!({
                "enabled": true,
                "receiveMode": "webhook",
                "endpointPath": "/custom/feishu",
                "replyUsingChatId": true,
                "webhookUrl": "",
                "websocketRunning": false
            }),
            relay: json!({
                "enabled": true,
                "endpointPath": "hooks/channel/custom-relay",
                "authToken": "",
                "webhookUrl": ""
            }),
            weixin: json!({
                "enabled": true,
                "endpointPath": "/hooks/weixin/custom",
                "authToken": "",
                "accountId": "",
                "autoStartSidecar": false,
                "cursorFile": "",
                "sidecarCommand": "",
                "sidecarArgs": [],
                "sidecarCwd": "",
                "sidecarEnv": {},
                "webhookUrl": "",
                "sidecarRunning": false,
                "connected": false,
                "stateDir": "",
                "availableAccountIds": []
            }),
            knowledge_api: json!({
                "enabled": true,
                "endpointPath": "/api/knowledge/custom",
                "authToken": "",
                "webhookUrl": ""
            }),
        }
    }

    #[test]
    fn assistant_state_value_populates_webhook_urls_from_runtime_host() {
        let value = assistant_state_value(&sample_assistant_state());
        assert_eq!(
            value
                .pointer("/feishu/webhookUrl")
                .and_then(|item| item.as_str()),
            Some("http://127.0.0.1:31937/custom/feishu")
        );
        assert_eq!(
            value
                .pointer("/relay/webhookUrl")
                .and_then(|item| item.as_str()),
            Some("http://127.0.0.1:31937/hooks/channel/custom-relay")
        );
        assert_eq!(
            value
                .pointer("/weixin/webhookUrl")
                .and_then(|item| item.as_str()),
            Some("http://127.0.0.1:31937/hooks/weixin/custom")
        );
        assert_eq!(
            value
                .pointer("/knowledgeApi/webhookUrl")
                .and_then(|item| item.as_str()),
            Some("http://127.0.0.1:31937/api/knowledge/custom")
        );
    }

    #[test]
    fn assistant_route_kind_for_path_uses_configured_endpoint_paths() {
        let state = sample_assistant_state();
        assert_eq!(
            assistant_route_kind_for_path("/custom/feishu?source=test", &state),
            "feishu"
        );
        assert_eq!(
            assistant_route_kind_for_path("/hooks/weixin/custom", &state),
            "weixin"
        );
        assert_eq!(
            assistant_route_kind_for_path("/hooks/channel/custom-relay", &state),
            "relay"
        );
        assert_eq!(
            assistant_route_kind_for_path("/hooks/feishu/events", &state),
            "generic"
        );
        assert!(is_knowledge_api_path(
            "/api/knowledge/custom/entries",
            &state
        ));
    }

    #[test]
    fn extract_assistant_prompt_reads_feishu_message_content_json() {
        let body = json!({
            "event": {
                "message": {
                    "content": "{\"text\":\"你好，助手\"}"
                }
            }
        });
        assert_eq!(
            extract_assistant_prompt("feishu", &body.to_string()).unwrap(),
            Some("你好，助手".to_string())
        );
    }

    #[test]
    fn validate_assistant_request_rejects_encrypted_feishu_events() {
        let headers = HashMap::new();
        let state = sample_assistant_state();
        let error = validate_assistant_request(
            "feishu",
            &headers,
            &json!({ "encrypt": "ciphertext" }),
            &state,
        )
        .unwrap_err();
        assert!(error.contains("Feishu 加密事件"));
    }
}
