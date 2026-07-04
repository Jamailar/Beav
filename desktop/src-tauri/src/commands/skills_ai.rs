#[path = "skills_ai/ai_control.rs"]
mod ai_control;
#[path = "skills_ai/marketplace.rs"]
mod marketplace;

use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    audit_skill_packages_value, build_skill_package_records, build_workspace_skill_record,
    compute_skill_discovery_fingerprint, enrich_skill_list_value_with_packages,
    find_catalog_skill_by_name, inspect_skill_package_value, install_skills_from_repo,
    invoke_skill, preferred_user_skill_root, refresh_skill_store_catalog, resolve_skill_file_path,
    skill_catalog_changed, skills_catalog_list_value, write_skill_record_to_path,
    InstallSkillsFromRepoRequest, SkillInvokeRequest, UninstallSkillRequest,
    DEFAULT_SKILL_RESOURCE_MAX_CHARS,
};
use crate::skills::{
    list_skill_resources_value, parse_skill_resource_uri, read_skill_resource_value,
};
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use ai_control::{ai_detect_protocol_value, ai_roles_list_value, ai_test_connection_value};
use marketplace::{
    enrich_skill_catalog_list_with_market_metadata, handle_marketplace_channel,
    install_skill_marketplace_package, list_skill_marketplace, marketplace_channel_names,
};

fn requested_skill_name(payload: &Value) -> String {
    let candidate = payload_string(payload, "name")
        .or_else(|| payload_string(payload, "skill"))
        .or_else(|| {
            payload_string(payload, "uri")
                .or_else(|| payload_string(payload, "path"))
                .and_then(|value| parse_skill_resource_uri(&value).map(|parsed| parsed.skill_name))
        })
        .unwrap_or_default();
    parse_skill_resource_uri(&candidate)
        .map(|parsed| parsed.skill_name)
        .unwrap_or(candidate)
}

fn requested_skill_resource_path(payload: &Value) -> String {
    payload_string(payload, "path")
        .or_else(|| payload_string(payload, "uri"))
        .unwrap_or_default()
}

fn payload_usize(payload: &Value, key: &str) -> Option<usize> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn payload_string_list(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn handle_skills_ai_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !marketplace_channel_names().contains(&channel)
        && !matches!(
            channel,
            "skills:list"
                | "skills:list-resources"
                | "skills:inspect"
                | "skills:audit"
                | "skills:read"
                | "skills:read-resource"
                | "skills:invoke"
                | "skills:create"
                | "skills:save"
                | "skills:disable"
                | "skills:enable"
                | "skills:marketplace"
                | "skills:market-install"
                | "skills:install-from-repo"
                | "skills:uninstall"
                | "ai:roles:list"
                | "ai:detect-protocol"
                | "ai:test-connection"
        )
    {
        return None;
    }

    Some((|| -> Result<Value, String> {
        if let Some(result) = handle_marketplace_channel(state, channel, payload) {
            return result;
        }
        match channel {
            "skills:list" => {
                let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
                let _ = refresh_skill_store_catalog(state);
                let include_body = payload
                    .get("includeBody")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let workspace = workspace_root(state).ok();
                let discovery_fingerprint =
                    compute_skill_discovery_fingerprint(workspace.as_deref());
                let ((mut list, watcher_snapshot), skill_records) = with_store(state, |store| {
                    Ok((
                        skills_catalog_list_value(
                            &store.skills,
                            Some(discovery_fingerprint.as_str()),
                            include_body,
                        ),
                        store.skills.clone(),
                    ))
                })?;
                let package_records =
                    build_skill_package_records(&skill_records, workspace.as_deref());
                enrich_skill_list_value_with_packages(&mut list, &package_records);
                enrich_skill_catalog_list_with_market_metadata(
                    &mut list,
                    &skill_records,
                    workspace.as_deref(),
                );
                let changed = {
                    let mut guard = state
                        .skill_watch
                        .lock()
                        .map_err(|_| "skill watcher lock 已损坏".to_string())?;
                    let changed = skill_catalog_changed(&guard, &watcher_snapshot);
                    *guard = watcher_snapshot;
                    changed
                };
                if changed {
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                }
                Ok(list)
            }
            "skills:inspect" => {
                let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
                let _ = refresh_skill_store_catalog(state);
                let operation = payload_string(payload, "operation")
                    .unwrap_or_else(|| {
                        if requested_skill_name(payload).trim().is_empty() {
                            "list".to_string()
                        } else {
                            "read".to_string()
                        }
                    })
                    .trim()
                    .to_ascii_lowercase();
                let workspace = workspace_root(state).ok();
                match operation.as_str() {
                    "list" => {
                        let skill_records = with_store(state, |store| Ok(store.skills.clone()))?;
                        let packages =
                            build_skill_package_records(&skill_records, workspace.as_deref());
                        Ok(json!({
                            "success": true,
                            "schemaVersion": 3,
                            "packages": packages,
                        }))
                    }
                    "read" | "get" => {
                        let requested_name = requested_skill_name(payload);
                        if requested_name.is_empty() {
                            return Err("技能名称不能为空".to_string());
                        }
                        let record = with_store(state, |store| {
                            Ok(store
                                .skills
                                .iter()
                                .find(|item| item.name.eq_ignore_ascii_case(&requested_name))
                                .cloned())
                        })?
                        .ok_or_else(|| format!("技能不存在: {requested_name}"))?;
                        let include_body = payload
                            .get("includeBody")
                            .and_then(Value::as_bool)
                            .unwrap_or(true);
                        Ok(inspect_skill_package_value(
                            &record,
                            workspace.as_deref(),
                            include_body,
                        ))
                    }
                    "audit" => {
                        let skill_records = with_store(state, |store| Ok(store.skills.clone()))?;
                        Ok(audit_skill_packages_value(
                            &skill_records,
                            workspace.as_deref(),
                        ))
                    }
                    other => Err(format!(
                        "unsupported skills inspect operation `{other}`; expected list, read, or audit"
                    )),
                }
            }
            "skills:audit" => {
                let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
                let _ = refresh_skill_store_catalog(state);
                let workspace = workspace_root(state).ok();
                let skill_records = with_store(state, |store| Ok(store.skills.clone()))?;
                Ok(audit_skill_packages_value(
                    &skill_records,
                    workspace.as_deref(),
                ))
            }
            "skills:list-resources" => {
                let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
                let _ = refresh_skill_store_catalog(state);
                let requested_name = requested_skill_name(payload);
                if requested_name.is_empty() {
                    return Err("技能名称不能为空".to_string());
                }
                let workspace = workspace_root(state).ok();
                let record = with_store(state, |store| {
                    Ok(store
                        .skills
                        .iter()
                        .find(|item| item.name.eq_ignore_ascii_case(&requested_name))
                        .cloned())
                })?
                .ok_or_else(|| format!("技能不存在: {requested_name}"))?;
                list_skill_resources_value(&record, workspace.as_deref())
            }
            "skills:read" => {
                let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
                let _ = refresh_skill_store_catalog(state);
                let requested_name = requested_skill_name(payload);
                if requested_name.is_empty() {
                    return Err("技能名称不能为空".to_string());
                }
                let skill = with_store(state, |store| {
                    Ok(find_catalog_skill_by_name(&store.skills, &requested_name))
                })?
                .ok_or_else(|| format!("技能不存在: {requested_name}"))?;
                let record = with_store(state, |store| {
                    Ok(store
                        .skills
                        .iter()
                        .find(|item| item.name.eq_ignore_ascii_case(&requested_name))
                        .cloned())
                })?;
                let workspace = workspace_root(state).ok();
                let package = record
                    .as_ref()
                    .map(|record| inspect_skill_package_value(record, workspace.as_deref(), false))
                    .and_then(|value| value.get("package").cloned());
                Ok(json!({
                    "success": true,
                    "skill": skill.clone(),
                    "name": skill.name,
                    "description": skill.description,
                    "location": skill.location,
                    "body": skill.body,
                    "metadata": skill.metadata,
                    "disabled": skill.disabled,
                    "isBuiltin": skill.is_builtin,
                    "sourceScope": skill.source_scope,
                    "fingerprint": skill.fingerprint,
                    "package": package,
                }))
            }
            "skills:read-resource" => {
                let _ = crate::commands::plugin::sync_enabled_thrive_plugin_capabilities(state);
                let _ = refresh_skill_store_catalog(state);
                let requested_name = requested_skill_name(payload);
                if requested_name.is_empty() {
                    return Err("技能名称不能为空".to_string());
                }
                let resource_path = requested_skill_resource_path(payload);
                if resource_path.trim().is_empty() {
                    return Err("技能资源路径不能为空".to_string());
                }
                let workspace = workspace_root(state).ok();
                let record = with_store(state, |store| {
                    Ok(store
                        .skills
                        .iter()
                        .find(|item| item.name.eq_ignore_ascii_case(&requested_name))
                        .cloned())
                })?
                .ok_or_else(|| format!("技能不存在: {requested_name}"))?;
                let max_chars = payload_usize(payload, "maxChars")
                    .or_else(|| payload_usize(payload, "limit"))
                    .unwrap_or(DEFAULT_SKILL_RESOURCE_MAX_CHARS)
                    .clamp(1, DEFAULT_SKILL_RESOURCE_MAX_CHARS);
                read_skill_resource_value(
                    &record,
                    workspace.as_deref(),
                    &resource_path,
                    max_chars,
                    None,
                )
            }
            "skills:invoke" => {
                let started_at = now_ms();
                let requested_name = requested_skill_name(payload);
                if requested_name.is_empty() {
                    return Err("技能名称不能为空".to_string());
                }
                let session_id = payload_string(payload, "sessionId");
                let runtime_mode_hint = payload_string(payload, "runtimeMode");
                let outcome = invoke_skill(
                    state,
                    SkillInvokeRequest {
                        skill_name: &requested_name,
                        session_id: session_id.as_deref(),
                        runtime_mode_hint: runtime_mode_hint.as_deref(),
                    },
                )?;
                let _ = record_skill_invocation_metric(
                    state,
                    SkillInvocationMetric {
                        session_id: session_id.clone(),
                        runtime_mode: outcome.runtime_mode.clone(),
                        skill_name: outcome.skill_name.clone(),
                        activation_scope: outcome.activation_scope.clone(),
                        persisted_to_session: outcome.persisted_to_session,
                        active_skill_count: outcome.active_skills.len() as i64,
                        elapsed_ms: now_ms().saturating_sub(started_at) as i64,
                        created_at: now_i64(),
                    },
                );
                log_timing_event(
                    state,
                    "skills",
                    &format!("skills:invoke:{}", outcome.skill_name),
                    "skills:invoke",
                    started_at,
                    Some(format!(
                        "runtimeMode={} activationScope={} activeSkills={} persistedToSession={}",
                        outcome.runtime_mode,
                        outcome.activation_scope,
                        outcome.active_skills.len(),
                        outcome.persisted_to_session
                    )),
                );
                Ok(json!({
                    "success": true,
                    "action": "invoke",
                    "name": outcome.skill_name,
                    "description": outcome.description,
                    "activationScope": outcome.activation_scope,
                    "persistedToSession": outcome.persisted_to_session,
                    "runtimeMode": outcome.runtime_mode,
                    "sessionId": session_id,
                    "activeSkills": outcome.active_skills,
                    "activationTransition": {
                        "kind": "skillActivation",
                        "continueWithUpdatedContext": true,
                        "suppressActivationNarration": true,
                        "doNotRepeatInvocation": true,
                        "activatedSkillNames": [outcome.skill_name.clone()]
                    }
                }))
            }
            "skills:create" => {
                let name = payload_string(payload, "name").unwrap_or_default();
                if name.is_empty() {
                    return Ok(json!({ "success": false, "error": "技能名称不能为空" }));
                }
                let workspace = workspace_root(state).ok();
                let created = if workspace.is_some() {
                    build_workspace_skill_record(&name)
                } else {
                    crate::skills::build_user_skill_record(&name)
                };
                let Some(path) = resolve_skill_file_path(&created, workspace.as_deref()) else {
                    return Ok(json!({ "success": false, "error": "无法解析技能文件路径" }));
                };
                write_skill_record_to_path(&created, &path)?;
                let _ = refresh_skill_store_catalog(state);
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                Ok(json!({
                    "success": true,
                    "location": created.location,
                    "path": path.display().to_string()
                }))
            }
            "skills:save" => {
                let location = payload_string(payload, "location").unwrap_or_default();
                let content = payload_string(payload, "content").unwrap_or_default();
                let workspace = workspace_root(state).ok();
                let existing = with_store(state, |store| {
                    Ok(store
                        .skills
                        .iter()
                        .find(|item| item.location == location)
                        .cloned())
                })?;
                let Some(mut skill) = existing else {
                    return Ok(json!({ "success": false, "error": "技能不存在" }));
                };
                skill.body = content;
                let Some(path) = resolve_skill_file_path(&skill, workspace.as_deref()) else {
                    return Ok(json!({ "success": false, "error": "无法解析技能文件路径" }));
                };
                write_skill_record_to_path(&skill, &path)?;
                let _ = refresh_skill_store_catalog(state);
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                Ok(json!({ "success": true, "path": path.display().to_string() }))
            }
            "skills:disable" | "skills:enable" => {
                let name = payload_string(payload, "name").unwrap_or_default();
                let disabled = channel == "skills:disable";
                with_store_mut(state, |store| {
                    let Some(skill) = store.skills.iter_mut().find(|item| item.name == name) else {
                        return Ok(json!({ "success": false, "error": "技能不存在" }));
                    };
                    let is_builtin = skill.is_builtin.unwrap_or(false)
                        || skill.source_scope.as_deref() == Some("builtin");
                    if disabled && is_builtin {
                        skill.disabled = Some(false);
                        return Ok(json!({ "success": false, "error": "内置技能不可关闭" }));
                    }
                    skill.disabled = Some(disabled);
                    Ok(json!({ "success": true }))
                })
                .map(|value| {
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                    value
                })
            }
            "skills:marketplace" => list_skill_marketplace(state, payload),
            "skills:market-install" => install_skill_marketplace_package(state, payload),
            "skills:install-from-repo" => {
                let source = payload_string(payload, "source")
                    .or_else(|| payload_string(payload, "url"))
                    .or_else(|| payload_string(payload, "repo"))
                    .unwrap_or_default();
                if source.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少技能仓库 URL" }));
                }
                let paths = {
                    let mut paths = payload_string_list(payload, "paths");
                    if let Some(path) = payload_string(payload, "path") {
                        paths.push(path);
                    }
                    paths
                };
                let scope = payload_string(payload, "scope");
                let workspace = workspace_root(state).ok();
                let outcome = install_skills_from_repo(
                    InstallSkillsFromRepoRequest {
                        source,
                        ref_name: payload_string(payload, "ref")
                            .or_else(|| payload_string(payload, "refName")),
                        paths,
                        scope,
                        workspace_root: workspace.clone(),
                    },
                    &preferred_user_skill_root(),
                )?;
                let _ = refresh_skill_store_catalog(state);
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                Ok(json!({
                    "success": true,
                    "source": outcome.source,
                    "refName": outcome.ref_name,
                    "scope": outcome.scope,
                    "installRoot": outcome.install_root,
                    "installed": outcome.installed,
                }))
            }
            "skills:uninstall" => {
                let name = requested_skill_name(payload);
                if name.is_empty() {
                    return Ok(json!({ "success": false, "error": "技能名称不能为空" }));
                }
                let workspace = workspace_root(state).ok();
                let existing = with_store(state, |store| {
                    Ok(store.skills.iter().find(|item| item.name == name).cloned())
                })?;
                let Some(skill) = existing else {
                    return Ok(json!({ "success": false, "error": "技能不存在" }));
                };
                let is_builtin = skill.is_builtin.unwrap_or(false)
                    || skill.source_scope.as_deref() == Some("builtin");
                if is_builtin {
                    return Ok(json!({ "success": false, "error": "内置技能不可删除" }));
                }
                let scope = payload_string(payload, "scope").or_else(|| {
                    match skill.source_scope.as_deref() {
                        Some("workspace") => Some("workspace".to_string()),
                        _ => Some("user".to_string()),
                    }
                });
                let outcome = crate::skills::uninstall_skill(
                    UninstallSkillRequest {
                        name,
                        scope,
                        workspace_root: workspace.clone(),
                    },
                    &preferred_user_skill_root(),
                )?;
                let _ = refresh_skill_store_catalog(state);
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                Ok(json!({
                    "success": true,
                    "name": outcome.name,
                    "scope": outcome.scope,
                    "installRoot": outcome.install_root,
                    "removedPath": outcome.removed_path,
                }))
            }
            "ai:roles:list" => ai_roles_list_value(),
            "ai:detect-protocol" => ai_detect_protocol_value(payload),
            "ai:test-connection" => ai_test_connection_value(payload),
            _ => unreachable!(),
        }
    })())
}
