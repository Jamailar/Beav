use serde_json::{json, Value};
use tauri::{AppHandle, Runtime, State};

use crate::cli_runtime::{
    load_cli_execution_snapshot, refresh_cli_execution, write_cli_execution_stdin,
    CliExecutionMode, CliExecutionStatus,
};
use crate::command_execution::{execute_shell_command, shell_env_from_value, CommandShellRequest};
use crate::interactive_runtime_shared::resolve_workspace_tool_path_for_session;
use crate::AppState;

const DEFAULT_OUTPUT_CHARS: usize = 8_000;
const MAX_OUTPUT_CHARS: usize = 40_000;

pub fn execute_shell<RT: Runtime>(
    arguments: &Value,
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
) -> Result<Value, String> {
    let max_chars = arguments
        .get("maxChars")
        .or_else(|| arguments.get("max_output_tokens"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_OUTPUT_CHARS)
        .clamp(200, MAX_OUTPUT_CHARS);

    if let Some(execution_id) = arguments
        .get("executionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return poll_shell_execution(state, execution_id, max_chars);
    }

    let raw_command = arguments
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| "command is required".to_string())?;

    let cwd = arguments
        .get("cwd")
        .or_else(|| arguments.get("workdir"))
        .and_then(Value::as_str)
        .map(|value| resolve_workspace_tool_path_for_session(state, session_id, value))
        .transpose()?
        .unwrap_or(resolve_workspace_tool_path_for_session(
            state, session_id, ".",
        )?);

    let use_pty = arguments
        .get("usePty")
        .or_else(|| arguments.get("tty"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let login = arguments
        .get("login")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let execution_mode = arguments
        .get("executionMode")
        .or_else(|| arguments.get("mode"))
        .and_then(Value::as_str)
        .map(normalize_execution_mode)
        .transpose()?;
    let env = shell_env_from_value(arguments.get("env"))?;

    let record = execute_shell_command(
        app,
        state,
        CommandShellRequest {
            session_id: session_id.map(ToString::to_string),
            tool_id: tool_call_id.map(ToString::to_string),
            command: raw_command.to_string(),
            cwd: Some(cwd.display().to_string()),
            use_pty,
            execution_mode,
            env,
            login,
        },
    )?;

    match record.status {
        CliExecutionStatus::AwaitingEscalation => {
            let escalation = record
                .metadata
                .as_ref()
                .and_then(|meta| meta.get("escalationId"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            Ok(json!({
                "ok": true,
                "status": "awaiting_escalation",
                "executionId": record.id,
                "command": raw_command,
                "cwd": cwd.display().to_string(),
                "escalationId": escalation,
                "message": "This command requires user approval before it can continue.",
            }))
        }
        CliExecutionStatus::Running => Ok(json!({
            "ok": true,
            "status": "running",
            "executionId": record.id,
            "command": raw_command,
            "cwd": cwd.display().to_string(),
            "message": "Command is running in the background. Use shell(executionId=<id>) to poll for results.",
        })),
        _ => {
            let snapshot = load_cli_execution_snapshot(state, &record.id, max_chars)?
                .unwrap_or_else(|| crate::cli_runtime::CliExecutionSnapshot {
                    execution: record,
                    stdout_tail: String::new(),
                    stderr_tail: String::new(),
                    verifications: Vec::new(),
                    escalation: None,
                });
            Ok(json!({
                "ok": true,
                "status": snapshot.execution.status,
                "exitCode": snapshot.execution.exit_code,
                "executionId": snapshot.execution.id,
                "command": raw_command,
                "cwd": cwd.display().to_string(),
                "stdout": snapshot.stdout_tail,
                "stderr": snapshot.stderr_tail,
                "verifications": snapshot.verifications.iter().map(|v| json!({
                    "status": v.status,
                    "summary": v.summary,
                })).collect::<Vec<_>>(),
            }))
        }
    }
}

pub fn write_stdin<RT: Runtime>(
    arguments: &Value,
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let execution_id = arguments
        .get("executionId")
        .or_else(|| arguments.get("session_id"))
        .or_else(|| arguments.get("sessionId"))
        .or_else(|| arguments.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "executionId is required".to_string())?;
    let chars = arguments
        .get("chars")
        .or_else(|| arguments.get("text"))
        .or_else(|| arguments.get("input"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let append_newline = arguments
        .get("appendNewline")
        .or_else(|| arguments.get("append_newline"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let close_stdin = arguments
        .get("closeStdin")
        .or_else(|| arguments.get("close_stdin"))
        .or_else(|| arguments.get("close"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_chars = arguments
        .get("maxChars")
        .or_else(|| arguments.get("max_output_tokens"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_OUTPUT_CHARS)
        .clamp(200, MAX_OUTPUT_CHARS);

    if chars.is_empty() && !close_stdin {
        let _ = refresh_cli_execution(app, execution_id)?;
    } else {
        let _ = write_cli_execution_stdin(
            app,
            state,
            execution_id,
            chars,
            append_newline,
            close_stdin,
        )?;
    }
    poll_shell_execution(state, execution_id, max_chars)
}

fn poll_shell_execution(
    state: &State<'_, AppState>,
    execution_id: &str,
    max_chars: usize,
) -> Result<Value, String> {
    let snapshot = load_cli_execution_snapshot(state, execution_id, max_chars)?
        .ok_or_else(|| format!("execution not found: {execution_id}"))?;

    let status = &snapshot.execution.status;
    if *status == CliExecutionStatus::Running {
        return Ok(json!({
            "ok": true,
            "status": "running",
            "executionId": snapshot.execution.id,
            "message": "Command is still running. Poll again with shell(executionId=<id>).",
        }));
    }

    Ok(json!({
        "ok": true,
        "status": snapshot.execution.status,
        "exitCode": snapshot.execution.exit_code,
        "executionId": snapshot.execution.id,
        "stdout": snapshot.stdout_tail,
        "stderr": snapshot.stderr_tail,
        "verifications": snapshot.verifications.iter().map(|v| json!({
            "status": v.status,
            "summary": v.summary,
        })).collect::<Vec<_>>(),
    }))
}

fn normalize_execution_mode(value: &str) -> Result<CliExecutionMode, String> {
    match value.trim() {
        "" | "host_compatible" | "host-compatible" => Ok(CliExecutionMode::HostCompatible),
        "managed" => Ok(CliExecutionMode::Managed),
        "unrestricted" => Ok(CliExecutionMode::Unrestricted),
        other => Err(format!("unsupported executionMode: {other}")),
    }
}
