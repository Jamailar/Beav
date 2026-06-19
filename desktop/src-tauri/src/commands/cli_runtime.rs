use std::path::Path;

mod install;
mod ipc_codec;
mod tools;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use install::install_value;
use ipc_codec::{execution_status_label, normalize_output_with_key, parse_payload, to_ipc_value};
use tools::{
    detect_tools_value, diagnose_tool_value, discover_detected_tools, discover_tools_value,
    inspect_tool_value,
};

use crate::cli_runtime::{
    approve_cli_escalation, cancel_cli_execution, create_task_ephemeral_environment,
    deny_cli_escalation, emit_cli_escalation_resolved, emit_cli_execution_status,
    emit_cli_verification_finished, ensure_app_global_environment, ensure_workspace_environment,
    ensure_workspace_environment_for_active_space, execute_cli_command, find_cli_execution_by_id,
    list_cli_environments, load_cli_execution_snapshot, refresh_cli_execution,
    resize_cli_execution_pty, run_cli_verification, write_cli_execution_stdin,
    CliApproveEscalationRequest, CliCreateEnvironmentRequest, CliDenyEscalationRequest,
    CliEnvironmentScope, CliExecuteRequest, CliVerifyExecutionRequest, CliVerifyResult,
};
use crate::{payload_string, AppState};

fn create_environment_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request: CliCreateEnvironmentRequest = parse_payload(payload)?;
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
    to_ipc_value(environment)
}

fn execute_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliExecuteRequest = parse_payload(payload)?;
    let execution = execute_cli_command(app, state, request)?;
    let max_chars = payload
        .get("maxChars")
        .and_then(Value::as_u64)
        .unwrap_or(4_000) as usize;
    let mut value = to_ipc_value(&execution)?;
    if let Some(snapshot) = load_cli_execution_snapshot(state, &execution.id, max_chars)? {
        if let Value::Object(object) = &mut value {
            object.insert(
                "stdoutTail".to_string(),
                Value::String(snapshot.stdout_tail.clone()),
            );
            object.insert(
                "stderrTail".to_string(),
                Value::String(snapshot.stderr_tail.clone()),
            );
            object.insert(
                "stdoutText".to_string(),
                Value::String(snapshot.stdout_tail),
            );
            object.insert(
                "stderrText".to_string(),
                Value::String(snapshot.stderr_tail),
            );
        }
    }
    Ok(value)
}

fn poll_execution_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .or_else(|| payload_string(payload, "id"))
        .ok_or_else(|| "executionId is required".to_string())?;
    let max_chars = payload
        .get("maxChars")
        .and_then(Value::as_u64)
        .unwrap_or(4_000) as usize;
    let _ = refresh_cli_execution(app, &execution_id)?;
    let snapshot = load_cli_execution_snapshot(state, &execution_id, max_chars)?;
    match snapshot {
        Some(snapshot) => to_ipc_value(snapshot),
        None => Ok(Value::Null),
    }
}

fn terminal_dimension(payload: &Value, key: &str, alternate: &str) -> Result<u16, String> {
    let value = payload
        .get(key)
        .or_else(|| payload.get(alternate))
        .or_else(|| payload.get("size").and_then(|size| size.get(key)))
        .or_else(|| payload.get("size").and_then(|size| size.get(alternate)))
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} is required"))?;
    u16::try_from(value).map_err(|_| format!("{key} is too large"))
}

fn verify_execution_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliVerifyExecutionRequest = parse_payload(payload)?;
    let execution = find_cli_execution_by_id(state, &request.execution_id)?
        .ok_or_else(|| format!("cli execution not found: {}", request.execution_id))?;
    let outcome = run_cli_verification(state, execution, &request.rules)?;
    emit_cli_verification_finished(app, &outcome.execution, &outcome.summary);
    to_ipc_value(CliVerifyResult {
        success: outcome.execution.verification_status
            != crate::cli_runtime::CliVerificationStatus::Failed,
        execution_id: outcome.execution.id.clone(),
        status: outcome.execution.verification_status.clone(),
        summary: outcome.summary,
        verifications: outcome.verifications,
        execution: Some(outcome.execution),
    })
}

fn cancel_execution_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .ok_or_else(|| "executionId is required".to_string())?;
    let execution = cancel_cli_execution(app, state, &execution_id)?;
    Ok(json!({
        "success": true,
        "supported": true,
        "executionId": execution_id,
        "status": execution_status_label(&execution.status),
        "execution": execution,
    }))
}

fn write_stdin_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .or_else(|| payload_string(payload, "id"))
        .ok_or_else(|| "executionId is required".to_string())?;
    let text = payload_string(payload, "text")
        .or_else(|| payload_string(payload, "input"))
        .unwrap_or_default();
    let append_newline = payload
        .get("appendNewline")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let close_stdin = payload
        .get("closeStdin")
        .or_else(|| payload.get("close"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let execution = write_cli_execution_stdin(
        app,
        state,
        &execution_id,
        &text,
        append_newline,
        close_stdin,
    )?;
    Ok(json!({
        "success": true,
        "supported": true,
        "executionId": execution_id,
        "status": execution_status_label(&execution.status),
        "execution": execution,
    }))
}

fn resize_pty_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .or_else(|| payload_string(payload, "id"))
        .ok_or_else(|| "executionId is required".to_string())?;
    let rows = terminal_dimension(payload, "rows", "height")?;
    let cols = terminal_dimension(payload, "cols", "columns")?;
    let execution = resize_cli_execution_pty(app, state, &execution_id, rows, cols)?;
    Ok(json!({
        "success": true,
        "supported": true,
        "executionId": execution_id,
        "status": execution_status_label(&execution.status),
        "execution": execution,
    }))
}

fn approve_escalation_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliApproveEscalationRequest = parse_payload(payload)?;
    let resolution = approve_cli_escalation(state, &request)?;
    if resolution.changed {
        if let Some(execution) = resolution.execution.as_ref() {
            emit_cli_execution_status(
                app,
                execution,
                Some("cli escalation approved; rerun execute to continue"),
            );
        }
        emit_cli_escalation_resolved(app, resolution.execution.as_ref(), &resolution.escalation);
    }
    Ok(json!({
        "success": true,
        "escalation": resolution.escalation,
        "execution": resolution.execution,
    }))
}

fn deny_escalation_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliDenyEscalationRequest = parse_payload(payload)?;
    let resolution = deny_cli_escalation(state, &request)?;
    if resolution.changed {
        if let Some(execution) = resolution.execution.as_ref() {
            emit_cli_execution_status(app, execution, Some("cli escalation denied by user"));
        }
        emit_cli_escalation_resolved(app, resolution.execution.as_ref(), &resolution.escalation);
    }
    Ok(json!({
        "success": true,
        "escalation": resolution.escalation,
        "execution": resolution.execution,
    }))
}

pub fn handle_cli_runtime_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "cli-runtime:detect" => detect_tools_value(state, payload),
        "cli-runtime:list-tools" => {
            discover_detected_tools(state, None, 500).and_then(to_ipc_value)
        }
        "cli-runtime:inspect" => {
            inspect_tool_value(state, payload).map(|value| value.unwrap_or(Value::Null))
        }
        "cli-runtime:diagnose" => diagnose_tool_value(state, payload),
        "cli-runtime:discover" => discover_tools_value(state, payload),
        "cli-runtime:list-environments" => list_cli_environments(state).and_then(to_ipc_value),
        "cli-runtime:create-environment" => create_environment_value(state, payload),
        "cli-runtime:install" => install_value(app, state, payload),
        "cli-runtime:execute" => execute_value(app, state, payload),
        "cli-runtime:get-execution" => poll_execution_value(app, state, payload),
        "cli-runtime:poll-execution" => poll_execution_value(app, state, payload),
        "cli-runtime:cancel-execution" => cancel_execution_value(app, state, payload),
        "cli-runtime:write-stdin" => write_stdin_value(app, state, payload),
        "cli-runtime:resize-pty" | "cli-runtime:resize" => resize_pty_value(app, state, payload),
        "cli-runtime:verify" => verify_execution_value(app, state, payload),
        "cli-runtime:approve-escalation" => approve_escalation_value(app, state, payload),
        "cli-runtime:deny-escalation" => deny_escalation_value(app, state, payload),
        _ => return None,
    };

    Some(result.map(|value| normalize_output_with_key(None, value)))
}
