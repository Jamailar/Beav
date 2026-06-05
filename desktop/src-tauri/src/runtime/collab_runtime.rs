use serde_json::{json, Value};

use crate::runtime::{
    runtime_subagent_role_spec, CollabMailboxMessageRecord, CollabMemberRecord,
    CollabProgressReportRecord, CollabSessionRecord, CollabSessionSnapshot, CollabTaskRecord,
    ReviewDecisionRecord, ReviewDocketRecord,
};
use crate::{now_i64, AppStore};

#[path = "collab_runtime/member_profile.rs"]
mod member_profile;
#[path = "collab_runtime/member_workload.rs"]
mod member_workload;
#[path = "collab_runtime/payload.rs"]
mod payload;
#[path = "collab_runtime/review_docket.rs"]
mod review_docket;
#[path = "collab_runtime/state_helpers.rs"]
mod state_helpers;
#[path = "collab_runtime/task_lifecycle.rs"]
mod task_lifecycle;

use member_profile::{build_member_agent_card, member_metadata_from_payload};
pub use member_workload::match_collab_members_for_task;
use member_workload::{
    initial_member_task_plan, remove_member_task_from_plan, upsert_member_task_plan,
    validate_member_executor_capacity,
};
use payload::{
    merge_object_defaults, value_array, value_i64, value_object, value_string, value_string_array,
    value_string_array_or_default, value_vec,
};
pub use review_docket::{
    archive_review_docket, create_review_docket, decide_review_docket, get_review_docket,
    list_review_dockets, review_docket_stats,
};
use state_helpers::{
    apply_task_status, completion_claim_payload, merge_task_metadata, next_collab_id,
    normalize_task_defaults, promote_ready_dependents, sync_task_dependency_links, touch_session,
    valid_task_transition, validate_member, validate_session, validate_task,
};
pub use task_lifecycle::{
    create_collab_task, list_collab_tasks, pin_collab_task_session, retry_collab_task,
    transition_collab_task, update_collab_task,
};

const DEFAULT_PROGRESS_INTERVAL_MS: i64 = 15 * 60 * 1000;
const COLLAB_MAILBOX_READ_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const COLLAB_REPORTS_KEEP_LATEST_PER_TASK: usize = 200;

pub fn create_collab_session(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabSessionRecord, String> {
    let objective = value_string(payload, "objective")
        .or_else(|| value_string(payload, "goal"))
        .unwrap_or_else(|| "协作任务".to_string());
    let title = value_string(payload, "title").unwrap_or_else(|| {
        objective
            .chars()
            .take(48)
            .collect::<String>()
            .trim()
            .to_string()
    });
    let now = now_i64();
    let session = CollabSessionRecord {
        id: next_collab_id("collab-session", |candidate| {
            store
                .collab_sessions
                .iter()
                .any(|session| session.id == candidate)
        }),
        owner_session_id: value_string(payload, "ownerSessionId")
            .or_else(|| value_string(payload, "sessionId")),
        coordinator_member_id: value_string(payload, "coordinatorMemberId"),
        workspace_root: value_string(payload, "workspaceRoot"),
        title,
        objective,
        status: value_string(payload, "status").unwrap_or_else(|| "active".to_string()),
        runtime_mode: value_string(payload, "runtimeMode").unwrap_or_else(|| "default".to_string()),
        source: value_string(payload, "source").unwrap_or_else(|| "internal".to_string()),
        metadata: value_object(payload, "metadata"),
        created_at: now,
        updated_at: now,
        completed_at: None,
    };
    store.collab_sessions.push(session.clone());
    Ok(session)
}

pub fn list_collab_sessions(store: &AppStore) -> Vec<CollabSessionRecord> {
    let mut sessions = store.collab_sessions.clone();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

pub fn update_collab_session_status(
    store: &mut AppStore,
    session_id: &str,
    status: &str,
) -> Result<CollabSessionRecord, String> {
    let now = now_i64();
    let session = store
        .collab_sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| "协作会话不存在".to_string())?;
    session.status = status.to_string();
    session.updated_at = now;
    if matches!(status, "completed" | "failed" | "archived") {
        session.completed_at.get_or_insert(now);
    }
    Ok(session.clone())
}

pub fn set_collab_session_coordinator(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabSessionRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_member(store, &session_id, &member_id)?;
    let now = now_i64();
    let session = store
        .collab_sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| "协作会话不存在".to_string())?;
    session.coordinator_member_id = Some(member_id);
    session.updated_at = now;
    Ok(session.clone())
}

pub fn ensure_collab_session_coordinator(
    store: &mut AppStore,
    session_id: &str,
) -> Result<(CollabSessionRecord, CollabMemberRecord, bool), String> {
    validate_session(store, session_id)?;

    if let Some(coordinator_id) = store
        .collab_sessions
        .iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.coordinator_member_id.clone())
    {
        if let Some(member) = store
            .collab_members
            .iter()
            .find(|member| member.session_id == session_id && member.id == coordinator_id)
            .cloned()
        {
            let session = store
                .collab_sessions
                .iter()
                .find(|session| session.id == session_id)
                .cloned()
                .ok_or_else(|| "协作会话不存在".to_string())?;
            return Ok((session, member, false));
        }
    }

    if let Some(member) = store
        .collab_members
        .iter()
        .find(|member| {
            member.session_id == session_id
                && matches!(
                    member.role_id.trim().to_ascii_lowercase().as_str(),
                    "leader" | "coordinator" | "director"
                )
        })
        .cloned()
    {
        let session = set_collab_session_coordinator(
            store,
            &json!({ "sessionId": session_id, "memberId": member.id }),
        )?;
        return Ok((session, member, false));
    }

    let member = add_collab_member(
        store,
        &json!({
            "sessionId": session_id,
            "displayName": "总监",
            "roleId": "leader",
            "sourceKind": "team_coordinator",
            "backend": "redbox-runtime",
            "adapterKind": "internal",
            "status": "idle",
            "capabilities": ["coordination", "task_dispatch", "progress_reporting", "user_entry"],
            "metadata": {
                "systemRole": "team_director",
                "pinnedFirst": true,
                "userEntry": true
            }
        }),
    )?;
    let session = set_collab_session_coordinator(
        store,
        &json!({ "sessionId": session_id, "memberId": member.id }),
    )?;
    Ok((session, member, true))
}

pub fn list_collab_members(store: &AppStore, session_id: &str) -> Vec<CollabMemberRecord> {
    let mut members: Vec<CollabMemberRecord> = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .cloned()
        .collect();
    members.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    members
}

pub fn list_collab_reports(
    store: &AppStore,
    session_id: &str,
    task_id: Option<&str>,
    member_id: Option<&str>,
    limit: Option<usize>,
) -> Vec<CollabProgressReportRecord> {
    let mut reports: Vec<CollabProgressReportRecord> = store
        .collab_progress_reports
        .iter()
        .filter(|report| report.session_id == session_id)
        .filter(|report| task_id.map_or(true, |value| report.task_id.as_deref() == Some(value)))
        .filter(|report| member_id.map_or(true, |value| report.member_id == value))
        .cloned()
        .collect();
    reports.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = limit.filter(|value| *value > 0) {
        let split_at = reports.len().saturating_sub(limit);
        reports.drain(..split_at);
    }
    reports
}

pub fn list_collab_messages(
    store: &AppStore,
    session_id: &str,
    member_id: Option<&str>,
    task_id: Option<&str>,
    unread_only: bool,
    limit: Option<usize>,
) -> Vec<CollabMailboxMessageRecord> {
    let mut messages: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id)
        .filter(|message| {
            member_id.map_or(true, |value| {
                message.to_member_id.as_deref() == Some(value)
                    || message.from_member_id.as_deref() == Some(value)
            })
        })
        .filter(|message| task_id.map_or(true, |value| message.task_id.as_deref() == Some(value)))
        .filter(|message| !unread_only || message.read_at.is_none())
        .cloned()
        .collect();
    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = limit.filter(|value| *value > 0) {
        let split_at = messages.len().saturating_sub(limit);
        messages.drain(..split_at);
    }
    messages
}

pub fn collab_session_snapshot(
    store: &AppStore,
    session_id: &str,
    mailbox_limit: Option<usize>,
    report_limit: Option<usize>,
) -> Option<CollabSessionSnapshot> {
    let session = store
        .collab_sessions
        .iter()
        .find(|session| session.id == session_id)?
        .clone();
    let mut members: Vec<CollabMemberRecord> = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .cloned()
        .collect();
    members.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let mut tasks: Vec<CollabTaskRecord> = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .cloned()
        .collect();
    for task in &mut tasks {
        normalize_task_defaults(task);
    }
    tasks.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });

    let mut mailbox: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id)
        .cloned()
        .collect();
    mailbox.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = mailbox_limit.filter(|value| *value > 0) {
        let split_at = mailbox.len().saturating_sub(limit);
        mailbox.drain(..split_at);
    }

    let mut reports: Vec<CollabProgressReportRecord> = store
        .collab_progress_reports
        .iter()
        .filter(|report| report.session_id == session_id)
        .cloned()
        .collect();
    reports.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    if let Some(limit) = report_limit.filter(|value| *value > 0) {
        let split_at = reports.len().saturating_sub(limit);
        reports.drain(..split_at);
    }

    Some(CollabSessionSnapshot {
        session,
        members,
        tasks,
        mailbox,
        reports,
    })
}

pub fn add_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member_id = next_collab_id("collab-member", |candidate| {
        store
            .collab_members
            .iter()
            .any(|member| member.id == candidate)
    });
    let display_name = value_string(payload, "displayName")
        .or_else(|| value_string(payload, "name"))
        .unwrap_or_else(|| "协作成员".to_string());
    let role_id = value_string(payload, "roleId").unwrap_or_else(|| "executor".to_string());
    let capabilities = value_string_array(payload, "capabilities");
    let allowed_tools = value_string_array(payload, "allowedTools");
    let member = CollabMemberRecord {
        id: member_id.clone(),
        session_id: session_id.clone(),
        display_name: display_name.clone(),
        role_id: role_id.clone(),
        source_kind: value_string(payload, "sourceKind")
            .or_else(|| value_string(payload, "adapterKind"))
            .unwrap_or_else(|| "internal_runtime".to_string()),
        backend: value_string(payload, "backend").unwrap_or_else(|| "redbox-runtime".to_string()),
        adapter_kind: value_string(payload, "adapterKind")
            .unwrap_or_else(|| "internal".to_string()),
        status: value_string(payload, "status").unwrap_or_else(|| "idle".to_string()),
        current_task_id: value_string(payload, "currentTaskId"),
        conversation_id: value_string(payload, "conversationId"),
        runtime_id: value_string(payload, "runtimeId"),
        capabilities: capabilities.clone(),
        allowed_tools: allowed_tools.clone(),
        desired_model_config: value_object(payload, "desiredModelConfig"),
        current_model_config: value_object(payload, "currentModelConfig"),
        progress_interval_ms: value_i64(payload, "progressIntervalMs")
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PROGRESS_INTERVAL_MS),
        report_interval_seconds: value_i64(payload, "reportIntervalSeconds")
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PROGRESS_INTERVAL_MS / 1000),
        last_seen_at: None,
        last_report_at: None,
        last_activity_at: None,
        last_error: None,
        metadata: member_metadata_from_payload(
            &member_id,
            &session_id,
            &display_name,
            &role_id,
            &capabilities,
            &allowed_tools,
            payload,
        ),
        created_at: now,
        updated_at: now,
    };
    store.collab_members.push(member.clone());
    touch_session(store, &session_id, now);
    Ok(member)
}

pub fn rename_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member = store
        .collab_members
        .iter_mut()
        .find(|member| member.session_id == session_id && member.id == member_id)
        .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
    if let Some(display_name) =
        value_string(payload, "displayName").or_else(|| value_string(payload, "name"))
    {
        member.display_name = display_name.clone();
        if let Some(agent_card) = member
            .metadata
            .as_mut()
            .and_then(Value::as_object_mut)
            .and_then(|metadata| metadata.get_mut("agentCard"))
            .and_then(Value::as_object_mut)
        {
            agent_card.insert("displayName".to_string(), json!(display_name));
        }
    }
    if let Some(role_id) = value_string(payload, "roleId") {
        member.role_id = role_id.clone();
        if let Some(agent_card) = member
            .metadata
            .as_mut()
            .and_then(Value::as_object_mut)
            .and_then(|metadata| metadata.get_mut("agentCard"))
            .and_then(Value::as_object_mut)
        {
            agent_card.insert("roleId".to_string(), json!(role_id));
        }
    }
    member.updated_at = now;
    let updated = member.clone();
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn shutdown_collab_member(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMemberRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    let now = now_i64();
    let member = store
        .collab_members
        .iter_mut()
        .find(|member| member.session_id == session_id && member.id == member_id)
        .ok_or_else(|| "协作成员不存在或不属于该会话".to_string())?;
    member.status = value_string(payload, "status").unwrap_or_else(|| "offline".to_string());
    member.current_task_id = None;
    member.last_error = value_string(payload, "reason");
    member.updated_at = now;
    member.last_activity_at = Some(now);
    let mut metadata = member
        .metadata
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    metadata.insert(
        "shutdown".to_string(),
        json!({
            "at": now,
            "reason": value_string(payload, "reason")
        }),
    );
    member.metadata = Some(Value::Object(metadata));
    let updated = member.clone();
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn post_collab_message(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMailboxMessageRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    if let Some(member_id) = value_string(payload, "fromMemberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(member_id) = value_string(payload, "toMemberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(task_id) = value_string(payload, "taskId") {
        validate_task(store, &session_id, &task_id)?;
    }
    let now = now_i64();
    let message = CollabMailboxMessageRecord {
        id: next_collab_id("collab-msg", |candidate| {
            store
                .collab_mailbox_messages
                .iter()
                .any(|message| message.id == candidate)
        }),
        session_id: session_id.clone(),
        from_member_id: value_string(payload, "fromMemberId"),
        to_member_id: value_string(payload, "toMemberId"),
        from_kind: value_string(payload, "fromKind").unwrap_or_else(|| "system".to_string()),
        task_id: value_string(payload, "taskId"),
        kind: value_string(payload, "kind").unwrap_or_else(|| "message".to_string()),
        message_type: value_string(payload, "messageType")
            .or_else(|| value_string(payload, "kind"))
            .unwrap_or_else(|| "message".to_string()),
        status: value_string(payload, "status").unwrap_or_else(|| "unread".to_string()),
        subject: value_string(payload, "subject"),
        body: value_string(payload, "body").unwrap_or_default(),
        attachment_refs: value_string_array(payload, "attachmentRefs"),
        payload: value_object(payload, "payload"),
        created_at: now,
        read_at: None,
    };
    store.collab_mailbox_messages.push(message.clone());
    touch_session(store, &session_id, now);
    Ok(message)
}

pub fn read_collab_mailbox(
    store: &mut AppStore,
    payload: &Value,
) -> Result<Vec<CollabMailboxMessageRecord>, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    let member_id = value_string(payload, "memberId");
    if let Some(member_id) = member_id.as_deref() {
        validate_member(store, &session_id, member_id)?;
    }
    let unread_only = payload
        .get("unreadOnly")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mark_read = payload
        .get("markRead")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let task_id = value_string(payload, "taskId");
    let limit = value_i64(payload, "limit")
        .filter(|value| *value > 0)
        .map(|value| value as usize);
    let messages = list_collab_messages(
        store,
        &session_id,
        member_id.as_deref(),
        task_id.as_deref(),
        unread_only,
        limit,
    );
    if mark_read {
        let now = now_i64();
        for message in store.collab_mailbox_messages.iter_mut() {
            if messages.iter().any(|item| item.id == message.id) && message.read_at.is_none() {
                message.read_at = Some(now);
                message.status = "read".to_string();
            }
        }
    }
    Ok(messages)
}

pub fn cleanup_collab_mailbox(store: &mut AppStore, session_id: &str, keep_latest: usize) -> usize {
    let keep_latest = keep_latest.max(1);
    let cutoff = now_i64().saturating_sub(COLLAB_MAILBOX_READ_TTL_MS);
    let mut read_messages: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id && message.read_at.is_some())
        .cloned()
        .collect();
    let expired_count = read_messages
        .iter()
        .filter(|message| message.read_at.unwrap_or(message.created_at) < cutoff)
        .count();
    if read_messages.len() <= keep_latest || expired_count == 0 {
        return 0;
    }
    read_messages.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let keep_ids = read_messages
        .iter()
        .take(keep_latest)
        .map(|message| message.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let before = store.collab_mailbox_messages.len();
    store.collab_mailbox_messages.retain(|message| {
        message.session_id != session_id
            || message.read_at.is_none()
            || message.read_at.unwrap_or(message.created_at) >= cutoff
            || keep_ids.contains(&message.id)
    });
    before.saturating_sub(store.collab_mailbox_messages.len())
}

fn cleanup_collab_reports_for_task(store: &mut AppStore, session_id: &str, task_id: &str) -> usize {
    let matching_ids = store
        .collab_progress_reports
        .iter()
        .filter(|report| {
            report.session_id == session_id && report.task_id.as_deref() == Some(task_id)
        })
        .map(|report| report.id.clone())
        .collect::<Vec<_>>();
    let overflow = matching_ids
        .len()
        .saturating_sub(COLLAB_REPORTS_KEEP_LATEST_PER_TASK);
    if overflow == 0 {
        return 0;
    }
    let remove_ids = matching_ids
        .into_iter()
        .take(overflow)
        .collect::<std::collections::HashSet<_>>();
    let removed_summaries = store
        .collab_progress_reports
        .iter()
        .filter(|report| remove_ids.contains(&report.id))
        .map(|report| {
            json!({
                "id": report.id,
                "reportType": report.report_type,
                "status": report.status,
                "summary": report.summary,
                "createdAt": report.created_at,
            })
        })
        .collect::<Vec<_>>();
    store
        .collab_progress_reports
        .retain(|report| !remove_ids.contains(&report.id));
    if let Some(task) = store
        .collab_tasks
        .iter_mut()
        .find(|task| task.session_id == session_id && task.id == task_id)
    {
        task.artifacts.push(json!({
            "kind": "collab-report-archive",
            "removedCount": overflow,
            "archivedAt": now_i64(),
            "reports": removed_summaries,
        }));
    }
    overflow
}

pub fn submit_collab_report(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabProgressReportRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let member_id = value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?;
    validate_session(store, &session_id)?;
    validate_member(store, &session_id, &member_id)?;
    if let Some(task_id) = value_string(payload, "taskId") {
        validate_task(store, &session_id, &task_id)?;
    }

    let now = now_i64();
    let status = value_string(payload, "status").unwrap_or_else(|| "reported".to_string());
    let status_is_completed = status == "completed";
    let summary = value_string(payload, "summary").unwrap_or_default();
    let report = CollabProgressReportRecord {
        id: next_collab_id("collab-report", |candidate| {
            store
                .collab_progress_reports
                .iter()
                .any(|report| report.id == candidate)
        }),
        session_id: session_id.clone(),
        member_id: member_id.clone(),
        task_id: value_string(payload, "taskId"),
        report_type: value_string(payload, "reportType").unwrap_or_else(|| {
            match status.as_str() {
                "blocked" => "blocker",
                "completed" => "completion",
                "failed" => "failure",
                _ => "periodic",
            }
            .to_string()
        }),
        status: status.clone(),
        summary: summary.clone(),
        next_action: value_string(payload, "nextAction"),
        next_steps: value_string_array(payload, "nextSteps"),
        progress_percent: value_i64(payload, "progressPercent").map(|value| value.clamp(0, 100)),
        blockers: value_string_array(payload, "blockers"),
        artifacts: value_vec(payload, "artifacts").unwrap_or_default(),
        artifact_ids: value_string_array(payload, "artifactIds"),
        payload: completion_claim_payload(payload, &session_id, &member_id, &status, &summary),
        created_at: now,
    };
    store.collab_progress_reports.push(report.clone());
    if let Some(task_id) = report.task_id.as_deref() {
        cleanup_collab_reports_for_task(store, &session_id, task_id);
    }

    if let Some(member) = store
        .collab_members
        .iter_mut()
        .find(|member| member.id == member_id && member.session_id == session_id)
    {
        member.status = value_string(payload, "memberStatus").unwrap_or_else(|| {
            match status.as_str() {
                "blocked" => "blocked",
                "completed" => "completed",
                "failed" => "failed",
                "cancelled" => "idle",
                _ => "working",
            }
            .to_string()
        });
        member.current_task_id = report.task_id.clone().or(member.current_task_id.clone());
        member.last_seen_at = Some(now);
        member.last_report_at = Some(now);
        member.updated_at = now;
    }

    let mut updated_task = None;
    if let Some(task_id) = report.task_id.clone() {
        if let Some(task) = store
            .collab_tasks
            .iter_mut()
            .find(|task| task.id == task_id && task.session_id == session_id)
        {
            if matches!(
                status.as_str(),
                "todo" | "running" | "blocked" | "completed" | "failed" | "cancelled"
            ) {
                apply_task_status(task, status, now);
            } else {
                task.updated_at = now;
            }
            if !report.summary.is_empty() {
                task.result_summary = Some(report.summary.clone());
            }
            if !report.artifacts.is_empty() {
                if report.report_type == "artifact" {
                    task.artifacts.extend(report.artifacts.clone());
                } else {
                    task.artifacts = report.artifacts.clone();
                }
            }
            if !report.artifact_ids.is_empty() {
                if report.report_type == "artifact" {
                    for artifact_id in report.artifact_ids.iter() {
                        if !task.artifact_ids.contains(artifact_id) {
                            task.artifact_ids.push(artifact_id.clone());
                        }
                    }
                } else {
                    task.artifact_ids = report.artifact_ids.clone();
                }
            }
            if report.progress_percent.is_some() {
                task.progress_percent = report.progress_percent;
            }
            updated_task = Some(task.clone());
        }
    }
    if let Some(task) = updated_task.as_ref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, task, Some(&report));
        }
    }
    if status_is_completed {
        promote_ready_dependents(store, &session_id, now);
    }

    touch_session(store, &session_id, now);
    Ok(report)
}

pub fn attach_collab_artifact(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabProgressReportRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    validate_session(store, &session_id)?;
    validate_task(store, &session_id, &task_id)?;

    let mut artifacts = value_vec(payload, "artifacts").unwrap_or_default();
    if let Some(artifact) = payload.get("artifact").filter(|value| value.is_object()) {
        artifacts.push(artifact.clone());
    }
    let artifact_ids = value_string_array(payload, "artifactIds");
    if artifacts.is_empty() && artifact_ids.is_empty() {
        return Err("缺少 artifact 或 artifactIds".to_string());
    }

    let report_payload = json!({
        "sessionId": session_id,
        "memberId": value_string(payload, "memberId").ok_or_else(|| "缺少 memberId".to_string())?,
        "taskId": task_id,
        "status": value_string(payload, "status").unwrap_or_else(|| "running".to_string()),
        "reportType": "artifact",
        "summary": value_string(payload, "summary").unwrap_or_else(|| "已附加任务产物。".to_string()),
        "artifacts": artifacts,
        "artifactIds": artifact_ids,
        "payload": value_object(payload, "payload").unwrap_or_else(|| json!({}))
    });
    submit_collab_report(store, &report_payload)
}

pub fn raise_collab_blocker(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabProgressReportRecord, String> {
    let blocker = value_string(payload, "blocker")
        .or_else(|| value_string(payload, "summary"))
        .unwrap_or_else(|| "任务被阻塞".to_string());
    let mut report_payload = payload.clone();
    let object = report_payload
        .as_object_mut()
        .ok_or_else(|| "blocker payload must be an object".to_string())?;
    object
        .entry("status".to_string())
        .or_insert_with(|| json!("blocked"));
    object
        .entry("reportType".to_string())
        .or_insert_with(|| json!("blocker"));
    object
        .entry("summary".to_string())
        .or_insert_with(|| json!(blocker.clone()));
    object
        .entry("blockers".to_string())
        .or_insert_with(|| json!([blocker]));
    submit_collab_report(store, &report_payload)
}

pub fn request_collab_report(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMailboxMessageRecord, String> {
    let mut request_payload = payload.clone();
    let object = request_payload
        .as_object_mut()
        .ok_or_else(|| "request report payload must be an object".to_string())?;
    object
        .entry("kind".to_string())
        .or_insert_with(|| Value::String("report_request".to_string()));
    object
        .entry("messageType".to_string())
        .or_insert_with(|| Value::String("report_request".to_string()));
    object
        .entry("fromKind".to_string())
        .or_insert_with(|| Value::String("system".to_string()));
    object.entry("body".to_string()).or_insert_with(|| {
        Value::String("请提交当前任务进度、阻塞点、下一步和可用产物。".to_string())
    });
    post_collab_message(store, &request_payload)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn collab_report_updates_member_and_task_board_state() {
        let mut store = AppStore::default();
        let session = create_collab_session(
            &mut store,
            &json!({
                "title": "视频工作流改造",
                "objective": "让团队成员并行处理视频任务",
                "runtimeMode": "default"
            }),
        )
        .unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "视频工程师",
                "roleId": "video-engineer",
                "capabilities": ["ffmpeg"]
            }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "生成剪辑任务 DAG",
                "objective": "把视频处理拆成可追踪任务",
                "priority": 8
            }),
        )
        .unwrap();

        let report = submit_collab_report(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "status": "running",
                "summary": "已完成任务 DAG 初版",
                "nextAction": "接入执行器",
                "blockers": []
            }),
        )
        .unwrap();

        assert_eq!(report.status, "running");
        let snapshot = collab_session_snapshot(&store, &session.id, None, None).unwrap();
        assert_eq!(
            snapshot.members[0].current_task_id.as_deref(),
            Some(task.id.as_str())
        );
        assert_eq!(snapshot.members[0].status, "working");
        assert_eq!(snapshot.tasks[0].status, "running");
        assert_eq!(
            snapshot.tasks[0].result_summary.as_deref(),
            Some("已完成任务 DAG 初版")
        );
        assert_eq!(snapshot.reports.len(), 1);
    }

    #[test]
    fn collab_report_cleanup_keeps_latest_reports_per_task() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "report cleanup" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "Reporter" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "Long task",
                "objective": "Generate many progress reports"
            }),
        )
        .unwrap();
        let other_task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "Other task",
                "objective": "Keep separate report retention"
            }),
        )
        .unwrap();

        for index in 0..205 {
            submit_collab_report(
                &mut store,
                &json!({
                    "sessionId": session.id,
                    "memberId": member.id,
                    "taskId": task.id,
                    "status": "running",
                    "summary": format!("report-{index}")
                }),
            )
            .unwrap();
        }
        submit_collab_report(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": other_task.id,
                "status": "running",
                "summary": "other-report"
            }),
        )
        .unwrap();

        let task_reports = list_collab_reports(&store, &session.id, Some(&task.id), None, None);
        let other_reports =
            list_collab_reports(&store, &session.id, Some(&other_task.id), None, None);
        let updated_task = store
            .collab_tasks
            .iter()
            .find(|item| item.id == task.id)
            .unwrap();

        assert_eq!(task_reports.len(), 200);
        assert_eq!(other_reports.len(), 1);
        assert_eq!(task_reports.first().unwrap().summary, "report-5");
        assert_eq!(task_reports.last().unwrap().summary, "report-204");
        assert!(updated_task.artifacts.iter().any(|artifact| {
            artifact.get("kind").and_then(Value::as_str) == Some("collab-report-archive")
                && artifact.get("removedCount").and_then(Value::as_u64) == Some(1)
        }));
    }

    #[test]
    fn collab_member_promotes_knowledge_binding_metadata() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "member knowledge" })).unwrap();

        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "法规研究员",
                "advisorId": "advisor-law",
                "sourceId": "advisor:advisor-law",
                "metadata": {
                    "specialty": "claims"
                }
            }),
        )
        .unwrap();

        let metadata = member.metadata.unwrap();
        assert_eq!(
            metadata.get("advisorId").and_then(Value::as_str),
            Some("advisor-law")
        );
        assert_eq!(
            metadata.get("sourceId").and_then(Value::as_str),
            Some("advisor:advisor-law")
        );
        assert_eq!(
            metadata.get("specialty").and_then(Value::as_str),
            Some("claims")
        );
    }

    #[test]
    fn collab_task_dependency_must_belong_to_same_session() {
        let mut store = AppStore::default();
        let first = create_collab_session(&mut store, &json!({ "objective": "first" })).unwrap();
        let second = create_collab_session(&mut store, &json!({ "objective": "second" })).unwrap();
        let external = create_collab_task(
            &mut store,
            &json!({
                "sessionId": first.id,
                "title": "外部任务"
            }),
        )
        .unwrap();

        let result = create_collab_task(
            &mut store,
            &json!({
                "sessionId": second.id,
                "title": "错误依赖",
                "dependsOnTaskIds": [external.id]
            }),
        );

        assert!(result.is_err());
    }

    #[test]
    fn collab_task_dependency_updates_reverse_blocks() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "deps" })).unwrap();
        let first = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "先做"
            }),
        )
        .unwrap();
        let second = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "后做"
            }),
        )
        .unwrap();
        let dependent = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "依赖任务",
                "dependsOnTaskIds": [first.id.clone()]
            }),
        )
        .unwrap();

        let first_after_create = store
            .collab_tasks
            .iter()
            .find(|task| task.id == first.id)
            .unwrap();
        assert!(first_after_create.blocks_task_ids.contains(&dependent.id));

        update_collab_task(
            &mut store,
            &json!({
                "taskId": dependent.id.clone(),
                "dependsOnTaskIds": [second.id.clone()]
            }),
        )
        .unwrap();

        let first_after_update = store
            .collab_tasks
            .iter()
            .find(|task| task.id == first.id)
            .unwrap();
        let second_after_update = store
            .collab_tasks
            .iter()
            .find(|task| task.id == second.id)
            .unwrap();
        assert!(!first_after_update.blocks_task_ids.contains(&dependent.id));
        assert!(second_after_update.blocks_task_ids.contains(&dependent.id));
    }

    #[test]
    fn collab_task_completion_promotes_dependents_to_ready() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "promote" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "成员" }),
        )
        .unwrap();
        let upstream = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "上游"
            }),
        )
        .unwrap();
        let downstream = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "下游",
                "status": "blocked",
                "dependsOnTaskIds": [upstream.id.clone()],
                "blockedByTaskIds": [upstream.id.clone()]
            }),
        )
        .unwrap();

        submit_collab_report(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": upstream.id,
                "status": "completed",
                "summary": "上游完成"
            }),
        )
        .unwrap();

        let downstream = store
            .collab_tasks
            .iter()
            .find(|task| task.id == downstream.id)
            .unwrap();
        assert_eq!(downstream.status, "ready");
        assert!(downstream.blocked_by_task_ids.is_empty());
    }

    #[test]
    fn collab_member_spawn_persists_agent_card_profile() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "profile" })).unwrap();

        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "研究员",
                "roleId": "researcher",
                "capabilities": ["knowledge_retrieval"]
            }),
        )
        .unwrap();

        let agent_card = member
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("agentCard"))
            .expect("agent card should be persisted");
        assert_eq!(
            agent_card.get("memberId").and_then(Value::as_str),
            Some(member.id.as_str())
        );
        assert_eq!(
            agent_card.get("displayName").and_then(Value::as_str),
            Some("研究员")
        );
        assert_eq!(
            agent_card.get("roleId").and_then(Value::as_str),
            Some("researcher")
        );
        assert_eq!(
            agent_card
                .pointer("/capacity/maxExecutorThreads")
                .and_then(Value::as_i64),
            Some(5)
        );
        assert!(agent_card
            .get("preferredTasks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|value| value == "research"));
    }

    #[test]
    fn collab_member_match_prefers_task_specific_agent_card() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "visual production" }))
                .unwrap();
        add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "研究员",
                "roleId": "researcher",
                "capabilities": ["knowledge_retrieval"]
            }),
        )
        .unwrap();
        add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "图片导演",
                "roleId": "image-director",
                "capabilities": ["image_generation"],
                "allowedTools": ["image.generate"]
            }),
        )
        .unwrap();

        let result = match_collab_members_for_task(
            &store,
            &json!({
                "sessionId": session.id,
                "title": "生成封面图",
                "objective": "用生图工具生成封面和视觉方案",
                "taskType": "image_generation",
                "requiredCapabilities": ["image_generation"],
                "requiredToolFamilies": ["image.generate"],
                "limit": 2
            }),
        )
        .unwrap();

        let first = result
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .expect("candidate should exist");
        assert_eq!(
            first.get("roleId").and_then(Value::as_str),
            Some("image-director")
        );
        assert!(first
            .get("reasons")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|value| value
                .as_str()
                .unwrap_or_default()
                .starts_with("preferred_task")));
    }

    #[test]
    fn collab_member_agent_card_allows_custom_profile_overlay() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "custom profile" })).unwrap();

        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "审稿人",
                "roleId": "reviewer",
                "metadata": {
                    "agentCard": {
                        "oneLine": "专门检查交付风险",
                        "preferredTasks": ["acceptance_check"]
                    }
                }
            }),
        )
        .unwrap();

        let agent_card = member
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("agentCard"))
            .unwrap();
        assert_eq!(
            agent_card.get("oneLine").and_then(Value::as_str),
            Some("专门检查交付风险")
        );
        assert!(agent_card
            .get("preferredTasks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .any(|value| value == "acceptance_check"));
    }

    #[test]
    fn collab_member_task_plan_tracks_assignment_and_completion_claim() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "plan" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "执行者" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "执行任务",
                "status": "running"
            }),
        )
        .unwrap();

        let report = submit_collab_report(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "status": "completed",
                "summary": "完成任务",
                "evidence": [{ "kind": "file", "path": "workspace://done.md" }],
                "handoff": "交给 reviewer",
                "risks": []
            }),
        )
        .unwrap();

        assert_eq!(report.report_type, "completion");
        assert!(report
            .payload
            .as_ref()
            .and_then(|payload| payload.get("completionClaim"))
            .is_some());
        let member = store
            .collab_members
            .iter()
            .find(|item| item.id == member.id)
            .unwrap();
        let plan = member
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("memberTaskPlan"))
            .unwrap();
        assert_eq!(
            plan.pointer("/tasks/0/status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            plan.pointer("/speechQueue/0/reason")
                .and_then(Value::as_str),
            Some("completion")
        );
    }

    #[test]
    fn collab_member_executor_capacity_blocks_extra_running_tasks() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "capacity" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "有限执行者",
                "metadata": {
                    "agentCard": {
                        "capacity": { "maxExecutorThreads": 1, "defaultExecutorThreads": 1 }
                    }
                }
            }),
        )
        .unwrap();
        create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "第一个任务",
                "status": "running"
            }),
        )
        .unwrap();

        let result = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "第二个任务",
                "status": "running"
            }),
        );

        assert!(result.is_err());
    }

    #[test]
    fn collab_artifact_and_blocker_helpers_submit_structured_reports() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "helpers" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "成员" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "title": "产物任务"
            }),
        )
        .unwrap();

        let artifact_report = attach_collab_artifact(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "artifact": { "kind": "note", "path": "workspace://a.md" }
            }),
        )
        .unwrap();
        assert_eq!(artifact_report.report_type, "artifact");
        let blocker_report = raise_collab_blocker(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "blocker": "等待输入"
            }),
        )
        .unwrap();
        assert_eq!(blocker_report.report_type, "blocker");
        assert_eq!(blocker_report.status, "blocked");
    }

    #[test]
    fn collab_task_lifecycle_claims_once_and_pins_resume_pointer() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "canonical task" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "执行者" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "统一任务",
                "source": "chat",
                "maxAttempts": 2
            }),
        )
        .unwrap();

        let claimed = transition_collab_task(
            &mut store,
            &json!({
                "taskId": task.id,
                "memberId": member.id,
                "leaseOwner": "worker-1",
                "leaseExpiresAt": 12345
            }),
            "claim",
        )
        .unwrap();
        assert_eq!(claimed.status, "claimed");
        assert_eq!(claimed.source, "chat");
        assert_eq!(claimed.lease_owner.as_deref(), Some("worker-1"));

        let duplicate = transition_collab_task(
            &mut store,
            &json!({ "taskId": claimed.id, "leaseOwner": "worker-2" }),
            "claim",
        );
        assert!(duplicate.is_err());

        let running =
            transition_collab_task(&mut store, &json!({ "taskId": claimed.id }), "start").unwrap();
        assert_eq!(running.status, "running");
        assert!(running.started_at.is_some());

        let pinned = pin_collab_task_session(
            &mut store,
            &json!({
                "taskId": running.id,
                "sessionResumeId": "agent-session-1",
                "workDir": "/tmp/redconvert-task"
            }),
        )
        .unwrap();
        assert_eq!(pinned.session_resume_id.as_deref(), Some("agent-session-1"));
        assert_eq!(pinned.work_dir.as_deref(), Some("/tmp/redconvert-task"));
    }

    #[test]
    fn collab_task_retry_preserves_parent_and_attempt() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "retry" })).unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "可重试任务",
                "maxAttempts": 2
            }),
        )
        .unwrap();
        let claimed = transition_collab_task(
            &mut store,
            &json!({ "taskId": task.id, "leaseOwner": "worker-1" }),
            "claim",
        )
        .unwrap();
        let running =
            transition_collab_task(&mut store, &json!({ "taskId": claimed.id }), "start").unwrap();
        let failed = transition_collab_task(
            &mut store,
            &json!({
                "taskId": running.id,
                "failureReason": "runtime_recovery",
                "sessionResumeId": "agent-session-1"
            }),
            "fail",
        )
        .unwrap();
        assert_eq!(failed.status, "failed");

        let retry = retry_collab_task(&mut store, &json!({ "taskId": failed.id })).unwrap();
        assert_eq!(retry.parent_task_id.as_deref(), Some(failed.id.as_str()));
        assert_eq!(retry.attempt, 2);
        assert_eq!(retry.max_attempts, 2);
        assert_eq!(retry.session_resume_id.as_deref(), Some("agent-session-1"));
        assert_eq!(retry.status, "queued");

        let exhausted = retry_collab_task(&mut store, &json!({ "taskId": retry.id }));
        assert!(exhausted.is_err());
    }

    #[test]
    fn review_docket_pauses_and_resumes_linked_task() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "review docket" })).unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({
                "sessionId": session.id,
                "title": "等待审批的任务",
                "status": "running"
            }),
        )
        .unwrap();

        let docket = create_review_docket(
            &mut store,
            &json!({
                "sourceKind": "team",
                "taskId": task.id,
                "title": "确认是否继续",
                "summary": "AI 需要人类批准继续执行",
                "decisionType": "approve",
                "proposedAction": {
                    "onDecisionTaskStatus": {
                        "approved": "running",
                        "rejected": "failed"
                    }
                }
            }),
        )
        .unwrap();
        assert_eq!(docket.status, "pending");
        let paused = store
            .collab_tasks
            .iter()
            .find(|item| item.id == task.id)
            .unwrap();
        assert_eq!(paused.status, "waiting_for_review");

        let decision = decide_review_docket(
            &mut store,
            &json!({
                "docketId": docket.id,
                "decision": "approve",
                "comment": "准"
            }),
        )
        .unwrap();
        assert_eq!(decision.decision, "approved");
        let resumed = store
            .collab_tasks
            .iter()
            .find(|item| item.id == task.id)
            .unwrap();
        assert_eq!(resumed.status, "running");
        let decided = store
            .review_dockets
            .iter()
            .find(|item| item.id == docket.id)
            .unwrap();
        assert_eq!(decided.status, "approved");
        assert!(decided.decided_at.is_some());
    }

    #[test]
    fn review_docket_cannot_be_decided_twice() {
        let mut store = AppStore::default();
        let docket = create_review_docket(
            &mut store,
            &json!({
                "sourceKind": "scheduler",
                "title": "创建自动任务",
                "summary": "是否允许创建自动任务"
            }),
        )
        .unwrap();
        decide_review_docket(
            &mut store,
            &json!({ "docketId": docket.id, "decision": "reject" }),
        )
        .unwrap();
        let duplicate = decide_review_docket(
            &mut store,
            &json!({ "docketId": docket.id, "decision": "approve" }),
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn review_docket_stats_counts_pending_and_expired() {
        let mut store = AppStore::default();
        let expired_at = now_i64() - 1;
        let pending = create_review_docket(
            &mut store,
            &json!({
                "sourceKind": "scheduler",
                "title": "过期审批",
                "summary": "需要尽快处理",
                "expiresAt": expired_at
            }),
        )
        .unwrap();
        let approved = create_review_docket(
            &mut store,
            &json!({
                "sourceKind": "team",
                "title": "已批准审批",
                "summary": "完成验收"
            }),
        )
        .unwrap();

        decide_review_docket(
            &mut store,
            &json!({ "docketId": approved.id, "decision": "approve" }),
        )
        .unwrap();

        let stats = review_docket_stats(&store);
        assert_eq!(stats["total"], 2);
        assert_eq!(stats["pending"], 1);
        assert_eq!(stats["approved"], 1);
        assert_eq!(stats["expiredPending"], 1);
        assert_eq!(pending.status, "pending");
    }
}
