use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    build_market_file_skill_record, build_workspace_skill_record,
    compute_skill_discovery_fingerprint, install_skills_from_repo, invoke_skill,
    preferred_user_skill_root, refresh_skill_store_catalog, resolve_skill_file_path,
    skill_catalog_changed, skills_catalog_list_value, write_skill_record_to_path,
    InstallSkillsFromRepoRequest, SkillInvokeRequest, UninstallSkillRequest,
};
use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

const THRIVE_SKILL_DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/ThrivingOS/Thrive-release/main/community-skills.json";
const THRIVE_SKILL_HTTP_USER_AGENT: &str =
    "Thrive/SkillMarketplace (+https://github.com/ThrivingOS/Thrive-release)";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ThriveSkillMarketplaceRequest {
    url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ThriveSkillMarketInstallRequest {
    slug: Option<String>,
    id: Option<String>,
    repo: Option<String>,
    ref_name: Option<String>,
    #[serde(rename = "ref")]
    ref_alias: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThriveSkillMarketplaceEntry {
    id: String,
    name: String,
    author: String,
    description: String,
    repo: String,
}

fn skill_marketplace_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(THRIVE_SKILL_HTTP_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|error| error.to_string())
}

fn is_safe_skill_marketplace_url(url: &str) -> bool {
    url.starts_with("https://raw.githubusercontent.com/")
        || url.starts_with("https://github.com/")
        || url.starts_with("https://api.github.com/")
}

fn skill_marketplace_registry_url(
    request: &ThriveSkillMarketplaceRequest,
) -> Result<String, String> {
    let url = request
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(THRIVE_SKILL_DEFAULT_REGISTRY_URL);
    if !is_safe_skill_marketplace_url(url) {
        return Err("skill marketplace registry must be a GitHub HTTPS URL".to_string());
    }
    Ok(url.to_string())
}

fn http_get_skill_marketplace_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    if !is_safe_skill_marketplace_url(url) {
        return Err("skill marketplace request must use a GitHub HTTPS URL".to_string());
    }
    let response = skill_marketplace_http_client()?
        .get(url)
        .send()
        .map_err(|error| format!("failed to request `{url}`: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("request `{url}` failed with HTTP {status}"));
    }
    response
        .json::<T>()
        .map_err(|error| format!("failed to parse `{url}`: {error}"))
}

fn load_skill_marketplace_entries(
    request: &ThriveSkillMarketplaceRequest,
) -> Result<(String, Vec<ThriveSkillMarketplaceEntry>), String> {
    let registry_url = skill_marketplace_registry_url(request)?;
    let entries =
        http_get_skill_marketplace_json::<Vec<ThriveSkillMarketplaceEntry>>(&registry_url)?;
    Ok((registry_url, entries))
}

fn list_skill_marketplace(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request: ThriveSkillMarketplaceRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:marketplace payload invalid: {error}"))?;
    let (registry_url, entries) = load_skill_marketplace_entries(&request)?;
    let installed_names = with_store(state, |store| {
        Ok(store
            .skills
            .iter()
            .map(|skill| skill.name.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>())
    })?;
    let skills = entries
        .into_iter()
        .map(|entry| {
            let installed = installed_names.contains(&entry.id.to_ascii_lowercase())
                || installed_names.contains(&entry.name.to_ascii_lowercase());
            json!({
                "id": entry.id,
                "name": entry.name,
                "author": entry.author,
                "description": entry.description,
                "repo": entry.repo,
                "installed": installed,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "success": true,
        "registryUrl": registry_url,
        "skills": skills,
    }))
}

fn resolve_market_install_entry(
    request: &ThriveSkillMarketInstallRequest,
) -> Result<Option<ThriveSkillMarketplaceEntry>, String> {
    let id = request
        .id
        .as_deref()
        .or(request.slug.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(id) = id else {
        return Ok(None);
    };
    let (_registry_url, entries) =
        load_skill_marketplace_entries(&ThriveSkillMarketplaceRequest::default())?;
    Ok(entries.into_iter().find(|entry| entry.id == id))
}

fn is_likely_image_model_id(model_id: &str) -> bool {
    let normalized = model_id.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    [
        "image",
        "dall-e",
        "dalle",
        "wan",
        "seedream",
        "jimeng",
        "imagen",
        "flux",
        "stable-diffusion",
        "sdxl",
        "midjourney",
        "mj",
    ]
    .iter()
    .any(|keyword| normalized.contains(keyword))
}

fn maybe_filter_models_by_purpose(models: Vec<Value>, purpose: Option<&str>) -> Vec<Value> {
    if purpose != Some("image") {
        return models;
    }
    let filtered = models
        .iter()
        .filter(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(is_likely_image_model_id)
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        models
    } else {
        filtered
    }
}

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
            | "ai:fetch-models"
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
            "ai:roles:list" => Ok(json!([
                {
                    "roleId": "planner",
                    "purpose": "负责拆解目标、确定阶段顺序、把任务转成明确执行步骤。",
                    "systemPrompt": "你是任务规划者，优先澄清目标、阶段、依赖和落盘动作，不要直接跳到模糊回答。",
                    "allowedToolPack": "redclaw",
                    "inputSchema": "目标、上下文、约束、历史项目状态",
                    "outputSchema": "阶段计划、执行建议、关键依赖、保存策略",
                    "handoffContract": "把任务拆成可执行步骤，并给出下一角色所需最小输入。",
                    "artifactTypes": ["plan", "task-outline"]
                },
                {
                    "roleId": "researcher",
                    "purpose": "负责检索知识、提取证据、整理素材、形成研究摘要。",
                    "systemPrompt": "你是研究代理，优先检索证据、阅读素材、提炼事实，不要在证据不足时强行下结论。",
                    "allowedToolPack": "knowledge",
                    "inputSchema": "问题、知识来源、素材、已有假设",
                    "outputSchema": "证据摘要、引用来源、结论边界、待验证点",
                    "handoffContract": "输出给写作者或评审时，必须包含证据、结论和不确定项。",
                    "artifactTypes": ["research-note", "evidence-summary"]
                },
                {
                    "roleId": "copywriter",
                    "purpose": "负责产出标题、正文、发布话术、完整稿件和成品文案。",
                    "systemPrompt": "你是写作代理，目标是生成可直接交付和落盘的内容，而不是停留在聊天草稿。",
                    "allowedToolPack": "redclaw",
                    "inputSchema": "目标、受众、策略、素材、证据",
                    "outputSchema": "完整稿件、标题包、标签、发布建议",
                    "handoffContract": "完成正文后必须准备保存路径或项目归档信息。",
                    "artifactTypes": ["manuscript", "title-pack", "copy-pack"]
                },
                {
                    "roleId": "image-director",
                    "purpose": "负责封面、配图、海报、图片策略和视觉执行指令。",
                    "systemPrompt": "你是图像策略代理，负责把目标转成可执行的配图/封面方案，并推动真实出图或落盘。",
                    "allowedToolPack": "redclaw",
                    "inputSchema": "内容目标、风格要求、参考素材、输出形式",
                    "outputSchema": "封面策略、图片提示词、视觉结构、保存方案",
                    "handoffContract": "给执行层的输出必须是可以直接生成或保存的结构化内容。",
                    "artifactTypes": ["image-plan", "cover-plan", "image-pack"]
                },
                {
                    "roleId": "reviewer",
                    "purpose": "负责校验结果是否符合需求、是否保存、是否存在幻觉或遗漏。",
                    "systemPrompt": "你是质量评审代理，优先检查结果是否满足需求、是否真实落盘、是否存在伪成功。",
                    "allowedToolPack": "redclaw",
                    "inputSchema": "目标、执行结果、工具回执、产物路径",
                    "outputSchema": "评审结论、问题列表、修正建议",
                    "handoffContract": "如果结果不满足交付条件，明确指出缺口并阻止宣称成功。",
                    "artifactTypes": ["review-report"]
                },
                {
                    "roleId": "ops-coordinator",
                    "purpose": "负责后台任务、自动化、记忆维护和持续执行任务的推进。",
                    "systemPrompt": "你是运行协调代理，负责长任务推进、自动化配置、状态检查、恢复和后台维护。",
                    "allowedToolPack": "redclaw",
                    "inputSchema": "任务目标、调度需求、运行状态、失败原因",
                    "outputSchema": "调度动作、运行状态、恢复策略、维护结论",
                    "handoffContract": "输出必须明确包含下一步执行条件与当前状态。",
                    "artifactTypes": ["automation-config", "ops-report"]
                }
            ])),
            "ai:detect-protocol" => {
                let base_url = payload_string(payload, "baseURL").unwrap_or_default();
                let preset_id = payload_string(payload, "presetId");
                let explicit = payload_string(payload, "protocol");
                let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
                Ok(json!({ "success": true, "protocol": protocol }))
            }
            "ai:test-connection" => {
                let base_url = payload_string(payload, "baseURL").unwrap_or_default();
                let api_key = payload_string(payload, "apiKey");
                let preset_id = payload_string(payload, "presetId");
                let explicit = payload_string(payload, "protocol");
                let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
                let models = maybe_filter_models_by_purpose(
                    fetch_models_by_protocol(&protocol, &base_url, api_key.as_deref())?,
                    payload_string(payload, "purpose").as_deref(),
                );
                Ok(json!({
                    "success": true,
                    "protocol": protocol,
                    "models": models,
                    "message": format!("连接成功，发现 {} 个模型", models.len())
                }))
            }
            "ai:fetch-models" => {
                let base_url = payload_string(payload, "baseURL").unwrap_or_default();
                let api_key = payload_string(payload, "apiKey");
                let preset_id = payload_string(payload, "presetId");
                let explicit = payload_string(payload, "protocol");
                let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
                let purpose = payload_string(payload, "purpose");
                Ok(json!(maybe_filter_models_by_purpose(
                    fetch_models_by_protocol(&protocol, &base_url, api_key.as_deref())?,
                    purpose.as_deref()
                )))
            }
            _ => unreachable!(),
        }
    })())
}
