use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};

#[path = "runtime_collab/task_panel.rs"]
mod task_panel;
#[path = "runtime_collab/team_wake.rs"]
mod team_wake;

use crate::agent::{
    build_session_bridge_turn, emit_session_agent_completion, execute_prepared_session_agent_turn,
    PreparedSessionAgentTurn, SessionAgentTurnKind,
};
use crate::commands::cli_runtime::handle_cli_runtime_channel;
use crate::commands::redclaw::redclaw_task_control;
use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, archive_review_docket, collab_session_snapshot, create_collab_session,
    create_collab_task, create_review_docket, decide_review_docket,
    ensure_collab_session_coordinator, get_review_docket, list_collab_members,
    list_collab_messages, list_collab_reports, list_collab_sessions, list_collab_tasks,
    list_review_dockets, pin_collab_task_session, post_collab_message, read_collab_mailbox,
    rename_collab_member, request_collab_report, request_runtime_approval,
    resolve_review_docket_waiters, resolve_runtime_approval_by_approval_id, retry_collab_task,
    review_docket_stats, set_collab_session_coordinator, shutdown_collab_member,
    submit_collab_report, transition_collab_task, update_collab_session_status, update_collab_task,
    CollabMailboxMessageRecord, CollabMemberRecord, CollabProgressReportRecord,
    CollabSessionRecord, CollabTaskRecord, ReviewDocketRecord, RuntimeApprovalDetails,
    RuntimeApprovalRecord,
};
use crate::session_manager::create_session;
use crate::store::redclaw as redclaw_store;
use crate::subagents::{execute_team_tool, team_tool_descriptors, tick_team_wake_runtime};
use crate::{now_i64, parse_timestamp_ms, payload_string, AppState};
pub use task_panel::task_panel_list_value;
use team_wake::{emit_team_action_result_events, schedule_message_target_wake};
#[cfg(test)]
use team_wake::{non_coordinator_members_settled, team_member_session_metadata};

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

fn team_mcp_host_action(tool_name: &str) -> Option<&'static str> {
    crate::mcp::team_mcp_tool_contracts()
        .into_iter()
        .find(|tool| tool.name == tool_name)
        .map(|tool| tool.host_action)
}

fn request_review_docket_runtime_approval(
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    call_id: Option<&str>,
) -> Result<RuntimeApprovalRecord, String> {
    let description = if !docket.summary.trim().is_empty() {
        docket.summary.clone()
    } else if !docket.body.trim().is_empty() {
        docket.body.clone()
    } else {
        docket.title.clone()
    };
    request_runtime_approval(
        state,
        RuntimeApprovalRecord::pending(
            docket.id.clone(),
            "review_docket",
            docket.id.clone(),
            docket.decision_type.clone(),
            RuntimeApprovalDetails {
                r#type: docket.decision_type.clone(),
                title: docket.title.clone(),
                description,
                impact: Some(format!(
                    "source={}, risk={}, priority={}",
                    docket.source_kind, docket.risk_level, docket.priority
                )),
            },
        )
        .with_scope(
            docket.session_id.as_deref(),
            docket.task_id.as_deref(),
            None,
            call_id,
        )
        .with_metadata(Some(json!({
            "docketId": docket.id,
            "sourceKind": docket.source_kind,
            "sourceId": docket.source_id,
            "decisionType": docket.decision_type,
            "riskLevel": docket.risk_level,
            "priority": docket.priority,
            "proposedAction": docket.proposed_action,
            "artifactRefs": docket.artifact_refs,
            "options": docket.options,
        }))),
    )
}

pub fn list_sessions_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| Ok(json!(list_collab_sessions(&store))))
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

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn confirmed_team_plan(payload: &Value) -> bool {
    payload_bool(payload, "userConfirmedTeamPlan")
        || payload
            .get("metadata")
            .map(|metadata| payload_bool(metadata, "userConfirmedTeamPlan"))
            .unwrap_or(false)
}

fn insert_if_present(map: &mut Map<String, Value>, payload: &Value, key: &str) {
    if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
        map.insert(key.to_string(), value.clone());
    }
}

pub fn guide_create_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    if !confirmed_team_plan(payload) {
        return Err("TEAM_PLAN_CONFIRMATION_REQUIRED: 创建 team 前必须先向用户列出团队成员和分工，并等待用户明确确认。确认后再调用本动作，并传入 userConfirmedTeamPlan=true。".to_string());
    }

    let (result, member_events, task_events, session_event) = with_store_mut(state, |store| {
        let summary = payload_string(payload, "summary")
            .or_else(|| payload_string(payload, "objective"))
            .or_else(|| payload_string(payload, "goal"))
            .unwrap_or_else(|| "协作任务".to_string());
        let name = payload_string(payload, "name")
            .or_else(|| payload_string(payload, "title"))
            .unwrap_or_else(|| {
                summary
                    .chars()
                    .take(48)
                    .collect::<String>()
                    .trim()
                    .to_string()
            });
        let auto_open = payload
            .get("autoOpen")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut metadata = payload
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        metadata.insert("surface".to_string(), json!("team"));
        metadata.insert("autoOpen".to_string(), json!(auto_open));
        metadata.insert("source".to_string(), json!("team_guide"));
        metadata.insert("userConfirmedTeamPlan".to_string(), json!(true));

        let mut session_payload = Map::new();
        session_payload.insert("title".to_string(), json!(name));
        session_payload.insert("objective".to_string(), json!(summary));
        session_payload.insert("runtimeMode".to_string(), json!("team"));
        session_payload.insert("source".to_string(), json!("team-guide"));
        session_payload.insert("metadata".to_string(), Value::Object(metadata));
        insert_if_present(&mut session_payload, payload, "ownerSessionId");
        insert_if_present(&mut session_payload, payload, "workspaceRoot");

        let session = create_collab_session(store, &Value::Object(session_payload))?;
        let (session, coordinator, coordinator_created) =
            ensure_collab_session_coordinator(store, &session.id)?;

        let mut member_events = Vec::new();
        if coordinator_created {
            member_events.push(json!({
                "collabSessionId": coordinator.session_id,
                "member": coordinator
            }));
        }

        let mut role_to_member_id = Map::new();
        let mut created_members = Vec::new();
        for (index, member_input) in payload
            .get("members")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
        {
            let display_name = payload_string(&member_input, "displayName")
                .or_else(|| payload_string(&member_input, "name"));
            let Some(display_name) = display_name else {
                continue;
            };
            let role_id = payload_string(&member_input, "roleId")
                .unwrap_or_else(|| format!("member-{}", index + 1));
            let mut member_metadata = member_input
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(responsibility) = payload_string(&member_input, "responsibility") {
                member_metadata.insert("responsibility".to_string(), json!(responsibility));
            }
            member_metadata.insert("source".to_string(), json!("team_guide"));
            let member = add_collab_member(
                store,
                &json!({
                    "sessionId": session.id,
                    "displayName": display_name,
                    "roleId": role_id,
                    "capabilities": member_input.get("capabilities").cloned().unwrap_or_else(|| json!([])),
                    "metadata": Value::Object(member_metadata),
                    "sourceKind": "team_guide",
                    "backend": "redbox-runtime",
                    "adapterKind": "internal",
                    "status": "idle"
                }),
            )?;
            role_to_member_id.insert(member.role_id.clone(), json!(member.id.clone()));
            role_to_member_id.insert(member.display_name.clone(), json!(member.id.clone()));
            member_events.push(json!({
                "collabSessionId": member.session_id,
                "member": member
            }));
            created_members.push(member);
        }

        let mut task_events = Vec::new();
        let mut created_tasks = Vec::new();
        let mut unassigned_task_count = 0usize;
        for task_input in payload
            .get("tasks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let title = payload_string(&task_input, "title");
            let objective = payload_string(&task_input, "objective")
                .or_else(|| payload_string(&task_input, "description"))
                .or_else(|| title.clone())
                .unwrap_or_else(|| "执行协作任务".to_string());
            let mut task_payload = Map::new();
            task_payload.insert("sessionId".to_string(), json!(session.id));
            if let Some(title) = title {
                task_payload.insert("title".to_string(), json!(title));
            }
            task_payload.insert("objective".to_string(), json!(objective));
            insert_if_present(&mut task_payload, &task_input, "description");
            insert_if_present(&mut task_payload, &task_input, "priority");
            insert_if_present(&mut task_payload, &task_input, "dependsOnTaskIds");

            let member_id = payload_string(&task_input, "memberId").or_else(|| {
                payload_string(&task_input, "memberRoleId")
                    .or_else(|| payload_string(&task_input, "roleId"))
                    .or_else(|| payload_string(&task_input, "memberName"))
                    .and_then(|key| {
                        role_to_member_id
                            .get(&key)
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
            });
            if let Some(member_id) = member_id {
                task_payload.insert("memberId".to_string(), json!(member_id));
            } else {
                unassigned_task_count += 1;
            }
            let mut task_metadata = task_input
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            task_metadata.insert("source".to_string(), json!("team_guide"));
            task_payload.insert("metadata".to_string(), Value::Object(task_metadata));
            let task = create_collab_task(store, &Value::Object(task_payload))?;
            task_events.push(json!({
                "collabSessionId": task.session_id,
                "task": task
            }));
            created_tasks.push(task);
        }

        let result = json!({
            "sessionId": session.id,
            "name": session.title,
            "memberCount": created_members.len(),
            "taskCount": created_tasks.len(),
            "unassignedTaskCount": unassigned_task_count,
            "route": {
                "view": "redclaw",
                "redclawAction": "open-team",
                "teamSessionId": session.id
            },
            "nextStep": "Team room opened automatically. End your turn now."
        });
        let session_event = json!({
            "collabSessionId": session.id,
            "session": session
        });

        Ok((result, member_events, task_events, session_event))
    })?;

    for payload in member_events {
        emit_collab_event(app, "runtime:collab-member-changed", None, payload);
    }
    for payload in task_events {
        emit_collab_event(app, "runtime:collab-task-changed", None, payload);
    }
    emit_collab_event(app, "runtime:collab-session-changed", None, session_event);

    Ok(result)
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
    let call_id = payload_string(payload, "callId").or_else(|| {
        payload
            .get("proposedAction")
            .and_then(Value::as_object)
            .and_then(|value| value.get("callId"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    });
    let approval = request_review_docket_runtime_approval(state, &docket, call_id.as_deref())?;
    let docket_id = docket.id.clone();
    emit_collab_event(
        app,
        "runtime:review-docket-changed",
        None,
        json!({ "docketId": docket_id, "docket": docket.clone(), "approval": approval }),
    );
    Ok(json!(docket))
}

pub fn decide_review_docket_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let decision = with_store_mut(state, |store| decide_review_docket(store, payload))?;
    let docket_id = decision.docket_id.clone();
    let action_result = route_review_docket_action(app, state, &docket_id, &decision)?;
    let confirmed = decision.decision == "approved";
    let runtime_approval = resolve_runtime_approval_by_approval_id(state, &docket_id, confirmed)?;
    let outcome = json!({
        "docketId": docket_id,
        "decision": decision.clone(),
        "confirmed": confirmed,
        "runtimeApproval": runtime_approval,
        "actionResult": action_result.json(),
    });
    resolve_review_docket_waiters(state, &docket_id, outcome.clone())?;
    emit_collab_event(app, "runtime:review-docket-changed", None, outcome);
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
    decision: &crate::runtime::ReviewDecisionRecord,
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
        "redclaw_task_draft" => {
            apply_redclaw_task_draft_approval(app, state, &docket, &decision.decision)
        }
        "cli_escalation" => apply_cli_escalation_approval(app, state, &docket, decision),
        "agent_approval" => Ok(ApprovalActionRouteResult {
            kind: kind.to_string(),
            status: "resolved",
            message: Some("通用 agent 审批已回填到等待中的 runtime。".to_string()),
        }),
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

fn apply_cli_escalation_approval(
    app: &AppHandle,
    state: &State<'_, AppState>,
    docket: &ReviewDocketRecord,
    decision: &crate::runtime::ReviewDecisionRecord,
) -> Result<ApprovalActionRouteResult, String> {
    let action = docket
        .proposed_action
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| "CLI 审批项缺少 proposedAction".to_string())?;
    let escalation_id = action
        .get("escalationId")
        .and_then(Value::as_str)
        .or(docket.source_id.as_deref())
        .ok_or_else(|| "CLI 审批项缺少 escalationId".to_string())?;
    if decision.decision == "approved" {
        let scope = decision
            .selected_option_id
            .as_deref()
            .or_else(|| action.get("defaultScope").and_then(Value::as_str))
            .unwrap_or("once");
        let _ = handle_cli_runtime_channel(
            app,
            state,
            "cli-runtime:approve-escalation",
            &json!({
                "escalationId": escalation_id,
                "scope": scope,
            }),
        )
        .ok_or_else(|| "CLI 审批处理器不可用".to_string())??;
        return Ok(ApprovalActionRouteResult {
            kind: "cli_escalation".to_string(),
            status: "succeeded",
            message: Some(format!("CLI 权限已按 {scope} 范围批准。")),
        });
    }
    if decision.decision == "rejected" {
        let _ = handle_cli_runtime_channel(
            app,
            state,
            "cli-runtime:deny-escalation",
            &json!({
                "escalationId": escalation_id,
                "reason": decision.comment,
            }),
        )
        .ok_or_else(|| "CLI 审批处理器不可用".to_string())??;
        return Ok(ApprovalActionRouteResult {
            kind: "cli_escalation".to_string(),
            status: "succeeded",
            message: Some("CLI 权限请求已拒绝。".to_string()),
        });
    }
    Ok(ApprovalActionRouteResult {
        kind: "cli_escalation".to_string(),
        status: "ignored",
        message: Some("该决定不会自动批准或拒绝 CLI 权限。".to_string()),
    })
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
    let docket_id = docket.id.clone();
    let runtime_approval = resolve_runtime_approval_by_approval_id(state, &docket_id, false)?;
    let outcome = json!({
        "docketId": docket_id,
        "docket": docket.clone(),
        "confirmed": false,
        "runtimeApproval": runtime_approval,
        "actionResult": {
            "kind": "archive",
            "status": status,
        },
    });
    resolve_review_docket_waiters(state, &docket_id, outcome.clone())?;
    emit_collab_event(app, "runtime:review-docket-changed", None, outcome);
    Ok(json!(docket))
}

pub fn post_message_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let message = with_store_mut(state, |store| post_collab_message(store, payload))?;
    schedule_message_target_wake(app, state, &message, "mailbox_message");
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
    schedule_message_target_wake(app, state, &message, "report_request");
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

pub fn execute_tool_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let action = payload_string(payload, "action").ok_or_else(|| "缺少 action".to_string())?;
    let tool_payload = payload.get("payload").unwrap_or(payload);
    let value = with_store_mut(state, |store| {
        execute_team_tool(store, &action, tool_payload)
    })?;
    emit_team_action_result_events(app, state, &action, &value);
    Ok(value)
}

pub fn mcp_contract_value() -> Value {
    json!({
        "serverName": "redbox-team",
        "tools": crate::mcp::team_mcp_tool_contracts(),
        "toolsListResponse": crate::mcp::team_mcp_tools_list_response()
    })
}

pub fn execute_mcp_tool_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let tool_name =
        payload_string(payload, "toolName").ok_or_else(|| "缺少 toolName".to_string())?;
    let arguments = payload.get("arguments").unwrap_or(payload);
    let value = with_store_mut(state, |store| {
        crate::mcp::execute_team_mcp_tool(store, &tool_name, arguments)
    })?;
    if let Some(host_action) = team_mcp_host_action(&tool_name) {
        emit_team_action_result_events(app, state, host_action, &value);
    }
    Ok(value)
}

pub fn list_agent_backends_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(crate::agent_hub::list_agent_backends(&store)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AdvisorRecord;

    fn advisor_record(id: &str) -> AdvisorRecord {
        AdvisorRecord {
            id: id.to_string(),
            name: "策略成员".to_string(),
            avatar: "S".to_string(),
            personality: "关注定位和取舍。".to_string(),
            system_prompt: "以策略视角给出判断。".to_string(),
            knowledge_language: None,
            knowledge_files: Vec::new(),
            youtube_channel: None,
            member_skill_ref: Some("member-strategy".to_string()),
            member_skill_status: Some("ready".to_string()),
            member_skill_version: None,
            member_skill_last_distilled_at: None,
            member_skill_last_error: None,
            member_skill_candidate_version: None,
            member_skill_candidate_path: None,
            member_skill_candidate_created_at: None,
            member_skill_candidate_source_event: None,
            detected_knowledge_language: None,
            language_detection_status: None,
            language_confidence: None,
            redclaw_visible: Some(true),
            redclaw_order: Some(0),
            created_at: "2026-05-30T00:00:00Z".to_string(),
            updated_at: "2026-05-30T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn team_member_session_metadata_binds_advisor_identity_and_skill() {
        let mut store = crate::AppStore::default();
        store.advisors.push(advisor_record("advisor-strategy"));
        let session = CollabSessionRecord {
            id: "collab-session-1".to_string(),
            title: "团队任务".to_string(),
            objective: "完成一次团队协作".to_string(),
            runtime_mode: "team".to_string(),
            source: "team-workbench".to_string(),
            ..Default::default()
        };
        let member = CollabMemberRecord {
            id: "collab-member-1".to_string(),
            session_id: session.id.clone(),
            display_name: "策略成员".to_string(),
            role_id: "advisor-strategy".to_string(),
            metadata: Some(json!({ "advisorId": "advisor-strategy" })),
            ..Default::default()
        };

        let metadata = team_member_session_metadata(&store, &session, &member);

        assert_eq!(
            metadata.get("runtimeMode").and_then(Value::as_str),
            Some("team")
        );
        assert_eq!(
            metadata.get("collabMemberId").and_then(Value::as_str),
            Some("collab-member-1")
        );
        assert_eq!(
            metadata.get("advisorId").and_then(Value::as_str),
            Some("advisor-strategy")
        );
        assert_eq!(
            metadata.get("memberSkillRef").and_then(Value::as_str),
            Some("member-strategy")
        );
        assert_eq!(
            metadata
                .get("activeSkills")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("member-strategy")
        );
        let active_speaker = metadata
            .get("activeSpeaker")
            .and_then(Value::as_object)
            .expect("active speaker metadata");
        assert_eq!(
            active_speaker.get("speakerId").and_then(Value::as_str),
            Some("advisor-strategy")
        );
        assert_eq!(
            active_speaker.get("memberId").and_then(Value::as_str),
            Some("advisor-strategy")
        );
        assert_eq!(
            active_speaker.get("collabMemberId").and_then(Value::as_str),
            Some("collab-member-1")
        );
        assert_eq!(
            active_speaker
                .get("knowledgeScope")
                .and_then(|value| value.get("advisorId"))
                .and_then(Value::as_str),
            Some("advisor-strategy")
        );
    }

    #[test]
    fn coordinator_wake_waits_until_non_coordinator_members_are_settled() {
        let mut store = crate::AppStore::default();
        let session_id = "collab-session-settled".to_string();
        store.collab_members.push(CollabMemberRecord {
            id: "coordinator".to_string(),
            session_id: session_id.clone(),
            status: "idle".to_string(),
            ..Default::default()
        });
        store.collab_members.push(CollabMemberRecord {
            id: "worker-a".to_string(),
            session_id: session_id.clone(),
            status: "idle".to_string(),
            ..Default::default()
        });
        store.collab_members.push(CollabMemberRecord {
            id: "worker-b".to_string(),
            session_id: session_id.clone(),
            status: "active".to_string(),
            ..Default::default()
        });

        assert!(!non_coordinator_members_settled(
            &store,
            &session_id,
            "coordinator"
        ));

        store
            .collab_members
            .iter_mut()
            .find(|member| member.id == "worker-b")
            .unwrap()
            .status = "failed".to_string();

        assert!(non_coordinator_members_settled(
            &store,
            &session_id,
            "coordinator"
        ));
    }
}
