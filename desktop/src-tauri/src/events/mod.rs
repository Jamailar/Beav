use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{now_i64, payload_field, payload_string};

fn should_emit_legacy_chat_compat(session_id: Option<&str>) -> bool {
    let Some(id) = session_id else {
        return false;
    };
    let normalized = id.trim();
    if normalized.is_empty() {
        return false;
    }
    !normalized.starts_with("session_wander_")
}

fn emit_legacy_chat_compat_event(
    app: &AppHandle,
    event_type: &str,
    session_id: Option<&str>,
    payload: &Value,
) {
    if !should_emit_legacy_chat_compat(session_id) {
        return;
    }
    match event_type {
        "stream_start" => {
            let phase = payload_string(payload, "phase").unwrap_or_default();
            if phase.is_empty() {
                return;
            }
            let _ = app.emit("chat:phase-start", json!({ "name": phase }));
            if phase == "thinking" {
                let _ = app.emit("chat:thought-start", json!({}));
            }
        }
        "text_delta" => {
            let stream =
                payload_string(payload, "stream").unwrap_or_else(|| "response".to_string());
            let content = payload_string(payload, "content").unwrap_or_default();
            if content.is_empty() {
                return;
            }
            if stream == "thought" {
                let _ = app.emit("chat:thought-delta", json!({ "content": content }));
                let _ = app.emit("chat:thinking", json!({ "content": content }));
            } else {
                let _ = app.emit("chat:response-chunk", json!({ "content": content }));
            }
        }
        "tool_request" => {
            let _ = app.emit(
                "chat:tool-start",
                json!({
                    "callId": payload_string(payload, "callId").unwrap_or_default(),
                    "name": payload_string(payload, "name").unwrap_or_default(),
                    "input": payload_field(payload, "input").cloned().unwrap_or_else(|| json!({})),
                    "description": payload_string(payload, "description").unwrap_or_default(),
                }),
            );
        }
        "tool_result" => {
            let call_id = payload_string(payload, "callId").unwrap_or_default();
            let name = payload_string(payload, "name").unwrap_or_default();
            let output = payload_field(payload, "output")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let partial = payload_field(&output, "partial")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let content = payload_string(&output, "content").unwrap_or_default();
            if partial {
                let _ = app.emit(
                    "chat:tool-update",
                    json!({
                        "callId": call_id,
                        "name": name,
                        "partial": content,
                    }),
                );
            } else {
                let _ = app.emit(
                    "chat:tool-end",
                    json!({
                        "callId": call_id,
                        "name": name,
                        "output": output,
                    }),
                );
            }
        }
        "task_checkpoint_saved" => {
            let checkpoint_type = payload_string(payload, "checkpointType").unwrap_or_default();
            let checkpoint_payload = payload_field(payload, "payload")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match checkpoint_type.as_str() {
                "chat.plan_updated" => {
                    let _ = app.emit(
                        "chat:plan-updated",
                        json!({
                            "steps": payload_field(&checkpoint_payload, "steps")
                                .cloned()
                                .unwrap_or_else(|| json!([])),
                        }),
                    );
                }
                "chat.thought_end" => {
                    let _ = app.emit("chat:thought-end", json!({}));
                }
                "chat.response_end" => {
                    let _ = app.emit(
                        "chat:response-end",
                        json!({
                            "content": payload_string(&checkpoint_payload, "content").unwrap_or_default()
                        }),
                    );
                }
                "chat.error" => {
                    let _ = app.emit("chat:error", checkpoint_payload);
                }
                "chat.session_title_updated" => {
                    let session_from_payload = payload_string(&checkpoint_payload, "sessionId");
                    let title = payload_string(&checkpoint_payload, "title").unwrap_or_default();
                    let _ = app.emit(
                        "chat:session-title-updated",
                        json!({
                            "sessionId": session_from_payload
                                .or_else(|| session_id.map(ToString::to_string))
                                .unwrap_or_default(),
                            "title": title,
                        }),
                    );
                }
                _ => {}
            }
        }
        _ => {}
    }
}

pub fn emit_runtime_event(
    app: &AppHandle,
    event_type: &str,
    session_id: Option<&str>,
    task_id: Option<&str>,
    payload: Value,
) {
    let _ = app.emit(
        "runtime:event",
        json!({
            "eventType": event_type,
            "sessionId": session_id,
            "taskId": task_id,
            "payload": payload,
            "timestamp": now_i64(),
        }),
    );
    emit_legacy_chat_compat_event(app, event_type, session_id, &payload);
}

pub fn emit_runtime_stream_start(
    app: &AppHandle,
    session_id: &str,
    phase: &str,
    runtime_mode: Option<&str>,
) {
    emit_runtime_event(
        app,
        "stream_start",
        Some(session_id),
        None,
        json!({
            "phase": phase,
            "runtimeMode": runtime_mode,
        }),
    );
}

pub fn emit_runtime_text_delta(app: &AppHandle, session_id: &str, stream: &str, content: &str) {
    emit_runtime_event(
        app,
        "text_delta",
        Some(session_id),
        None,
        json!({
            "stream": stream,
            "content": content,
        }),
    );
}

pub fn emit_runtime_tool_request(
    app: &AppHandle,
    session_id: Option<&str>,
    call_id: &str,
    name: &str,
    input: Value,
    description: Option<&str>,
) {
    emit_runtime_event(
        app,
        "tool_request",
        session_id,
        None,
        json!({
            "callId": call_id,
            "name": name,
            "input": input,
            "description": description.unwrap_or(""),
        }),
    );
}

pub fn emit_runtime_tool_result(
    app: &AppHandle,
    session_id: Option<&str>,
    call_id: &str,
    name: &str,
    success: bool,
    content: &str,
) {
    emit_runtime_event(
        app,
        "tool_result",
        session_id,
        None,
        json!({
            "callId": call_id,
            "name": name,
            "output": {
                "success": success,
                "content": content,
            },
        }),
    );
}

pub fn emit_runtime_tool_partial(
    app: &AppHandle,
    session_id: Option<&str>,
    call_id: &str,
    name: &str,
    partial: &str,
) {
    emit_runtime_event(
        app,
        "tool_result",
        session_id,
        None,
        json!({
            "callId": call_id,
            "name": name,
            "output": {
                "success": true,
                "content": partial,
                "partial": true,
            },
        }),
    );
}

pub fn emit_runtime_task_node_changed(
    app: &AppHandle,
    task_id: &str,
    session_id: Option<&str>,
    node_id: &str,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
) {
    emit_runtime_event(
        app,
        "task_node_changed",
        session_id,
        Some(task_id),
        json!({
            "nodeId": node_id,
            "status": status,
            "summary": summary,
            "error": error,
        }),
    );
}

pub fn emit_runtime_subagent_spawned(
    app: &AppHandle,
    task_id: Option<&str>,
    session_id: Option<&str>,
    role_id: &str,
    runtime_mode: &str,
) {
    emit_runtime_event(
        app,
        "subagent_spawned",
        session_id,
        task_id,
        json!({
            "roleId": role_id,
            "runtimeMode": runtime_mode,
        }),
    );
}

pub fn emit_runtime_task_checkpoint_saved(
    app: &AppHandle,
    task_id: Option<&str>,
    session_id: Option<&str>,
    checkpoint_type: &str,
    summary: &str,
    payload: Option<Value>,
) {
    emit_runtime_event(
        app,
        "task_checkpoint_saved",
        session_id,
        task_id,
        json!({
            "checkpointType": checkpoint_type,
            "summary": summary,
            "payload": payload,
        }),
    );
}
