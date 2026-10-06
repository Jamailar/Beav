use super::server_payload::{
    mcp_server_from_add_payload, mcp_target_name, validate_mcp_server_name,
};
use super::*;

pub fn mcp_list_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
    let (servers, builtin_synced) = with_store_mut(state, |store| {
        let builtin_synced = crate::browser_control_mcp::ensure_builtin_browser_control_mcp(store);
        Ok((mcp_tools_store::list_servers(&store), builtin_synced))
    })?;
    if builtin_synced {
        state.mcp_manager.sync_servers(&servers)?;
    }
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

pub fn mcp_save_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    if let Some(server_value) = payload_field(payload, "server").cloned() {
        let server: McpServerRecord =
            serde_json::from_value(server_value).map_err(|error| error.to_string())?;
        let next = with_store_mut(state, |store| {
            Ok(mcp_tools_store::upsert_server(store, server.clone()))
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
        mcp_tools_store::replace_servers(store, next.clone());
        Ok(())
    })?;
    state.mcp_manager.sync_servers(&next)?;
    Ok(json!({ "success": true, "servers": next }))
}

pub fn mcp_add_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let name = payload_string(payload, "name")
        .or_else(|| payload_string(payload, "serverId"))
        .or_else(|| payload_string(payload, "id"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "mcp add requires name".to_string())?;
    validate_mcp_server_name(&name)?;

    let existing = with_store(state, |store| {
        Ok(mcp_tools_store::find_server(&store, &name))
    })?;
    let server = mcp_server_from_add_payload(payload, &name, existing.as_ref())?;
    let mode = if existing.is_some() { "update" } else { "add" };
    let next = with_store_mut(state, |store| {
        Ok(mcp_tools_store::upsert_server(store, server.clone()))
    })?;
    state.mcp_manager.sync_servers(&next)?;
    Ok(json!({
        "success": true,
        "mode": mode,
        "server": server,
        "servers": next
    }))
}

pub fn mcp_get_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let target = mcp_target_name(payload)?;
    let server = find_mcp_server(state, &target)?;
    Ok(json!({
        "success": true,
        "server": server,
        "session": state.mcp_manager.session_for_server(&server)?,
        "effectiveServer": crate::mcp::config::effective_server_config(&server),
        "effectiveEnvironment": crate::mcp::transport::mcp_stdio_effective_environment_metadata(&server),
    }))
}

pub fn mcp_remove_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let target = mcp_target_name(payload)?;
    let (removed, next) = with_store_mut(state, |store| {
        Ok(mcp_tools_store::remove_server(store, &target))
    })?;
    state.mcp_manager.sync_servers(&next)?;
    let disconnected = removed
        .as_ref()
        .map(|server| state.mcp_manager.disconnect_server(server))
        .transpose()?
        .unwrap_or(false);
    Ok(json!({
        "success": true,
        "removed": removed.is_some(),
        "server": removed,
        "disconnected": disconnected,
        "servers": next
    }))
}

pub fn mcp_set_enabled_value(
    state: &State<'_, AppState>,
    payload: &Value,
    enabled: bool,
) -> Result<Value, String> {
    let target = mcp_target_name(payload)?;
    let (server, next) = with_store_mut(state, |store| {
        mcp_tools_store::set_server_enabled(store, &target, enabled)
    })?;
    state.mcp_manager.sync_servers(&next)?;
    let disconnected = if enabled {
        false
    } else {
        state.mcp_manager.disconnect_server(&server)?
    };
    Ok(json!({
        "success": true,
        "enabled": enabled,
        "server": server,
        "disconnected": disconnected,
        "servers": next
    }))
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
        Ok(mcp_tools_store::replace_servers_if_non_empty(
            store,
            merged.clone(),
        ))
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
        let status = mcp_tools_store::oauth_status(&store, server_id);
        Ok(json!({
            "success": true,
            "connected": status.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "tokenPath": status.get("tokenPath").and_then(|v| v.as_str()).unwrap_or("")
        }))
    })
}

fn find_mcp_server(state: &State<'_, AppState>, target: &str) -> Result<McpServerRecord, String> {
    with_store(state, |store| {
        mcp_tools_store::find_server(&store, target)
            .ok_or_else(|| format!("MCP server `{target}` not found"))
    })
}
