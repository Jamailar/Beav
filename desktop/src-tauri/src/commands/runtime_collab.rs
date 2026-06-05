use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

#[path = "runtime_collab/review_approval.rs"]
mod review_approval;
#[path = "runtime_collab/session_values.rs"]
mod session_values;
#[path = "runtime_collab/task_panel.rs"]
mod task_panel;
#[path = "runtime_collab/team_guide.rs"]
mod team_guide;
#[path = "runtime_collab/team_tools.rs"]
mod team_tools;
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
    add_collab_member, archive_review_docket, create_collab_task, create_review_docket,
    decide_review_docket, get_review_docket, list_collab_members, list_collab_messages,
    list_collab_reports, list_collab_tasks, list_review_dockets, pin_collab_task_session,
    post_collab_message, read_collab_mailbox, rename_collab_member, request_collab_report,
    request_runtime_approval, resolve_review_docket_waiters,
    resolve_runtime_approval_by_approval_id, retry_collab_task, review_docket_stats,
    set_collab_session_coordinator, shutdown_collab_member, submit_collab_report,
    transition_collab_task, update_collab_task, CollabMailboxMessageRecord, CollabMemberRecord,
    CollabProgressReportRecord, CollabSessionRecord, CollabTaskRecord, ReviewDocketRecord,
    RuntimeApprovalDetails, RuntimeApprovalRecord,
};
use crate::session_manager::create_session;
use crate::store::redclaw as redclaw_store;
use crate::{now_i64, parse_timestamp_ms, payload_string, AppState};
use review_approval::{request_review_docket_runtime_approval, route_review_docket_action};
pub use session_values::{
    create_session_value, list_sessions_value, session_snapshot_value, tick_reports_value,
    update_session_status_value,
};
pub use task_panel::task_panel_list_value;
pub use team_guide::guide_create_value;
pub use team_tools::{
    execute_mcp_tool_value, execute_tool_value, list_agent_backends_value, mcp_contract_value,
    tool_descriptors_value,
};
use team_wake::{emit_team_action_result_events, schedule_message_target_wake};
#[cfg(test)]
use team_wake::{non_coordinator_members_settled, team_member_session_metadata};

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
