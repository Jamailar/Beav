use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::cli_runtime::{
    add_installed_tool_to_environment, approve_cli_escalation, cancel_cli_execution,
    create_task_ephemeral_environment, default_detect_commands, deny_cli_escalation, detect_many,
    detect_tool, emit_cli_escalation_resolved, emit_cli_execution_status,
    emit_cli_install_finished, emit_cli_install_started, emit_cli_verification_finished,
    ensure_app_global_environment, ensure_workspace_environment,
    ensure_workspace_environment_for_active_space, execute_cli_command, find_cli_environment_by_id,
    find_cli_execution_by_id, list_cli_environments, load_cli_execution_snapshot,
    load_host_shell_env, merge_execution_env, refresh_cli_execution, run_cli_verification,
    CliApproveEscalationRequest, CliCreateEnvironmentRequest, CliDenyEscalationRequest,
    CliEnvironmentRecord, CliEnvironmentScope, CliExecuteRequest, CliExecutionStatus,
    CliInstallMethod, CliInstallRequest, CliInstallResult, CliToolHealth, CliToolSource,
    CliVerifyExecutionRequest, CliVerifyResult,
};
use crate::{make_id, payload_string, AppState};

fn load_host_env() -> std::collections::BTreeMap<String, String> {
    load_host_shell_env().unwrap_or_else(|_| std::env::vars().collect())
}

fn cli_runtime_execution_status_label(status: &CliExecutionStatus) -> String {
    match status {
        CliExecutionStatus::AwaitingEscalation => "waiting-approval".to_string(),
        other => serde_json::to_value(other)
            .ok()
            .and_then(|value| value.as_str().map(|text| text.replace('_', "-")))
            .unwrap_or_else(|| "unknown".to_string()),
    }
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

fn infer_tool_command(spec: &str) -> Option<String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = trimmed
        .rsplit('/')
        .next()
        .unwrap_or(trimmed)
        .trim()
        .trim_end_matches('/');
    let candidate = if candidate.starts_with('@') {
        candidate
            .split_once('@')
            .map(|(_, tail)| tail)
            .unwrap_or(candidate)
    } else {
        candidate
            .split_once('@')
            .map(|(head, _)| head)
            .unwrap_or(candidate)
    };
    let candidate = Path::new(candidate)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(candidate)
        .trim();
    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

fn install_tool_command(request: &CliInstallRequest) -> String {
    request
        .tool_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| infer_tool_command(&request.spec))
        .unwrap_or_else(|| request.spec.trim().to_string())
}

fn install_source_for_environment(environment: &CliEnvironmentRecord) -> CliToolSource {
    match environment.scope {
        CliEnvironmentScope::WorkspaceLocal => CliToolSource::WorkspaceManaged,
        CliEnvironmentScope::AppGlobal | CliEnvironmentScope::TaskEphemeral => {
            CliToolSource::AppManaged
        }
    }
}

fn build_install_env(
    install_method: &CliInstallMethod,
    environment: &CliEnvironmentRecord,
) -> BTreeMap<String, String> {
    let root = Path::new(&environment.root_path);
    let mut env = BTreeMap::new();
    match install_method {
        CliInstallMethod::Go => {
            env.insert(
                "GOBIN".to_string(),
                root.join("bin").to_string_lossy().to_string(),
            );
        }
        CliInstallMethod::Pnpm => {
            env.insert(
                "PNPM_HOME".to_string(),
                root.join("bin").to_string_lossy().to_string(),
            );
        }
        CliInstallMethod::Uv => {
            env.insert(
                "UV_TOOL_DIR".to_string(),
                root.join("uv-tools").to_string_lossy().to_string(),
            );
            env.insert(
                "UV_TOOL_BIN_DIR".to_string(),
                root.join("bin").to_string_lossy().to_string(),
            );
        }
        _ => {}
    }
    env
}

fn build_install_argv(
    install_method: &CliInstallMethod,
    spec: &str,
    environment: &CliEnvironmentRecord,
    tool_command: &str,
) -> Result<Vec<String>, String> {
    let normalized_spec = spec.trim();
    if normalized_spec.is_empty() {
        return Err("spec is required for cli install".to_string());
    }
    let argv = match install_method {
        CliInstallMethod::Manual => {
            return Err("manual install must be performed by the user".to_string());
        }
        CliInstallMethod::Npm => vec![
            "npm".to_string(),
            "install".to_string(),
            "--prefix".to_string(),
            environment.root_path.clone(),
            "--no-save".to_string(),
            normalized_spec.to_string(),
        ],
        CliInstallMethod::Pnpm => vec![
            "pnpm".to_string(),
            "add".to_string(),
            "--dir".to_string(),
            environment.root_path.clone(),
            normalized_spec.to_string(),
        ],
        CliInstallMethod::Python => vec![
            "python3".to_string(),
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--prefix".to_string(),
            environment.root_path.clone(),
            normalized_spec.to_string(),
        ],
        CliInstallMethod::Uv => vec![
            "uv".to_string(),
            "tool".to_string(),
            "install".to_string(),
            normalized_spec.to_string(),
        ],
        CliInstallMethod::Cargo => vec![
            "cargo".to_string(),
            "install".to_string(),
            "--root".to_string(),
            environment.root_path.clone(),
            normalized_spec.to_string(),
        ],
        CliInstallMethod::Go => vec![
            "go".to_string(),
            "install".to_string(),
            normalized_spec.to_string(),
        ],
        CliInstallMethod::Binary => {
            if normalized_spec.starts_with("http://") || normalized_spec.starts_with("https://") {
                vec![
                    "curl".to_string(),
                    "-fsSL".to_string(),
                    normalized_spec.to_string(),
                    "-o".to_string(),
                    Path::new(&environment.root_path)
                        .join("bin")
                        .join(tool_command)
                        .to_string_lossy()
                        .to_string(),
                ]
            } else {
                return Err(
                    "binary install currently supports only direct download URLs".to_string(),
                );
            }
        }
    };
    Ok(argv)
}

fn install_summary(
    tool_name: &str,
    status: &CliExecutionStatus,
    tool_health: &CliToolHealth,
) -> String {
    match status {
        CliExecutionStatus::AwaitingEscalation => {
            format!("安装 {tool_name} 需要额外授权，授权后请重新执行")
        }
        CliExecutionStatus::Completed if matches!(tool_health, CliToolHealth::Ready) => {
            format!("安装完成：{tool_name}")
        }
        CliExecutionStatus::Completed => {
            format!("安装命令完成，但未检测到 {tool_name} 可执行文件")
        }
        CliExecutionStatus::Failed => format!("安装失败：{tool_name}"),
        CliExecutionStatus::Cancelled => format!("安装已取消：{tool_name}"),
        CliExecutionStatus::Running => format!("安装进行中：{tool_name}"),
        CliExecutionStatus::Pending => format!("安装已排队：{tool_name}"),
    }
}

fn install_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliInstallRequest = parse_cli_runtime_payload(payload)?;
    let environment = if let Some(environment_id) = request
        .environment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        find_cli_environment_by_id(state, environment_id)?
            .ok_or_else(|| format!("cli environment not found: {environment_id}"))?
    } else {
        ensure_app_global_environment(state)?
    };
    let install_id = make_id("cli-install");
    let tool_name = install_tool_command(&request);
    emit_cli_install_started(
        app,
        request.session_id.as_deref(),
        request.task_id.as_deref(),
        request.runtime_id.as_deref(),
        &install_id,
        Some(&environment.id),
        &tool_name,
        &request.install_method,
        request.spec.trim(),
    );

    let mut execution_env = build_install_env(&request.install_method, &environment);
    for (key, value) in &request.env {
        execution_env.insert(key.clone(), value.clone());
    }

    let execution = execute_cli_command(
        app,
        state,
        CliExecuteRequest {
            session_id: request.session_id.clone(),
            task_id: request.task_id.clone(),
            runtime_id: request.runtime_id.clone(),
            environment_id: Some(environment.id.clone()),
            tool_id: Some(tool_name.clone()),
            argv: build_install_argv(
                &request.install_method,
                &request.spec,
                &environment,
                &tool_name,
            )?,
            cwd: Some(environment.root_path.clone()),
            use_pty: false,
            verification_rules: Vec::new(),
            env: execution_env.clone(),
        },
    )?;

    let merged_env = merge_execution_env(&load_host_env(), &environment, Some(&execution_env));
    let mut detected_tool = detect_tool(&tool_name, &merged_env);
    detected_tool.source = install_source_for_environment(&environment);
    detected_tool.install_method = Some(request.install_method.clone());
    detected_tool.install_spec = Some(request.spec.trim().to_string());

    let installed = execution.status == CliExecutionStatus::Completed
        && detected_tool.health == CliToolHealth::Ready;
    if installed {
        let _ = add_installed_tool_to_environment(state, &environment.id, &tool_name)?;
    }

    let summary = install_summary(&tool_name, &execution.status, &detected_tool.health);
    emit_cli_install_finished(
        app,
        request.session_id.as_deref(),
        request.task_id.as_deref(),
        request.runtime_id.as_deref(),
        &install_id,
        Some(&execution.id),
        Some(&environment.id),
        &tool_name,
        &cli_runtime_execution_status_label(&execution.status),
        &summary,
    );

    to_cli_runtime_ipc_value(CliInstallResult {
        success: installed || execution.status == CliExecutionStatus::AwaitingEscalation,
        installed,
        install_id,
        status: execution.status.clone(),
        environment_id: environment.id.clone(),
        tool_id: Some(tool_name.clone()),
        tool_name: Some(tool_name),
        install_method: request.install_method,
        spec: request.spec.trim().to_string(),
        summary,
        execution: Some(execution),
        tool: Some(detected_tool),
    })
}

fn poll_execution_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let execution_id = payload_string(payload, "executionId")
        .ok_or_else(|| "executionId is required".to_string())?;
    let max_chars = payload
        .get("maxChars")
        .and_then(Value::as_u64)
        .unwrap_or(4_000) as usize;
    let _ = refresh_cli_execution(app, &execution_id)?;
    let snapshot = load_cli_execution_snapshot(state, &execution_id, max_chars)?;
    match snapshot {
        Some(snapshot) => to_cli_runtime_ipc_value(snapshot),
        None => Ok(Value::Null),
    }
}

fn verify_execution_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliVerifyExecutionRequest = parse_cli_runtime_payload(payload)?;
    let execution = find_cli_execution_by_id(state, &request.execution_id)?
        .ok_or_else(|| format!("cli execution not found: {}", request.execution_id))?;
    let outcome = run_cli_verification(state, execution, &request.rules)?;
    emit_cli_verification_finished(app, &outcome.execution, &outcome.summary);
    to_cli_runtime_ipc_value(CliVerifyResult {
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
        "status": cli_runtime_execution_status_label(&execution.status),
        "execution": execution,
    }))
}

fn approve_escalation_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliApproveEscalationRequest = parse_cli_runtime_payload(payload)?;
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
    let request: CliDenyEscalationRequest = parse_cli_runtime_payload(payload)?;
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
        "cli-runtime:install" => install_value(app, state, payload),
        "cli-runtime:execute" => execute_value(app, state, payload),
        "cli-runtime:poll-execution" => poll_execution_value(app, state, payload),
        "cli-runtime:cancel-execution" => cancel_execution_value(app, state, payload),
        "cli-runtime:verify" => verify_execution_value(app, state, payload),
        "cli-runtime:approve-escalation" => approve_escalation_value(app, state, payload),
        "cli-runtime:deny-escalation" => deny_escalation_value(app, state, payload),
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

    #[test]
    fn build_install_argv_uses_scope_specific_package_manager_forms() {
        let environment = CliEnvironmentRecord {
            id: "cli-env-app-global".to_string(),
            scope: CliEnvironmentScope::AppGlobal,
            root_path: "/tmp/redbox-cli".to_string(),
            workspace_root: None,
            path_entries: Vec::new(),
            runtimes: Default::default(),
            installed_tool_ids: Vec::new(),
            created_at: 0,
            updated_at: 0,
            metadata: None,
        };
        assert_eq!(
            build_install_argv(&CliInstallMethod::Pnpm, "cowsay", &environment, "cowsay")
                .expect("argv should build"),
            vec![
                "pnpm".to_string(),
                "add".to_string(),
                "--dir".to_string(),
                "/tmp/redbox-cli".to_string(),
                "cowsay".to_string()
            ]
        );
        assert_eq!(
            build_install_argv(&CliInstallMethod::Npm, "eslint", &environment, "eslint")
                .expect("argv should build"),
            vec![
                "npm".to_string(),
                "install".to_string(),
                "--prefix".to_string(),
                "/tmp/redbox-cli".to_string(),
                "--no-save".to_string(),
                "eslint".to_string()
            ]
        );
    }
}
