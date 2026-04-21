use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    build_market_skill_record, build_user_skill_record, compute_skill_discovery_fingerprint,
    find_catalog_skill_by_name, merge_requested_skills_into_session, normalized_activation_scope,
    render_invoked_skill_bundle, skill_allows_runtime_mode, skill_catalog_changed,
    skills_catalog_list_value, SkillActivationSource,
};
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

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

fn merge_active_skill_into_session(
    state: &State<'_, AppState>,
    session_id: &str,
    skill_name: &str,
) -> Result<Vec<String>, String> {
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Err(format!("session not found: {session_id}"));
        };
        let active_skills = merge_requested_skills_into_session(
            session,
            &[skill_name.to_string()],
            SkillActivationSource::Explicit,
            "skills.invoke",
        );
        Ok(active_skills)
    })
}

fn effective_active_skill_names(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    skill_name: &str,
    activation_scope: &str,
) -> Result<(Vec<String>, bool), String> {
    if activation_scope == "turn" {
        return Ok((vec![skill_name.to_string()], false));
    }
    let active = if let Some(session_id) = session_id {
        merge_active_skill_into_session(state, session_id, skill_name)?
    } else {
        vec![skill_name.to_string()]
    };
    Ok((active, session_id.is_some()))
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
            | "skills:market-install"
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
                    Ok(skills_catalog_list_value(
                        &store.skills,
                        Some(discovery_fingerprint.as_str()),
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
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
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
                let workspace = workspace_root(state).ok();
                let (skill, runtime_mode) = with_store(state, |store| {
                    let runtime_mode = session_id
                        .as_deref()
                        .map(|value| {
                            super::chat_state::resolve_runtime_mode_for_session(&store, value)
                        })
                        .or_else(|| payload_string(payload, "runtimeMode"))
                        .unwrap_or_else(|| "default".to_string());
                    let Some(skill) = find_catalog_skill_by_name(&store.skills, &requested_name)
                    else {
                        return Err(format!("技能不存在: {requested_name}"));
                    };
                    Ok((skill, runtime_mode))
                })?;
                if skill.disabled {
                    return Err(format!("技能已禁用: {}", skill.name));
                }
                if !skill_allows_runtime_mode(&skill, &runtime_mode) {
                    return Err(format!(
                        "技能 `{}` 不允许在 runtime mode `{}` 中激活",
                        skill.name, runtime_mode
                    ));
                }
                let activation_scope =
                    normalized_activation_scope(skill.metadata.activation_scope.as_deref());
                let (active_skills, persisted_to_session) = effective_active_skill_names(
                    state,
                    session_id.as_deref(),
                    &skill.name,
                    activation_scope,
                )?;
                let _ = record_skill_invocation_metric(
                    state,
                    SkillInvocationMetric {
                        session_id: session_id.clone(),
                        runtime_mode: runtime_mode.clone(),
                        skill_name: skill.name.clone(),
                        activation_scope: activation_scope.to_string(),
                        persisted_to_session,
                        active_skill_count: active_skills.len() as i64,
                        elapsed_ms: now_ms().saturating_sub(started_at) as i64,
                        created_at: now_i64(),
                    },
                );
                log_timing_event(
                    state,
                    "skills",
                    &format!("skills:invoke:{}", skill.name),
                    "skills:invoke",
                    started_at,
                    Some(format!(
                        "runtimeMode={} activationScope={} activeSkills={} persistedToSession={}",
                        runtime_mode,
                        activation_scope,
                        active_skills.len(),
                        persisted_to_session
                    )),
                );
                let rendered = render_invoked_skill_bundle(&skill, workspace.as_deref());
                Ok(json!({
                    "success": true,
                    "action": "invoke",
                    "name": skill.name,
                    "description": skill.description,
                    "activationScope": activation_scope,
                    "persistedToSession": persisted_to_session,
                    "runtimeMode": runtime_mode,
                    "sessionId": session_id,
                    "activeSkills": active_skills,
                    "activatedSkill": rendered
                }))
            }
            "skills:create" => {
                let name = payload_string(payload, "name").unwrap_or_default();
                if name.is_empty() {
                    return Ok(json!({ "success": false, "error": "技能名称不能为空" }));
                }
                let created = with_store_mut(state, |store| {
                    let item = build_user_skill_record(&name);
                    store.skills.push(item.clone());
                    Ok(item)
                })?;
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                Ok(json!({ "success": true, "location": created.location }))
            }
            "skills:save" => {
                let location = payload_string(payload, "location").unwrap_or_default();
                let content = payload_string(payload, "content").unwrap_or_default();
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
                let created = with_store_mut(state, |store| {
                    let item = build_market_skill_record(&slug);
                    store.skills.push(item);
                    Ok(json!({ "success": true, "displayName": slug }))
                })?;
                let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                Ok(created)
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
