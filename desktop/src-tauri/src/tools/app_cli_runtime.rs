use super::*;

pub(super) fn handle(
    executor: &AppCliExecutor<'_>,
    tokens: &[String],
    payload: &Value,
) -> Result<Value, String> {
    let Some(action) = tokens.first().map(String::as_str) else {
        return Ok(help_response(Some("runtime")));
    };
    let args = parse_cli_args(&tokens[1..])?;
    match action {
        "query" => executor.call_channel(
            "runtime:query",
            json!({
                "sessionId": args
                    .string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId")),
                "message": args
                    .string(&["message"])
                    .or_else(|| payload_string(payload, "message"))
                    .unwrap_or_default(),
                "modelConfig": payload_field(payload, "modelConfig").cloned().unwrap_or(Value::Null),
            }),
        ),
        "resume" => executor.call_channel(
            "runtime:resume",
            json!({
                "sessionId": args
                    .string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId"))
                    .unwrap_or_default()
            }),
        ),
        "fork-session" => executor.call_channel(
            "runtime:fork-session",
            json!({
                "sessionId": args
                    .string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId"))
                    .unwrap_or_default()
            }),
        ),
        "get-trace" => executor.call_channel(
            "runtime:get-trace",
            json!({
                "sessionId": args
                    .string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId"))
                    .unwrap_or_default(),
                "limit": args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(50)
            }),
        ),
        "get-checkpoints" => executor.call_channel(
            "runtime:get-checkpoints",
            json!({
                "sessionId": args
                    .string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId"))
                    .unwrap_or_default(),
                "limit": args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(50)
            }),
        ),
        "get-tool-results" => executor.call_channel(
            "runtime:get-tool-results",
            json!({
                "sessionId": args
                    .string(&["session-id", "sessionId"])
                    .or_else(|| payload_string(payload, "sessionId"))
                    .unwrap_or_default(),
                "limit": args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64))
                    .unwrap_or(50)
            }),
        ),
        "tasks" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
            let nested_args = parse_cli_args(&tokens[2..])?;
            match sub {
                "create" => executor.call_channel(
                    "tasks:create",
                    payload_field(payload, "payload")
                        .cloned()
                        .unwrap_or_else(|| merge_payload(&nested_args.options, payload)),
                ),
                "list" => executor.call_channel("tasks:list", json!({})),
                "get" => executor.call_channel(
                    "tasks:get",
                    json!({
                        "taskId": nested_args
                            .string(&["task-id", "taskId"])
                            .or_else(|| payload_string(payload, "taskId"))
                            .ok_or_else(|| "runtime tasks get requires --task-id".to_string())?
                    }),
                ),
                "resume" => executor.call_channel(
                    "tasks:resume",
                    json!({
                        "taskId": nested_args
                            .string(&["task-id", "taskId"])
                            .or_else(|| payload_string(payload, "taskId"))
                            .ok_or_else(|| "runtime tasks resume requires --task-id".to_string())?
                    }),
                ),
                "cancel" => executor.call_channel(
                    "tasks:cancel",
                    json!({
                        "taskId": nested_args
                            .string(&["task-id", "taskId"])
                            .or_else(|| payload_string(payload, "taskId"))
                            .ok_or_else(|| "runtime tasks cancel requires --task-id".to_string())?
                    }),
                ),
                _ => Err(format!("unsupported runtime tasks action: {sub}")),
            }
        }
        "background" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
            let nested_args = parse_cli_args(&tokens[2..])?;
            match sub {
                "list" => executor.call_channel("background-tasks:list", json!({})),
                "get" => executor.call_channel(
                    "background-tasks:get",
                    json!({
                        "taskId": nested_args
                            .string(&["task-id", "taskId"])
                            .or_else(|| payload_string(payload, "taskId"))
                            .ok_or_else(|| "runtime background get requires --task-id".to_string())?
                    }),
                ),
                "cancel" => executor.call_channel(
                    "background-tasks:cancel",
                    json!({
                        "taskId": nested_args
                            .string(&["task-id", "taskId"])
                            .or_else(|| payload_string(payload, "taskId"))
                            .ok_or_else(|| "runtime background cancel requires --task-id".to_string())?
                    }),
                ),
                _ => Err(format!("unsupported runtime background action: {sub}")),
            }
        }
        "team" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("list-sessions");
            let nested_args = parse_cli_args(&tokens[2..])?;
            let merged = || merge_payload(&nested_args.options, payload);
            let session_payload = || {
                json!({
                    "sessionId": nested_args
                        .string(&["session-id", "sessionId"])
                        .or_else(|| payload_string(payload, "sessionId"))
                        .unwrap_or_default()
                })
            };
            match sub {
                "list-sessions" | "sessions" => {
                    executor.call_channel("team-runtime:list-sessions", json!({}))
                }
                "create-session" => {
                    let payload = merged();
                    require_confirmed_team_plan("team.session.create", &payload)?;
                    executor.call_channel("team-runtime:create-session", payload)
                }
                "get-session" => executor.call_channel("team-runtime:get-session", session_payload()),
                "pause-session" => {
                    executor.call_channel("team-runtime:pause-session", session_payload())
                }
                "resume-session" => {
                    executor.call_channel("team-runtime:resume-session", session_payload())
                }
                "archive-session" => {
                    executor.call_channel("team-runtime:archive-session", session_payload())
                }
                "list-members" | "members" => {
                    executor.call_channel("team-runtime:list-members", session_payload())
                }
                "add-member" | "spawn-member" => {
                    let payload = merged();
                    require_confirmed_team_plan("team.member.spawn", &payload)?;
                    executor.call_channel("team-runtime:add-member", payload)
                }
                "list-tasks" | "tasks" => {
                    executor.call_channel("team-runtime:list-tasks", session_payload())
                }
                "create-task" => executor.call_channel("team-runtime:create-task", merged()),
                "update-task" => executor.call_channel("team-runtime:update-task", merged()),
                "send-message" => executor.call_channel("team-runtime:send-message", merged()),
                "read-mailbox" => executor.call_channel("team-runtime:read-mailbox", merged()),
                "request-report" => executor.call_channel("team-runtime:request-report", merged()),
                "submit-report" => executor.call_channel("team-runtime:submit-report", merged()),
                "list-reports" => executor.call_channel("team-runtime:list-reports", merged()),
                "tick-reports" => {
                    executor.call_channel("team-runtime:tick-reports", session_payload())
                }
                "list-agent-backends" | "backends" => {
                    executor.call_channel("team-runtime:list-agent-backends", json!({}))
                }
                "list-tools" => executor.call_channel("team-runtime:list-tools", json!({})),
                "execute-tool" => executor.call_channel("team-runtime:execute-tool", merged()),
                "mcp-contract" => executor.call_channel("team-runtime:mcp-contract", json!({})),
                "execute-mcp-tool" => {
                    executor.call_channel("team-runtime:execute-mcp-tool", merged())
                }
                _ => Err(format!("unsupported runtime team action: {sub}")),
            }
        }
        "session-enter-diagnostics" => executor.call_channel(
            "chat:create-diagnostics-session",
            json!({
                "title": args.string(&["title"]).or_else(|| payload_string(payload, "title")),
                "contextId": args
                    .string(&["context-id", "contextId"])
                    .or_else(|| payload_string(payload, "contextId")),
                "contextType": args
                    .string(&["context-type", "contextType"])
                    .or_else(|| payload_string(payload, "contextType")),
            }),
        ),
        "session-bridge" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("status");
            let nested_args = parse_cli_args(&tokens[2..])?;
            match sub {
                "status" => executor.call_channel("session-bridge:status", json!({})),
                "list-sessions" => executor.call_channel("session-bridge:list-sessions", json!({})),
                "get-session" => executor.call_channel(
                    "session-bridge:get-session",
                    json!({
                        "sessionId": nested_args
                            .string(&["session-id", "sessionId"])
                            .or_else(|| payload_string(payload, "sessionId"))
                            .ok_or_else(|| "runtime session-bridge get-session requires --session-id".to_string())?
                    }),
                ),
                _ => Err(format!("unsupported runtime session-bridge action: {sub}")),
            }
        }
        _ => Err(format!("unsupported runtime action: {action}")),
    }
}
