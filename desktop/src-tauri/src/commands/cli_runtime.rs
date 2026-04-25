use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::cli_runtime::{
    add_installed_tool_to_environment, approve_cli_escalation, build_cli_sandbox_spec,
    build_cli_tool_manifest, cancel_cli_execution, collect_cli_requested_permissions,
    create_task_ephemeral_environment, default_detect_commands, deny_cli_escalation, detect_tool,
    detect_tool_with_managed_paths, discover_all_commands, emit_cli_escalation_resolved,
    emit_cli_execution_status, emit_cli_install_finished, emit_cli_install_started,
    emit_cli_verification_finished, ensure_app_global_environment, ensure_workspace_environment,
    ensure_workspace_environment_for_active_space, execute_cli_command, find_cli_environment_by_id,
    find_cli_execution_by_id, find_cli_tool_by_command, find_cli_tool_by_id,
    find_cli_tool_manifest_by_tool_id, list_cli_environments, list_cli_tool_records,
    load_cli_execution_snapshot, load_host_shell_env, merge_execution_env, prepare_cli_install,
    refresh_cli_execution, resolve_cli_environment, run_cli_verification, sandbox_metadata,
    upsert_cli_tool_manifest, upsert_cli_tool_record, CliApproveEscalationRequest,
    CliCreateEnvironmentRequest, CliDenyEscalationRequest, CliDiscoverRequest,
    CliEnvironmentRecord, CliEnvironmentResolveRequest, CliEnvironmentScope, CliExecuteRequest,
    CliExecutionMode, CliExecutionStatus, CliInstallRequest, CliInstallResult, CliToolHealth,
    CliToolManifestRecord, CliToolRecord, CliToolSource, CliVerifyExecutionRequest,
    CliVerifyResult,
};
use crate::{make_id, payload_string, AppState};

fn load_host_env() -> std::collections::BTreeMap<String, String> {
    load_host_shell_env().unwrap_or_else(|_| std::env::vars().collect())
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct CliDiagnoseRequest {
    command: String,
    environment_id: Option<String>,
    cwd: Option<String>,
    execution_mode: Option<CliExecutionMode>,
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
    for tool in list_cli_tool_records(state)? {
        let executable = tool.executable.trim();
        if !executable.is_empty() {
            commands.insert(executable.to_string());
        }
        let name = tool.name.trim();
        if !name.is_empty() {
            commands.insert(name.to_string());
        }
    }
    Ok(commands.into_iter().collect())
}

fn tool_source_for_environment(environment: &CliEnvironmentRecord) -> CliToolSource {
    match environment.scope {
        CliEnvironmentScope::WorkspaceLocal => CliToolSource::WorkspaceManaged,
        CliEnvironmentScope::AppGlobal | CliEnvironmentScope::TaskEphemeral => {
            CliToolSource::AppManaged
        }
    }
}

fn environment_scope_rank(scope: &CliEnvironmentScope) -> u8 {
    match scope {
        CliEnvironmentScope::AppGlobal => 0,
        CliEnvironmentScope::WorkspaceLocal => 1,
        CliEnvironmentScope::TaskEphemeral => 2,
    }
}

fn merge_tool_metadata(existing: Option<&Value>, generated: Option<Value>) -> Option<Value> {
    let mut merged = serde_json::Map::<String, Value>::new();
    if let Some(Value::Object(object)) = existing {
        for (key, value) in object {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(Value::Object(object)) = generated {
        for (key, value) in object {
            merged.insert(key, value);
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(Value::Object(merged))
    }
}

fn manifest_metadata(manifest: &CliToolManifestRecord) -> Value {
    json!({
        "commandCount": manifest.commands.len(),
        "supportsJsonOutput": manifest.supports_json_output,
        "supportsVersionFlag": manifest.supports_version_flag,
        "helpExcerpt": manifest.help_excerpt,
        "preferredParser": manifest.preferred_parser,
        "manifestGeneratedAt": manifest.generated_at,
    })
}

fn merge_detected_tool_with_stored(
    detected: CliToolRecord,
    stored: Option<&CliToolRecord>,
    environment: Option<&CliEnvironmentRecord>,
    manifest: Option<&CliToolManifestRecord>,
) -> CliToolRecord {
    let mut merged = detected;
    if let Some(stored) = stored {
        if merged.name.trim().is_empty() {
            merged.name = stored.name.clone();
        }
        if merged.executable.trim().is_empty() {
            merged.executable = stored.executable.clone();
        }
        merged.install_method = stored.install_method.clone().or(merged.install_method);
        merged.install_spec = stored.install_spec.clone().or(merged.install_spec);
        merged.manifest_id = stored.manifest_id.clone().or(merged.manifest_id);
        merged.environment_id = merged
            .environment_id
            .clone()
            .or(stored.environment_id.clone());
        merged.resolved_from = merged
            .resolved_from
            .clone()
            .or(stored.resolved_from.clone());
        if merged.effective_path_preview.is_empty() {
            merged.effective_path_preview = stored.effective_path_preview.clone();
        }
        merged.searched_path_entries_count = merged
            .searched_path_entries_count
            .or(stored.searched_path_entries_count);
        merged.is_in_default_detect_catalog |= stored.is_in_default_detect_catalog;
        if matches!(merged.source, CliToolSource::System)
            && !matches!(stored.source, CliToolSource::System)
            && merged.health != CliToolHealth::Ready
        {
            merged.source = stored.source.clone();
        }
        merged.metadata = merge_tool_metadata(stored.metadata.as_ref(), merged.metadata);
    }
    if let Some(environment) = environment {
        merged.environment_id = Some(environment.id.clone());
        merged.source = tool_source_for_environment(environment);
    }
    if let Some(manifest) = manifest {
        merged.manifest_id = Some(manifest.id.clone());
        merged.metadata =
            merge_tool_metadata(merged.metadata.as_ref(), Some(manifest_metadata(manifest)));
    }
    merged
}

fn detect_tool_across_environments(
    state: &State<'_, AppState>,
    command: &str,
    host_env: &BTreeMap<String, String>,
) -> Result<CliToolRecord, String> {
    let stored = find_cli_tool_by_command(state, command)?;
    let manifest = stored.as_ref().and_then(|tool| {
        find_cli_tool_manifest_by_tool_id(state, &tool.id)
            .ok()
            .flatten()
    });
    let mut environments = list_cli_environments(state)?;
    let preferred_environment_id = stored
        .as_ref()
        .and_then(|tool| tool.environment_id.as_deref())
        .map(ToString::to_string);
    environments.sort_by(|left, right| {
        let left_preferred = preferred_environment_id
            .as_deref()
            .is_some_and(|value| value == left.id);
        let right_preferred = preferred_environment_id
            .as_deref()
            .is_some_and(|value| value == right.id);
        left_preferred
            .cmp(&right_preferred)
            .reverse()
            .then(environment_scope_rank(&left.scope).cmp(&environment_scope_rank(&right.scope)))
            .then(right.updated_at.cmp(&left.updated_at))
    });

    for environment in &environments {
        let merged_env = merge_execution_env(host_env, environment, None);
        let detected = detect_tool_with_managed_paths(
            command,
            &merged_env,
            Some(&environment.path_entries),
            true,
        );
        if detected.health == CliToolHealth::Ready {
            return Ok(merge_detected_tool_with_stored(
                detected,
                stored.as_ref(),
                Some(environment),
                manifest.as_ref(),
            ));
        }
    }

    let detected = detect_tool(command, host_env);
    Ok(merge_detected_tool_with_stored(
        detected,
        stored.as_ref(),
        None,
        manifest.as_ref(),
    ))
}

fn detect_registered_tools(
    state: &State<'_, AppState>,
    commands: &[String],
) -> Result<Vec<CliToolRecord>, String> {
    let host_env = load_host_env();
    let mut records = BTreeMap::<String, CliToolRecord>::new();
    for command in commands {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            continue;
        }
        let detected = detect_tool_across_environments(state, trimmed, &host_env)?;
        records.insert(detected.id.clone(), detected);
    }
    Ok(records.into_values().collect())
}

fn discover_tools_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request: CliDiscoverRequest = parse_cli_runtime_payload(payload)?;
    let host_env = load_host_env();
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = request.limit.unwrap_or(100).clamp(1, 500);
    let mut discovered = Vec::<CliToolRecord>::new();
    let mut seen = BTreeSet::<String>::new();
    for environment in list_cli_environments(state)? {
        let merged_env = merge_execution_env(&host_env, &environment, None);
        for mut tool in discover_all_commands(&merged_env, query, limit) {
            let key = format!(
                "{}:{}",
                tool.executable,
                tool.resolved_path.clone().unwrap_or_default()
            );
            if !seen.insert(key) {
                continue;
            }
            tool.environment_id = Some(environment.id.clone());
            tool.source = tool_source_for_environment(&environment);
            discovered.push(tool);
            if discovered.len() >= limit {
                break;
            }
        }
        if discovered.len() >= limit {
            break;
        }
    }
    if discovered.len() < limit {
        for tool in discover_all_commands(&host_env, query, limit) {
            let key = format!(
                "{}:{}",
                tool.executable,
                tool.resolved_path.clone().unwrap_or_default()
            );
            if !seen.insert(key) {
                continue;
            }
            discovered.push(tool);
            if discovered.len() >= limit {
                break;
            }
        }
    }
    let discovered_len = discovered.len();
    for tool in &mut discovered {
        if let Some(stored) = find_cli_tool_by_command(state, &tool.executable)? {
            let manifest = find_cli_tool_manifest_by_tool_id(state, &stored.id)?;
            let environment = tool.environment_id.as_deref().and_then(|environment_id| {
                find_cli_environment_by_id(state, environment_id)
                    .ok()
                    .flatten()
            });
            *tool = merge_detected_tool_with_stored(
                tool.clone(),
                Some(&stored),
                environment.as_ref(),
                manifest.as_ref(),
            );
        }
    }
    Ok(json!({
        "success": true,
        "query": query,
        "limit": limit,
        "truncated": discovered_len >= limit,
        "tools": discovered,
    }))
}

fn inspect_tool_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let requested = payload_string(payload, "command")
        .or_else(|| payload_string(payload, "toolId"))
        .or_else(|| payload_string(payload, "executable"))
        .unwrap_or_default();
    if requested.is_empty() {
        return Ok(None);
    }

    let host_env = load_host_env();
    let requested_command = if requested.starts_with("cli-tool-") {
        find_cli_tool_by_id(state, &requested)?
            .map(|tool| tool.executable)
            .or_else(|| {
                list_tool_commands(state).ok().and_then(|commands| {
                    commands
                        .into_iter()
                        .find(|command| detect_tool(command, &host_env).id == requested)
                })
            })
            .unwrap_or_default()
    } else {
        requested.clone()
    };
    if requested_command.trim().is_empty() {
        return Ok(None);
    }

    let mut tool = detect_tool_across_environments(state, &requested_command, &host_env)?;
    if let Some(manifest) = build_cli_tool_manifest(&tool, &host_env) {
        let manifest = upsert_cli_tool_manifest(state, manifest)?;
        let environment = tool.environment_id.as_deref().and_then(|environment_id| {
            find_cli_environment_by_id(state, environment_id)
                .ok()
                .flatten()
        });
        tool = merge_detected_tool_with_stored(tool, None, environment.as_ref(), Some(&manifest));
    }
    let tool = upsert_cli_tool_record(state, tool)?;
    Ok(Some(to_cli_runtime_ipc_value(tool)?))
}

fn diagnose_tool_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request: CliDiagnoseRequest = parse_cli_runtime_payload(payload)?;
    let command = request.command.trim();
    if command.is_empty() {
        return Err("cli diagnose requires command".to_string());
    }

    let resolution = resolve_cli_environment(
        state,
        &CliEnvironmentResolveRequest {
            requested_environment_id: request.environment_id.clone(),
            tool_id: Some(command.to_string()),
            ..Default::default()
        },
    )?;
    let host_env = load_host_env();
    let merged_env = merge_execution_env(&host_env, &resolution.environment, None);
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&resolution.environment.root_path)
        .to_string();
    let tool = detect_tool_with_managed_paths(
        command,
        &merged_env,
        Some(&resolution.environment.path_entries),
        false,
    );
    let execution_request = CliExecuteRequest {
        environment_id: Some(resolution.environment.id.clone()),
        tool_id: Some(command.to_string()),
        execution_mode: request.execution_mode.clone(),
        argv: vec![command.to_string(), "--version".to_string()],
        cwd: Some(cwd.clone()),
        ..Default::default()
    };
    let permissions = collect_cli_requested_permissions(
        state,
        &execution_request,
        &resolution.environment,
        Path::new(&cwd),
    );
    let sandbox = build_cli_sandbox_spec(
        &execution_request,
        &resolution.environment,
        Path::new(&cwd),
        &merged_env,
        &permissions,
    );
    let summary = if tool.health == CliToolHealth::Ready {
        format!("{command} 将以 {} 模式运行", sandbox.mode)
    } else {
        format!("未在当前执行环境 PATH 中找到 {command}")
    };
    Ok(json!({
        "success": true,
        "command": command,
        "tool": tool,
        "environment": resolution.environment,
        "environmentResolution": {
            "reason": resolution.reason,
            "reusedExisting": resolution.reused_existing,
        },
        "cwd": cwd,
        "permissions": permissions,
        "sandbox": sandbox_metadata(&sandbox),
        "canResolve": tool.health == CliToolHealth::Ready,
        "willUseSandbox": sandbox.backend == "sandbox-exec",
        "summary": summary,
    }))
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

fn managed_install_env(environment: &CliEnvironmentRecord) -> BTreeMap<String, String> {
    let root = Path::new(&environment.root_path);
    BTreeMap::from([
        ("HOME".to_string(), environment.root_path.clone()),
        (
            "XDG_CACHE_HOME".to_string(),
            root.join(".cache").to_string_lossy().to_string(),
        ),
        (
            "XDG_CONFIG_HOME".to_string(),
            root.join(".config").to_string_lossy().to_string(),
        ),
        (
            "npm_config_cache".to_string(),
            root.join(".npm-cache").to_string_lossy().to_string(),
        ),
        ("npm_config_audit".to_string(), "false".to_string()),
        ("npm_config_fund".to_string(), "false".to_string()),
        (
            "npm_config_update_notifier".to_string(),
            "false".to_string(),
        ),
        (
            "PIP_CACHE_DIR".to_string(),
            root.join(".cache")
                .join("pip")
                .to_string_lossy()
                .to_string(),
        ),
        (
            "UV_CACHE_DIR".to_string(),
            root.join(".cache").join("uv").to_string_lossy().to_string(),
        ),
        (
            "CARGO_HOME".to_string(),
            root.join(".cargo").to_string_lossy().to_string(),
        ),
        (
            "GOPATH".to_string(),
            root.join("go").to_string_lossy().to_string(),
        ),
        (
            "GOMODCACHE".to_string(),
            root.join("go")
                .join("pkg")
                .join("mod")
                .to_string_lossy()
                .to_string(),
        ),
        (
            "GOCACHE".to_string(),
            root.join(".cache")
                .join("go-build")
                .to_string_lossy()
                .to_string(),
        ),
    ])
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

    let install_plan = prepare_cli_install(&request, &environment, &tool_name)?;
    let mut execution_env = managed_install_env(&environment);
    for (key, value) in install_plan.env.clone() {
        execution_env.insert(key, value);
    }
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
            execution_mode: request.execution_mode.clone(),
            argv: install_plan.argv.clone(),
            cwd: Some(environment.root_path.clone()),
            use_pty: false,
            verification_rules: Vec::new(),
            env: execution_env.clone(),
        },
    )?;

    let merged_env = merge_execution_env(&load_host_env(), &environment, Some(&execution_env));
    let mut detected_tool = detect_tool_with_managed_paths(
        &tool_name,
        &merged_env,
        Some(&environment.path_entries),
        true,
    );
    detected_tool.source = tool_source_for_environment(&environment);
    detected_tool.environment_id = Some(environment.id.clone());
    detected_tool.install_method = Some(request.install_method.clone());
    detected_tool.install_spec = Some(request.spec.trim().to_string());
    if let Some(manifest) = build_cli_tool_manifest(&detected_tool, &merged_env) {
        let manifest = upsert_cli_tool_manifest(state, manifest)?;
        detected_tool = merge_detected_tool_with_stored(detected_tool, None, None, Some(&manifest));
    }
    let detected_tool = upsert_cli_tool_record(state, detected_tool)?;

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
            let tools = detect_registered_tools(state, &commands)?;
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
            detect_registered_tools(state, &commands).and_then(to_cli_runtime_ipc_value)
        }
        "cli-runtime:inspect" => {
            inspect_tool_value(state, payload).map(|value| value.unwrap_or(Value::Null))
        }
        "cli-runtime:diagnose" => diagnose_tool_value(state, payload),
        "cli-runtime:discover" => discover_tools_value(state, payload),
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
    use crate::cli_runtime::CliInstallMethod;

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
    fn prepare_cli_install_uses_scope_specific_package_manager_forms() {
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
            prepare_cli_install(
                &CliInstallRequest {
                    install_method: CliInstallMethod::Pnpm,
                    spec: "cowsay".to_string(),
                    ..CliInstallRequest::default()
                },
                &environment,
                "cowsay",
            )
            .expect("argv should build")
            .argv,
            vec![
                "pnpm".to_string(),
                "add".to_string(),
                "--dir".to_string(),
                "/tmp/redbox-cli".to_string(),
                "cowsay".to_string()
            ]
        );
        assert_eq!(
            prepare_cli_install(
                &CliInstallRequest {
                    install_method: CliInstallMethod::Npm,
                    spec: "eslint".to_string(),
                    ..CliInstallRequest::default()
                },
                &environment,
                "eslint",
            )
            .expect("argv should build")
            .argv,
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
