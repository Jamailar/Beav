use serde_json::{json, Value};

use super::types::AppStore;
use crate::{McpServerRecord, RuntimeHookRecord};

pub(crate) fn list_servers(store: &AppStore) -> Vec<McpServerRecord> {
    store.mcp_servers.clone()
}

pub(crate) fn find_server(store: &AppStore, target: &str) -> Option<McpServerRecord> {
    store
        .mcp_servers
        .iter()
        .find(|server| server.id == target || server.name == target)
        .cloned()
}

pub(crate) fn upsert_server(store: &mut AppStore, server: McpServerRecord) -> Vec<McpServerRecord> {
    store
        .mcp_servers
        .retain(|item| item.id != server.id && item.name != server.name);
    store.mcp_servers.push(server);
    list_servers(store)
}

pub(crate) fn replace_servers(
    store: &mut AppStore,
    servers: Vec<McpServerRecord>,
) -> Vec<McpServerRecord> {
    store.mcp_servers = servers;
    list_servers(store)
}

pub(crate) fn replace_servers_if_non_empty(
    store: &mut AppStore,
    servers: Vec<McpServerRecord>,
) -> Vec<McpServerRecord> {
    if !servers.is_empty() {
        store.mcp_servers = servers;
    }
    list_servers(store)
}

pub(crate) fn replace_thrive_plugin_servers(
    store: &mut AppStore,
    servers: Vec<McpServerRecord>,
) -> Vec<McpServerRecord> {
    store
        .mcp_servers
        .retain(|server| thrive_plugin_id(server).is_none());
    store.mcp_servers.extend(servers);
    list_servers(store)
}

pub(crate) fn remove_server(
    store: &mut AppStore,
    target: &str,
) -> (Option<McpServerRecord>, Vec<McpServerRecord>) {
    let removed = find_server(store, target);
    if removed.is_some() {
        store
            .mcp_servers
            .retain(|server| server.id != target && server.name != target);
    }
    (removed, list_servers(store))
}

pub(crate) fn set_server_enabled(
    store: &mut AppStore,
    target: &str,
    enabled: bool,
) -> Result<(McpServerRecord, Vec<McpServerRecord>), String> {
    let server = store
        .mcp_servers
        .iter_mut()
        .find(|server| server.id == target || server.name == target)
        .ok_or_else(|| format!("MCP server `{target}` not found"))?;
    server.enabled = enabled;
    Ok((server.clone(), list_servers(store)))
}

pub(crate) fn oauth_status(store: &AppStore, server_id: &str) -> Value {
    store
        .mcp_servers
        .iter()
        .find(|item| item.id == server_id)
        .and_then(|item| item.oauth.clone())
        .unwrap_or_else(|| json!({}))
}

fn thrive_plugin_id(server: &McpServerRecord) -> Option<&str> {
    server
        .oauth
        .as_ref()
        .and_then(|value| value.get("redbox"))
        .and_then(|value| value.get("pluginId"))
        .and_then(Value::as_str)
}

pub(crate) fn list_runtime_hooks(store: &AppStore) -> Vec<RuntimeHookRecord> {
    store.runtime_hooks.clone()
}

pub(crate) fn push_runtime_hook(store: &mut AppStore, hook: RuntimeHookRecord) {
    store.runtime_hooks.push(hook);
}

pub(crate) fn remove_runtime_hook(store: &mut AppStore, hook_id: &str) {
    store.runtime_hooks.retain(|item| item.id != hook_id);
}
