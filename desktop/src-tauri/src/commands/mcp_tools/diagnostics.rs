use super::*;
use crate::tools::registry::diagnostics_tool_items;

pub(super) fn is_tools_diagnostics_channel(channel: &str) -> bool {
    matches!(
        channel,
        "tools:diagnostics:list" | "tools:diagnostics:run-direct" | "tools:diagnostics:run-ai"
    )
}

pub(super) fn handle_tools_diagnostics_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "tools:diagnostics:list" => list_diagnostics_tools(state),
        "tools:diagnostics:run-direct" | "tools:diagnostics:run-ai" => {
            run_diagnostics_tool(state, channel, payload)
        }
        _ => return None,
    };
    Some(result)
}

fn list_diagnostics_tools(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        let mut items = vec![
            json!({
                "name": "desktop_host",
                "displayName": format!("{} Host", app_brand_display_name()),
                "description": "Check local Rust host availability.",
                "kind": "host",
                "visibility": "developer",
                "contexts": ["desktop"],
                "availabilityStatus": "available",
                "availabilityReason": "Rust host is compiled locally."
            }),
            json!({
                "name": "tauri_runtime",
                "displayName": "Tauri Runtime",
                "description": "Check Tauri desktop runtime build pipeline.",
                "kind": "host",
                "visibility": "developer",
                "contexts": ["desktop"],
                "availabilityStatus": "available",
                "availabilityReason": "Tauri debug build succeeds locally."
            }),
        ];
        items.extend(diagnostics_tool_items());
        for server in mcp_tools_store::list_servers(&store) {
            items.push(json!({
                "name": format!("mcp_server:{}", server.id),
                "displayName": format!("MCP · {}", server.name),
                "description": "Run a real MCP tools/list probe against this configured server.",
                "kind": "mcp",
                "visibility": "developer",
                "contexts": ["desktop"],
                "availabilityStatus": if server.enabled { "available" } else { "missing_context" },
                "availabilityReason": if server.enabled {
                    format!("server configured in {}", app_brand_display_name())
                } else {
                    "server disabled".to_string()
                },
            }));
        }
        Ok(json!(items))
    })
}

fn run_diagnostics_tool(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Result<Value, String> {
    let tool_name = payload_string(payload, "toolName").unwrap_or_else(|| "unknown".to_string());
    let mode = if channel.ends_with("run-ai") {
        "ai"
    } else {
        "direct"
    };
    if let Some(server_id) = tool_name.strip_prefix("mcp_server:") {
        let server = with_store(state, |store| {
            Ok(mcp_tools_store::find_server(&store, server_id))
        })?;
        if let Some(server) = server {
            return match state.mcp_manager.list_tools(&server) {
                Ok(result) => Ok(json!({
                    "success": true,
                    "mode": mode,
                    "toolName": tool_name,
                    "request": { "server": server, "method": "tools/list" },
                    "response": result.response,
                    "session": result.session,
                    "capabilities": result.capabilities,
                    "effectiveEnvironment": crate::mcp::transport::mcp_stdio_effective_environment_metadata(&server),
                    "executionSucceeded": true
                })),
                Err(error) => Ok(json!({
                    "success": false,
                    "mode": mode,
                    "toolName": tool_name,
                    "request": { "server": server, "method": "tools/list" },
                    "error": error,
                    "effectiveEnvironment": crate::mcp::transport::mcp_stdio_effective_environment_metadata(&server),
                    "executionSucceeded": false
                })),
            };
        }
    }
    Ok(json!({
        "success": true,
        "mode": mode,
        "toolName": tool_name,
        "request": payload,
        "response": { "status": "ok", "source": "local-host" },
        "executionSucceeded": true
    }))
}
