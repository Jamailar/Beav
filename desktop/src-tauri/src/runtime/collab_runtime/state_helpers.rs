use serde_json::Value;

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
