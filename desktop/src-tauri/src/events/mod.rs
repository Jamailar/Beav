use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::persistence::try_with_store_mut;
use crate::runtime::{
    append_runtime_event, session_lineage_fields, RuntimeCheckpointPayload, RuntimeEventEnvelope,
    RuntimeSubagentEventPayload, RuntimeTaskNodeChangedPayload, RuntimeToolCallPayload,
    RuntimeToolOutputPayload, RuntimeToolResultPayload,
};
use crate::{append_debug_trace_state, now_i64, payload_field, payload_string, AppState};

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

fn emit_legacy_chat_compat_event<R: Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    session_id: Option<&str>,
    payload: &Value,
) {
    if !should_emit_legacy_chat_compat(session_id) {
        return;
    }
    match event_type {
        "stream_start" | "runtime:stream-start" => {
            let phase = payload_string(payload, "phase").unwrap_or_default();
            if phase.is_empty() {
                return;
            }
            let _ = app.emit("chat:phase-start", json!({ "name": phase }));
            if phase == "thinking" {
                let _ = app.emit("chat:thought-start", json!({}));
            }
        }
        "text_delta" | "runtime:text-delta" => {
            let stream =
                payload_string(payload, "stream").unwrap_or_else(|| "response".to_string());
            let content = payload_string(payload, "content").unwrap_or_default();
            let message_phase = payload_string(payload, "messagePhase")
                .unwrap_or_else(|| runtime_text_delta_message_phase(&stream).to_string());
            if content.is_empty() {
                return;
            }
            if stream == "thought" {
                let _ = app.emit(
                    "chat:thought-delta",
                    json!({ "content": content, "messagePhase": message_phase }),
                );
                let _ = app.emit(
                    "chat:thinking",
                    json!({ "content": content, "messagePhase": message_phase }),
                );
            } else {
                let _ = app.emit(
                    "chat:response-chunk",
                    json!({ "content": content, "messagePhase": message_phase }),
                );
            }
        }
        "tool_request" | "runtime:tool-start" => {
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
        "tool_result" | "runtime:tool-update" | "runtime:tool-end" => {
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
        "task_checkpoint_saved" | "runtime:checkpoint" => {
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
                "chat.skill_activated" => {
                    let _ = app.emit(
                        "chat:skill-activated",
                        json!({
                            "name": payload_string(&checkpoint_payload, "name").unwrap_or_default(),
                            "description": payload_string(&checkpoint_payload, "description").unwrap_or_default(),
                        }),
                    );
                }
                "chat.tool_confirm_request" => {
                    let _ = app.emit("chat:tool-confirm-request", checkpoint_payload);
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn log_runtime_event_emit<R: Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    session_id: Option<&str>,
    task_id: Option<&str>,
    payload: &Value,
) {
    let line = match event_type {
        "runtime:stream-start" => Some(format!(
            "[runtime][emit] event={} session={} task={} phase={} runtimeMode={}",
            event_type,
            session_id.unwrap_or(""),
            task_id.unwrap_or(""),
            payload_string(payload, "phase").unwrap_or_default(),
            payload_string(payload, "runtimeMode").unwrap_or_default(),
        )),
        "runtime:text-delta" => Some(format!(
            "[runtime][emit] event={} session={} task={} stream={} messagePhase={} content_chars={}",
            event_type,
            session_id.unwrap_or(""),
            task_id.unwrap_or(""),
            payload_string(payload, "stream").unwrap_or_else(|| "response".to_string()),
            payload_string(payload, "messagePhase").unwrap_or_default(),
            payload_string(payload, "content")
                .unwrap_or_default()
                .chars()
                .count(),
        )),
        "runtime:done" => Some(format!(
            "[runtime][emit] event={} session={} task={} status={} reason={} content_chars={}",
            event_type,
            session_id.unwrap_or(""),
            task_id.unwrap_or(""),
            payload_string(payload, "status").unwrap_or_default(),
            payload_string(payload, "reason").unwrap_or_default(),
            payload_string(payload, "content")
                .unwrap_or_default()
                .chars()
                .count(),
        )),
        "runtime:checkpoint" => {
            let checkpoint_type = payload_string(payload, "checkpointType").unwrap_or_default();
            if checkpoint_type.starts_with("chat.") {
                Some(format!(
                    "[runtime][emit] event={} session={} task={} checkpointType={} summary={} content_chars={}",
                    event_type,
                    session_id.unwrap_or(""),
                    task_id.unwrap_or(""),
                    checkpoint_type,
                    payload_string(payload, "summary").unwrap_or_default(),
                    payload
                        .get("payload")
                        .and_then(|value| value.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .count(),
                ))
            } else {
                None
            }
        }
        _ => None,
    };
    let Some(line) = line else {
        return;
    };
    let state = app.state::<AppState>();
    append_debug_trace_state(&state, line);
}

fn runtime_event_category(event_type: &str) -> &'static str {
    if event_type.starts_with("runtime:cli-") {
        "cli_runtime"
    } else if event_type.starts_with("runtime:collab-") {
        "team_runtime"
    } else {
        "chat_runtime"
    }
}

fn runtime_event_tool_call_id(payload: &Value) -> Option<String> {
    payload_string(payload, "callId")
        .or_else(|| payload_string(payload, "toolCallId"))
        .or_else(|| payload_string(payload, "tool_call_id"))
        .filter(|value| !value.trim().is_empty())
}

fn persist_runtime_event_record<R: Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    session_id: Option<&str>,
    task_id: Option<&str>,
    runtime_id: Option<&str>,
    parent_runtime_id: Option<&str>,
    payload: &Value,
) {
    let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let state = app.state::<AppState>();
    let _ = try_with_store_mut(&state, |store| {
        let (store_runtime_id, store_parent_runtime_id, source_task_id) =
            session_lineage_fields(store, session_id);
        append_runtime_event(
            store,
            runtime_event_category(event_type),
            event_type,
            Some(session_id.to_string()),
            runtime_id.map(ToString::to_string).or(store_runtime_id),
            parent_runtime_id
                .map(ToString::to_string)
                .or(store_parent_runtime_id),
            source_task_id,
            task_id.map(ToString::to_string),
            runtime_event_tool_call_id(payload),
            None,
            Some(payload.clone()),
        );
        Ok(())
    });
}

fn project_acp_runtime_event<R: Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    session_id: Option<&str>,
    payload: &Value,
) {
    let state = app.state::<AppState>();
    let _ = try_with_store_mut(&state, |store| {
        crate::project_runtime_event_to_acp_audit(store, event_type, session_id, payload);
        Ok(())
    });
}

pub fn emit_runtime_event<R: Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    session_id: Option<&str>,
    task_id: Option<&str>,
    payload: Value,
) {
    emit_runtime_event_with_lineage(app, event_type, session_id, task_id, None, None, payload);
}

pub fn emit_runtime_event_with_lineage<R: Runtime>(
    app: &AppHandle<R>,
    event_type: &str,
    session_id: Option<&str>,
    task_id: Option<&str>,
    runtime_id: Option<&str>,
    parent_runtime_id: Option<&str>,
    payload: Value,
) {
    let event_payload = payload.clone();
    persist_runtime_event_record(
        app,
        event_type,
        session_id,
        task_id,
        runtime_id,
        parent_runtime_id,
        &payload,
    );
    project_acp_runtime_event(app, event_type, session_id, &payload);
    let state = app.state::<AppState>();
    crate::analytics::observe_runtime_event(&state, event_type, &payload);
    let _ = app.emit(
        "runtime:event",
        RuntimeEventEnvelope::new(
            event_type,
            session_id,
            task_id,
            runtime_id,
            parent_runtime_id,
            event_payload,
        ),
    );
    log_runtime_event_emit(app, event_type, session_id, task_id, &payload);
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
        "runtime:stream-start",
        Some(session_id),
        None,
        json!({
            "phase": phase,
            "runtimeMode": runtime_mode,
        }),
    );
}

pub fn emit_runtime_text_delta(app: &AppHandle, session_id: &str, stream: &str, content: &str) {
    let message_phase = runtime_text_delta_message_phase(stream);
    emit_runtime_event(
        app,
        "runtime:text-delta",
        Some(session_id),
        None,
        json!({
            "stream": stream,
            "content": content,
            "messagePhase": message_phase,
        }),
    );
}

fn runtime_text_delta_message_phase(stream: &str) -> &'static str {
    if stream == "thought" {
        "thought"
    } else {
        "final_answer"
    }
}

pub fn split_stream_chunks(content: &str, max_chars: usize) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0usize;
    for ch in content.chars() {
        current.push(ch);
        count += 1;
        let boundary = ch == '\n' || ch == '。' || ch == '！' || ch == '？';
        if count >= max_chars && boundary {
            chunks.push(current.clone());
            current.clear();
            count = 0;
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn emit_chat_sequence(
    app: &AppHandle,
    session_id: &str,
    response: &str,
    thought: &str,
    runtime_mode: &str,
    title_update: Option<(String, String)>,
) {
    emit_runtime_stream_start(app, session_id, "thinking", Some(runtime_mode));
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        Some(session_id),
        "chat.plan_updated",
        "plan updated",
        Some(json!({ "steps": [] })),
    );
    if !thought.trim().is_empty() {
        emit_runtime_text_delta(app, session_id, "thought", thought);
    }
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        Some(session_id),
        "chat.thought_end",
        "thought stream completed",
        None,
    );
    emit_runtime_stream_start(app, session_id, "responding", Some(runtime_mode));
    for chunk in split_stream_chunks(response, 160) {
        emit_runtime_text_delta(app, session_id, "response", &chunk);
    }
    if let Some((sid, title)) = title_update {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(&sid),
            "chat.session_title_updated",
            "session title updated",
            Some(json!({ "sessionId": sid.clone(), "title": title.clone() })),
        );
    }
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        Some(session_id),
        "chat.response_end",
        "chat response completed",
        Some(json!({ "content": response })),
    );
    emit_runtime_done(
        app,
        session_id,
        "completed",
        Some(runtime_mode),
        Some(response),
        Some("response_end"),
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
    let display_input = summarize_large_tool_input(input);
    let legacy_input = display_input.clone();
    emit_runtime_event(
        app,
        "runtime:tool-start",
        session_id,
        None,
        serde_json::to_value(RuntimeToolCallPayload::new(
            call_id,
            name,
            display_input,
            description.unwrap_or(""),
        ))
        .unwrap_or_else(|_| {
            json!({
                "callId": call_id,
                "name": name,
                "input": legacy_input,
                "description": description.unwrap_or(""),
            })
        }),
    );
}

const TOOL_EVENT_STRING_PREVIEW_LIMIT: usize = 1200;

fn summarize_large_tool_input(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(summarize_large_tool_input)
                .collect::<Vec<_>>(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    if key == "content" {
                        (key, summarize_large_content_value(value))
                    } else {
                        (key, summarize_large_tool_input(value))
                    }
                })
                .collect(),
        ),
        other => other,
    }
}

fn summarize_large_content_value(value: Value) -> Value {
    let Value::String(text) = value else {
        return summarize_large_tool_input(value);
    };
    let chars = text.chars().count();
    if chars <= TOOL_EVENT_STRING_PREVIEW_LIMIT {
        return Value::String(text);
    }
    let preview = text
        .chars()
        .take(TOOL_EVENT_STRING_PREVIEW_LIMIT)
        .collect::<String>();
    json!({
        "omitted": true,
        "reason": "large_tool_content",
        "chars": chars,
        "preview": preview,
    })
}

pub fn emit_runtime_done(
    app: &AppHandle,
    session_id: &str,
    status: &str,
    runtime_mode: Option<&str>,
    content: Option<&str>,
    reason: Option<&str>,
) {
    emit_runtime_event(
        app,
        "runtime:done",
        Some(session_id),
        None,
        json!({
            "status": status,
            "runtimeMode": runtime_mode,
            "content": content,
            "reason": reason,
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
        "runtime:tool-end",
        session_id,
        None,
        serde_json::to_value(RuntimeToolResultPayload::new(
            call_id,
            name,
            RuntimeToolOutputPayload::final_result(success, content),
        ))
        .unwrap_or_else(|_| {
            json!({
                "callId": call_id,
                "name": name,
                "output": {
                    "success": success,
                    "content": content,
                },
            })
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
        "runtime:tool-update",
        session_id,
        None,
        serde_json::to_value(RuntimeToolResultPayload::new(
            call_id,
            name,
            RuntimeToolOutputPayload::partial(partial),
        ))
        .unwrap_or_else(|_| {
            json!({
                "callId": call_id,
                "name": name,
                "output": {
                    "success": true,
                    "content": partial,
                    "partial": true,
                },
            })
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
        "runtime:task-node-changed",
        session_id,
        Some(task_id),
        serde_json::to_value(RuntimeTaskNodeChangedPayload::new(
            node_id, status, summary, error,
        ))
        .unwrap_or_else(|_| {
            json!({
                "nodeId": node_id,
                "status": status,
                "summary": summary,
                "error": error,
            })
        }),
    );
}

pub fn emit_runtime_subagent_spawned(
    app: &AppHandle,
    task_id: Option<&str>,
    session_id: Option<&str>,
    role_id: &str,
    runtime_mode: &str,
    child_runtime_id: Option<&str>,
    child_task_id: Option<&str>,
    child_session_id: Option<&str>,
    parent_runtime_id: Option<&str>,
) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:subagent-started",
        session_id,
        task_id,
        child_runtime_id,
        parent_runtime_id,
        serde_json::to_value(RuntimeSubagentEventPayload::new(
            role_id,
            runtime_mode,
            child_runtime_id,
            child_task_id,
            child_session_id,
            task_id,
        ))
        .unwrap_or_else(|_| {
            json!({
                "roleId": role_id,
                "runtimeMode": runtime_mode,
                "childRuntimeId": child_runtime_id,
                "childTaskId": child_task_id,
                "childSessionId": child_session_id,
                "parentTaskId": task_id,
            })
        }),
    );
}

pub fn emit_runtime_subagent_finished(
    app: &AppHandle,
    task_id: Option<&str>,
    session_id: Option<&str>,
    role_id: &str,
    runtime_mode: &str,
    child_runtime_id: Option<&str>,
    child_task_id: Option<&str>,
    child_session_id: Option<&str>,
    parent_runtime_id: Option<&str>,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
) {
    emit_runtime_event_with_lineage(
        app,
        "runtime:subagent-finished",
        session_id,
        task_id,
        child_runtime_id,
        parent_runtime_id,
        serde_json::to_value(
            RuntimeSubagentEventPayload::new(
                role_id,
                runtime_mode,
                child_runtime_id,
                child_task_id,
                child_session_id,
                task_id,
            )
            .with_result(status, summary, error),
        )
        .unwrap_or_else(|_| {
            json!({
                "roleId": role_id,
                "runtimeMode": runtime_mode,
                "childRuntimeId": child_runtime_id,
                "childTaskId": child_task_id,
                "childSessionId": child_session_id,
                "parentTaskId": task_id,
                "status": status,
                "summary": summary,
                "error": error,
            })
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
    let legacy_payload = payload.clone();
    emit_runtime_event(
        app,
        "runtime:checkpoint",
        session_id,
        task_id,
        serde_json::to_value(RuntimeCheckpointPayload::new(
            checkpoint_type,
            summary,
            payload,
        ))
        .unwrap_or_else(|_| {
            json!({
                "checkpointType": checkpoint_type,
                "summary": summary,
                "payload": legacy_payload,
            })
        }),
    );
}

pub fn emit_manuscript_write_proposal_changed(
    app: &AppHandle,
    file_path: &str,
    proposal: Option<Value>,
) {
    let _ = app.emit(
        "manuscripts:write-proposal",
        json!({
            "filePath": file_path,
            "proposal": proposal,
            "timestamp": now_i64(),
        }),
    );
}

pub fn emit_manuscripts_changed(app: &AppHandle, action: &str, file_path: &str) {
    let _ = app.emit(
        "data:changed",
        json!({
            "scope": "manuscripts",
            "action": action,
            "filePath": file_path,
            "entityId": file_path,
            "timestamp": now_i64(),
        }),
    );
}

pub fn emit_redclaw_task_event(
    app: &AppHandle,
    event_type: &str,
    task_id: &str,
    task_name: &str,
    task_kind: &str,
    result: Option<&str>,
    summary: Option<&str>,
    session_id: Option<&str>,
    execution_id: Option<&str>,
    artifact_count: usize,
) {
    let _ = app.emit(
        "redclaw:task-event",
        json!({
            "eventType": event_type,
            "taskId": task_id,
            "taskName": task_name,
            "taskKind": task_kind,
            "result": result,
            "summary": summary,
            "sessionId": session_id,
            "executionId": execution_id,
            "artifactCount": artifact_count,
            "createdAt": crate::now_iso(),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_large_tool_input_replaces_large_content_fields() {
        let value = summarize_large_tool_input(json!({
            "path": "manuscripts://current",
            "content": "x".repeat(TOOL_EVENT_STRING_PREVIEW_LIMIT + 1),
        }));

        assert_eq!(
            value.get("path").and_then(Value::as_str),
            Some("manuscripts://current")
        );
        let content = value.get("content").expect("content summary should exist");
        assert_eq!(
            content.get("reason").and_then(Value::as_str),
            Some("large_tool_content")
        );
        assert_eq!(
            content.get("chars").and_then(Value::as_u64),
            Some((TOOL_EVENT_STRING_PREVIEW_LIMIT + 1) as u64)
        );
    }

    #[test]
    fn summarize_large_tool_input_keeps_short_content_fields() {
        let value = summarize_large_tool_input(json!({
            "content": "short",
        }));

        assert_eq!(value.get("content").and_then(Value::as_str), Some("short"));
    }
}
