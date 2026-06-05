#[path = "skills_ai/ai_control.rs"]
mod ai_control;
#[path = "skills_ai/marketplace.rs"]
mod marketplace;

use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    build_market_file_skill_record, build_workspace_skill_record,
    compute_skill_discovery_fingerprint, install_skills_from_repo, invoke_skill,
    preferred_user_skill_root, refresh_skill_store_catalog, resolve_skill_file_path,
    skill_catalog_changed, skills_catalog_list_value, write_skill_record_to_path,
    InstallSkillsFromRepoRequest, SkillInvokeRequest, UninstallSkillRequest,
};
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use ai_control::{ai_detect_protocol_value, ai_roles_list_value, ai_test_connection_value};
use marketplace::{
    list_skill_marketplace, resolve_market_install_entry, ThriveSkillMarketInstallRequest,
};

fn requested_skill_name(payload: &Value) -> String {
    payload_string(payload, "name")
        .or_else(|| payload_string(payload, "skill"))
        .unwrap_or_default()
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
    if !matches!(
        channel,
        "skills:list"
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
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
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
                let (list, watcher_snapshot) = with_store(state, |store| {
                    Ok(skills_catalog_list_value(
                        &store.skills,
                        Some(discovery_fingerprint.as_str()),
                        include_body,
                    ))
                })?;
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
            "skills:market-install" => {
                let request: ThriveSkillMarketInstallRequest =
                    serde_json::from_value(payload.clone()).map_err(|error| {
                        format!("skills:market-install payload invalid: {error}")
                    })?;
                let repo = request
                    .repo
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| {
                        resolve_market_install_entry(&request)
                            .ok()
                            .flatten()
                            .map(|entry| entry.repo)
                    });
                if let Some(repo) = repo {
                    let workspace = workspace_root(state).ok();
                    let outcome = install_skills_from_repo(
                        InstallSkillsFromRepoRequest {
                            source: repo,
                            ref_name: request.ref_name.or(request.ref_alias),
                            paths: Vec::new(),
                            scope: Some("user".to_string()),
                            workspace_root: workspace,
                        },
                        &preferred_user_skill_root(),
                    )?;
                    let _ = refresh_skill_store_catalog(state);
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                    return Ok(json!({
                        "success": true,
                        "source": outcome.source,
                        "refName": outcome.ref_name,
                        "scope": outcome.scope,
                        "installRoot": outcome.install_root,
                        "installed": outcome.installed,
                    }));
                }

                let slug = request.slug.or(request.id).unwrap_or_default();
                if slug.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少技能 slug" }));
                }
                let created = build_market_file_skill_record(&slug);
                let Some(path) = resolve_skill_file_path(&created, None) else {
                    return Ok(json!({ "success": false, "error": "无法解析技能文件路径" }));
                };
                write_skill_record_to_path(&created, &path)?;
                let _ = refresh_skill_store_catalog(state);
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                Ok(json!({
                    "success": true,
                    "displayName": slug,
                    "location": created.location,
                    "path": path.display().to_string(),
                    "placeholder": true,
                    "requiresCliRuntimeBootstrap": true,
                    "summary": "Market skill registered as a placeholder only. External CLI tools and runtimes must be provisioned through cli_runtime.*."
                }))
            }
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
