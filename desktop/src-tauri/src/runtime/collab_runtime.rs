use serde_json::Value;

use crate::runtime::{
    CollabMailboxMessageRecord, CollabMemberRecord, CollabProgressReportRecord,
    CollabSessionRecord, CollabSessionSnapshot, CollabTaskRecord,
};
use crate::{make_id, now_i64, AppStore};

const DEFAULT_PROGRESS_INTERVAL_MS: i64 = 15 * 60 * 1000;

fn value_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn value_i64(payload: &Value, key: &str) -> Option<i64> {
    payload.get(key).and_then(Value::as_i64)
}

fn value_string_array(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn value_vec(payload: &Value, key: &str) -> Option<Vec<Value>> {
    payload.get(key).and_then(Value::as_array).cloned()
}

fn value_object(payload: &Value, key: &str) -> Option<Value> {
    payload.get(key).filter(|value| value.is_object()).cloned()
}

fn member_metadata_from_payload(payload: &Value) -> Option<Value> {
    let mut object = value_object(payload, "metadata")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for key in [
        "advisorId",
        "sourceId",
        "knowledgeSourceId",
        "rootPath",
        "knowledgeRootPath",
    ] {
        if object.contains_key(key) {
            continue;
        }
        if let Some(value) = payload.get(key).cloned() {
            object.insert(key.to_string(), value);
        }
    }
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object))
    }
}

fn next_collab_id(prefix: &str, exists: impl Fn(&str) -> bool) -> String {
    let base = make_id(prefix);
    if !exists(&base) {
        return base;
    }
    for attempt in 1..1000 {
        let candidate = format!("{base}-{attempt}");
        if !exists(&candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", now_i64())
}

fn session_exists(store: &AppStore, session_id: &str) -> bool {
    store
        .collab_sessions
        .iter()
        .any(|session| session.id == session_id)
}

fn touch_session(store: &mut AppStore, session_id: &str, now: i64) {
    if let Some(session) = store
        .collab_sessions
        .iter_mut()
        .find(|session| session.id == session_id)
    {
        session.updated_at = now;
    }
}

fn validate_session(store: &AppStore, session_id: &str) -> Result<(), String> {
    if session_exists(store, session_id) {
        Ok(())
    } else {
        Err("协作会话不存在".to_string())
    }
}

fn validate_member(store: &AppStore, session_id: &str, member_id: &str) -> Result<(), String> {
    if store
        .collab_members
        .iter()
        .any(|member| member.session_id == session_id && member.id == member_id)
    {
        Ok(())
    } else {
        Err("协作成员不存在或不属于该会话".to_string())
    }
}

fn validate_task(store: &AppStore, session_id: &str, task_id: &str) -> Result<(), String> {
    if store
        .collab_tasks
        .iter()
        .any(|task| task.session_id == session_id && task.id == task_id)
    {
        Ok(())
    } else {
        Err("协作任务不存在或不属于该会话".to_string())
    }
}

fn apply_task_status(task: &mut CollabTaskRecord, status: String, now: i64) {
    task.status = status.clone();
    task.updated_at = now;
    if matches!(status.as_str(), "running" | "blocked") && task.started_at.is_none() {
        task.started_at = Some(now);
    }
    if matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        task.completed_at = Some(now);
    }
}

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

pub fn list_collab_tasks(store: &AppStore, session_id: &str) -> Vec<CollabTaskRecord> {
    let mut tasks: Vec<CollabTaskRecord> = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .cloned()
        .collect();
    tasks.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    tasks
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
    let member = CollabMemberRecord {
        id: next_collab_id("collab-member", |candidate| {
            store
                .collab_members
                .iter()
                .any(|member| member.id == candidate)
        }),
        session_id: session_id.clone(),
        display_name: value_string(payload, "displayName")
            .or_else(|| value_string(payload, "name"))
            .unwrap_or_else(|| "协作成员".to_string()),
        role_id: value_string(payload, "roleId").unwrap_or_else(|| "executor".to_string()),
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
        capabilities: value_string_array(payload, "capabilities"),
        allowed_tools: value_string_array(payload, "allowedTools"),
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
        metadata: member_metadata_from_payload(payload),
        created_at: now,
        updated_at: now,
    };
    store.collab_members.push(member.clone());
    touch_session(store, &session_id, now);
    Ok(member)
}

pub fn create_collab_task(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    if let Some(member_id) = value_string(payload, "memberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(reviewer_member_id) = value_string(payload, "reviewerMemberId") {
        validate_member(store, &session_id, &reviewer_member_id)?;
        if value_string(payload, "memberId").as_deref() == Some(reviewer_member_id.as_str()) {
            return Err("任务负责人不能同时作为 reviewer".to_string());
        }
    }
    for task_id in value_string_array(payload, "dependsOnTaskIds") {
        validate_task(store, &session_id, &task_id)?;
    }

    let objective = value_string(payload, "objective")
        .or_else(|| value_string(payload, "goal"))
        .unwrap_or_else(|| "执行协作任务".to_string());
    let now = now_i64();
    let task = CollabTaskRecord {
        id: next_collab_id("collab-task", |candidate| {
            store.collab_tasks.iter().any(|task| task.id == candidate)
        }),
        session_id: session_id.clone(),
        parent_task_id: value_string(payload, "parentTaskId"),
        member_id: value_string(payload, "memberId"),
        reviewer_member_id: value_string(payload, "reviewerMemberId"),
        title: value_string(payload, "title").unwrap_or_else(|| {
            objective
                .chars()
                .take(56)
                .collect::<String>()
                .trim()
                .to_string()
        }),
        description: value_string(payload, "description").unwrap_or_else(|| objective.clone()),
        objective,
        status: value_string(payload, "status").unwrap_or_else(|| "todo".to_string()),
        priority: value_i64(payload, "priority").unwrap_or(0),
        task_type: value_string(payload, "taskType").unwrap_or_else(|| "work".to_string()),
        depends_on_task_ids: value_string_array(payload, "dependsOnTaskIds"),
        blocked_by_task_ids: value_string_array(payload, "blockedByTaskIds"),
        blocks_task_ids: value_string_array(payload, "blocksTaskIds"),
        runtime_task_id: value_string(payload, "runtimeTaskId"),
        external_task_ref: value_string(payload, "externalTaskRef"),
        result_summary: None,
        progress_percent: value_i64(payload, "progressPercent").map(|value| value.clamp(0, 100)),
        artifacts: value_vec(payload, "artifacts").unwrap_or_default(),
        artifact_ids: value_string_array(payload, "artifactIds"),
        due_at: value_i64(payload, "dueAt"),
        metadata: value_object(payload, "metadata"),
        created_at: now,
        updated_at: now,
        started_at: None,
        completed_at: None,
    };
    store.collab_tasks.push(task.clone());
    touch_session(store, &session_id, now);
    Ok(task)
}

pub fn update_collab_task(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    let task_index = store
        .collab_tasks
        .iter()
        .position(|task| task.id == task_id)
        .ok_or_else(|| "协作任务不存在".to_string())?;
    let session_id = store.collab_tasks[task_index].session_id.clone();
    if let Some(member_id) = value_string(payload, "memberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(reviewer_member_id) = value_string(payload, "reviewerMemberId") {
        validate_member(store, &session_id, &reviewer_member_id)?;
        let owner_member_id = value_string(payload, "memberId")
            .or_else(|| store.collab_tasks[task_index].member_id.clone());
        if owner_member_id.as_deref() == Some(reviewer_member_id.as_str()) {
            return Err("任务负责人不能同时作为 reviewer".to_string());
        }
    }
    for task_id in value_string_array(payload, "dependsOnTaskIds") {
        validate_task(store, &session_id, &task_id)?;
    }

    let now = now_i64();
    let task = &mut store.collab_tasks[task_index];
    if let Some(value) = value_string(payload, "title") {
        task.title = value;
    }
    if let Some(value) =
        value_string(payload, "objective").or_else(|| value_string(payload, "goal"))
    {
        task.objective = value;
    }
    if let Some(value) = value_string(payload, "memberId") {
        task.member_id = Some(value);
    }
    if payload.get("memberId").is_some() && value_string(payload, "memberId").is_none() {
        task.member_id = None;
    }
    if let Some(value) = value_string(payload, "reviewerMemberId") {
        task.reviewer_member_id = Some(value);
    }
    if payload.get("reviewerMemberId").is_some()
        && value_string(payload, "reviewerMemberId").is_none()
    {
        task.reviewer_member_id = None;
    }
    if let Some(value) = value_string(payload, "description") {
        task.description = value;
    }
    if let Some(value) = value_i64(payload, "priority") {
        task.priority = value;
    }
    if let Some(value) = value_string(payload, "taskType") {
        task.task_type = value;
    }
    if payload.get("dependsOnTaskIds").is_some() {
        task.depends_on_task_ids = value_string_array(payload, "dependsOnTaskIds");
    }
    if payload.get("blockedByTaskIds").is_some() {
        task.blocked_by_task_ids = value_string_array(payload, "blockedByTaskIds");
    }
    if payload.get("blocksTaskIds").is_some() {
        task.blocks_task_ids = value_string_array(payload, "blocksTaskIds");
    }
    if let Some(value) = value_string(payload, "runtimeTaskId") {
        task.runtime_task_id = Some(value);
    }
    if let Some(value) = value_string(payload, "externalTaskRef") {
        task.external_task_ref = Some(value);
    }
    if let Some(value) = value_string(payload, "resultSummary") {
        task.result_summary = Some(value);
    }
    if let Some(value) = value_i64(payload, "progressPercent") {
        task.progress_percent = Some(value.clamp(0, 100));
    }
    if let Some(value) = value_vec(payload, "artifacts") {
        task.artifacts = value;
    }
    if payload.get("artifactIds").is_some() {
        task.artifact_ids = value_string_array(payload, "artifactIds");
    }
    if let Some(value) = value_i64(payload, "dueAt") {
        task.due_at = Some(value);
    }
    if let Some(value) = value_object(payload, "metadata") {
        task.metadata = Some(value);
    }
    if let Some(status) = value_string(payload, "status") {
        apply_task_status(task, status, now);
    } else {
        task.updated_at = now;
    }
    let updated = task.clone();
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
    let mut read_messages: Vec<CollabMailboxMessageRecord> = store
        .collab_mailbox_messages
        .iter()
        .filter(|message| message.session_id == session_id && message.read_at.is_some())
        .cloned()
        .collect();
    if read_messages.len() <= keep_latest {
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
            || keep_ids.contains(&message.id)
    });
    before.saturating_sub(store.collab_mailbox_messages.len())
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
        summary: value_string(payload, "summary").unwrap_or_default(),
        next_action: value_string(payload, "nextAction"),
        next_steps: value_string_array(payload, "nextSteps"),
        progress_percent: value_i64(payload, "progressPercent").map(|value| value.clamp(0, 100)),
        blockers: value_string_array(payload, "blockers"),
        artifacts: value_vec(payload, "artifacts").unwrap_or_default(),
        artifact_ids: value_string_array(payload, "artifactIds"),
        payload: value_object(payload, "payload"),
        created_at: now,
    };
    store.collab_progress_reports.push(report.clone());

    if let Some(member) = store
        .collab_members
        .iter_mut()
        .find(|member| member.id == member_id && member.session_id == session_id)
    {
        member.status = value_string(payload, "memberStatus").unwrap_or_else(|| {
            if status == "blocked" {
                "blocked".to_string()
            } else {
                "working".to_string()
            }
        });
        member.current_task_id = report.task_id.clone().or(member.current_task_id.clone());
        member.last_seen_at = Some(now);
        member.last_report_at = Some(now);
        member.updated_at = now;
    }

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
                task.artifacts = report.artifacts.clone();
            }
            if !report.artifact_ids.is_empty() {
                task.artifact_ids = report.artifact_ids.clone();
            }
            if report.progress_percent.is_some() {
                task.progress_percent = report.progress_percent;
            }
        }
    }

    touch_session(store, &session_id, now);
    Ok(report)
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
    use serde_json::{json, Value};

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
                "capabilities": ["ffmpeg", "remotion"]
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
}
