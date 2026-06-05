use super::*;

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
