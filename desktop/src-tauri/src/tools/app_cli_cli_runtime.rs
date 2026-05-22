use super::*;

pub(super) fn handle(
    executor: &AppCliExecutor<'_>,
    tokens: &[String],
    payload: &Value,
) -> Result<Value, String> {
    let Some(action) = tokens.first().map(String::as_str) else {
        return Ok(help_response(Some("cli_runtime")));
    };
    let args = parse_cli_args(&tokens[1..])?;
    match action {
        "detect" => executor.call_channel(
            "cli-runtime:detect",
            json!({
                "commands": payload_field(payload, "commands")
                    .cloned()
                    .unwrap_or_else(|| json!(args.positionals)),
                "sessionId": payload_string(payload, "sessionId"),
                "taskId": payload_string(payload, "taskId"),
            }),
        ),
        "discover" => executor.call_channel(
            "cli-runtime:discover",
            json!({
                "query": args
                    .string(&["query", "q"])
                    .or_else(|| payload_string(payload, "query")),
                "limit": args
                    .i64(&["limit"])
                    .or_else(|| payload_field(payload, "limit").and_then(Value::as_i64)),
                "sessionId": payload_string(payload, "sessionId"),
                "taskId": payload_string(payload, "taskId"),
            }),
        ),
        "inspect" => executor.call_channel(
            "cli-runtime:inspect",
            json!({
                "toolId": args
                    .string(&["tool-id", "toolId"])
                    .or_else(|| payload_string(payload, "toolId"))
                    .or_else(|| payload_string(payload, "id")),
                "command": args
                    .string(&["command", "executable", "name", "id"])
                    .or_else(|| payload_string(payload, "command"))
                    .or_else(|| payload_string(payload, "executable"))
                    .or_else(|| payload_string(payload, "name"))
                    .or_else(|| payload_string(payload, "id")),
                "executable": args
                    .string(&["executable", "command", "name", "id"])
                    .or_else(|| payload_string(payload, "executable"))
                    .or_else(|| payload_string(payload, "command"))
                    .or_else(|| payload_string(payload, "name"))
                    .or_else(|| payload_string(payload, "id")),
            }),
        ),
        "diagnose" => executor.call_channel(
            "cli-runtime:diagnose",
            json!({
                "command": args
                    .string(&["command", "executable", "name", "id"])
                    .or_else(|| payload_string(payload, "command"))
                    .or_else(|| payload_string(payload, "executable"))
                    .or_else(|| payload_string(payload, "name"))
                    .or_else(|| payload_string(payload, "id"))
                    .or_else(|| args.positionals.first().cloned())
                    .ok_or_else(|| "cli_runtime diagnose requires --command".to_string())?,
                "environmentId": args
                    .string(&["environment-id", "environmentId"])
                    .or_else(|| payload_string(payload, "environmentId")),
                "cwd": args
                    .string(&["cwd"])
                    .or_else(|| payload_string(payload, "cwd")),
                "executionMode": args
                    .string(&["execution-mode", "executionMode", "mode"])
                    .or_else(|| payload_string(payload, "executionMode"))
                    .or_else(|| payload_string(payload, "mode")),
            }),
        ),
        "environment" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("list");
            let nested_args = parse_cli_args(&tokens[2..])?;
            match sub {
                "list" => executor.call_channel("cli-runtime:list-environments", json!({})),
                "create" => executor.call_channel(
                    "cli-runtime:create-environment",
                    json!({
                        "scope": executor
                            .cli_runtime_scope_input(&nested_args, payload, &["name"])
                            .ok_or_else(|| "cli_runtime environment.create requires --scope".to_string())?,
                        "workspaceRoot": nested_args
                            .string(&["workspace-root", "workspaceRoot"])
                            .or_else(|| payload_string(payload, "workspaceRoot")),
                        "taskId": nested_args
                            .string(&["task-id", "taskId"])
                            .or_else(|| payload_string(payload, "taskId")),
                    }),
                ),
                _ => Err(format!("unsupported cli_runtime environment action: {sub}")),
            }
        }
        "install" => executor.call_channel(
            "cli-runtime:install",
            json!({
                "environmentId": args
                    .string(&["environment-id", "environmentId"])
                    .or_else(|| payload_string(payload, "environmentId")),
                "installMethod": args
                    .string(&["install-method", "installMethod"])
                    .or_else(|| payload_string(payload, "installMethod"))
                    .ok_or_else(|| "cli_runtime install requires --install-method".to_string())?,
                "spec": args
                    .string(&["spec"])
                    .or_else(|| payload_string(payload, "spec"))
                    .or_else(|| payload_string(payload, "installSpec"))
                    .or_else(|| payload_string(payload, "package"))
                    .or_else(|| payload_string(payload, "packageName"))
                    .or_else(|| {
                        if payload_string(payload, "toolName").is_none() {
                            payload_string(payload, "name")
                        } else {
                            None
                        }
                    })
                    .ok_or_else(|| "cli_runtime install requires --spec".to_string())?,
                "toolName": args
                    .string(&["tool-name", "toolName"])
                    .or_else(|| payload_string(payload, "toolName"))
                    .or_else(|| payload_string(payload, "name")),
                "executionMode": args
                    .string(&["execution-mode", "executionMode", "mode"])
                    .or_else(|| payload_string(payload, "executionMode"))
                    .or_else(|| payload_string(payload, "mode")),
                "sessionId": payload_string(payload, "sessionId"),
                "taskId": payload_string(payload, "taskId"),
                "runtimeId": payload_string(payload, "runtimeId"),
                "env": payload_field(payload, "env").cloned().unwrap_or_else(|| json!({})),
            }),
        ),
        "execute" => executor.call_channel(
            "cli-runtime:execute",
            json!({
                "environmentId": args
                    .string(&["environment-id", "environmentId"])
                    .or_else(|| payload_string(payload, "environmentId")),
                "toolId": args
                    .string(&["tool-id", "toolId"])
                    .or_else(|| payload_string(payload, "toolId")),
                "argv": payload_field(payload, "argv")
                    .cloned()
                    .or_else(|| {
                        if args.positionals.is_empty() {
                            None
                        } else {
                            Some(json!(args.positionals))
                        }
                    })
                    .ok_or_else(|| "cli_runtime execute requires argv".to_string())?,
                "cwd": args
                    .string(&["cwd"])
                    .or_else(|| payload_string(payload, "cwd")),
                "sessionId": payload_string(payload, "sessionId"),
                "taskId": payload_string(payload, "taskId"),
                "runtimeId": payload_string(payload, "runtimeId"),
                "executionMode": args
                    .string(&["execution-mode", "executionMode", "mode"])
                    .or_else(|| payload_string(payload, "executionMode"))
                    .or_else(|| payload_string(payload, "mode")),
                "usePty": payload_field(payload, "usePty").cloned().unwrap_or_else(|| json!(false)),
                "verificationRules": payload_field(payload, "verificationRules")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                "env": payload_field(payload, "env").cloned().unwrap_or_else(|| json!({})),
            }),
        ),
        "get" => executor.call_channel(
            "cli-runtime:get-execution",
            json!({
                "executionId": args
                    .string(&["execution-id", "executionId", "id"])
                    .or_else(|| payload_string(payload, "executionId"))
                    .or_else(|| payload_string(payload, "id"))
                    .ok_or_else(|| "cli_runtime get requires --execution-id".to_string())?,
                "maxChars": args
                    .i64(&["max-chars", "maxChars"])
                    .or_else(|| payload_field(payload, "maxChars").and_then(Value::as_i64)),
            }),
        ),
        "execution" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("get");
            let nested_args = parse_cli_args(&tokens[2..])?;
            match sub {
                "get" | "poll" => executor.call_channel(
                    "cli-runtime:get-execution",
                    json!({
                        "executionId": nested_args
                            .string(&["execution-id", "executionId", "id"])
                            .or_else(|| payload_string(payload, "executionId"))
                            .or_else(|| payload_string(payload, "id"))
                            .ok_or_else(|| "cli_runtime execution.get requires --execution-id".to_string())?,
                        "maxChars": nested_args
                            .i64(&["max-chars", "maxChars"])
                            .or_else(|| payload_field(payload, "maxChars").and_then(Value::as_i64)),
                    }),
                ),
                _ => Err(format!("unsupported cli_runtime execution action: {sub}")),
            }
        }
        "verify" => executor.call_channel(
            "cli-runtime:verify",
            json!({
                "executionId": args
                    .string(&["execution-id", "executionId"])
                    .or_else(|| payload_string(payload, "executionId"))
                    .ok_or_else(|| "cli_runtime verify requires --execution-id".to_string())?,
                "rules": payload_field(payload, "rules")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            }),
        ),
        "escalation" => {
            let sub = tokens.get(1).map(String::as_str).unwrap_or("");
            let nested_args = parse_cli_args(&tokens[2..])?;
            match sub {
                "approve" => executor.call_channel(
                    "cli-runtime:approve-escalation",
                    json!({
                        "escalationId": nested_args
                            .string(&["escalation-id", "escalationId"])
                            .or_else(|| payload_string(payload, "escalationId"))
                            .ok_or_else(|| "cli_runtime escalation.approve requires --escalation-id".to_string())?,
                        "scope": nested_args
                            .string(&["scope"])
                            .or_else(|| payload_string(payload, "scope"))
                            .ok_or_else(|| "cli_runtime escalation.approve requires --scope".to_string())?,
                    }),
                ),
                "deny" => executor.call_channel(
                    "cli-runtime:deny-escalation",
                    json!({
                        "escalationId": nested_args
                            .string(&["escalation-id", "escalationId"])
                            .or_else(|| payload_string(payload, "escalationId"))
                            .ok_or_else(|| "cli_runtime escalation.deny requires --escalation-id".to_string())?,
                        "reason": nested_args
                            .string(&["reason"])
                            .or_else(|| payload_string(payload, "reason")),
                    }),
                ),
                _ => Err(format!("unsupported cli_runtime escalation action: {sub}")),
            }
        }
        _ => Err(format!("unsupported cli_runtime action: {action}")),
    }
}
