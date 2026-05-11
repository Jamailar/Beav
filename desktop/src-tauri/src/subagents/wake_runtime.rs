use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::runtime::{request_collab_report, submit_collab_report};
use crate::{AppStore, now_i64};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamWakeTickOutcome {
    pub requested_report_count: usize,
    pub stale_report_count: usize,
    pub coordinator_should_wake: bool,
    pub settled_member_count: usize,
    pub active_member_count: usize,
}

fn is_settled_status(status: &str) -> bool {
    matches!(
        status,
        "idle" | "completed" | "failed" | "pending" | "blocked" | "offline" | "suspended"
    )
}

fn is_inactive_session_status(status: &str) -> bool {
    matches!(status, "paused" | "completed" | "failed" | "archived")
}

fn has_pending_report_request(
    store: &AppStore,
    session_id: &str,
    member_id: &str,
    task_id: Option<&str>,
) -> bool {
    store.collab_mailbox_messages.iter().any(|message| {
        message.session_id == session_id
            && message.to_member_id.as_deref() == Some(member_id)
            && message.message_type == "report_request"
            && message.read_at.is_none()
            && match task_id {
                Some(task_id) => message.task_id.as_deref() == Some(task_id),
                None => message.task_id.is_none(),
            }
    })
}

pub fn non_leader_members_settled(store: &AppStore, session_id: &str) -> bool {
    let coordinator_member_id = store
        .collab_sessions
        .iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.coordinator_member_id.as_deref());
    store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .filter(|member| Some(member.id.as_str()) != coordinator_member_id)
        .all(|member| is_settled_status(member.status.as_str()))
}

pub fn tick_team_wake_runtime(
    store: &mut AppStore,
    session_id: &str,
) -> Result<TeamWakeTickOutcome, String> {
    let session_status = store
        .collab_sessions
        .iter()
        .find(|session| session.id == session_id)
        .map(|session| session.status.clone())
        .ok_or_else(|| "协作会话不存在".to_string())?;
    if is_inactive_session_status(&session_status) {
        let settled_member_count = store
            .collab_members
            .iter()
            .filter(|member| member.session_id == session_id)
            .filter(|member| is_settled_status(member.status.as_str()))
            .count();
        return Ok(TeamWakeTickOutcome {
            requested_report_count: 0,
            stale_report_count: 0,
            coordinator_should_wake: false,
            settled_member_count,
            active_member_count: 0,
        });
    }
    let now = now_i64();
    let active_members = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .filter(|member| matches!(member.status.as_str(), "active" | "running" | "working"))
        .cloned()
        .collect::<Vec<_>>();

    let mut requested_report_count = 0usize;
    let mut stale_report_count = 0usize;
    for member in active_members.iter() {
        let interval_ms = member
            .progress_interval_ms
            .max(member.report_interval_seconds.max(1) * 1000);
        let last_report_at = member.last_report_at.or(member.last_seen_at).unwrap_or(0);
        if now.saturating_sub(last_report_at) < interval_ms {
            continue;
        }
        if has_pending_report_request(
            store,
            session_id,
            &member.id,
            member.current_task_id.as_deref(),
        ) {
            continue;
        }
        request_collab_report(
            store,
            &json!({
                "sessionId": session_id,
                "toMemberId": member.id,
                "taskId": member.current_task_id,
                "body": "进度汇报时间到：请提交当前进展、阻塞点、下一步和产物。"
            }),
        )?;
        requested_report_count += 1;
        if now.saturating_sub(last_report_at) > interval_ms.saturating_mul(2) {
            submit_collab_report(
                store,
                &json!({
                    "sessionId": session_id,
                    "memberId": member.id,
                    "taskId": member.current_task_id,
                    "status": "blocked",
                    "reportType": "blocker",
                    "summary": "成员超过两个汇报周期未更新，系统生成停滞报告。",
                    "blockers": ["progress_report_timeout"]
                }),
            )?;
            stale_report_count += 1;
        }
    }

    let active_member_count = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .filter(|member| !is_settled_status(member.status.as_str()))
        .count();
    let settled_member_count = store
        .collab_members
        .iter()
        .filter(|member| member.session_id == session_id)
        .filter(|member| is_settled_status(member.status.as_str()))
        .count();

    Ok(TeamWakeTickOutcome {
        requested_report_count,
        stale_report_count,
        coordinator_should_wake: non_leader_members_settled(store, session_id),
        settled_member_count,
        active_member_count,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runtime::{add_collab_member, create_collab_session};

    #[test]
    fn settled_rule_ignores_coordinator() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "settled" })).unwrap();
        let coordinator = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "负责人", "status": "active" }),
        )
        .unwrap();
        let worker = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "成员", "status": "idle" }),
        )
        .unwrap();
        store.collab_sessions[0].coordinator_member_id = Some(coordinator.id);

        assert_ne!(
            worker.id,
            store.collab_sessions[0]
                .coordinator_member_id
                .clone()
                .unwrap()
        );
        assert!(non_leader_members_settled(&store, &session.id));
    }

    #[test]
    fn report_tick_dedups_pending_report_requests() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "dedup" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({
                "sessionId": session.id,
                "displayName": "成员",
                "status": "working",
                "reportIntervalSeconds": 1,
                "progressIntervalMs": 1000
            }),
        )
        .unwrap();
        let member_record = store
            .collab_members
            .iter_mut()
            .find(|item| item.id == member.id)
            .unwrap();
        member_record.last_report_at = Some(now_i64().saturating_sub(1_100));

        let first = tick_team_wake_runtime(&mut store, &session.id).unwrap();
        let second = tick_team_wake_runtime(&mut store, &session.id).unwrap();

        assert_eq!(first.requested_report_count, 1);
        assert_eq!(second.requested_report_count, 0);
        assert_eq!(store.collab_mailbox_messages.len(), 1);
    }

    #[test]
    fn report_tick_ignores_paused_sessions_and_completed_members() {
        let mut store = AppStore::default();
        let paused_session =
            create_collab_session(&mut store, &json!({ "objective": "paused" })).unwrap();
        store.collab_sessions[0].status = "paused".to_string();
        add_collab_member(
            &mut store,
            &json!({
                "sessionId": paused_session.id,
                "displayName": "暂停成员",
                "status": "working",
                "reportIntervalSeconds": 1,
                "progressIntervalMs": 1000
            }),
        )
        .unwrap();

        let paused = tick_team_wake_runtime(&mut store, &paused_session.id).unwrap();
        assert_eq!(paused.requested_report_count, 0);

        let active_session =
            create_collab_session(&mut store, &json!({ "objective": "completed" })).unwrap();
        add_collab_member(
            &mut store,
            &json!({
                "sessionId": active_session.id,
                "displayName": "已完成成员",
                "status": "completed",
                "reportIntervalSeconds": 1,
                "progressIntervalMs": 1000
            }),
        )
        .unwrap();

        let completed = tick_team_wake_runtime(&mut store, &active_session.id).unwrap();
        assert_eq!(completed.requested_report_count, 0);
        assert!(store.collab_mailbox_messages.is_empty());
    }
}
