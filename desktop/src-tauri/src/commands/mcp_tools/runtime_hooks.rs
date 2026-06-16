use super::*;

pub(super) fn handle_runtime_hooks_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "tools:hooks:list" => Some(with_store(state, |store| {
            Ok(json!(mcp_tools_store::list_runtime_hooks(&store)))
        })),
        "tools:hooks:register" => Some(register_runtime_hook(state, payload)),
        "tools:hooks:remove" => Some(remove_runtime_hook(state, payload)),
        _ => None,
    }
}

fn register_runtime_hook(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
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
        source_scope: None,
        plugin_id: None,
        plugin_root: None,
        plugin_data_root: None,
        source_path: None,
        source_relative_path: None,
        command: None,
        command_windows: None,
        timeout_sec: None,
        r#async: None,
        status_message: None,
        raw: None,
    };
    with_store_mut(state, |store| {
        mcp_tools_store::push_runtime_hook(store, hook.clone());
        Ok(json!({ "success": true, "hookId": hook.id }))
    })
}

fn remove_runtime_hook(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let hook_id = payload_string(payload, "hookId")
        .or_else(|| payload_string(payload, "id"))
        .unwrap_or_default();
    with_store_mut(state, |store| {
        mcp_tools_store::remove_runtime_hook(store, &hook_id);
        Ok(json!({ "success": true }))
    })
}
