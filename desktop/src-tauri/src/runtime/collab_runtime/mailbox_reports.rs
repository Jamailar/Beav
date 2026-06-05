use super::*;

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
