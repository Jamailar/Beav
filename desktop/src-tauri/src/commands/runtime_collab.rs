use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::redclaw::redclaw_task_control;
use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, archive_review_docket, collab_session_snapshot, create_collab_session,
    create_collab_task, create_review_docket, decide_review_docket, get_review_docket,
    list_collab_members, list_collab_messages, list_collab_reports, list_collab_sessions,
    list_collab_tasks, list_review_dockets, pin_collab_task_session, post_collab_message,
    read_collab_mailbox, request_collab_report, retry_collab_task, review_docket_stats,
    submit_collab_report, transition_collab_task, update_collab_session_status, update_collab_task,
    ReviewDocketRecord,
};
use crate::subagents::{execute_team_tool, team_tool_descriptors, tick_team_wake_runtime};
use crate::{payload_string, AppState};

#[derive(Debug, Clone)]
struct ApprovalActionRouteResult {
    kind: String,
    status: &'static str,
    message: Option<String>,
}

impl ApprovalActionRouteResult {
    fn json(&self) -> Value {
        json!({
            "kind": self.kind,
            "status": self.status,
            "message": self.message,
        })
    }
}

fn payload_limit(payload: &Value, key: &str) -> Option<usize> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
}

fn emit_collab_event(
    app: &AppHandle,
    event_type: &str,
    owner_session_id: Option<&str>,
    payload: Value,
) {
    emit_runtime_event(app, event_type, owner_session_id, None, payload);
}

pub fn list_sessions_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| Ok(json!(list_collab_sessions(&store))))
}

pub fn create_session_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session = with_store_mut(state, |store| create_collab_session(store, payload))?;
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

pub fn list_members_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    with_store(state, |store| {
        Ok(json!(list_collab_members(&store, &session_id)))
    })
}

pub fn list_tasks_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id =
        payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    with_store(state, |store| {
        Ok(json!(list_collab_tasks(&store, &session_id)))
    })
}

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

pub fn create_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| create_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task }),
    );
    Ok(json!(task))
}

pub fn update_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| update_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task }),
    );
    Ok(json!(task))
}

pub fn transition_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    transition: &str,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| {
        transition_collab_task(store, payload, transition)
    })?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": transition }),
    );
    Ok(json!(task))
}

pub fn pin_task_session_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| pin_collab_task_session(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": "pin-session" }),
    );
    Ok(json!(task))
}

pub fn retry_task_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let task = with_store_mut(state, |store| retry_collab_task(store, payload))?;
    emit_collab_event(
        app,
        "runtime:collab-task-changed",
        None,
        json!({ "collabSessionId": task.session_id, "task": task, "transition": "retry" }),
    );
    Ok(json!(task))
}

pub fn list_review_dockets_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(list_review_dockets(&store, payload)))
    })
}

pub fn get_review_docket_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let docket_id =
        payload_string(payload, "docketId").ok_or_else(|| "缺少 docketId".to_string())?;
    with_store(state, |store| {
        get_review_docket(&store, &docket_id)
            .map(|docket| json!(docket))
            .ok_or_else(|| "审批项不存在".to_string())
    })
}

pub fn review_docket_stats_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| Ok(review_docket_stats(&store)))
}

pub fn create_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let docket = with_store_mut(state, |store| create_review_docket(store, payload))?;
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": docket.id, "docket": docket }),
    );
    Ok(json!(docket))
}

pub fn decide_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let decision = with_store_mut(state, |store| decide_review_docket(store, payload))?;
    let action_result =
        route_review_docket_action(app, state, &decision.docket_id, &decision.decision)?;
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": decision.docket_id, "decision": decision, "actionResult": action_result.json() }),
    );
    Ok(json!(decision))
}

fn proposed_action_kind(action: Option<&Value>) -> Option<&str> {
    action
        .and_then(Value::as_object)
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
}

fn route_review_docket_action(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket_id: &str,
    decision: &str,
) -> Result<ApprovalActionRouteResult, String> {
    let docket = with_store(state, |store| {
        get_review_docket(&store, docket_id).ok_or_else(|| "审批项不存在".to_string())
    })?;
    let Some(kind) = proposed_action_kind(docket.proposed_action.as_ref()) else {
        return Ok(ApprovalActionRouteResult {
            kind: "none".to_string(),
            status: "not_applicable",
            message: None,
        });
    };

    match kind {
        "redclaw_task_draft" => apply_redclaw_task_draft_approval(app, state, &docket, decision),
        "collab_task_completion" => Ok(ApprovalActionRouteResult {
            kind: kind.to_string(),
            status: "already_applied",
            message: Some(
                "协作任务状态已由审批 runtime 按 onDecisionTaskStatus 回写。".to_string(),
            ),
        }),
        other => Ok(ApprovalActionRouteResult {
            kind: other.to_string(),
            status: "unsupported",
            message: Some("审批动作 kind 尚未注册业务处理器。".to_string()),
        }),
    }
}

fn apply_redclaw_task_draft_approval(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    decision: &str,
) -> Result<ApprovalActionRouteResult, String> {
    let action = docket
        .proposed_action
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| "RedClaw 审批项缺少 proposedAction".to_string())?;
    let draft_id = action
        .get("draftId")
        .and_then(Value::as_str)
        .or(docket.source_id.as_deref())
        .ok_or_else(|| "RedClaw 审批项缺少 draftId".to_string())?;
    let confirm = match decision {
        "approved" => Some(true),
        "rejected" => Some(false),
        _ => None,
    };
    if let Some(confirm) = confirm {
        redclaw_task_control::handle_task_confirm(
            app,
            state,
            &json!({
                "draftId": draft_id,
                "confirm": confirm,
            }),
        )?;
        return Ok(ApprovalActionRouteResult {
            kind: "redclaw_task_draft".to_string(),
            status: "succeeded",
            message: Some(if confirm {
                "RedClaw 草稿已确认。".to_string()
            } else {
                "RedClaw 草稿已丢弃。".to_string()
            }),
        });
    }
    Ok(ApprovalActionRouteResult {
        kind: "redclaw_task_draft".to_string(),
        status: "ignored",
        message: Some("该决定不会自动确认或丢弃 RedClaw 草稿。".to_string()),
    })
}

pub fn archive_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
    status: &str,
) -> Result<Value, String> {
    let docket = with_store_mut(state, |store| archive_review_docket(store, payload, status))?;
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": docket.id, "docket": docket }),
    );
    Ok(json!(docket))
}

pub fn post_message_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let message = with_store_mut(state, |store| post_collab_message(store, payload))?;
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

pub fn tool_descriptors_value() -> Value {
    json!(team_tool_descriptors())
}

pub fn execute_tool_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let action = payload_string(payload, "action").ok_or_else(|| "缺少 action".to_string())?;
    let tool_payload = payload.get("payload").unwrap_or(payload);
    with_store_mut(state, |store| {
        execute_team_tool(store, &action, tool_payload)
    })
}

pub fn mcp_contract_value() -> Value {
    json!({
        "serverName": "redbox-team",
        "tools": crate::mcp::team_mcp_tool_contracts(),
        "toolsListResponse": crate::mcp::team_mcp_tools_list_response()
    })
}

pub fn execute_mcp_tool_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let tool_name =
        payload_string(payload, "toolName").ok_or_else(|| "缺少 toolName".to_string())?;
    let arguments = payload.get("arguments").unwrap_or(payload);
    with_store_mut(state, |store| {
        crate::mcp::execute_team_mcp_tool(store, &tool_name, arguments)
    })
}

pub fn list_agent_backends_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(crate::agent_hub::list_agent_backends(&store)))
    })
}
