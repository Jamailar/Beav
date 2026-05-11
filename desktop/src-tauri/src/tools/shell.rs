use serde_json::{Value, json};
use tauri::{AppHandle, Runtime, State};

use crate::AppState;
use crate::cli_runtime::{
    CliExecuteRequest, CliExecutionStatus, execute_cli_command, load_cli_execution_snapshot,
};
use crate::interactive_runtime_shared::resolve_workspace_tool_path_for_session;

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
        .and_then(Value::as_str)
        .map(|value| resolve_workspace_tool_path_for_session(state, session_id, value))
        .transpose()?
        .unwrap_or(resolve_workspace_tool_path_for_session(
            state, session_id, ".",
        )?);

    let use_pty = arguments
        .get("usePty")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let argv = shell_words::split(raw_command).map_err(|error| error.to_string())?;
    if argv.is_empty() {
        return Err("command is empty".to_string());
    }

    let request = CliExecuteRequest {
        session_id: session_id.map(ToString::to_string),
        tool_id: tool_call_id.map(ToString::to_string),
        task_id: None,
        runtime_id: None,
        environment_id: None,
        execution_mode: None,
        argv,
        cwd: Some(cwd.display().to_string()),
        use_pty,
        verification_rules: Vec::new(),
        env: Default::default(),
    };

    let record = execute_cli_command(app, state, request)?;

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
                "message": "This command requires approval. Use cli_runtime.escalation.approve to authorize it, or cli_runtime.escalation.deny to reject it.",
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
