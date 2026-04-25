use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::runtime::{
    add_collab_member, collab_session_snapshot, create_collab_session, list_collab_members,
    list_collab_reports, list_collab_sessions,
};
use crate::subagents::{
    team_mailbox_cleanup, team_mailbox_history, team_mailbox_read, team_mailbox_request_report,
    team_mailbox_send, team_task_create, team_task_list, team_task_move, team_task_update,
};
use crate::{payload_string, AppStore};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    pub mutating: bool,
}

pub fn team_tool_descriptors() -> Vec<TeamToolDescriptor> {
    vec![
        TeamToolDescriptor {
            name: "team.members.list",
            description: "List members in one collaboration session.",
            mutating: false,
        },
        TeamToolDescriptor {
            name: "team.member.spawn",
            description: "Register a new internal or ACP collaboration member.",
            mutating: true,
        },
        TeamToolDescriptor {
            name: "team.message.send",
            description: "Send a durable mailbox message.",
            mutating: true,
        },
        TeamToolDescriptor {
            name: "team.task.create",
            description: "Create a structured team task.",
            mutating: true,
        },
        TeamToolDescriptor {
            name: "team.task.update",
            description: "Update a structured team task.",
            mutating: true,
        },
        TeamToolDescriptor {
            name: "team.task.list",
            description: "List team tasks for one collaboration session.",
            mutating: false,
        },
        TeamToolDescriptor {
            name: "team.report.submit",
            description: "Submit a member progress report.",
            mutating: true,
        },
        TeamToolDescriptor {
            name: "team.report.request",
            description: "Request a progress report through mailbox.",
            mutating: true,
        },
    ]
}

pub fn execute_team_tool(
    store: &mut AppStore,
    action: &str,
    payload: &Value,
) -> Result<Value, String> {
    match action {
        "team.session.create" => Ok(json!(create_collab_session(store, payload)?)),
        "team.session.get" => {
            let session_id =
                payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
            Ok(json!(collab_session_snapshot(
                store,
                &session_id,
                Some(100),
                Some(100)
            )))
        }
        "team.session.list" => Ok(json!(list_collab_sessions(store))),
        "team.members.list" => {
            let session_id =
                payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
            Ok(json!(list_collab_members(store, &session_id)))
        }
        "team.member.spawn" => Ok(json!(add_collab_member(store, payload)?)),
        "team.message.send" => Ok(json!(team_mailbox_send(store, payload)?)),
        "team.message.read" => Ok(json!(team_mailbox_read(store, payload)?)),
        "team.message.history" => {
            let session_id =
                payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
            Ok(json!(team_mailbox_history(
                store,
                &session_id,
                payload_string(payload, "memberId").as_deref(),
                payload_string(payload, "taskId").as_deref(),
                payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
            )))
        }
        "team.mailbox.cleanup" => {
            let session_id =
                payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
            Ok(json!({
                "removed": team_mailbox_cleanup(
                    store,
                    &session_id,
                    payload
                        .get("keepLatestRead")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(500)
                )
            }))
        }
        "team.task.create" => Ok(json!(team_task_create(store, payload)?)),
        "team.task.update" => Ok(json!(team_task_update(store, payload)?)),
        "team.task.move" => {
            let task_id =
                payload_string(payload, "taskId").ok_or_else(|| "缺少 taskId".to_string())?;
            let status =
                payload_string(payload, "status").ok_or_else(|| "缺少 status".to_string())?;
            Ok(json!(team_task_move(store, &task_id, &status)?))
        }
        "team.task.list" => {
            let session_id =
                payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
            Ok(json!(team_task_list(store, &session_id)))
        }
        "team.report.submit" => Ok(json!(crate::runtime::submit_collab_report(store, payload)?)),
        "team.report.request" => Ok(json!(team_mailbox_request_report(store, payload)?)),
        "team.report.list" => {
            let session_id =
                payload_string(payload, "sessionId").ok_or_else(|| "缺少 sessionId".to_string())?;
            Ok(json!(list_collab_reports(
                store,
                &session_id,
                payload_string(payload, "taskId").as_deref(),
                payload_string(payload, "memberId").as_deref(),
                payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
            )))
        }
        _ => Err(format!("unsupported team tool action: {action}")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn team_tool_can_create_session_member_and_task() {
        let mut store = AppStore::default();
        let session = execute_team_tool(
            &mut store,
            "team.session.create",
            &json!({ "objective": "tool contract" }),
        )
        .unwrap();
        let session_id = session.get("id").and_then(Value::as_str).unwrap();
        let member = execute_team_tool(
            &mut store,
            "team.member.spawn",
            &json!({ "sessionId": session_id, "displayName": "执行者" }),
        )
        .unwrap();
        let member_id = member.get("id").and_then(Value::as_str).unwrap();
        let task = execute_team_tool(
            &mut store,
            "team.task.create",
            &json!({ "sessionId": session_id, "memberId": member_id, "title": "任务" }),
        )
        .unwrap();
        assert_eq!(
            task.get("memberId").and_then(Value::as_str),
            Some(member_id)
        );
    }
}
