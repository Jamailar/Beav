use super::*;

pub(super) fn handle(
    executor: &AppCliExecutor<'_>,
    tokens: &[String],
    payload: &Value,
) -> Result<Value, String> {
    let Some(action) = tokens.first().map(String::as_str) else {
        return Ok(help_response(Some("mcp")));
    };
    let args = parse_cli_args(&tokens[1..])?;
    let server_value = payload_field(payload, "server")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let parse_server = || -> Result<McpServerRecord, String> {
        if let Some(server_id) = payload_string(payload, "serverId")
            .or_else(|| payload_string(payload, "id"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return with_store(executor.state, |store| {
                store
                    .mcp_servers
                    .iter()
                    .find(|server| server.id == server_id || server.name == server_id)
                    .cloned()
                    .ok_or_else(|| format!("MCP server `{server_id}` not found"))
            });
        }
        serde_json::from_value(server_value.clone()).map_err(|error| error.to_string())
    };
    match action {
        "list" => commands::mcp_tools::mcp_list_value(executor.state),
        "add" => {
            let mut request = merge_payload(&args.options, payload);
            if let Some(object) = request.as_object_mut() {
                if !object.contains_key("name") {
                    if let Some(name) = args.positionals.first() {
                        object.insert("name".to_string(), Value::String(name.clone()));
                    }
                }
                if !object.contains_key("command") && !object.contains_key("url") {
                    if let Some(command) = args.positionals.get(1) {
                        object.insert("command".to_string(), Value::String(command.clone()));
                    }
                }
                if !object.contains_key("args") && args.positionals.len() > 2 {
                    object.insert(
                        "args".to_string(),
                        json!(args.positionals.iter().skip(2).cloned().collect::<Vec<_>>()),
                    );
                }
            }
            commands::mcp_tools::mcp_add_value(executor.state, &request)
        }
        "get" => {
            let request = merge_mcp_target_payload(&args, payload, "mcp get requires --id")?;
            commands::mcp_tools::mcp_get_value(executor.state, &request)
        }
        "remove" | "delete" => {
            let request = merge_mcp_target_payload(&args, payload, "mcp remove requires --id")?;
            commands::mcp_tools::mcp_remove_value(executor.state, &request)
        }
        "enable" => {
            let request = merge_mcp_target_payload(&args, payload, "mcp enable requires --id")?;
            commands::mcp_tools::mcp_set_enabled_value(executor.state, &request, true)
        }
        "disable" => {
            let request = merge_mcp_target_payload(&args, payload, "mcp disable requires --id")?;
            commands::mcp_tools::mcp_set_enabled_value(executor.state, &request, false)
        }
        "sessions" => commands::mcp_tools::mcp_sessions_value(executor.state),
        "oauth-status" => commands::mcp_tools::mcp_oauth_status_value(
            executor.state,
            &args
                .string(&["id", "server-id"])
                .or_else(|| payload_string(payload, "serverId"))
                .or_else(|| payload_string(payload, "id"))
                .or_else(|| args.positionals.first().cloned())
                .ok_or_else(|| "mcp oauth-status requires --id".to_string())?,
        ),
        "save" => commands::mcp_tools::mcp_save_value(executor.state, payload),
        "test" => commands::mcp_tools::mcp_probe_value(executor.state, &parse_server()?),
        "call" => commands::mcp_tools::mcp_call_value(
            executor.state,
            &parse_server()?,
            &args
                .string(&["method"])
                .or_else(|| payload_string(payload, "method"))
                .unwrap_or_default(),
            payload_field(payload, "params")
                .cloned()
                .unwrap_or_else(|| json!({})),
            args.string(&["session-id", "sessionId"])
                .or_else(|| payload_string(payload, "sessionId")),
        ),
        "list-tools" => commands::mcp_tools::mcp_call_value(
            executor.state,
            &parse_server()?,
            "tools/list",
            json!({}),
            args.string(&["session-id", "sessionId"])
                .or_else(|| payload_string(payload, "sessionId")),
        ),
        "list-resources" => commands::mcp_tools::mcp_call_value(
            executor.state,
            &parse_server()?,
            "resources/list",
            json!({}),
            args.string(&["session-id", "sessionId"])
                .or_else(|| payload_string(payload, "sessionId")),
        ),
        "list-resource-templates" => commands::mcp_tools::mcp_call_value(
            executor.state,
            &parse_server()?,
            "resources/templates/list",
            json!({}),
            args.string(&["session-id", "sessionId"])
                .or_else(|| payload_string(payload, "sessionId")),
        ),
        "disconnect" => commands::mcp_tools::mcp_disconnect_value(executor.state, &parse_server()?),
        "disconnect-all" => commands::mcp_tools::mcp_disconnect_all_value(executor.state),
        "discover-local" => commands::mcp_tools::mcp_discover_local_value(),
        "import-local" => commands::mcp_tools::mcp_import_local_value(executor.state),
        _ => Err(format!("unsupported mcp action: {action}")),
    }
}
