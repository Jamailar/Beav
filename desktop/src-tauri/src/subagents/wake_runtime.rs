use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::runtime::{request_collab_report, submit_collab_report};
use crate::{now_i64, AppStore};

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
    if !store
        .collab_sessions
        .iter()
        .any(|session| session.id == session_id)
    {
        return Err("协作会话不存在".to_string());
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
}
