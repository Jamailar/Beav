use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, State};

use super::tools::{
    attach_effective_environment_metadata, load_host_env, merge_detected_tool_with_stored,
    tool_source_for_environment,
};
use super::{execution_status_label, parse_payload, to_ipc_value};
use crate::cli_runtime::{
    add_installed_tool_to_environment, build_cli_tool_manifest, build_effective_environment,
    detect_tool_with_shell_probe, emit_cli_install_finished, emit_cli_install_started,
    ensure_app_global_environment, execute_cli_command, find_cli_environment_by_id,
    prepare_cli_install, upsert_cli_tool_manifest, upsert_cli_tool_record, CliEnvironmentRecord,
    CliExecuteRequest, CliExecutionStatus, CliInstallRequest, CliInstallResult, CliToolHealth,
};
use crate::{make_id, AppState};

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

pub(super) fn install_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliInstallRequest = parse_payload(payload)?;
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

    let host = load_host_env();
    let effective = build_effective_environment(&host, Some(&environment), Some(&execution_env));
    let mut detected_tool = attach_effective_environment_metadata(
        detect_tool_with_shell_probe(
            &tool_name,
            &effective.env,
            Some(&environment.path_entries),
            true,
            effective.shell_path.as_deref(),
        ),
        &host,
        &effective,
    );
    detected_tool.source = tool_source_for_environment(&environment);
    detected_tool.environment_id = Some(environment.id.clone());
    detected_tool.install_method = Some(request.install_method.clone());
    detected_tool.install_spec = Some(request.spec.trim().to_string());
    if let Some(manifest) = build_cli_tool_manifest(&detected_tool, &effective.env) {
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
        &execution_status_label(&execution.status),
        &summary,
    );

    to_ipc_value(CliInstallResult {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_runtime::{CliEnvironmentScope, CliInstallMethod};

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
