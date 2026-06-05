use super::*;

pub fn list_review_dockets(store: &AppStore, payload: &Value) -> Vec<ReviewDocketRecord> {
    let status = value_string(payload, "status");
    let source_kind = value_string(payload, "sourceKind");
    let task_id = value_string(payload, "taskId");
    let session_id = value_string(payload, "sessionId");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize);
    let mut dockets: Vec<ReviewDocketRecord> = store
        .review_dockets
        .iter()
        .filter(|docket| {
            status
                .as_ref()
                .map_or(true, |value| docket.status == *value)
        })
        .filter(|docket| {
            source_kind
                .as_ref()
                .map_or(true, |value| docket.source_kind == *value)
        })
        .filter(|docket| {
            task_id
                .as_ref()
                .map_or(true, |value| docket.task_id.as_ref() == Some(value))
        })
        .filter(|docket| {
            session_id
                .as_ref()
                .map_or(true, |value| docket.session_id.as_ref() == Some(value))
        })
        .cloned()
        .collect();
    dockets.sort_by(|a, b| {
        let status_rank = |status: &str| if status == "pending" { 0 } else { 1 };
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    if let Some(limit) = limit {
        dockets.truncate(limit);
    }
    dockets
}

pub fn get_review_docket(store: &AppStore, docket_id: &str) -> Option<ReviewDocketRecord> {
    store
        .review_dockets
        .iter()
        .find(|docket| docket.id == docket_id)
        .cloned()
}

pub fn review_docket_stats(store: &AppStore) -> Value {
    let now = now_i64();
    let total = store.review_dockets.len();
    let mut pending = 0usize;
    let mut approved = 0usize;
    let mut rejected = 0usize;
    let mut changes_requested = 0usize;
    let mut skipped = 0usize;
    let mut archived = 0usize;
    let mut expired_pending = 0usize;
    let mut linked_tasks = 0usize;

    for docket in &store.review_dockets {
        match docket.status.as_str() {
            "pending" => pending += 1,
            "approved" => approved += 1,
            "rejected" => rejected += 1,
            "changes_requested" => changes_requested += 1,
            "skipped" => skipped += 1,
            "archived" => archived += 1,
            _ => {}
        }
        if docket.status == "pending"
            && docket
                .expires_at
                .is_some_and(|expires_at| expires_at <= now)
        {
            expired_pending += 1;
        }
        if docket.task_id.is_some() {
            linked_tasks += 1;
        }
    }

    json!({
        "total": total,
        "pending": pending,
        "approved": approved,
        "rejected": rejected,
        "changesRequested": changes_requested,
        "skipped": skipped,
        "archived": archived,
        "expiredPending": expired_pending,
        "linkedTasks": linked_tasks,
    })
}

pub fn create_review_docket(
    store: &mut AppStore,
    payload: &Value,
) -> Result<ReviewDocketRecord, String> {
    let source_kind = value_string(payload, "sourceKind").unwrap_or_else(|| "team".to_string());
    let task_id = value_string(payload, "taskId");
    let session_id = value_string(payload, "sessionId").or_else(|| {
        task_id.as_ref().and_then(|task_id| {
            store
                .collab_tasks
                .iter()
                .find(|task| &task.id == task_id)
                .map(|task| task.session_id.clone())
        })
    });
    if let Some(session_id) = session_id.as_deref() {
        validate_session(store, session_id)?;
    }
    if let Some(task_id) = task_id.as_deref() {
        let task = store
            .collab_tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| "协作任务不存在".to_string())?;
        if let Some(session_id) = session_id.as_deref() {
            if task.session_id != session_id {
                return Err("审批项任务不属于指定协作会话".to_string());
            }
        }
    }
    let summary = value_string(payload, "summary")
        .or_else(|| value_string(payload, "body"))
        .unwrap_or_else(|| "需要人工审批".to_string());
    let now = now_i64();
    let docket = ReviewDocketRecord {
        id: next_collab_id("review-docket", |candidate| {
            store
                .review_dockets
                .iter()
                .any(|docket| docket.id == candidate)
        }),
        source_kind,
        source_id: value_string(payload, "sourceId"),
        session_id: session_id.clone(),
        task_id: task_id.clone(),
        title: value_string(payload, "title").unwrap_or_else(|| {
            summary
                .chars()
                .take(56)
                .collect::<String>()
                .trim()
                .to_string()
        }),
        summary,
        body: value_string(payload, "body").unwrap_or_default(),
        decision_type: value_string(payload, "decisionType")
            .unwrap_or_else(|| "approve".to_string()),
        priority: value_string(payload, "priority").unwrap_or_else(|| "normal".to_string()),
        status: "pending".to_string(),
        risk_level: value_string(payload, "riskLevel").unwrap_or_else(|| "medium".to_string()),
        proposed_action: value_object(payload, "proposedAction"),
        evidence_refs: value_array(payload, "evidenceRefs"),
        artifact_refs: value_string_array(payload, "artifactRefs"),
        options: value_array(payload, "options"),
        created_by_agent_id: value_string(payload, "createdByAgentId"),
        assigned_to_user_id: value_string(payload, "assignedToUserId"),
        expires_at: value_i64(payload, "expiresAt"),
        created_at: now,
        updated_at: now,
        decided_at: None,
    };
    if let Some(task_id) = task_id.as_deref() {
        let _ = transition_collab_task(
            store,
            &json!({
                "taskId": task_id,
                "metadata": {
                    "reviewDocketId": docket.id,
                    "reviewStatus": "pending"
                }
            }),
            "wait-review",
        )?;
    }
    store.review_dockets.push(docket.clone());
    Ok(docket)
}

fn decision_status(decision: &str) -> Result<&'static str, String> {
    match decision {
        "approve" | "approved" => Ok("approved"),
        "reject" | "rejected" => Ok("rejected"),
        "changes_requested" | "request_changes" | "requestChanges" => Ok("changes_requested"),
        "skip" | "skipped" => Ok("skipped"),
        other => Err(format!("未知审批决定：{other}")),
    }
}

fn task_status_for_decision(docket: &ReviewDocketRecord, decision_status: &str) -> Option<String> {
    docket
        .proposed_action
        .as_ref()
        .and_then(|action| action.get("onDecisionTaskStatus"))
        .and_then(|mapping| mapping.get(decision_status))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| match decision_status {
            "approved" => Some("running".to_string()),
            "rejected" => Some("failed".to_string()),
            "changes_requested" => Some("claimed".to_string()),
            _ => None,
        })
}

pub fn decide_review_docket(
    store: &mut AppStore,
    payload: &Value,
) -> Result<ReviewDecisionRecord, String> {
    let docket_id = value_string(payload, "docketId").ok_or_else(|| "缺少 docketId".to_string())?;
    let decision = value_string(payload, "decision").ok_or_else(|| "缺少 decision".to_string())?;
    let status = decision_status(&decision)?.to_string();
    let docket_index = store
        .review_dockets
        .iter()
        .position(|docket| docket.id == docket_id)
        .ok_or_else(|| "审批项不存在".to_string())?;
    if store.review_dockets[docket_index].status != "pending" {
        return Err("审批项已经处理".to_string());
    }
    let now = now_i64();
    let mut docket = store.review_dockets[docket_index].clone();
    docket.status = status.clone();
    docket.updated_at = now;
    docket.decided_at = Some(now);
    let record = ReviewDecisionRecord {
        id: next_collab_id("review-decision", |candidate| {
            store
                .review_decisions
                .iter()
                .any(|decision| decision.id == candidate)
        }),
        docket_id: docket.id.clone(),
        decision: status.clone(),
        comment: value_string(payload, "comment"),
        selected_option_id: value_string(payload, "selectedOptionId"),
        patch: value_object(payload, "patch"),
        decided_at: now,
    };
    store.review_dockets[docket_index] = docket.clone();
    store.review_decisions.push(record.clone());
    if let Some(task_id) = docket.task_id.as_deref() {
        if let Some(task_status) = value_string(payload, "taskStatus")
            .or_else(|| task_status_for_decision(&docket, &status))
        {
            let transition = match task_status.as_str() {
                "claimed" => "claim",
                "running" => "start",
                "waiting_for_review" => "wait-review",
                "completed" => "complete",
                "failed" => "fail",
                "cancelled" => "cancel",
                _ => "",
            };
            if transition.is_empty() {
                update_collab_task(
                    store,
                    &json!({
                        "taskId": task_id,
                        "status": task_status,
                        "metadata": {
                            "reviewDocketId": docket.id,
                            "reviewDecision": status
                        }
                    }),
                )?;
            } else {
                transition_collab_task(
                    store,
                    &json!({
                        "taskId": task_id,
                        "resultSummary": value_string(payload, "comment"),
                        "failureReason": status,
                        "metadata": {
                            "reviewDocketId": docket.id,
                            "reviewDecision": status
                        }
                    }),
                    transition,
                )?;
            }
        }
    }
    Ok(record)
}

pub fn archive_review_docket(
    store: &mut AppStore,
    payload: &Value,
    status: &str,
) -> Result<ReviewDocketRecord, String> {
    let docket_id = value_string(payload, "docketId").ok_or_else(|| "缺少 docketId".to_string())?;
    let now = now_i64();
    let docket = store
        .review_dockets
        .iter_mut()
        .find(|docket| docket.id == docket_id)
        .ok_or_else(|| "审批项不存在".to_string())?;
    if docket.status == "pending" {
        docket.status = status.to_string();
        docket.updated_at = now;
        docket.decided_at = Some(now);
    }
    Ok(docket.clone())
}
