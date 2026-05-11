use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::subagents::execute_team_tool;
use crate::{AppStore, payload_string};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMcpToolContract {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub host_action: &'static str,
    pub mutating: bool,
}

fn object_schema(required: &[&str], properties: Value) -> Value {
    json!({
        "type": "object",
        "required": required,
        "properties": properties,
        "additionalProperties": true
    })
}

pub fn team_mcp_tool_contracts() -> Vec<TeamMcpToolContract> {
    vec![
        TeamMcpToolContract {
            name: "team_list_members",
            description: "List collaboration members in the current team session.",
            host_action: "team.members.list",
            mutating: false,
            input_schema: object_schema(
                &["sessionId"],
                json!({
                    "sessionId": { "type": "string" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_match_member",
            description: "Rank existing collaboration members for a task objective.",
            host_action: "team.member.match",
            mutating: false,
            input_schema: object_schema(
                &["sessionId"],
                json!({
                    "sessionId": { "type": "string" },
                    "title": { "type": "string" },
                    "objective": { "type": "string" },
                    "taskType": { "type": "string" },
                    "requiredCapabilities": { "type": "array", "items": { "type": "string" } },
                    "requiredToolFamilies": { "type": "array", "items": { "type": "string" } },
                    "limit": { "type": "integer" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_rename_agent",
            description: "Rename or retitle one collaboration member.",
            host_action: "team.member.rename",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "memberId", "displayName"],
                json!({
                    "sessionId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "displayName": { "type": "string" },
                    "roleId": { "type": "string" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_shutdown_agent",
            description: "Mark one collaboration member offline or suspended.",
            host_action: "team.member.shutdown",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "memberId"],
                json!({
                    "sessionId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "status": { "type": "string" },
                    "reason": { "type": "string" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_list_work_items",
            description: "List structured work items in the current team session.",
            host_action: "team.task.list",
            mutating: false,
            input_schema: object_schema(
                &["sessionId"],
                json!({
                    "sessionId": { "type": "string" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_send_message",
            description: "Send a durable mailbox message to another team member or the coordinator.",
            host_action: "team.message.send",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "body"],
                json!({
                    "sessionId": { "type": "string" },
                    "fromMemberId": { "type": "string" },
                    "toMemberId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "subject": { "type": "string" },
                    "body": { "type": "string" },
                    "messageType": { "type": "string" },
                    "payload": { "type": "object" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_claim_work_item",
            description: "Claim a work item for one member and move it to running.",
            host_action: "team.task.update",
            mutating: true,
            input_schema: object_schema(
                &["taskId", "memberId"],
                json!({
                    "taskId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "status": { "type": "string", "default": "running" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_update_work_item",
            description: "Update task status, progress, blockers, summary, or artifacts.",
            host_action: "team.task.update",
            mutating: true,
            input_schema: object_schema(
                &["taskId"],
                json!({
                    "taskId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "status": { "type": "string" },
                    "progressPercent": { "type": "integer", "minimum": 0, "maximum": 100 },
                    "resultSummary": { "type": "string" },
                    "blockedByTaskIds": { "type": "array", "items": { "type": "string" } },
                    "artifacts": { "type": "array", "items": { "type": "object" } },
                    "metadata": { "type": "object" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_request_report",
            description: "Request a progress report from a member through the team mailbox.",
            host_action: "team.report.request",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "toMemberId"],
                json!({
                    "sessionId": { "type": "string" },
                    "toMemberId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "body": { "type": "string" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_submit_report",
            description: "Submit a structured progress, blocker, completion, or failure report.",
            host_action: "team.report.submit",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "memberId", "summary"],
                json!({
                    "sessionId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "status": { "type": "string" },
                    "reportType": { "type": "string" },
                    "summary": { "type": "string" },
                    "nextAction": { "type": "string" },
                    "nextSteps": { "type": "array", "items": { "type": "string" } },
                    "progressPercent": { "type": "integer", "minimum": 0, "maximum": 100 },
                    "blockers": { "type": "array", "items": { "type": "string" } },
                    "artifacts": { "type": "array", "items": { "type": "object" } },
                    "artifactIds": { "type": "array", "items": { "type": "string" } },
                    "payload": { "type": "object" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_save_artifact",
            description: "Attach artifact metadata to a task through a structured progress report.",
            host_action: "team.artifact.attach",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "memberId", "taskId", "artifact"],
                json!({
                    "sessionId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "summary": { "type": "string" },
                    "artifact": { "type": "object" }
                }),
            ),
        },
        TeamMcpToolContract {
            name: "team_raise_blocker",
            description: "Raise a structured blocker report for a task.",
            host_action: "team.blocker.raise",
            mutating: true,
            input_schema: object_schema(
                &["sessionId", "memberId", "taskId"],
                json!({
                    "sessionId": { "type": "string" },
                    "memberId": { "type": "string" },
                    "taskId": { "type": "string" },
                    "blocker": { "type": "string" },
                    "summary": { "type": "string" },
                    "blockers": { "type": "array", "items": { "type": "string" } },
                    "nextSteps": { "type": "array", "items": { "type": "string" } }
                }),
            ),
        },
    ]
}

pub fn team_mcp_tools_list_response() -> Value {
    json!({
        "tools": team_mcp_tool_contracts()
            .into_iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
            }))
            .collect::<Vec<_>>()
    })
}

pub fn execute_team_mcp_tool(
    store: &mut AppStore,
    tool_name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let payload = normalize_team_mcp_payload(tool_name, arguments)?;
    let host_action = team_mcp_tool_contracts()
        .into_iter()
        .find(|tool| tool.name == tool_name)
        .map(|tool| tool.host_action)
        .ok_or_else(|| format!("unsupported redbox-team MCP tool: {tool_name}"))?;
    execute_team_tool(store, host_action, &payload)
}

fn normalize_team_mcp_payload(tool_name: &str, arguments: &Value) -> Result<Value, String> {
    let mut payload = arguments.clone();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "MCP tool arguments must be a JSON object".to_string())?;
    match tool_name {
        "team_claim_work_item" => {
            object
                .entry("status".to_string())
                .or_insert_with(|| json!("running"));
        }
        "team_save_artifact" => {
            let artifact = object
                .remove("artifact")
                .ok_or_else(|| "team_save_artifact requires artifact".to_string())?;
            object.insert("reportType".to_string(), json!("artifact"));
            object.insert("status".to_string(), json!("running"));
            object.insert(
                "summary".to_string(),
                json!(
                    payload_string(arguments, "summary")
                        .unwrap_or_else(|| { "Artifact saved by team member".to_string() })
                ),
            );
            object.insert("artifacts".to_string(), json!([artifact]));
        }
        _ => {}
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runtime::{add_collab_member, create_collab_session, create_collab_task};

    #[test]
    fn team_mcp_contract_exposes_required_tools() {
        let names = team_mcp_tool_contracts()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"team_send_message"));
        assert!(names.contains(&"team_list_members"));
        assert!(names.contains(&"team_match_member"));
        assert!(names.contains(&"team_rename_agent"));
        assert!(names.contains(&"team_shutdown_agent"));
        assert!(names.contains(&"team_list_work_items"));
        assert!(names.contains(&"team_claim_work_item"));
        assert!(names.contains(&"team_update_work_item"));
        assert!(names.contains(&"team_request_report"));
        assert!(names.contains(&"team_save_artifact"));
        assert!(names.contains(&"team_raise_blocker"));
    }

    #[test]
    fn team_mcp_claim_and_artifact_map_to_host_actions() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "mcp" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "worker" }),
        )
        .unwrap();
        let task = create_collab_task(
            &mut store,
            &json!({ "sessionId": session.id, "title": "work" }),
        )
        .unwrap();

        let claimed = execute_team_mcp_tool(
            &mut store,
            "team_claim_work_item",
            &json!({ "taskId": task.id, "memberId": member.id }),
        )
        .unwrap();
        assert_eq!(
            claimed.get("status").and_then(Value::as_str),
            Some("running")
        );

        let report = execute_team_mcp_tool(
            &mut store,
            "team_save_artifact",
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "taskId": task.id,
                "artifact": { "kind": "note", "content": "done" }
            }),
        )
        .unwrap();
        assert_eq!(
            report.get("reportType").and_then(Value::as_str),
            Some("artifact")
        );
    }
}
