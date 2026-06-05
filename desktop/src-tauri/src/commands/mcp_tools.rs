#[path = "mcp_tools/diagnostics.rs"]
mod diagnostics;
#[path = "mcp_tools/registry.rs"]
mod registry;
#[path = "mcp_tools/runtime_hooks.rs"]
mod runtime_hooks;
#[path = "mcp_tools/server_payload.rs"]
mod server_payload;

use crate::persistence::{with_store, with_store_mut};
use crate::session_lineage_fields;
use crate::store::mcp_tools as mcp_tools_store;
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use diagnostics::{handle_tools_diagnostics_channel, is_tools_diagnostics_channel};
pub use registry::{
    mcp_add_value, mcp_discover_local_value, mcp_get_value, mcp_import_local_value, mcp_list_value,
    mcp_oauth_status_value, mcp_remove_value, mcp_save_value, mcp_set_enabled_value,
};
use runtime_hooks::handle_runtime_hooks_channel;

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
            | "mcp:add"
            | "mcp:get"
            | "mcp:remove"
            | "mcp:delete"
            | "mcp:enable"
            | "mcp:disable"
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
            | "tools:hooks:list"
            | "tools:hooks:register"
            | "tools:hooks:remove"
    ) && !is_tools_diagnostics_channel(channel)
    {
        return None;
    }

    Some((|| -> Result<Value, String> {
        if let Some(result) = handle_tools_diagnostics_channel(state, channel, payload) {
            return result;
        }
        if let Some(result) = handle_runtime_hooks_channel(state, channel, payload) {
            return result;
        }
        match channel {
            "mcp:list" => mcp_list_value(state),
            "mcp:add" => mcp_add_value(state, payload),
            "mcp:get" => mcp_get_value(state, payload),
            "mcp:remove" | "mcp:delete" => mcp_remove_value(state, payload),
            "mcp:enable" => mcp_set_enabled_value(state, payload, true),
            "mcp:disable" => mcp_set_enabled_value(state, payload, false),
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
        mcp_tools_store::find_server(&store, &server_id)
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
