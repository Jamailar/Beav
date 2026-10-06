use super::payload::{value_object, value_string, value_string_array, value_vec};
use serde_json::{json, Value};

use crate::runtime::CollabTaskRecord;
use crate::{make_id, now_i64, AppStore};

pub(super) fn next_collab_id(prefix: &str, exists: impl Fn(&str) -> bool) -> String {
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

pub(super) fn session_exists(store: &AppStore, session_id: &str) -> bool {
    store
        .collab_sessions
        .iter()
        .any(|session| session.id == session_id)
}

pub(super) fn touch_session(store: &mut AppStore, session_id: &str, now: i64) {
    if let Some(session) = store
        .collab_sessions
        .iter_mut()
        .find(|session| session.id == session_id)
    {
        session.updated_at = now;
    }
}

pub(super) fn validate_session(store: &AppStore, session_id: &str) -> Result<(), String> {
    if session_exists(store, session_id) {
        Ok(())
    } else {
        Err("协作会话不存在".to_string())
    }
}

pub(super) fn validate_member(
    store: &AppStore,
    session_id: &str,
    member_id: &str,
) -> Result<(), String> {
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

pub(super) fn validate_task(
    store: &AppStore,
    session_id: &str,
    task_id: &str,
) -> Result<(), String> {
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

pub(super) fn sync_task_dependency_links(store: &mut AppStore, session_id: &str) {
    let session_task_ids = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .map(|task| task.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let edges = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id)
        .flat_map(|task| {
            task.depends_on_task_ids
                .iter()
                .filter(|dependency_id| session_task_ids.contains(*dependency_id))
                .map(|dependency_id| (dependency_id.clone(), task.id.clone()))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    for task in store
        .collab_tasks
        .iter_mut()
        .filter(|task| task.session_id == session_id)
    {
        task.blocks_task_ids
            .retain(|blocked_id| !session_task_ids.contains(blocked_id));
    }
    for (dependency_id, blocked_task_id) in edges {
        if let Some(task) = store
            .collab_tasks
            .iter_mut()
            .find(|task| task.session_id == session_id && task.id == dependency_id)
        {
            if !task.blocks_task_ids.contains(&blocked_task_id) {
                task.blocks_task_ids.push(blocked_task_id);
            }
        }
    }
}

pub(super) fn promote_ready_dependents(store: &mut AppStore, session_id: &str, now: i64) {
    let completed_task_ids = store
        .collab_tasks
        .iter()
        .filter(|task| task.session_id == session_id && task.status == "completed")
        .map(|task| task.id.clone())
        .collect::<std::collections::HashSet<_>>();
    for task in store
        .collab_tasks
        .iter_mut()
        .filter(|task| task.session_id == session_id)
    {
        if task.depends_on_task_ids.is_empty()
            || !matches!(task.status.as_str(), "todo" | "backlog" | "blocked")
        {
            continue;
        }
        if task
            .depends_on_task_ids
            .iter()
            .all(|dependency_id| completed_task_ids.contains(dependency_id))
        {
            task.status = "ready".to_string();
            task.blocked_by_task_ids
                .retain(|task_id| !completed_task_ids.contains(task_id));
            task.updated_at = now;
        }
    }
}

pub(super) fn completion_claim_payload(
    payload: &Value,
    session_id: &str,
    member_id: &str,
    status: &str,
    summary: &str,
) -> Option<Value> {
    if status != "completed" {
        return value_object(payload, "payload");
    }
    let mut object = value_object(payload, "payload")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    object.insert(
        "completionClaim".to_string(),
        json!({
            "sessionId": session_id,
            "taskId": value_string(payload, "taskId"),
            "memberId": member_id,
            "status": "completed",
            "summary": summary,
            "evidence": value_vec(payload, "evidence").unwrap_or_default(),
            "artifactRefs": value_vec(payload, "artifacts")
                .unwrap_or_default()
                .into_iter()
                .chain(value_string_array(payload, "artifactIds").into_iter().map(|id| json!({ "id": id })))
                .collect::<Vec<_>>(),
            "handoff": value_string(payload, "handoff"),
            "risks": value_string_array(payload, "risks")
        }),
    );
    Some(Value::Object(object))
}

pub(super) fn apply_task_status(task: &mut CollabTaskRecord, status: String, now: i64) {
    task.status = status.clone();
    task.updated_at = now;
    if matches!(status.as_str(), "running" | "blocked") && task.started_at.is_none() {
        task.started_at = Some(now);
    }
    if matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        task.completed_at = Some(now);
    }
}

pub(super) fn valid_task_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    match (from, to) {
        (
            "backlog" | "todo" | "ready" | "queued",
            "claimed" | "running" | "waiting_for_review" | "cancelled",
        ) => true,
        ("claimed", "running" | "waiting_for_review" | "completed" | "failed" | "cancelled") => {
            true
        }
        ("running", "waiting_for_review" | "completed" | "failed" | "cancelled" | "blocked") => {
            true
        }
        ("blocked", "claimed" | "running" | "waiting_for_review" | "failed" | "cancelled") => true,
        ("waiting_for_review", "claimed" | "running" | "completed" | "failed" | "cancelled") => {
            true
        }
        ("failed", "queued" | "cancelled") => true,
        _ => false,
    }
}

pub(super) fn merge_task_metadata(existing: Option<Value>, patch: Value) -> Option<Value> {
    let mut object = existing
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Value::Object(patch) = patch {
        for (key, value) in patch {
            object.insert(key, value);
        }
    }
    if object.is_empty() {
        None
    } else {
        Some(Value::Object(object))
    }
}

pub(super) fn normalize_task_defaults(task: &mut CollabTaskRecord) {
    if task.source.trim().is_empty() {
        task.source = "user_board".to_string();
    }
    if task.status.trim().is_empty() {
        task.status = "todo".to_string();
    }
    if task.task_type.trim().is_empty() {
        task.task_type = "work".to_string();
    }
    if task.attempt < 1 {
        task.attempt = 1;
    }
    if task.max_attempts < 1 {
        task.max_attempts = 1;
    }
}
