use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

#[path = "runtime_collab/member_values.rs"]
mod member_values;
#[path = "runtime_collab/message_report_values.rs"]
mod message_report_values;
#[path = "runtime_collab/review_approval.rs"]
mod review_approval;
#[path = "runtime_collab/review_values.rs"]
mod review_values;
#[path = "runtime_collab/session_values.rs"]
mod session_values;
#[path = "runtime_collab/task_panel.rs"]
mod task_panel;
#[path = "runtime_collab/task_values.rs"]
mod task_values;
#[path = "runtime_collab/team_events.rs"]
mod team_events;
#[path = "runtime_collab/team_guide.rs"]
mod team_guide;
#[path = "runtime_collab/team_prompt.rs"]
mod team_prompt;
#[path = "runtime_collab/team_tools.rs"]
mod team_tools;
#[path = "runtime_collab/team_wake.rs"]
mod team_wake;

use crate::agent::{
    build_session_bridge_turn, emit_session_agent_completion, execute_prepared_session_agent_turn,
    PreparedSessionAgentTurn, SessionAgentTurnKind,
};
use crate::commands::cli_runtime::handle_cli_runtime_channel;
use crate::commands::redclaw::redclaw_task_control;
use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    request_runtime_approval, CollabMailboxMessageRecord, CollabMemberRecord,
    CollabProgressReportRecord, CollabSessionRecord, CollabTaskRecord, ReviewDocketRecord,
    RuntimeApprovalDetails, RuntimeApprovalRecord,
};
use crate::session_manager::create_session;
use crate::store::redclaw as redclaw_store;
use crate::{now_i64, parse_timestamp_ms, payload_string, AppState};
pub use member_values::{
    add_member_value, list_members_value, rename_member_value, set_session_coordinator_value,
    shutdown_member_value,
};
pub use message_report_values::{
    list_messages_value, list_reports_value, post_message_value, read_mailbox_value,
    request_report_value, submit_report_value,
};
pub use review_values::{
    archive_review_docket_value, create_review_docket_value, decide_review_docket_value,
    get_review_docket_value, list_review_dockets_value, review_docket_stats_value,
};
pub use session_values::{
    create_session_value, list_sessions_value, session_snapshot_value, tick_reports_value,
    update_session_status_value,
};
pub use task_panel::task_panel_list_value;
pub use task_values::{
    create_task_value, list_tasks_value, pin_task_session_value, retry_task_value,
    transition_task_value, update_task_value,
};
use team_events::emit_team_action_result_events;
pub use team_guide::guide_create_value;
#[cfg(test)]
use team_prompt::team_member_session_metadata;
pub use team_tools::{
    execute_mcp_tool_value, execute_tool_value, list_agent_backends_value, mcp_contract_value,
    tool_descriptors_value,
};
#[cfg(test)]
use team_wake::non_coordinator_members_settled;
use team_wake::schedule_message_target_wake;

fn payload_limit(payload: &Value, key: &str) -> Option<usize> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
}

fn emit_collab_event(
    app: &AppHandle,
    event_type: &str,
    owner_session_id: Option<&str>,
    payload: Value,
) {
    emit_runtime_event(app, event_type, owner_session_id, None, payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AdvisorRecord;

    fn advisor_record(id: &str) -> AdvisorRecord {
        AdvisorRecord {
            id: id.to_string(),
            name: "策略成员".to_string(),
            avatar: "S".to_string(),
            personality: "关注定位和取舍。".to_string(),
            system_prompt: "以策略视角给出判断。".to_string(),
            knowledge_language: None,
            knowledge_files: Vec::new(),
            youtube_channel: None,
            member_skill_ref: Some("member-strategy".to_string()),
            member_skill_status: Some("ready".to_string()),
            member_skill_version: None,
            member_skill_last_distilled_at: None,
            member_skill_last_error: None,
            member_skill_candidate_version: None,
            member_skill_candidate_path: None,
            member_skill_candidate_created_at: None,
            member_skill_candidate_source_event: None,
            detected_knowledge_language: None,
            language_detection_status: None,
            language_confidence: None,
            redclaw_visible: Some(true),
            redclaw_order: Some(0),
            created_at: "2026-05-30T00:00:00Z".to_string(),
            updated_at: "2026-05-30T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn team_member_session_metadata_binds_advisor_identity_and_skill() {
        let mut store = crate::AppStore::default();
        store.advisors.push(advisor_record("advisor-strategy"));
        let session = CollabSessionRecord {
            id: "collab-session-1".to_string(),
            title: "团队任务".to_string(),
            objective: "完成一次团队协作".to_string(),
            runtime_mode: "team".to_string(),
            source: "team-workbench".to_string(),
            ..Default::default()
        };
        let member = CollabMemberRecord {
            id: "collab-member-1".to_string(),
            session_id: session.id.clone(),
            display_name: "策略成员".to_string(),
            role_id: "advisor-strategy".to_string(),
            metadata: Some(json!({ "advisorId": "advisor-strategy" })),
            ..Default::default()
        };

        let metadata = team_member_session_metadata(&store, &session, &member);

        assert_eq!(
            metadata.get("runtimeMode").and_then(Value::as_str),
            Some("team")
        );
        assert_eq!(
            metadata.get("collabMemberId").and_then(Value::as_str),
            Some("collab-member-1")
        );
        assert_eq!(
            metadata.get("advisorId").and_then(Value::as_str),
            Some("advisor-strategy")
        );
        assert_eq!(
            metadata.get("memberSkillRef").and_then(Value::as_str),
            Some("member-strategy")
        );
        assert_eq!(
            metadata
                .get("activeSkills")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("member-strategy")
        );
        let active_speaker = metadata
            .get("activeSpeaker")
            .and_then(Value::as_object)
            .expect("active speaker metadata");
        assert_eq!(
            active_speaker.get("speakerId").and_then(Value::as_str),
            Some("advisor-strategy")
        );
        assert_eq!(
            active_speaker.get("memberId").and_then(Value::as_str),
            Some("advisor-strategy")
        );
        assert_eq!(
            active_speaker.get("collabMemberId").and_then(Value::as_str),
            Some("collab-member-1")
        );
        assert_eq!(
            active_speaker
                .get("knowledgeScope")
                .and_then(|value| value.get("advisorId"))
                .and_then(Value::as_str),
            Some("advisor-strategy")
        );
    }

    #[test]
    fn coordinator_wake_waits_until_non_coordinator_members_are_settled() {
        let mut store = crate::AppStore::default();
        let session_id = "collab-session-settled".to_string();
        store.collab_members.push(CollabMemberRecord {
            id: "coordinator".to_string(),
            session_id: session_id.clone(),
            status: "idle".to_string(),
            ..Default::default()
        });
        store.collab_members.push(CollabMemberRecord {
            id: "worker-a".to_string(),
            session_id: session_id.clone(),
            status: "idle".to_string(),
            ..Default::default()
        });
        store.collab_members.push(CollabMemberRecord {
            id: "worker-b".to_string(),
            session_id: session_id.clone(),
            status: "active".to_string(),
            ..Default::default()
        });

        assert!(!non_coordinator_members_settled(
            &store,
            &session_id,
            "coordinator"
        ));

        store
            .collab_members
            .iter_mut()
            .find(|member| member.id == "worker-b")
            .unwrap()
            .status = "failed".to_string();

        assert!(non_coordinator_members_settled(
            &store,
            &session_id,
            "coordinator"
        ));
    }
}
