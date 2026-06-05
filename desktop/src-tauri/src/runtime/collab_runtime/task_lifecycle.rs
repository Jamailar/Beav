use super::*;

pub fn list_collab_tasks(store: &AppStore, session_id: &str) -> Vec<CollabTaskRecord> {
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
    tasks
}

pub fn create_collab_task(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let session_id =
        value_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
    validate_session(store, &session_id)?;
    let assigned_member_id = value_string(payload, "memberId");
    if let Some(member_id) = assigned_member_id.as_deref() {
        validate_member(store, &session_id, &member_id)?;
    }
    if let Some(reviewer_member_id) = value_string(payload, "reviewerMemberId") {
        validate_member(store, &session_id, &reviewer_member_id)?;
        if assigned_member_id.as_deref() == Some(reviewer_member_id.as_str()) {
            return Err("任务负责人不能同时作为 reviewer".to_string());
        }
    }
    for task_id in value_string_array(payload, "dependsOnTaskIds") {
        validate_task(store, &session_id, &task_id)?;
    }

    let objective = value_string(payload, "objective")
        .or_else(|| value_string(payload, "goal"))
        .unwrap_or_else(|| "执行协作任务".to_string());
    let status = value_string(payload, "status").unwrap_or_else(|| "todo".to_string());
    if let Some(member_id) = assigned_member_id.as_deref() {
        validate_member_executor_capacity(store, &session_id, member_id, &status, None)?;
    }
    let now = now_i64();
    let task = CollabTaskRecord {
        id: next_collab_id("collab-task", |candidate| {
            store.collab_tasks.iter().any(|task| task.id == candidate)
        }),
        session_id: session_id.clone(),
        parent_task_id: value_string(payload, "parentTaskId"),
        source: value_string(payload, "source").unwrap_or_else(|| "user_board".to_string()),
        member_id: assigned_member_id,
        assignee_agent_id: value_string(payload, "assigneeAgentId"),
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
        status,
        priority: value_i64(payload, "priority").unwrap_or(0),
        task_type: value_string(payload, "taskType").unwrap_or_else(|| "work".to_string()),
        depends_on_task_ids: value_string_array(payload, "dependsOnTaskIds"),
        blocked_by_task_ids: value_string_array(payload, "blockedByTaskIds"),
        blocks_task_ids: value_string_array(payload, "blocksTaskIds"),
        runtime_task_id: value_string(payload, "runtimeTaskId"),
        external_task_ref: value_string(payload, "externalTaskRef"),
        attempt: value_i64(payload, "attempt").unwrap_or(1).max(1),
        max_attempts: value_i64(payload, "maxAttempts").unwrap_or(1).max(1),
        lease_owner: value_string(payload, "leaseOwner"),
        lease_expires_at: value_i64(payload, "leaseExpiresAt"),
        session_resume_id: value_string(payload, "sessionResumeId"),
        work_dir: value_string(payload, "workDir"),
        failure_reason: value_string(payload, "failureReason"),
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
    sync_task_dependency_links(store, &session_id);
    promote_ready_dependents(store, &session_id, now);
    let task = store
        .collab_tasks
        .iter()
        .find(|item| item.id == task.id)
        .cloned()
        .unwrap_or(task);
    if let Some(member_id) = task.member_id.as_deref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, &task, None);
        }
    }
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
    let next_member_id = if payload.get("memberId").is_some() {
        value_string(payload, "memberId")
    } else {
        store.collab_tasks[task_index].member_id.clone()
    };
    let next_status = value_string(payload, "status")
        .unwrap_or_else(|| store.collab_tasks[task_index].status.clone());
    if let Some(member_id) = next_member_id.as_deref() {
        validate_member_executor_capacity(
            store,
            &session_id,
            member_id,
            &next_status,
            Some(&task_id),
        )?;
    }

    let now = now_i64();
    let previous_member_id = store.collab_tasks[task_index].member_id.clone();
    let task = &mut store.collab_tasks[task_index];
    normalize_task_defaults(task);
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
    if let Some(value) = value_string(payload, "assigneeAgentId") {
        task.assignee_agent_id = Some(value);
    }
    if payload.get("assigneeAgentId").is_some()
        && value_string(payload, "assigneeAgentId").is_none()
    {
        task.assignee_agent_id = None;
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
    if let Some(value) = value_string(payload, "source") {
        task.source = value;
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
    if let Some(value) = value_i64(payload, "attempt") {
        task.attempt = value.max(1);
    }
    if let Some(value) = value_i64(payload, "maxAttempts") {
        task.max_attempts = value.max(1);
    }
    if let Some(value) = value_string(payload, "leaseOwner") {
        task.lease_owner = Some(value);
    }
    if payload.get("leaseOwner").is_some() && value_string(payload, "leaseOwner").is_none() {
        task.lease_owner = None;
    }
    if let Some(value) = value_i64(payload, "leaseExpiresAt") {
        task.lease_expires_at = Some(value);
    }
    if payload.get("leaseExpiresAt").is_some() && value_i64(payload, "leaseExpiresAt").is_none() {
        task.lease_expires_at = None;
    }
    if let Some(value) = value_string(payload, "sessionResumeId") {
        task.session_resume_id = Some(value);
    }
    if payload.get("sessionResumeId").is_some()
        && value_string(payload, "sessionResumeId").is_none()
    {
        task.session_resume_id = None;
    }
    if let Some(value) = value_string(payload, "workDir") {
        task.work_dir = Some(value);
    }
    if payload.get("workDir").is_some() && value_string(payload, "workDir").is_none() {
        task.work_dir = None;
    }
    if let Some(value) = value_string(payload, "failureReason") {
        task.failure_reason = Some(value);
    }
    if payload.get("failureReason").is_some() && value_string(payload, "failureReason").is_none() {
        task.failure_reason = None;
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
        if !valid_task_transition(&task.status, &status) {
            return Err(format!("非法任务状态变更：{} -> {}", task.status, status));
        }
        apply_task_status(task, status, now);
    } else {
        task.updated_at = now;
    }
    let updated_id = task.id.clone();
    sync_task_dependency_links(store, &session_id);
    promote_ready_dependents(store, &session_id, now);
    let updated = store
        .collab_tasks
        .iter()
        .find(|task| task.id == updated_id)
        .cloned()
        .ok_or_else(|| "协作任务不存在".to_string())?;
    if let Some(member_id) = updated.member_id.as_deref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, &updated, None);
        }
    }
    if previous_member_id.as_deref() != updated.member_id.as_deref() {
        if let Some(previous_member_id) = previous_member_id.as_deref() {
            remove_member_task_from_plan(store, &session_id, previous_member_id, &updated.id);
        }
    }
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn transition_collab_task(
    store: &mut AppStore,
    payload: &Value,
    transition: &str,
) -> Result<CollabTaskRecord, String> {
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    let task_index = store
        .collab_tasks
        .iter()
        .position(|task| task.id == task_id)
        .ok_or_else(|| "协作任务不存在".to_string())?;
    let session_id = store.collab_tasks[task_index].session_id.clone();
    let previous_member_id = store.collab_tasks[task_index].member_id.clone();
    if let Some(member_id) = value_string(payload, "memberId") {
        validate_member(store, &session_id, &member_id)?;
    }
    let now = now_i64();
    let task = &mut store.collab_tasks[task_index];
    normalize_task_defaults(task);
    let next_status = match transition {
        "claim" => {
            if matches!(
                task.status.as_str(),
                "claimed" | "running" | "completed" | "failed" | "cancelled"
            ) {
                return Err("任务已经被领取或已结束".to_string());
            }
            if let Some(member_id) = value_string(payload, "memberId") {
                if task
                    .member_id
                    .as_deref()
                    .is_some_and(|current| current != member_id)
                {
                    return Err("任务已分配给其他成员".to_string());
                }
                task.member_id = Some(member_id);
            }
            if let Some(agent_id) = value_string(payload, "assigneeAgentId") {
                task.assignee_agent_id = Some(agent_id);
            }
            task.lease_owner = value_string(payload, "leaseOwner")
                .or_else(|| task.member_id.clone())
                .or_else(|| task.assignee_agent_id.clone());
            task.lease_expires_at = value_i64(payload, "leaseExpiresAt");
            "claimed"
        }
        "start" => {
            if let Some(owner) = value_string(payload, "leaseOwner") {
                task.lease_owner = Some(owner);
            }
            if let Some(expires_at) = value_i64(payload, "leaseExpiresAt") {
                task.lease_expires_at = Some(expires_at);
            }
            "running"
        }
        "wait-review" | "waiting-for-review" => {
            task.lease_owner = None;
            task.lease_expires_at = None;
            "waiting_for_review"
        }
        "complete" => {
            task.result_summary = value_string(payload, "resultSummary")
                .or_else(|| value_string(payload, "summary"))
                .or_else(|| task.result_summary.clone());
            task.lease_owner = None;
            task.lease_expires_at = None;
            "completed"
        }
        "fail" => {
            task.failure_reason = value_string(payload, "failureReason")
                .or_else(|| value_string(payload, "reason"))
                .or_else(|| task.failure_reason.clone());
            task.result_summary = value_string(payload, "resultSummary")
                .or_else(|| value_string(payload, "summary"))
                .or_else(|| task.result_summary.clone());
            task.lease_owner = None;
            task.lease_expires_at = None;
            "failed"
        }
        "cancel" => {
            task.failure_reason = value_string(payload, "failureReason")
                .or_else(|| value_string(payload, "reason"))
                .or_else(|| Some("cancelled".to_string()));
            task.lease_owner = None;
            task.lease_expires_at = None;
            "cancelled"
        }
        other => return Err(format!("未知任务生命周期动作：{other}")),
    };
    if !valid_task_transition(&task.status, next_status) {
        return Err(format!(
            "非法任务状态变更：{} -> {}",
            task.status, next_status
        ));
    }
    if let Some(session_resume_id) = value_string(payload, "sessionResumeId") {
        task.session_resume_id = Some(session_resume_id);
    }
    if let Some(work_dir) = value_string(payload, "workDir") {
        task.work_dir = Some(work_dir);
    }
    if let Some(artifacts) = value_vec(payload, "artifacts") {
        task.artifacts = artifacts;
    }
    if payload.get("artifactIds").is_some() {
        task.artifact_ids = value_string_array(payload, "artifactIds");
    }
    if let Some(progress) = value_i64(payload, "progressPercent") {
        task.progress_percent = Some(progress.clamp(0, 100));
    }
    if let Some(metadata) = value_object(payload, "metadata") {
        task.metadata = merge_task_metadata(task.metadata.clone(), metadata);
    }
    apply_task_status(task, next_status.to_string(), now);
    let updated_id = task.id.clone();
    let updated = store
        .collab_tasks
        .iter()
        .find(|task| task.id == updated_id)
        .cloned()
        .ok_or_else(|| "协作任务不存在".to_string())?;
    if let Some(member_id) = updated.member_id.as_deref() {
        if let Some(member) = store
            .collab_members
            .iter_mut()
            .find(|member| member.id == member_id && member.session_id == session_id)
        {
            upsert_member_task_plan(member, &updated, None);
        }
    }
    if previous_member_id.as_deref() != updated.member_id.as_deref() {
        if let Some(previous_member_id) = previous_member_id.as_deref() {
            remove_member_task_from_plan(store, &session_id, previous_member_id, &updated.id);
        }
    }
    touch_session(store, &session_id, now);
    Ok(updated)
}

pub fn pin_collab_task_session(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    let mut updated = false;
    let task = store
        .collab_tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| "协作任务不存在".to_string())?;
    if let Some(session_resume_id) =
        value_string(payload, "sessionResumeId").or_else(|| value_string(payload, "agentSessionId"))
    {
        task.session_resume_id = Some(session_resume_id);
        updated = true;
    }
    if let Some(work_dir) = value_string(payload, "workDir") {
        task.work_dir = Some(work_dir);
        updated = true;
    }
    if !updated {
        return Err("缺少 sessionResumeId 或 workDir".to_string());
    }
    task.updated_at = now_i64();
    Ok(task.clone())
}

pub fn retry_collab_task(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabTaskRecord, String> {
    let task_id = value_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
    let mut parent = store
        .collab_tasks
        .iter()
        .find(|task| task.id == task_id)
        .cloned()
        .ok_or_else(|| "协作任务不存在".to_string())?;
    normalize_task_defaults(&mut parent);
    if parent.attempt >= parent.max_attempts {
        return Err("任务已达到最大重试次数".to_string());
    }
    let now = now_i64();
    let mut child = parent.clone();
    child.id = next_collab_id("collab-task", |candidate| {
        store.collab_tasks.iter().any(|task| task.id == candidate)
    });
    child.parent_task_id = Some(parent.id.clone());
    child.status = value_string(payload, "status").unwrap_or_else(|| "queued".to_string());
    child.attempt = parent.attempt + 1;
    child.lease_owner = None;
    child.lease_expires_at = None;
    child.failure_reason = None;
    child.result_summary = None;
    child.progress_percent = None;
    child.created_at = now;
    child.updated_at = now;
    child.started_at = None;
    child.completed_at = None;
    if let Some(metadata) = value_object(payload, "metadata") {
        child.metadata = merge_task_metadata(child.metadata, metadata);
    }
    store.collab_tasks.push(child.clone());
    touch_session(store, &child.session_id, now);
    Ok(child)
}
