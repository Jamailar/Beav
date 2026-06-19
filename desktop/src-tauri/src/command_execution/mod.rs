use serde_json::Value;
use std::collections::BTreeMap;
use tauri::{AppHandle, Runtime, State};

use crate::cli_runtime::{
    execute_cli_command, run_managed_cli_command, CliExecuteRequest, CliExecutionMode,
    CliExecutionRecord, CliExecutionSnapshot, CliVerifyRule,
};
use crate::AppState;

#[derive(Debug, Clone, Default)]
pub struct CommandShellRequest {
    pub session_id: Option<String>,
    pub tool_id: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub use_pty: bool,
    pub execution_mode: Option<CliExecutionMode>,
    pub env: BTreeMap<String, String>,
    pub login: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AppManagedArgvRequest {
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub environment_id: Option<String>,
    pub tool_id: Option<String>,
    pub execution_mode: Option<CliExecutionMode>,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub use_pty: bool,
    pub verification_rules: Vec<CliVerifyRule>,
    pub env: BTreeMap<String, String>,
}

impl From<AppManagedArgvRequest> for CliExecuteRequest {
    fn from(request: AppManagedArgvRequest) -> Self {
        Self {
            session_id: request.session_id,
            task_id: request.task_id,
            runtime_id: request.runtime_id,
            environment_id: request.environment_id,
            tool_id: request.tool_id,
            execution_mode: request.execution_mode,
            argv: request.argv,
            cwd: request.cwd,
            use_pty: request.use_pty,
            verification_rules: request.verification_rules,
            env: request.env,
        }
    }
}

pub fn execute_argv<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    request: CliExecuteRequest,
) -> Result<CliExecutionRecord, String> {
    execute_cli_command(app, state, request)
}

pub fn execute_shell_command<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    request: CommandShellRequest,
) -> Result<CliExecutionRecord, String> {
    let argv = shell_command_argv(&request.command, request.login)?;
    execute_argv(
        app,
        state,
        CliExecuteRequest {
            session_id: request.session_id,
            task_id: None,
            runtime_id: Some("command-execution-shell".to_string()),
            environment_id: None,
            tool_id: request.tool_id,
            execution_mode: request.execution_mode,
            argv,
            cwd: request.cwd,
            use_pty: request.use_pty,
            verification_rules: Vec::new(),
            env: request.env,
        },
    )
}

pub fn run_app_managed_argv<RT: Runtime>(
    app: &AppHandle<RT>,
    state: &State<'_, AppState>,
    request: AppManagedArgvRequest,
    max_chars: usize,
) -> Result<CliExecutionSnapshot, String> {
    run_managed_cli_command(app, state, request.into(), max_chars)
}

pub fn shell_env_from_value(value: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| "env must be an object with string values".to_string())?;
    let mut env = BTreeMap::new();
    for (key, value) in object {
        let Some(value) = value.as_str() else {
            return Err(format!("env.{key} must be a string"));
        };
        env.insert(key.clone(), value.to_string());
    }
    Ok(env)
}

fn shell_command_argv(command: &str, login: bool) -> Result<Vec<String>, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command is empty".to_string());
    }
    let shell = default_shell_program();
    let flag = if login { "-lc" } else { "-c" };
    Ok(vec![shell, flag.to_string(), command.to_string()])
}

#[cfg(unix)]
fn default_shell_program() -> String {
    std::env::var("SHELL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

#[cfg(windows)]
fn default_shell_program() -> String {
    "powershell.exe".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_command_argv_preserves_shell_syntax() {
        let argv = shell_command_argv("printf 'a\\nb\\n' | rg b", true).expect("argv");
        assert_eq!(argv[1], "-lc");
        assert_eq!(argv[2], "printf 'a\\nb\\n' | rg b");
    }

    #[test]
    fn shell_command_argv_rejects_empty_command() {
        let error = shell_command_argv("  ", true).expect_err("empty command should fail");
        assert!(error.contains("empty"));
    }
}
