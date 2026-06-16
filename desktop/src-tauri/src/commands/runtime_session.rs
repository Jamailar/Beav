use serde_json::Value;
use tauri::{AppHandle, State};

#[path = "runtime_collab.rs"]
mod runtime_collab;
#[path = "runtime_query.rs"]
mod runtime_query;
#[path = "runtime_session_ops.rs"]
mod runtime_session_ops;

use crate::AppState;

pub fn handle_runtime_session_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "chat:get-runtime-state" => runtime_session_ops::runtime_state_value(state, payload),
        "runtime:query" => runtime_query::handle_runtime_query(app, state, payload),
        "runtime:resume" => Ok(runtime_session_ops::runtime_resume_value(payload)),
        "runtime:fork-session" => runtime_session_ops::fork_runtime_session(app, state, payload),
        "runtime:export-session" => runtime_session_ops::export_runtime_session(state, payload),
        "runtime:import-session" => runtime_session_ops::import_runtime_session(state, payload),
        "runtime:get-trace" => runtime_session_ops::runtime_trace_value(state, payload),
        "runtime:get-checkpoints" => runtime_session_ops::runtime_checkpoints_value(state, payload),
        "runtime:get-tool-results" => {
            runtime_session_ops::runtime_tool_results_value(state, payload)
        }
        "runtime:get-events" => runtime_session_ops::runtime_events_value(state, payload),
        "runtime:list-approvals" => runtime_session_ops::runtime_approvals_value(state),
        "task-panel:list" => runtime_collab::task_panel_list_value(state, payload),
        "team-runtime:list-sessions" | "collab:sessions:list" => {
            runtime_collab::list_sessions_value(state)
        }
        "team-runtime:create-session" | "collab:sessions:create" => {
            runtime_collab::create_session_value(app, state, payload)
        }
        "team-runtime:guide-create" => runtime_collab::guide_create_value(app, state, payload),
        "team-runtime:get-session" | "collab:sessions:get" => {
            runtime_collab::session_snapshot_value(state, payload)
        }
        "team-runtime:list-members" => runtime_collab::list_members_value(state, payload),
        "team-runtime:list-tasks" => runtime_collab::list_tasks_value(state, payload),
        "team-runtime:list-messages" => runtime_collab::list_messages_value(state, payload),
        "team-runtime:read-mailbox" => runtime_collab::read_mailbox_value(state, payload),
        "team-runtime:list-reports" => runtime_collab::list_reports_value(state, payload),
        "team-runtime:add-member" | "collab:members:add" => {
            runtime_collab::add_member_value(app, state, payload)
        }
        "team-runtime:set-session-coordinator" => {
            runtime_collab::set_session_coordinator_value(app, state, payload)
        }
        "team-runtime:rename-member" => runtime_collab::rename_member_value(app, state, payload),
        "team-runtime:shutdown-member" => {
            runtime_collab::shutdown_member_value(app, state, payload)
        }
        "team-runtime:create-task" | "collab:tasks:create" => {
            runtime_collab::create_task_value(app, state, payload)
        }
        "team-runtime:update-task" | "collab:tasks:update" => {
            runtime_collab::update_task_value(app, state, payload)
        }
        "team-runtime:claim-task" => {
            runtime_collab::transition_task_value(app, state, payload, "claim")
        }
        "team-runtime:start-task" => {
            runtime_collab::transition_task_value(app, state, payload, "start")
        }
        "team-runtime:wait-review-task" => {
            runtime_collab::transition_task_value(app, state, payload, "wait-review")
        }
        "team-runtime:complete-task" => {
            runtime_collab::transition_task_value(app, state, payload, "complete")
        }
        "team-runtime:fail-task" => {
            runtime_collab::transition_task_value(app, state, payload, "fail")
        }
        "team-runtime:cancel-task" => {
            runtime_collab::transition_task_value(app, state, payload, "cancel")
        }
        "team-runtime:pin-task-session" => {
            runtime_collab::pin_task_session_value(app, state, payload)
        }
        "team-runtime:retry-task" => runtime_collab::retry_task_value(app, state, payload),
        "review:dockets:list" | "team-runtime:list-review-dockets" => {
            runtime_collab::list_review_dockets_value(state, payload)
        }
        "review:dockets:get" | "team-runtime:get-review-docket" => {
            runtime_collab::get_review_docket_value(state, payload)
        }
        "review:dockets:stats" | "team-runtime:review-docket-stats" => {
            runtime_collab::review_docket_stats_value(state)
        }
        "review:dockets:create" | "team-runtime:create-review-docket" => {
            runtime_collab::create_review_docket_value(app, state, payload)
        }
        "review:dockets:decide" | "team-runtime:decide-review-docket" => {
            runtime_collab::decide_review_docket_value(app, state, payload)
        }
        "review:dockets:skip" | "team-runtime:skip-review-docket" => {
            runtime_collab::archive_review_docket_value(app, state, payload, "skipped")
        }
        "review:dockets:archive" | "team-runtime:archive-review-docket" => {
            runtime_collab::archive_review_docket_value(app, state, payload, "archived")
        }
        "team-runtime:send-message" | "collab:mailbox:post" => {
            runtime_collab::post_message_value(app, state, payload)
        }
        "team-runtime:request-report" => runtime_collab::request_report_value(app, state, payload),
        "team-runtime:submit-report" | "collab:reports:submit" => {
            runtime_collab::submit_report_value(app, state, payload)
        }
        "team-runtime:pause-session" => {
            runtime_collab::update_session_status_value(app, state, payload, "paused")
        }
        "team-runtime:resume-session" => {
            runtime_collab::update_session_status_value(app, state, payload, "active")
        }
        "team-runtime:archive-session" => {
            runtime_collab::update_session_status_value(app, state, payload, "archived")
        }
        "team-runtime:tick-reports" => runtime_collab::tick_reports_value(app, state, payload),
        "team-runtime:list-agent-backends" => runtime_collab::list_agent_backends_value(state),
        "team-runtime:list-tools" => Ok(runtime_collab::tool_descriptors_value()),
        "team-runtime:execute-tool" => runtime_collab::execute_tool_value(app, state, payload),
        "team-runtime:mcp-contract" => Ok(runtime_collab::mcp_contract_value()),
        "team-runtime:execute-mcp-tool" => {
            runtime_collab::execute_mcp_tool_value(app, state, payload)
        }
        _ => return None,
    })
}
