use std::collections::BTreeSet;
use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::cli_runtime::{
    create_task_ephemeral_environment, default_detect_commands, detect_many, detect_tool,
    ensure_app_global_environment, ensure_workspace_environment,
    ensure_workspace_environment_for_active_space, execute_cli_command, find_cli_execution_by_id,
    list_cli_environments, load_cli_execution_snapshot, load_host_shell_env,
    CliCreateEnvironmentRequest, CliEnvironmentScope, CliExecuteRequest,
};
use crate::{payload_string, AppState};

fn load_host_env() -> std::collections::BTreeMap<String, String> {
    load_host_shell_env().unwrap_or_else(|_| std::env::vars().collect())
}

fn normalize_cli_runtime_input_with_key(key: Option<&str>, value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(child_key, child_value)| {
                    (
                        child_key.clone(),
                        normalize_cli_runtime_input_with_key(Some(&child_key), child_value),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_cli_runtime_input_with_key(None, item))
                .collect(),
        ),
        Value::String(text)
            if matches!(key, Some("scope" | "preferredScope")) && text.contains('-') =>
        {
            Value::String(text.replace('-', "_"))
        }
        other => other,
    }
}

fn parse_cli_runtime_payload<T: DeserializeOwned>(payload: &Value) -> Result<T, String> {
    serde_json::from_value(normalize_cli_runtime_input_with_key(None, payload.clone()))
        .map_err(|error| error.to_string())
}

fn cli_runtime_enum_output(key: &str, value: &str) -> Option<String> {
    match key {
        "scope" | "source" | "health" | "verificationStatus" => Some(value.replace('_', "-")),
        "status" => Some(match value {
            "awaiting_escalation" => "waiting-approval".to_string(),
            other => other.replace('_', "-"),
        }),
        _ => None,
    }
}

fn normalize_cli_runtime_output_with_key(key: Option<&str>, value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(child_key, child_value)| {
                    (
                        child_key.clone(),
                        normalize_cli_runtime_output_with_key(Some(&child_key), child_value),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_cli_runtime_output_with_key(None, item))
                .collect(),
        ),
        Value::String(text) => key
            .and_then(|field| cli_runtime_enum_output(field, &text))
            .map(Value::String)
            .unwrap_or(Value::String(text)),
        other => other,
    }
}

fn to_cli_runtime_ipc_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value)
        .map(|raw| normalize_cli_runtime_output_with_key(None, raw))
        .map_err(|error| error.to_string())
}

fn list_tool_commands(state: &State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut commands = BTreeSet::new();
    for command in default_detect_commands() {
        let trimmed = command.trim();
        if !trimmed.is_empty() {
            commands.insert(trimmed.to_string());
        }
    }
    for environment in list_cli_environments(state)? {
        for tool_id in environment.installed_tool_ids {
            let trimmed = tool_id.trim();
            if !trimmed.is_empty() {
                commands.insert(trimmed.to_string());
            }
        }
    }
    Ok(commands.into_iter().collect())
}

fn inspect_tool_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let env = load_host_env();
    if let Some(command) = payload_string(payload, "command") {
        return Ok(Some(to_cli_runtime_ipc_value(detect_tool(&command, &env))?));
    }

    let requested_tool = payload_string(payload, "toolId")
        .or_else(|| payload_string(payload, "executable"))
        .unwrap_or_default();
    if requested_tool.is_empty() {
        return Ok(None);
    }

    let commands = list_tool_commands(state)?;
    let matched = detect_many(&commands, &env)
        .into_iter()
        .find(|tool| {
            tool.id == requested_tool
                || tool.executable == requested_tool
                || tool.name == requested_tool
        })
        .or_else(|| {
            if requested_tool.starts_with("cli-tool-") {
                None
            } else {
                Some(detect_tool(&requested_tool, &env))
            }
        });

    matched.map(to_cli_runtime_ipc_value).transpose()
}

fn create_environment_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request: CliCreateEnvironmentRequest = parse_cli_runtime_payload(payload)?;
    let environment = match request.scope {
        CliEnvironmentScope::AppGlobal => ensure_app_global_environment(state)?,
        CliEnvironmentScope::WorkspaceLocal => {
            if let Some(workspace_root) = request.workspace_root.as_deref().map(str::trim) {
                if !workspace_root.is_empty() {
                    ensure_workspace_environment(state, Path::new(workspace_root))?
                } else {
                    ensure_workspace_environment_for_active_space(state)?
                }
            } else {
                ensure_workspace_environment_for_active_space(state)?
            }
        }
        CliEnvironmentScope::TaskEphemeral => {
            let task_id = request
                .task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "taskId is required for task-ephemeral environment".to_string())?;
            create_task_ephemeral_environment(state, task_id)?
        }
    };
    to_cli_runtime_ipc_value(environment)
}

fn execute_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliExecuteRequest = parse_cli_runtime_payload(payload)?;
    let execution = execute_cli_command(app, state, request)?;
    to_cli_runtime_ipc_value(execution)
}

fn poll_execution_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .ok_or_else(|| "executionId is required".to_string())?;
    let max_chars = payload
        .get("maxChars")
        .and_then(Value::as_u64)
        .unwrap_or(4_000) as usize;
    let snapshot = load_cli_execution_snapshot(state, &execution_id, max_chars)?;
    match snapshot {
        Some(snapshot) => to_cli_runtime_ipc_value(snapshot),
        None => Ok(Value::Null),
    }
}

fn unsupported_execution_action(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .ok_or_else(|| "executionId is required".to_string())?;
    let record = find_cli_execution_by_id(state, &execution_id)?;
    Ok(json!({
        "success": false,
        "supported": false,
        "executionId": execution_id,
        "status": record.map(|item| item.status).map(|status| match status {
            crate::cli_runtime::CliExecutionStatus::AwaitingEscalation => "waiting-approval".to_string(),
            other => serde_json::to_value(other)
                .ok()
                .and_then(|value| value.as_str().map(|text| text.replace('_', "-")))
                .unwrap_or_else(|| "unknown".to_string()),
        }),
        "error": "cli runtime cancellation is not available until background execution lands",
    }))
}

fn unsupported_escalation_action(payload: &Value, action: &str) -> Result<Value, String> {
    let escalation_id = payload_string(payload, "escalationId")
        .ok_or_else(|| "escalationId is required".to_string())?;
    Ok(json!({
        "success": false,
        "supported": false,
        "action": action,
        "escalationId": escalation_id,
        "error": "cli runtime escalation approval is not available until policy flow lands",
    }))
}

pub fn handle_cli_runtime_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "cli-runtime:detect" => (|| -> Result<Value, String> {
            let request =
                parse_cli_runtime_payload::<crate::cli_runtime::CliDetectRequest>(payload)
                    .unwrap_or_default();
            let commands = if request.commands.is_empty() {
                list_tool_commands(state)?
            } else {
                request.commands
            };
            let tools = detect_many(&commands, &load_host_env());
            Ok(json!({
                "success": true,
                "tools": tools,
            }))
        })(),
        "cli-runtime:list-tools" => {
            let commands = match list_tool_commands(state) {
                Ok(commands) => commands,
                Err(error) => return Some(Err(error)),
            };
            to_cli_runtime_ipc_value(detect_many(&commands, &load_host_env()))
        }
        "cli-runtime:inspect" => {
            inspect_tool_value(state, payload).map(|value| value.unwrap_or(Value::Null))
        }
        "cli-runtime:list-environments" => {
            list_cli_environments(state).and_then(to_cli_runtime_ipc_value)
        }
        "cli-runtime:create-environment" => create_environment_value(state, payload),
        "cli-runtime:execute" => execute_value(app, state, payload),
        "cli-runtime:poll-execution" => poll_execution_value(state, payload),
        "cli-runtime:cancel-execution" => unsupported_execution_action(state, payload),
        "cli-runtime:approve-escalation" => unsupported_escalation_action(payload, "approve"),
        "cli-runtime:deny-escalation" => unsupported_escalation_action(payload, "deny"),
        _ => return None,
    };

    Some(result.map(|value| normalize_cli_runtime_output_with_key(None, value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_cli_runtime_input_accepts_kebab_case_scope() {
        let normalized = normalize_cli_runtime_input_with_key(
            None,
            json!({
                "scope": "workspace-local",
                "preferredScope": "task-ephemeral",
            }),
        );
        assert_eq!(
            normalized.get("scope").and_then(Value::as_str),
            Some("workspace_local")
        );
        assert_eq!(
            normalized.get("preferredScope").and_then(Value::as_str),
            Some("task_ephemeral")
        );
    }

    #[test]
    fn normalize_cli_runtime_output_uses_renderer_enum_shapes() {
        let normalized = normalize_cli_runtime_output_with_key(
            None,
            json!({
                "scope": "workspace_local",
                "source": "app_managed",
                "status": "awaiting_escalation",
            }),
        );
        assert_eq!(
            normalized.get("scope").and_then(Value::as_str),
            Some("workspace-local")
        );
        assert_eq!(
            normalized.get("source").and_then(Value::as_str),
            Some("app-managed")
        );
        assert_eq!(
            normalized.get("status").and_then(Value::as_str),
            Some("waiting-approval")
        );
    }
}
