use super::emit_collab_event;
use crate::commands::chat_state::request_chat_runtime_cancel;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, list_collab_members, rename_collab_member, resume_collab_member,
    set_collab_session_coordinator, shutdown_collab_member,
};
use crate::{now_i64, payload_string, AppState};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, State};

pub fn list_members_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    with_store(state, |store| {
        Ok(json!(list_collab_members(&store, &session_id)))
    })
}

pub fn add_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| add_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!(member))
}

pub fn set_session_coordinator_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session = with_store_mut(state, |store| {
        set_collab_session_coordinator(store, payload)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-session-changed",
        session.owner_session_id.as_deref(),
        json!({ "collabSessionId": session.id, "session": session }),
    );
    Ok(json!(session))
}

pub fn rename_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| rename_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!(member))
}

pub fn shutdown_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| shutdown_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!(member))
}

pub fn interrupt_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id =
        payload_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    let reason = payload_string(payload, "reason")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "interrupted".to_string());
    let requested_status = payload_string(payload, "status")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "failed".to_string());
    let active_wake = member_wake_is_active(state, &session_id, &member_id);
    let (member, conversation_id) = with_store_mut(state, |store| {
        let now = now_i64();
        let member = store
            .collab_members
            .iter_mut()
            .find(|item| item.session_id == session_id && item.id == member_id)
            .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
        member.status = requested_status.clone();
        member.last_error = Some(reason.clone());
        member.last_activity_at = Some(now);
        member.updated_at = now;
        let mut metadata = member
            .metadata
            .take()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        metadata.insert(
            "interrupt".to_string(),
            json!({
                "at": now,
                "reason": reason,
                "activeWake": active_wake,
                "conversationId": member.conversation_id.clone(),
            }),
        );
        member.metadata = Some(Value::Object(metadata));
        Ok((member.clone(), member.conversation_id.clone()))
    })?;
    let mut cancel_requested = false;
    let mut child_killed = false;
    if let Some(conversation_id) = conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request_chat_runtime_cancel(state, conversation_id)?;
        cancel_requested = true;
        if let Ok(guard) = state.active_chat_requests.lock() {
            if let Some(child) = guard.get(conversation_id) {
                if let Ok(mut child_guard) = child.lock() {
                    child_killed = child_guard.kill().is_ok();
                }
            }
        }
    }
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    Ok(json!({
        "success": true,
        "sessionId": session_id,
        "memberId": member_id,
        "activeWake": active_wake,
        "cancelRequested": cancel_requested,
        "childKilled": child_killed,
        "conversationId": conversation_id,
        "member": member,
    }))
}

pub fn resume_member_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let member = with_store_mut(state, |store| resume_collab_member(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-member-changed",
        None,
        json!({ "collabSessionId": member.session_id, "member": member }),
    );
    super::schedule_team_member_wake(
        app,
        state,
        member.session_id.clone(),
        member.id.clone(),
        "member_resume",
    );
    Ok(json!(member))
}

pub fn wait_member_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id =
        payload_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    let timeout_ms = payload
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(30_000);
    let poll_ms = payload
        .get("pollMs")
        .and_then(Value::as_u64)
        .unwrap_or(250)
        .clamp(50, 2_000);
    let started = std::time::Instant::now();
    loop {
        let active_wake = member_wake_is_active(state, &session_id, &member_id);
        let member = with_store(state, |store| {
            store
                .collab_members
                .iter()
                .find(|item| item.session_id == session_id && item.id == member_id)
                .cloned()
                .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())
        })?;
        let settled = member_is_settled(member.status.as_str()) && !active_wake;
        if settled || started.elapsed().as_millis() as u64 >= timeout_ms {
            return Ok(json!({
                "success": true,
                "sessionId": session_id,
                "memberId": member_id,
                "settled": settled,
                "activeWake": active_wake,
                "timedOut": !settled,
                "elapsedMs": started.elapsed().as_millis() as u64,
                "member": member,
            }));
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }
}

fn member_wake_is_active(state: &State<'_, AppState>, session_id: &str, member_id: &str) -> bool {
    let Ok(active) = state.active_team_member_wakes.lock() else {
        return false;
    };
    active.contains(&format!("{session_id}:{member_id}"))
}

fn member_is_settled(status: &str) -> bool {
    matches!(
        status,
        "idle"
            | "completed"
            | "failed"
            | "cancelled"
            | "offline"
            | "suspended"
            | "archived"
            | "shutdown"
    )
}
