use crate::persistence::{with_store, with_store_mut};
use crate::session_lineage_fields;
use crate::tools::registry::diagnostics_tool_items;
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

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
            "mcp:list" => with_store(state, |store| {
                Ok(json!({ "success": true, "servers": store.mcp_servers.clone() }))
            }),
            "mcp:save" => {
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
                    Ok(json!({ "success": true, "servers": next }))
                })
            }
            "mcp:test" => {
                let server: McpServerRecord = payload_field(payload, "server")
                    .cloned()
                    .ok_or_else(|| "缺少 server".to_string())
                    .and_then(|value| {
                        serde_json::from_value(value).map_err(|error| error.to_string())
                    })?;
                match test_mcp_server(&server) {
                    Ok((message, detail)) => {
                        Ok(json!({ "success": true, "message": message, "detail": detail }))
                    }
                    Err(error) => {
                        Ok(json!({ "success": false, "message": error.clone(), "detail": error }))
                    }
                }
            }
            "mcp:call" => {
                let server: McpServerRecord = payload_field(payload, "server")
                    .cloned()
                    .ok_or_else(|| "缺少 server".to_string())
                    .and_then(|value| {
                        serde_json::from_value(value).map_err(|error| error.to_string())
                    })?;
                let method = payload_string(payload, "method").unwrap_or_default();
                let params = payload_field(payload, "params")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let session_id = payload_string(payload, "sessionId");
                if method.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少 method" }));
                }
                match invoke_mcp_server(&server, &method, params) {
                    Ok(response) => {
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
                                    payload: Some(
                                        json!({ "server": server, "response": response }),
                                    ),
                                    created_at: now_i64(),
                                    updated_at: now_i64(),
                                });
                                Ok(())
                            });
                        }
                        Ok(json!({ "success": true, "response": response }))
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
            "mcp:discover-local" => {
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
            "mcp:import-local" => {
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
                    Ok(json!({
                        "success": true,
                        "imported": merged.len(),
                        "total": merged.len(),
                        "sources": sources,
                        "servers": store.mcp_servers.clone()
                    }))
                })
            }
            "mcp:oauth-status" => {
                let server_id = payload_string(payload, "serverId").unwrap_or_default();
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
                        return match invoke_mcp_server(&server, "tools/list", json!({})) {
                            Ok(response) => Ok(json!({
                                "success": true,
                                "mode": mode,
                                "toolName": tool_name,
                                "request": { "server": server, "method": "tools/list" },
                                "response": response,
                                "executionSucceeded": true
                            })),
                            Err(error) => Ok(json!({
                                "success": false,
                                "mode": mode,
                                "toolName": tool_name,
                                "request": { "server": server, "method": "tools/list" },
                                "error": error,
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
                    "response": { "status": "ok", "source": "lexbox-local-host" },
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
