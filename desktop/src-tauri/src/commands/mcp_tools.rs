use crate::persistence::{with_store, with_store_mut};
use crate::session_lineage_fields;
use crate::tools::registry::diagnostics_tool_items;
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn mcp_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let servers = with_store(state, |store| Ok(store.mcp_servers.clone()))?;
    let sessions = state.mcp_manager.sessions()?;
    let items = servers
        .iter()
        .cloned()
        .map(|server| {
            let session = state.mcp_manager.session_for_server(&server)?;
            Ok(json!({
                "server": server,
                "session": session,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "success": true,
        "servers": servers,
        "effectiveServers": crate::mcp::config::effective_servers_value(&servers),
        "items": items,
        "sessions": sessions,
    }))
}

pub fn mcp_probe_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
) -> Result<Value, String> {
    let effective_environment =
        crate::mcp::transport::mcp_stdio_effective_environment_metadata(server);
    match test_mcp_server(state, server) {
        Ok(result) => Ok(json!({
            "success": true,
            "message": result.message,
            "detail": result.detail,
            "session": result.session,
            "capabilities": result.capabilities,
            "effectiveEnvironment": effective_environment,
        })),
        Err(error) => Ok(json!({
            "success": false,
            "message": error.clone(),
            "detail": error,
            "effectiveEnvironment": effective_environment,
        })),
    }
}

pub fn mcp_call_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
    method: &str,
    params: Value,
    session_id: Option<String>,
) -> Result<Value, String> {
    if method.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "缺少 method" }));
    }
    if !is_allowed_diagnostics_mcp_method(method) {
        return Ok(json!({
            "success": false,
            "error": format!("unsupported MCP diagnostics method: {method}"),
            "code": "MCP_METHOD_NOT_ALLOWED",
            "allowedMethods": allowed_diagnostics_mcp_methods(),
        }));
    }
    mcp_call_result_value(
        state,
        server,
        method,
        session_id,
        invoke_mcp_server(state, server, method, params),
    )
}

pub fn mcp_sessions_value(state: &State<'_, AppState>) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "sessions": state.mcp_manager.sessions()?,
    }))
}

pub fn mcp_list_tools_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
    session_id: Option<String>,
) -> Result<Value, String> {
    mcp_call_result_value(
        state,
        server,
        "tools/list",
        session_id,
        state.mcp_manager.list_tools(server),
    )
}

pub fn mcp_list_resources_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
    session_id: Option<String>,
) -> Result<Value, String> {
    mcp_call_result_value(
        state,
        server,
        "resources/list",
        session_id,
        state.mcp_manager.list_resources(server),
    )
}

pub fn mcp_list_resource_templates_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
    session_id: Option<String>,
) -> Result<Value, String> {
    mcp_call_result_value(
        state,
        server,
        "resources/templates/list",
        session_id,
        state.mcp_manager.list_resource_templates(server),
    )
}

pub fn mcp_save_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    if let Some(server_value) = payload_field(payload, "server").cloned() {
        let server: McpServerRecord =
            serde_json::from_value(server_value).map_err(|error| error.to_string())?;
        let next = with_store_mut(state, |store| {
            store
                .mcp_servers
                .retain(|item| item.id != server.id && item.name != server.name);
            store.mcp_servers.push(server.clone());
            Ok(store.mcp_servers.clone())
        })?;
        state.mcp_manager.sync_servers(&next)?;
        return Ok(json!({ "success": true, "mode": "upsert", "server": server, "servers": next }));
    }
    let servers = payload_field(payload, "servers")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let next: Vec<McpServerRecord> = servers
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();
    with_store_mut(state, |store| {
        store.mcp_servers = next.clone();
        Ok(())
    })?;
    state.mcp_manager.sync_servers(&next)?;
    Ok(json!({ "success": true, "servers": next }))
}

pub fn mcp_discover_local_value() -> Result<Value, String> {
    let items = discover_local_mcp_configs()
        .into_iter()
        .map(|(source_path, servers)| {
            json!({
                "sourcePath": source_path,
                "count": servers.len(),
                "servers": servers,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "success": true, "items": items }))
}

pub fn mcp_import_local_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let discovered = discover_local_mcp_configs();
    let mut merged = Vec::<McpServerRecord>::new();
    let mut sources = Vec::<String>::new();
    for (source_path, servers) in &discovered {
        sources.push(source_path.clone());
        merged.extend(servers.clone());
    }
    with_store_mut(state, |store| {
        if !merged.is_empty() {
            store.mcp_servers = merged.clone();
        }
        Ok(store.mcp_servers.clone())
    })
    .and_then(|servers| {
        state.mcp_manager.sync_servers(&servers)?;
        Ok(json!({
            "success": true,
            "imported": merged.len(),
            "total": merged.len(),
            "sources": sources,
            "servers": servers
        }))
    })
}

pub fn mcp_oauth_status_value(
    state: &State<'_, AppState>,
    server_id: &str,
) -> Result<Value, String> {
    with_store(state, |store| {
        let status = store
            .mcp_servers
            .iter()
            .find(|item| item.id == server_id)
            .and_then(|item| item.oauth.clone())
            .unwrap_or_else(|| json!({}));
        Ok(json!({
            "success": true,
            "connected": status.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "tokenPath": status.get("tokenPath").and_then(|v| v.as_str()).unwrap_or("")
        }))
    })
}

pub fn mcp_disconnect_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "disconnected": state.mcp_manager.disconnect_server(server)?,
        "sessions": state.mcp_manager.sessions()?,
    }))
}

pub fn mcp_disconnect_all_value(state: &State<'_, AppState>) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "disconnected": state.mcp_manager.disconnect_all()?,
        "sessions": state.mcp_manager.sessions()?,
    }))
}

pub fn handle_mcp_tools_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "mcp:list"
            | "mcp:save"
            | "mcp:test"
            | "mcp:call"
            | "mcp:sessions"
            | "mcp:list-tools"
            | "mcp:list-resources"
            | "mcp:list-resource-templates"
            | "mcp:disconnect"
            | "mcp:disconnect-all"
            | "mcp:discover-local"
            | "mcp:import-local"
            | "mcp:oauth-status"
            | "tools:diagnostics:list"
            | "tools:diagnostics:run-direct"
            | "tools:diagnostics:run-ai"
            | "tools:hooks:list"
            | "tools:hooks:register"
            | "tools:hooks:remove"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "mcp:list" => mcp_list_value(state),
            "mcp:save" => mcp_save_value(state, payload),
            "mcp:test" => {
                let server = resolve_mcp_server_from_payload(state, payload)?;
                mcp_probe_value(state, &server)
            }
            "mcp:call" => {
                let server = resolve_mcp_server_from_payload(state, payload)?;
                let method = payload_string(payload, "method").unwrap_or_default();
                let params = payload_field(payload, "params")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let session_id = payload_string(payload, "sessionId");
                mcp_call_value(state, &server, &method, params, session_id)
            }
            "mcp:sessions" => mcp_sessions_value(state),
            "mcp:list-tools" => mcp_typed_list_value(state, payload, McpListKind::Tools),
            "mcp:list-resources" => mcp_typed_list_value(state, payload, McpListKind::Resources),
            "mcp:list-resource-templates" => {
                mcp_typed_list_value(state, payload, McpListKind::ResourceTemplates)
            }
            "mcp:disconnect" => {
                let server = resolve_mcp_server_from_payload(state, payload)?;
                mcp_disconnect_value(state, &server)
            }
            "mcp:disconnect-all" => mcp_disconnect_all_value(state),
            "mcp:discover-local" => mcp_discover_local_value(),
            "mcp:import-local" => mcp_import_local_value(state),
            "mcp:oauth-status" => {
                let server_id = payload_string(payload, "serverId").unwrap_or_default();
                mcp_oauth_status_value(state, &server_id)
            }
            "tools:diagnostics:list" => with_store(state, |store| {
                let mut items = vec![
                    json!({
                        "name": "redbox_host",
                        "displayName": "RedBox Host",
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
                for server in &store.mcp_servers {
                    items.push(json!({
                        "name": format!("mcp_server:{}", server.id),
                        "displayName": format!("MCP · {}", server.name),
                        "description": "Run a real MCP tools/list probe against this configured server.",
                        "kind": "mcp",
                        "visibility": "developer",
                        "contexts": ["desktop"],
                        "availabilityStatus": if server.enabled { "available" } else { "missing_context" },
                        "availabilityReason": if server.enabled { "server configured in RedBox" } else { "server disabled" },
                    }));
                }
                Ok(json!(items))
            }),
            "tools:diagnostics:run-direct" | "tools:diagnostics:run-ai" => {
                let tool_name =
                    payload_string(payload, "toolName").unwrap_or_else(|| "unknown".to_string());
                if let Some(server_id) = tool_name.strip_prefix("mcp_server:") {
                    let server = with_store(state, |store| {
                        Ok(store
                            .mcp_servers
                            .iter()
                            .find(|item| item.id == server_id)
                            .cloned())
                    })?;
                    if let Some(server) = server {
                        let mode = if channel.ends_with("run-ai") {
                            "ai"
                        } else {
                            "direct"
                        };
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
                    "mode": if channel.ends_with("run-ai") { "ai" } else { "direct" },
                    "toolName": tool_name,
                    "request": payload,
                    "response": { "status": "ok", "source": "redbox-local-host" },
                    "executionSucceeded": true
                }))
            }
            "tools:hooks:list" => with_store(state, |store| Ok(json!(store.runtime_hooks.clone()))),
            "tools:hooks:register" => {
                let hook = RuntimeHookRecord {
                    id: make_id("hook"),
                    event: payload_string(payload, "event").unwrap_or_else(|| "tool".to_string()),
                    r#type: payload_string(payload, "type").unwrap_or_else(|| "log".to_string()),
                    matcher: normalize_optional_string(payload_string(payload, "matcher")),
                    enabled: Some(
                        payload_field(payload, "enabled")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true),
                    ),
                };
                with_store_mut(state, |store| {
                    store.runtime_hooks.push(hook.clone());
                    Ok(json!({ "success": true, "hookId": hook.id }))
                })
            }
            "tools:hooks:remove" => {
                let hook_id = payload_string(payload, "hookId")
                    .or_else(|| payload_string(payload, "id"))
                    .unwrap_or_default();
                with_store_mut(state, |store| {
                    store.runtime_hooks.retain(|item| item.id != hook_id);
                    Ok(json!({ "success": true }))
                })
            }
            _ => unreachable!(),
        }
    })())
}

fn mcp_call_result_value(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
    method: &str,
    session_id: Option<String>,
    result: Result<crate::mcp::McpInvocationResult, String>,
) -> Result<Value, String> {
    match result {
        Ok(result) => {
            let response = result.response.clone();
            let session_snapshot = result.session.clone();
            let capabilities = result.capabilities.clone();
            if let Some(session_id) = session_id.clone() {
                let _ = with_store_mut(state, |store| {
                    let (runtime_id, parent_runtime_id, source_task_id) =
                        session_lineage_fields(store, &session_id);
                    store.session_tool_results.push(SessionToolResultRecord {
                        id: make_id("tool-result"),
                        session_id,
                        runtime_id,
                        parent_runtime_id,
                        source_task_id,
                        call_id: make_id("call"),
                        tool_name: format!("mcp:{}", method),
                        command: server.command.clone().or(server.url.clone()),
                        success: true,
                        result_text: Some(response.to_string()),
                        summary_text: Some(format!("MCP {} succeeded", method)),
                        prompt_text: None,
                        original_chars: None,
                        prompt_chars: None,
                        truncated: false,
                        payload: Some(json!({
                            "server": server,
                            "response": response.clone(),
                            "session": session_snapshot.clone(),
                            "capabilities": capabilities.clone(),
                        })),
                        created_at: now_i64(),
                        updated_at: now_i64(),
                    });
                    Ok(())
                });
            }
            Ok(json!({
                "success": true,
                "response": response,
                "session": result.session,
                "capabilities": result.capabilities,
            }))
        }
        Err(error) => {
            if let Some(session_id) = session_id {
                let _ = with_store_mut(state, |store| {
                    let (runtime_id, parent_runtime_id, source_task_id) =
                        session_lineage_fields(store, &session_id);
                    store.session_tool_results.push(SessionToolResultRecord {
                        id: make_id("tool-result"),
                        session_id,
                        runtime_id,
                        parent_runtime_id,
                        source_task_id,
                        call_id: make_id("call"),
                        tool_name: format!("mcp:{}", method),
                        command: server.command.clone().or(server.url.clone()),
                        success: false,
                        result_text: None,
                        summary_text: Some(error.clone()),
                        prompt_text: None,
                        original_chars: None,
                        prompt_chars: None,
                        truncated: false,
                        payload: Some(json!({ "server": server })),
                        created_at: now_i64(),
                        updated_at: now_i64(),
                    });
                    Ok(())
                });
            }
            Ok(json!({ "success": false, "error": error }))
        }
    }
}

enum McpListKind {
    Tools,
    Resources,
    ResourceTemplates,
}

fn mcp_typed_list_value(
    state: &State<'_, AppState>,
    payload: &Value,
    kind: McpListKind,
) -> Result<Value, String> {
    let server = resolve_mcp_server_from_payload(state, payload)?;
    let session_id = payload_string(payload, "sessionId");
    match kind {
        McpListKind::Tools => mcp_list_tools_value(state, &server, session_id),
        McpListKind::Resources => mcp_list_resources_value(state, &server, session_id),
        McpListKind::ResourceTemplates => {
            mcp_list_resource_templates_value(state, &server, session_id)
        }
    }
}

fn resolve_mcp_server_from_payload(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<McpServerRecord, String> {
    if let Some(server_value) = payload_field(payload, "server").cloned() {
        return serde_json::from_value(server_value).map_err(|error| error.to_string());
    }
    let server_id = payload_string(payload, "serverId")
        .or_else(|| payload_string(payload, "id"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 server 或 serverId".to_string())?;
    with_store(state, |store| {
        store
            .mcp_servers
            .iter()
            .find(|server| server.id == server_id || server.name == server_id)
            .cloned()
            .ok_or_else(|| format!("MCP server `{server_id}` not found"))
    })
}

fn allowed_diagnostics_mcp_methods() -> &'static [&'static str] {
    &[
        "initialize",
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "resources/templates/list",
        "ping",
    ]
}

fn is_allowed_diagnostics_mcp_method(method: &str) -> bool {
    allowed_diagnostics_mcp_methods()
        .iter()
        .any(|allowed| *allowed == method.trim())
}
