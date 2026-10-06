use super::{emit_collab_event, payload_limit};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    list_collab_messages, list_collab_reports, post_collab_message, read_collab_mailbox,
    request_collab_report, submit_collab_report,
};
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn list_messages_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = payload_string(payload, "memberId");
    let task_id = payload_string(payload, "taskId");
    let unread_only = payload
        .get("unreadOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let limit = payload_limit(payload, "limit");
    with_store(state, |store| {
        Ok(json!(list_collab_messages(
            &store,
            &session_id,
            member_id.as_deref(),
            task_id.as_deref(),
            unread_only,
            limit,
        )))
    })
}

pub fn read_mailbox_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    with_store_mut(state, |store| {
        Ok(json!(read_collab_mailbox(store, payload)?))
    })
}

pub fn list_reports_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let task_id = payload_string(payload, "taskId");
    let member_id = payload_string(payload, "memberId");
    let limit = payload_limit(payload, "limit");
    with_store(state, |store| {
        Ok(json!(list_collab_reports(
            &store,
            &session_id,
            task_id.as_deref(),
            member_id.as_deref(),
            limit,
        )))
    })
}

pub fn post_message_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let message = with_store_mut(state, |store| post_collab_message(store, payload))?;
    super::schedule_message_target_wake(app, state, &message, "mailbox_message");
    emit_collab_event(
        app,
        "runtime:collab-message-delivered",
        None,
        json!({ "collabSessionId": message.session_id, "message": message }),
    );
    Ok(json!(message))
}

pub fn request_report_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let message = with_store_mut(state, |store| request_collab_report(store, payload))?;
    super::schedule_message_target_wake(app, state, &message, "report_request");
    emit_collab_event(
        app,
        "runtime:collab-message-delivered",
        None,
        json!({ "collabSessionId": message.session_id, "message": message }),
    );
    Ok(json!(message))
}

pub fn submit_report_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let report = with_store_mut(state, |store| submit_collab_report(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-report-submitted",
        None,
        json!({ "collabSessionId": report.session_id, "report": report }),
    );
    Ok(json!(report))
}
