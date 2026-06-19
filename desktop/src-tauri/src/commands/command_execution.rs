use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::cli_runtime::{
    cancel_cli_execution, load_cli_execution_snapshot, refresh_cli_execution,
    resize_cli_execution_pty, write_cli_execution_stdin, CliExecuteRequest, CliExecutionMode,
};
use crate::command_execution::{
    execute_argv, execute_shell_command, shell_env_from_value, CommandShellRequest,
};
use crate::{payload_string, AppState};

fn max_chars(payload: &Value) -> usize {
    payload
        .get("maxChars")
        .or_else(|| payload.get("max_output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(8_000) as usize
}

fn execution_id(payload: &Value) -> Result<String, String> {
    payload_string(payload, "executionId")
        .or_else(|| payload_string(payload, "session_id"))
        .or_else(|| payload_string(payload, "sessionId"))
        .or_else(|| payload_string(payload, "id"))
        .ok_or_else(|| "executionId is required".to_string())
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

fn execution_mode(payload: &Value) -> Result<Option<CliExecutionMode>, String> {
    let Some(value) = payload.get("executionMode").or_else(|| payload.get("mode")) else {
        return Ok(None);
    };
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|error| format!("invalid executionMode: {error}"))
}

fn get_execution_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = execution_id(payload)?;
    let _ = refresh_cli_execution(app, &execution_id)?;
    Ok(
        load_cli_execution_snapshot(state, &execution_id, max_chars(payload))?
            .map(|snapshot| json!(snapshot))
            .unwrap_or(Value::Null),
    )
}

fn shell_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let command = payload_string(payload, "command")
        .or_else(|| payload_string(payload, "cmd"))
        .ok_or_else(|| "command is required".to_string())?;
    let record = execute_shell_command(
        app,
        state,
        CommandShellRequest {
            session_id: payload_string(payload, "sessionId"),
            tool_id: payload_string(payload, "toolId"),
            command,
            cwd: payload_string(payload, "cwd").or_else(|| payload_string(payload, "workdir")),
            use_pty: payload
                .get("usePty")
                .or_else(|| payload.get("tty"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            execution_mode: execution_mode(payload)?,
            env: shell_env_from_value(payload.get("env"))?,
            login: payload
                .get("login")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        },
    )?;
    Ok(json!(record))
}

fn exec_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliExecuteRequest =
        serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
    let record = execute_argv(app, state, request)?;
    Ok(json!(record))
}

fn write_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = execution_id(payload)?;
    let text = payload_string(payload, "chars")
        .or_else(|| payload_string(payload, "text"))
        .or_else(|| payload_string(payload, "input"))
        .unwrap_or_default();
    let append_newline = payload
        .get("appendNewline")
        .or_else(|| payload.get("append_newline"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let close_stdin = payload
        .get("closeStdin")
        .or_else(|| payload.get("close_stdin"))
        .or_else(|| payload.get("close"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if text.is_empty() && !close_stdin {
        let _ = refresh_cli_execution(app, &execution_id)?;
    } else {
        let _ = write_cli_execution_stdin(
            app,
            state,
            &execution_id,
            &text,
            append_newline,
            close_stdin,
        )?;
    }
    get_execution_value(app, state, payload)
}

fn terminate_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = execution_id(payload)?;
    let execution = cancel_cli_execution(app, state, &execution_id)?;
    Ok(json!({
        "success": true,
        "executionId": execution_id,
        "execution": execution,
    }))
}

fn resize_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = execution_id(payload)?;
    let rows = terminal_dimension(payload, "rows", "height")?;
    let cols = terminal_dimension(payload, "cols", "columns")?;
    let execution = resize_cli_execution_pty(app, state, &execution_id, rows, cols)?;
    Ok(json!({
        "success": true,
        "executionId": execution_id,
        "execution": execution,
    }))
}

pub fn handle_command_execution_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "command-execution:exec" | "command-execution:execute" => exec_value(app, state, payload),
        "command-execution:shell" => shell_value(app, state, payload),
        "command-execution:get" | "command-execution:poll" => {
            get_execution_value(app, state, payload)
        }
        "command-execution:write" | "command-execution:write-stdin" => {
            write_value(app, state, payload)
        }
        "command-execution:terminate" | "command-execution:cancel" => {
            terminate_value(app, state, payload)
        }
        "command-execution:resize" => resize_value(app, state, payload),
        _ => return None,
    };
    Some(result)
}
