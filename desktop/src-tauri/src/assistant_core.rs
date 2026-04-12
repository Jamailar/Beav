use serde_json::{json, Value};
use crate::agent::{execute_prepared_session_agent_turn, AssistantDaemonTurn, PreparedSessionAgentTurn};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    now_iso, with_store, AppState, AssistantSidecarRuntime, AssistantStateRecord,
};

pub(crate) fn value_to_i64_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|item| {
        item.as_i64()
            .map(|number| number.to_string())
            .or_else(|| item.as_str().map(ToString::to_string))
    })
}

pub(crate) fn assistant_state_value(state: &AssistantStateRecord) -> Value {
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
        "feishu": state.feishu,
        "relay": state.relay,
        "weixin": state.weixin,
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

pub(crate) fn http_ok_json(stream: &mut TcpStream, body: Value) -> Result<(), String> {
    let payload = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())
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
        "feishu" => parsed
            .pointer("/event/text")
            .and_then(|value| value.as_str())
            .or_else(|| {
                parsed
                    .pointer("/event/message/content")
                    .and_then(|value| value.as_str())
            })
            .or_else(|| parsed.get("text").and_then(|value| value.as_str())),
        "weixin" => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("content").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("message").and_then(|value| value.as_str())),
        "relay" => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("message").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("prompt").and_then(|value| value.as_str())),
        _ => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("message").and_then(|value| value.as_str())),
    };

    Ok(text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

pub(crate) fn validate_assistant_request(
    route_kind: &str,
    headers: &HashMap<String, String>,
    body: &Value,
    assistant_state: &AssistantStateRecord,
) -> Result<Option<Value>, String> {
    match route_kind {
        "feishu" => {
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
                let auth = headers
                    .get("authorization")
                    .or_else(|| headers.get("x-auth-token"))
                    .cloned()
                    .unwrap_or_default();
                let normalized = auth.strip_prefix("Bearer ").unwrap_or(&auth);
                if normalized.trim() != expected {
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
                let auth = headers
                    .get("authorization")
                    .or_else(|| headers.get("x-auth-token"))
                    .cloned()
                    .unwrap_or_default();
                let normalized = auth.strip_prefix("Bearer ").unwrap_or(&auth);
                if normalized.trim() != expected {
                    return Err("Weixin auth token mismatch".to_string());
                }
            }
        }
        _ => {}
    }
    Ok(None)
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
    emit_assistant_log(
        app,
        &format!("assistant daemon completed {} request", route_kind),
    );
    Ok(json!({
        "success": true,
        "routeKind": route_kind,
        "reply": execution.response(),
        "sessionId": execution.session_id()
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
                    let mut buffer = [0_u8; 4096];
                    let _ = stream.read(&mut buffer);
                    let request = String::from_utf8_lossy(&buffer);
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
                    let route_kind = if path.contains("/hooks/feishu/") {
                        "feishu"
                    } else if path.contains("/hooks/weixin/") {
                        "weixin"
                    } else if path.contains("/hooks/channel/relay") {
                        "relay"
                    } else {
                        "generic"
                    };
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon matched route kind: {}", route_kind),
                    );
                    let (raw_headers, body) = parse_http_request_parts(&request);
                    let (_method, _path, headers) = parse_http_request_meta(&raw_headers);
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
                    thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(error) => {
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon listener error: {}", error),
                    );
                    thread::sleep(std::time::Duration::from_millis(500));
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
