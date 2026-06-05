use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use super::ipc_codec::{parse_payload, to_ipc_value};
use crate::cli_runtime::{
    build_cli_sandbox_spec, build_cli_tool_manifest, build_effective_environment,
    collect_cli_requested_permissions, default_cli_execution_mode, detect_tool,
    detect_tool_with_shell_probe, discover_all_commands, find_cli_environment_by_id,
    find_cli_tool_by_command, find_cli_tool_by_id, find_cli_tool_manifest_by_tool_id,
    list_cli_environments, list_cli_tool_records, load_host_shell_snapshot,
    resolve_cli_environment, sandbox_metadata, upsert_cli_tool_manifest, upsert_cli_tool_record,
    CliDiscoverRequest, CliEffectiveEnvironment, CliEnvironmentRecord,
    CliEnvironmentResolveRequest, CliEnvironmentScope, CliExecuteRequest, CliExecutionMode,
    CliHostShellSnapshot, CliToolHealth, CliToolManifestRecord, CliToolRecord, CliToolSource,
};
use crate::{payload_string, AppState};

#[path = "tools/metadata.rs"]
mod metadata;

use metadata::environment_scope_rank;
pub(super) use metadata::{
    attach_effective_environment_metadata, merge_detected_tool_with_stored,
    tool_source_for_environment,
};

pub(super) fn load_host_env() -> CliHostShellSnapshot {
    load_host_shell_snapshot()
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct CliDiagnoseRequest {
    command: String,
    environment_id: Option<String>,
    cwd: Option<String>,
    execution_mode: Option<CliExecutionMode>,
}

fn list_tool_commands(state: &State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut commands = BTreeSet::new();
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

pub(super) fn discover_detected_tools(
    state: &State<'_, AppState>,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<CliToolRecord>, String> {
    let host = load_host_env();
    let limit = limit.clamp(1, 500);
    let mut discovered = Vec::<CliToolRecord>::new();
    let mut seen = BTreeSet::<String>::new();

    for environment in list_cli_environments(state)? {
        let effective = build_effective_environment(&host, Some(&environment), None);
        for mut tool in discover_all_commands(&effective.env, query, limit) {
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
            tool = attach_effective_environment_metadata(tool, &host, &effective);
            discovered.push(tool);
            if discovered.len() >= limit {
                return Ok(discovered);
            }
        }
    }

    let effective = build_effective_environment(&host, None, None);
    for mut tool in discover_all_commands(&effective.env, query, limit) {
        let key = format!(
            "{}:{}",
            tool.executable,
            tool.resolved_path.clone().unwrap_or_default()
        );
        if !seen.insert(key) {
            continue;
        }
        tool = attach_effective_environment_metadata(tool, &host, &effective);
        discovered.push(tool);
        if discovered.len() >= limit {
            break;
        }
    }

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

    Ok(discovered)
}

fn detect_tool_across_environments(
    state: &State<'_, AppState>,
    command: &str,
    host: &CliHostShellSnapshot,
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
        let effective = build_effective_environment(host, Some(environment), None);
        let detected = detect_tool_with_shell_probe(
            command,
            &effective.env,
            Some(&environment.path_entries),
            true,
            effective.shell_path.as_deref(),
        );
        if detected.health == CliToolHealth::Ready {
            return Ok(merge_detected_tool_with_stored(
                attach_effective_environment_metadata(detected, host, &effective),
                stored.as_ref(),
                Some(environment),
                manifest.as_ref(),
            ));
        }
    }

    let effective = build_effective_environment(host, None, None);
    let detected = detect_tool_with_shell_probe(
        command,
        &effective.env,
        None,
        true,
        effective.shell_path.as_deref(),
    );
    Ok(merge_detected_tool_with_stored(
        attach_effective_environment_metadata(detected, host, &effective),
        stored.as_ref(),
        None,
        manifest.as_ref(),
    ))
}

fn detect_registered_tools(
    state: &State<'_, AppState>,
    commands: &[String],
) -> Result<Vec<CliToolRecord>, String> {
    let host = load_host_env();
    let mut records = BTreeMap::<String, CliToolRecord>::new();
    for command in commands {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            continue;
        }
        let detected = detect_tool_across_environments(state, trimmed, &host)?;
        records.insert(detected.id.clone(), detected);
    }
    Ok(records.into_values().collect())
}

pub(super) fn detect_tools_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request =
        parse_payload::<crate::cli_runtime::CliDetectRequest>(payload).unwrap_or_default();
    let tools = if request.commands.is_empty() {
        discover_detected_tools(state, None, 500)?
    } else {
        detect_registered_tools(state, &request.commands)?
    };
    Ok(json!({
        "success": true,
        "tools": tools,
    }))
}

pub(super) fn discover_tools_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliDiscoverRequest = parse_payload(payload)?;
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = request.limit.unwrap_or(100).clamp(1, 500);
    let discovered = discover_detected_tools(state, query, limit)?;
    let discovered_len = discovered.len();
    Ok(json!({
        "success": true,
        "query": query,
        "limit": limit,
        "truncated": discovered_len >= limit,
        "tools": discovered,
    }))
}

pub(super) fn inspect_tool_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let requested = payload_string(payload, "command")
        .or_else(|| payload_string(payload, "toolId"))
        .or_else(|| payload_string(payload, "executable"))
        .or_else(|| payload_string(payload, "name"))
        .or_else(|| payload_string(payload, "id"))
        .unwrap_or_default();
    if requested.is_empty() {
        return Ok(None);
    }

    let host = load_host_env();
    let requested_command = if requested.starts_with("cli-tool-") {
        find_cli_tool_by_id(state, &requested)?
            .map(|tool| tool.executable)
            .or_else(|| {
                discover_detected_tools(state, None, 500)
                    .ok()
                    .and_then(|tools| {
                        tools
                            .into_iter()
                            .find(|tool| tool.id == requested)
                            .map(|tool| tool.executable)
                    })
            })
            .or_else(|| {
                list_tool_commands(state).ok().and_then(|commands| {
                    commands
                        .into_iter()
                        .find(|command| detect_tool(command, &host.env).id == requested)
                })
            })
            .unwrap_or_default()
    } else {
        requested.clone()
    };
    if requested_command.trim().is_empty() {
        return Ok(None);
    }

    let mut tool = detect_tool_across_environments(state, &requested_command, &host)?;
    if let Some(manifest) = build_cli_tool_manifest(&tool, &host.env) {
        let manifest = upsert_cli_tool_manifest(state, manifest)?;
        let environment = tool.environment_id.as_deref().and_then(|environment_id| {
            find_cli_environment_by_id(state, environment_id)
                .ok()
                .flatten()
        });
        tool = merge_detected_tool_with_stored(tool, None, environment.as_ref(), Some(&manifest));
    }
    let tool = upsert_cli_tool_record(state, tool)?;
    Ok(Some(to_ipc_value(tool)?))
}

pub(super) fn diagnose_tool_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: CliDiagnoseRequest = parse_payload(payload)?;
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
    let host = load_host_env();
    let effective = build_effective_environment(&host, Some(&resolution.environment), None);
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&resolution.environment.root_path)
        .to_string();
    let tool = attach_effective_environment_metadata(
        detect_tool_with_shell_probe(
            command,
            &effective.env,
            Some(&resolution.environment.path_entries),
            false,
            effective.shell_path.as_deref(),
        ),
        &host,
        &effective,
    );
    let execution_request = CliExecuteRequest {
        environment_id: Some(resolution.environment.id.clone()),
        tool_id: Some(command.to_string()),
        execution_mode: Some(
            request
                .execution_mode
                .clone()
                .unwrap_or(default_cli_execution_mode(state)?),
        ),
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
        &effective.env,
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
        "effectiveEnvironment": effective.metadata_value(),
        "hostShell": host.metadata_value(),
        "canResolve": tool.health == CliToolHealth::Ready,
        "willUseSandbox": sandbox.backend == "sandbox-exec",
        "summary": summary,
    }))
}
