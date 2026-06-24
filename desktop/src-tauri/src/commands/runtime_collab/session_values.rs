use super::{emit_collab_event, payload_limit};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    collab_session_snapshot, create_collab_session, ensure_collab_session_coordinator,
    list_collab_sessions, update_collab_session_status,
};
use crate::subagents::tick_team_wake_runtime;
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn list_sessions_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let sessions = list_collab_sessions(&store)
            .into_iter()
            .filter(|session| {
                let source = session.source.trim();
                let metadata_source = session
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("source"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                source != "acp" && metadata_source != "acp"
            })
            .collect::<Vec<_>>();
        Ok(json!(sessions))
    })
}

pub fn create_session_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let (session, coordinator) = with_store_mut(state, |store| {
        let session = create_collab_session(store, payload)?;
        let runtime_mode = session.runtime_mode.trim().to_ascii_lowercase();
        let source = session.source.trim().to_ascii_lowercase();
        if runtime_mode == "team" || source == "team-workbench" {
            let (session, member, created) = ensure_collab_session_coordinator(store, &session.id)?;
            Ok((session, created.then_some(member)))
        } else {
            Ok((session, None))
        }
    })?;
    if let Some(member) = coordinator {
        emit_collab_event(
            app,
            "runtime:collab-member-changed",
            None,
            json!({ "collabSessionId": member.session_id, "member": member }),
        );
    }
    emit_collab_event(
        app,
        "runtime:collab-session-changed",
        session.owner_session_id.as_deref(),
        json!({ "collabSessionId": session.id, "session": session }),
    );
    Ok(json!(session))
}

pub fn session_snapshot_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let mailbox_limit = payload_limit(payload, "mailboxLimit");
    let report_limit = payload_limit(payload, "reportLimit");
    with_store(state, |store| {
        collab_session_snapshot(&store, &session_id, mailbox_limit, report_limit)
            .map(|snapshot| json!(snapshot))
            .ok_or_else(|| "协作会话不存在".to_string())
    })
}

pub fn update_session_status_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    status: &str,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let session = with_store_mut(state, |store| {
        update_collab_session_status(store, &session_id, status)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-session-changed",
        session.owner_session_id.as_deref(),
        json!({ "collabSessionId": session.id, "session": session }),
    );
    Ok(json!(session))
}

pub fn tick_reports_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let outcome = with_store_mut(state, |store| tick_team_wake_runtime(store, &session_id))?;
    emit_collab_event(
        app,
        "runtime:collab-report-tick",
        None,
        json!({ "collabSessionId": session_id, "outcome": outcome }),
    );
    Ok(json!(outcome))
}
