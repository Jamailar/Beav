use serde_json::Value;

use crate::{payload_string, AcpAuditEventRecord, AppStore};

use super::make_acp_id;

pub(crate) struct AcpEventsPage {
    pub(crate) events: Vec<AcpAuditEventRecord>,
    pub(crate) next_cursor: Option<String>,
    pub(crate) has_more: bool,
}

pub(crate) fn append_acp_audit_event(
    store: &mut AppStore,
    session_id: Option<String>,
    run_id: Option<String>,
    event_type: &str,
    status: &str,
    message: Option<String>,
    payload: Option<Value>,
) -> AcpAuditEventRecord {
    let event = AcpAuditEventRecord {
        id: make_acp_id("acp-event"),
        session_id,
        run_id,
        event_type: event_type.to_string(),
        status: status.to_string(),
        message,
        payload,
        created_at: crate::now_i64(),
    };
    store.acp_audit_events.push(event.clone());
    if store.acp_audit_events.len() > 2_000 {
        let remove_count = store.acp_audit_events.len().saturating_sub(2_000);
        store.acp_audit_events.drain(0..remove_count);
    }
    event
}

fn paged_events(
    events: Vec<AcpAuditEventRecord>,
    cursor: Option<&str>,
    limit: usize,
) -> AcpEventsPage {
    let start_index = cursor
        .and_then(|cursor| events.iter().position(|event| event.id == cursor))
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut page = events
        .into_iter()
        .skip(start_index)
        .take(limit.saturating_add(1))
        .collect::<Vec<_>>();
    let has_more = page.len() > limit;
    if has_more {
        page.truncate(limit);
    }
    let next_cursor = if has_more {
        page.last().map(|event| event.id.clone())
    } else {
        None
    };
    AcpEventsPage {
        events: page,
        next_cursor,
        has_more,
    }
}

pub(crate) fn acp_events_page_for_run(
    store: &AppStore,
    run_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> AcpEventsPage {
    let events = store
        .acp_audit_events
        .iter()
        .filter(|event| event.run_id.as_deref() == Some(run_id))
        .cloned()
        .collect();
    paged_events(events, cursor, limit)
}

pub(crate) fn acp_events_page_for_session(
    store: &AppStore,
    session_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> AcpEventsPage {
    let events = store
        .acp_audit_events
        .iter()
        .filter(|event| event.session_id.as_deref() == Some(session_id))
        .cloned()
        .collect();
    paged_events(events, cursor, limit)
}

fn should_project_runtime_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "runtime:stream-start"
            | "runtime:tool-start"
            | "runtime:tool-end"
            | "runtime:checkpoint"
            | "runtime:done"
    )
}

fn runtime_event_status(event_type: &str, payload: &Value) -> &'static str {
    match event_type {
        "runtime:done" => match payload_string(payload, "status").as_deref() {
            Some("failed") | Some("error") => "failed",
            Some("cancelled") => "cancelled",
            _ => "ok",
        },
        "runtime:tool-end" => {
            let success = payload
                .get("output")
                .and_then(|value| value.get("success"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if success {
                "ok"
            } else {
                "failed"
            }
        }
        _ => "ok",
    }
}

fn runtime_event_message(event_type: &str, payload: &Value) -> String {
    match event_type {
        "runtime:stream-start" => format!(
            "Runtime stream started: {}.",
            payload_string(payload, "phase").unwrap_or_else(|| "unknown".to_string())
        ),
        "runtime:tool-start" => format!(
            "Runtime tool started: {}.",
            payload_string(payload, "name").unwrap_or_else(|| "tool".to_string())
        ),
        "runtime:tool-end" => format!(
            "Runtime tool finished: {}.",
            payload_string(payload, "name").unwrap_or_else(|| "tool".to_string())
        ),
        "runtime:checkpoint" => payload_string(payload, "summary")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                format!(
                    "Runtime checkpoint: {}.",
                    payload_string(payload, "checkpointType")
                        .unwrap_or_else(|| "checkpoint".to_string())
                )
            }),
        "runtime:done" => format!(
            "Runtime completed with status {}.",
            payload_string(payload, "status").unwrap_or_else(|| "completed".to_string())
        ),
        _ => event_type.to_string(),
    }
}

fn runtime_event_projection_payload(event_type: &str, payload: &Value) -> Value {
    let content_chars = payload_string(payload, "content").map(|value| value.chars().count());
    serde_json::json!({
        "runtimeEventType": event_type,
        "phase": payload_string(payload, "phase"),
        "name": payload_string(payload, "name"),
        "status": payload_string(payload, "status"),
        "reason": payload_string(payload, "reason"),
        "checkpointType": payload_string(payload, "checkpointType"),
        "summary": payload_string(payload, "summary"),
        "contentChars": content_chars,
        "callId": payload_string(payload, "callId")
    })
}

pub(crate) fn project_runtime_event_to_acp_audit(
    store: &mut AppStore,
    event_type: &str,
    session_id: Option<&str>,
    payload: &Value,
) -> bool {
    if !should_project_runtime_event(event_type) {
        return false;
    }
    let Some(chat_session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some(acp_session) = store
        .acp_sessions
        .iter()
        .find(|session| session.chat_session_id == chat_session_id)
        .cloned()
    else {
        return false;
    };
    let run = store
        .acp_runs
        .iter()
        .rev()
        .find(|run| {
            run.session_id == acp_session.id && matches!(run.status.as_str(), "queued" | "running")
        })
        .cloned()
        .or_else(|| {
            store
                .acp_runs
                .iter()
                .rev()
                .find(|run| run.session_id == acp_session.id)
                .cloned()
        });
    let Some(run) = run else {
        return false;
    };
    append_acp_audit_event(
        store,
        Some(acp_session.id),
        Some(run.id),
        "acp.runtime.event",
        runtime_event_status(event_type, payload),
        Some(runtime_event_message(event_type, payload)),
        Some(runtime_event_projection_payload(event_type, payload)),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AcpRunRecord, AcpSessionRecord};
    use serde_json::json;

    #[test]
    fn events_page_uses_cursor_and_reports_has_more() {
        let mut store = crate::persistence::default_store();
        for index in 0..3 {
            append_acp_audit_event(
                &mut store,
                Some("acp-session-1".to_string()),
                Some("acp-run-1".to_string()),
                "acp.test",
                "ok",
                Some(format!("event {index}")),
                None,
            );
        }

        let first = acp_events_page_for_run(&store, "acp-run-1", None, 2);
        assert_eq!(first.events.len(), 2);
        assert!(first.has_more);
        let cursor = first.next_cursor.expect("first page should provide cursor");

        let second = acp_events_page_for_run(&store, "acp-run-1", Some(&cursor), 2);
        assert_eq!(second.events.len(), 1);
        assert!(!second.has_more);
    }

    #[test]
    fn runtime_milestones_project_to_active_acp_run() {
        let mut store = crate::persistence::default_store();
        store.acp_sessions.push(AcpSessionRecord {
            id: "acp-session-1".to_string(),
            chat_session_id: "chat-1".to_string(),
            collab_session_id: "collab-1".to_string(),
            source_label: "ACP: Codex".to_string(),
            ..Default::default()
        });
        store.acp_runs.push(AcpRunRecord {
            id: "acp-run-1".to_string(),
            session_id: "acp-session-1".to_string(),
            chat_session_id: "chat-1".to_string(),
            collab_session_id: "collab-1".to_string(),
            status: "running".to_string(),
            ..Default::default()
        });

        let projected = project_runtime_event_to_acp_audit(
            &mut store,
            "runtime:stream-start",
            Some("chat-1"),
            &json!({ "phase": "responding" }),
        );

        assert!(projected);
        let event = store.acp_audit_events.last().unwrap();
        assert_eq!(event.event_type, "acp.runtime.event");
        assert_eq!(event.run_id.as_deref(), Some("acp-run-1"));
        assert_eq!(event.payload.as_ref().unwrap()["phase"], "responding");
    }
}
