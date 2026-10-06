use super::*;
use crate::subagents::{execute_team_tool, team_tool_descriptors};

fn team_mcp_host_action(tool_name: &str) -> Option<&'static str> {
    crate::mcp::team_mcp_tool_contracts()
        .into_iter()
        .find(|tool| tool.name == tool_name)
        .map(|tool| tool.host_action)
}

pub fn tool_descriptors_value() -> Value {
    json!(team_tool_descriptors())
}

pub fn execute_tool_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let action = payload_string(payload, "action").ok_or_else(|| "缺少 action".to_string())?;
    let tool_payload = payload.get("payload").unwrap_or(payload);
    let value = with_store_mut(state, |store| {
        execute_team_tool(store, &action, tool_payload)
    })?;
    emit_team_action_result_events(app, state, &action, &value);
    Ok(value)
}

pub fn mcp_contract_value() -> Value {
    json!({
        "serverName": "redbox-team",
        "tools": crate::mcp::team_mcp_tool_contracts(),
        "toolsListResponse": crate::mcp::team_mcp_tools_list_response()
    })
}

pub fn execute_mcp_tool_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let tool_name =
        payload_string(payload, "toolName").ok_or_else(|| "缺少 toolName".to_string())?;
    let arguments = payload.get("arguments").unwrap_or(payload);
    let value = with_store_mut(state, |store| {
        crate::mcp::execute_team_mcp_tool(store, &tool_name, arguments)
    })?;
    if let Some(host_action) = team_mcp_host_action(&tool_name) {
        emit_team_action_result_events(app, state, host_action, &value);
    }
    Ok(value)
}

pub fn list_agent_backends_value(state: &State<'_, AppState>) -> Result<Value, String> {
    with_store(state, |store| {
        Ok(json!(crate::agent_hub::list_agent_backends(&store)))
    })
}
