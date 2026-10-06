use super::team_wake::schedule_message_target_wake;
use super::*;

fn mailbox_messages_from_value(value: &Value) -> Vec<CollabMailboxMessageRecord> {
    if let Ok(message) = serde_json::from_value::<CollabMailboxMessageRecord>(value.clone()) {
        return vec![message];
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    serde_json::from_value::<CollabMailboxMessageRecord>(item.clone()).ok()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn emit_team_action_result_events(
    app: &AppHandle,
    state: &State<'_, AppState>,
    action: &str,
    value: &Value,
) {
    match action {
        "team.session.create" => {
            if let Ok(session) = serde_json::from_value::<CollabSessionRecord>(value.clone()) {
                emit_collab_event(
                    app,
                    "runtime:collab-session-created",
                    None,
                    json!({ "collabSessionId": session.id, "session": session }),
                );
            }
        }
        "team.member.add" | "team.member.rename" | "team.member.shutdown" => {
            if let Ok(member) = serde_json::from_value::<CollabMemberRecord>(value.clone()) {
                emit_collab_event(
                    app,
                    "runtime:collab-member-changed",
                    None,
                    json!({ "collabSessionId": member.session_id, "member": member }),
                );
            }
        }
        "team.task.create" | "team.task.update" | "team.task.transition" | "team.task.retry" => {
            if let Ok(task) = serde_json::from_value::<CollabTaskRecord>(value.clone()) {
                emit_collab_event(
                    app,
                    "runtime:collab-task-changed",
                    None,
                    json!({ "collabSessionId": task.session_id, "task": task }),
                );
            }
        }
        "team.message.post" | "team.report.request" => {
            for message in mailbox_messages_from_value(value) {
                emit_collab_event(
                    app,
                    "runtime:collab-message-delivered",
                    None,
                    json!({ "collabSessionId": message.session_id, "message": message }),
                );
                schedule_message_target_wake(app, state, &message, action);
            }
        }
        "team.report.submit" => {
            if let Ok(report) = serde_json::from_value::<CollabProgressReportRecord>(value.clone())
            {
                emit_collab_event(
                    app,
                    "runtime:collab-report-submitted",
                    None,
                    json!({ "collabSessionId": report.session_id, "report": report }),
                );
            }
        }
        _ => {}
    }
}
