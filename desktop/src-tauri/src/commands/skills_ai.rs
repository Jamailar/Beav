use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    build_skill_template_markdown, compute_skill_discovery_fingerprint, invoke_skill_value,
    preview_skill_activation_value, resolve_skill_records, skill_catalog_changed,
    skills_catalog_list_value,
};
use crate::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

fn build_skill_usage_map(store: &AppStore) -> serde_json::Map<String, Value> {
    let mut counts = BTreeMap::<String, (usize, Option<i64>)>::new();
    for checkpoint in &store.session_checkpoints {
        if checkpoint.checkpoint_type != "chat.skill_activated" {
            continue;
        }
        let Some(skill_name) = checkpoint
            .payload
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let entry = counts
            .entry(skill_name.to_ascii_lowercase())
            .or_insert((0, None));
        entry.0 += 1;
        entry.1 = Some(entry.1.map(|value| value.max(checkpoint.created_at)).unwrap_or(checkpoint.created_at));
    }
    counts
        .into_iter()
        .map(|(key, (usage_count, last_used_at))| {
            (
                key,
                json!({
                    "usageCount": usage_count,
                    "lastUsedAt": last_used_at,
                }),
            )
        })
        .collect()
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("invalid path".to_string());
    };
    fs::create_dir_all(parent).map_err(|error| error.to_string())
}

fn default_create_root(state: &State<'_, AppState>) -> PathBuf {
    workspace_root(state)
        .map(|root| root.join("skills"))
        .unwrap_or_else(|_| lexbox_project_root().join("skills"))
}

fn resolve_skill_file_path(location: &str) -> PathBuf {
    let path = PathBuf::from(location);
    if path.is_file() {
        return path;
    }
    path
}

fn write_skill_file(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn upsert_frontmatter_bool(body: &str, key: &str, value: bool) -> String {
    let line = format!("{key}: {}", if value { "true" } else { "false" });
    if let Some(rest) = body.strip_prefix("---\n") {
        if let Some((frontmatter, content)) = rest.split_once("\n---\n") {
            let mut updated = Vec::<String>::new();
            let mut replaced = false;
            for item in frontmatter.lines() {
                let trimmed = item.trim();
                if trimmed.to_ascii_lowercase().starts_with(&format!("{}:", key.to_ascii_lowercase())) {
                    updated.push(line.clone());
                    replaced = true;
                } else {
                    updated.push(item.to_string());
                }
            }
            if !replaced {
                updated.push(line);
            }
            return format!("---\n{}\n---\n{}", updated.join("\n"), content);
        }
    }
    format!("---\n{line}\n---\n{}", body.trim())
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
            | "skills:create"
            | "skills:save"
            | "skills:disable"
            | "skills:enable"
            | "skills:market-install"
            | "skills:invoke"
            | "skills:preview-activation"
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
                let workspace = workspace_root(state).ok();
                let discovery_fingerprint =
                    compute_skill_discovery_fingerprint(workspace.as_deref());
                let (list, watcher_snapshot) = with_store(state, |store| {
                    let resolved = resolve_skill_records(&store.skills, workspace.as_deref());
                    let usage = build_skill_usage_map(&store);
                    let (list, watcher) =
                        skills_catalog_list_value(&resolved, Some(discovery_fingerprint.as_str()));
                    let enriched = list
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|item| {
                            let mut object = item.as_object().cloned().unwrap_or_default();
                            let name = object
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_ascii_lowercase();
                            if let Some(usage_value) = usage.get(&name) {
                                object.insert("usage".to_string(), usage_value.clone());
                            }
                            Value::Object(object)
                        })
                        .collect::<Vec<_>>();
                    Ok((Value::Array(enriched), watcher))
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
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                }
                Ok(list)
            }
            "skills:create" => {
                let name = payload_string(payload, "name").unwrap_or_default();
                if name.is_empty() {
                    return Ok(json!({ "success": false, "error": "技能名称不能为空" }));
                }
                let root = default_create_root(state);
                let slug = slug_from_relative_path(&name);
                let skill_file = root.join(&slug).join("SKILL.md");
                if skill_file.exists() {
                    return Ok(json!({ "success": false, "error": "技能已存在" }));
                }
                write_skill_file(
                    &skill_file,
                    &build_skill_template_markdown(&name, false, ""),
                )?;
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                Ok(json!({ "success": true, "location": skill_file.display().to_string() }))
            }
            "skills:save" => {
                let location = payload_string(payload, "location").unwrap_or_default();
                let content = payload_string(payload, "content").unwrap_or_default();
                let path = resolve_skill_file_path(&location);
                if path.is_absolute() || path.exists() {
                    write_skill_file(&path, &content)?;
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                    return Ok(json!({ "success": true }));
                }
                with_store_mut(state, |store| {
                    let Some(skill) = store
                        .skills
                        .iter_mut()
                        .find(|item| item.location == location)
                    else {
                        return Ok(json!({ "success": false, "error": "技能不存在" }));
                    };
                    skill.body = content;
                    Ok(json!({ "success": true }))
                })
                .map(|value| {
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                    value
                })
            }
            "skills:disable" | "skills:enable" => {
                let name = payload_string(payload, "name").unwrap_or_default();
                let disabled = channel == "skills:disable";
                let workspace = workspace_root(state).ok();
                let resolved = with_store(state, |store| {
                    Ok(resolve_skill_records(&store.skills, workspace.as_deref()))
                })?;
                if let Some(skill) = resolved
                    .iter()
                    .find(|item| item.name.eq_ignore_ascii_case(&name))
                {
                    let path = resolve_skill_file_path(&skill.location);
                    if path.is_absolute() || path.exists() {
                        let body = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                        write_skill_file(&path, &upsert_frontmatter_bool(&body, "disabled", disabled))?;
                        let _ =
                            refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                        return Ok(json!({ "success": true }));
                    }
                }
                with_store_mut(state, |store| {
                    let Some(skill) = store.skills.iter_mut().find(|item| item.name == name) else {
                        return Ok(json!({ "success": false, "error": "技能不存在" }));
                    };
                    skill.disabled = Some(disabled);
                    Ok(json!({ "success": true }))
                })
                .map(|value| {
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                    value
                })
            }
            "skills:market-install" => {
                let slug = payload_string(payload, "slug").unwrap_or_default();
                if slug.is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少技能 slug" }));
                }
                let root = dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".codex")
                    .join("skills");
                let skill_file = root
                    .join(slug_from_relative_path(&slug))
                    .join("SKILL.md");
                write_skill_file(
                    &skill_file,
                    &build_skill_template_markdown(&slug, true, "Installed from market."),
                )?;
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                Ok(json!({
                    "success": true,
                    "displayName": slug,
                    "location": skill_file.display().to_string()
                }))
            }
            "skills:invoke" => {
                let name = payload_string(payload, "name").unwrap_or_default();
                if name.trim().is_empty() {
                    return Ok(json!({ "success": false, "error": "缺少技能名称" }));
                }
                let workspace = workspace_root(state).ok();
                with_store(state, |store| {
                    invoke_skill_value(
                        &store.skills,
                        workspace.as_deref(),
                        &name,
                        payload_string(payload, "args").as_deref(),
                    )
                })
            }
            "skills:preview-activation" => {
                let runtime_mode =
                    payload_string(payload, "runtimeMode").unwrap_or_else(|| "default".to_string());
                let workspace = workspace_root(state).ok();
                with_store(state, |store| {
                    Ok(preview_skill_activation_value(
                        &store.skills,
                        workspace.as_deref(),
                        &runtime_mode,
                        payload_field(payload, "metadata"),
                        Some(&crate::skills::SkillActivationContext {
                            current_message: payload_string(payload, "message"),
                            intent: payload_string(payload, "intent"),
                            touched_paths: payload_field(payload, "touchedPaths")
                                .and_then(Value::as_array)
                                .map(|items| {
                                    items.iter()
                                        .filter_map(Value::as_str)
                                        .map(ToString::to_string)
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default(),
                            args: payload_string(payload, "args"),
                        }),
                    ))
                })
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
                let models = fetch_models_by_protocol(&protocol, &base_url, api_key.as_deref())?;
                Ok(json!({
                    "success": true,
                    "protocol": protocol,
                    "message": format!("连接成功，发现 {} 个模型", models.len())
                }))
            }
            "ai:fetch-models" => {
                let base_url = payload_string(payload, "baseURL").unwrap_or_default();
                let api_key = payload_string(payload, "apiKey");
                let preset_id = payload_string(payload, "presetId");
                let explicit = payload_string(payload, "protocol");
                let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
                Ok(json!(fetch_models_by_protocol(
                    &protocol,
                    &base_url,
                    api_key.as_deref()
                )?))
            }
            _ => unreachable!(),
        }
    })())
}
