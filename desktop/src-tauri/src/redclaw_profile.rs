use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{AppState, now_iso, workspace_root};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RedclawProfilePromptBundle {
    pub(crate) profile_root: PathBuf,
    pub(crate) agent: String,
    pub(crate) soul: String,
    pub(crate) identity: String,
    pub(crate) user: String,
    pub(crate) creator_profile: String,
    pub(crate) bootstrap: String,
    pub(crate) onboarding_state: Value,
}

pub(crate) fn redclaw_profile_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("redclaw").join("profile");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(crate) fn ensure_file_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

pub(crate) fn read_text_if_exists(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn build_default_agent_profile_doc() -> String {
    [
        "# Agent.md",
        "",
        "你是 RedClaw，服务于 RedBox 的多平台内容创作执行 Agent。",
        "",
        "## 启动顺序（每次会话）",
        "1. 读取 Soul.md（你的行为风格）",
        "2. 读取 user.md（用户画像和创作目标）",
        "3. 读取 CreatorProfile.md（用户长期自媒体定位与策略档案）",
        "4. 读取 identity.md（你的身份设定）",
        "5. 读取 memory/MEMORY.md（长期记忆摘要）",
        "",
        "## RedClaw 规则",
        "- 先执行再解释，优先给出可落地动作。",
        "- 涉及本应用能力时优先调用 redbox_* 工具。",
        "- 文件操作严格限制在 currentSpaceRoot。",
        "- 对文件数量/列表/状态类事实，必须先工具验证。",
        "",
        "## 核心档案职责",
        "- Soul.md：维护 RedClaw 的协作语气、反馈方式、执行风格。",
        "- user.md：维护用户的稳定画像与长期事实。",
        "- CreatorProfile.md：维护用户的长期自媒体定位、目标群体、风格、商业目标与运营边界。",
        "- Agent.md：维护 RedClaw 的工作契约、流程和规则，不为一次性任务随意改写。",
        "",
        "## 创作流程",
        "目标 -> 选题 -> 文案 -> 配图 -> 发布计划 -> 数据复盘 -> 下一轮假设",
    ]
    .join("\n")
}

fn build_default_soul_profile_doc() -> String {
    [
        "# Soul.md",
        "",
        "## 核心人格",
        "- 行动导向，不空谈。",
        "- 对结果负责：每一步都给验收标准。",
        "- 风格务实、直接、尊重用户时间。",
        "",
        "## 表达风格",
        "- 默认中文。",
        "- 先结论后细节。",
        "- 优先给 checklist、步骤和可执行命令。",
        "",
        "## 什么时候更新本文件",
        "- 用户明确要求 RedClaw 改变沟通方式、反馈力度、协作氛围时更新。",
        "- 临时任务中的一句话语气要求，不默认升格为长期人格设定。",
    ]
    .join("\n")
}

fn build_default_identity_profile_doc() -> String {
    [
        "# identity.md",
        "",
        "- Name: RedClaw",
        "- Role: 多平台内容创作自动化 Agent",
        "- Vibe: 执行型、结构化、结果导向",
        "- Signature: 🦀",
        &format!("- UpdatedAt: {}", now_iso()),
    ]
    .join("\n")
}

fn build_default_user_profile_doc() -> String {
    [
        "# user.md",
        "",
        "## 用户创作档案（持续更新）",
        "- 称呼: （待填写）",
        "- 核心创作目标: （待填写）",
        "- 目标用户画像: （待填写）",
        "- 内容赛道: （待填写）",
        "- 文案风格偏好: （待填写）",
        "- 发布节奏: （待填写）",
        "- 成功指标: （待填写）",
        "",
        "## 备注",
        "- 本文件用于长期个性化，不存放敏感密钥。",
        "- 当用户长期目标、受众、节奏、赛道等稳定信息变化时更新本文件。",
    ]
    .join("\n")
}

fn build_default_creator_profile_doc() -> String {
    [
        "# CreatorProfile.md",
        "",
        "## 定位总览",
        "- 自媒体定位: （待填写，可包含小红书 / 公众号等平台）",
        "- 核心目标: （待填写）",
        "- 商业目标: （待填写）",
        "",
        "## 目标群体",
        "- 核心受众: （待填写）",
        "- 主要痛点: （待填写）",
        "- 愿意付费的原因: （待填写）",
        "",
        "## 内容风格",
        "- 内容赛道: （待填写）",
        "- 结构偏好: （待填写）",
        "- 文案风格: （待填写）",
        "- 封面/视觉倾向: （待填写）",
        "",
        "## 运营策略",
        "- 发布节奏: （待填写）",
        "- 成功指标: （待填写）",
        "- 禁区与边界: （待填写）",
        "",
        "## 维护规则",
        "- 本文档是用户长期自媒体策略档案，每次 RedClaw 会话都应优先参考。",
        "- 当用户明确给出新的定位、目标群体、风格、边界、商业目标时，应更新本文件。",
        "- 临时任务要求不直接改写长期定位，除非用户明确表示要长期变更。",
        "- 不记录 API Key、Token、账号密码等敏感信息。",
    ]
    .join("\n")
}

fn build_default_bootstrap_profile_doc() -> String {
    [
        "# BOOTSTRAP.md",
        "",
        "这是 RedClaw 在当前空间的首次设定引导。",
        "",
        "目标：通过聊天收集用户偏好，完善以下文件：",
        "- identity.md",
        "- user.md",
        "- Soul.md",
        "- CreatorProfile.md",
        "",
        "完成后删除 BOOTSTRAP.md。",
    ]
    .join("\n")
}

fn default_onboarding_state_value() -> Value {
    json!({
        "version": 1,
        "startedAt": Value::Null,
        "updatedAt": now_iso(),
        "askedFirstQuestion": false,
        "stepIndex": 0,
        "answers": {}
    })
}

const REDCLAW_ONBOARDING_STEPS: [(&str, &str, &str); 5] = [
    (
        "assistant_style",
        "1/5 先定一下我的协作风格。你希望 RedClaw 在对话里更偏向哪种风格？例如：高执行、强结构、温和陪跑、直接批判。",
        "高执行 + 强结构 + 直接反馈",
    ),
    (
        "creator_goal",
        "2/5 你的核心创作目标是什么？例如：涨粉、获客、卖课、品牌影响力。可以写主目标 + 次目标。",
        "主目标：稳定涨粉；次目标：建立可信个人品牌",
    ),
    (
        "target_audience",
        "3/5 你的目标用户是谁？请描述人群画像（年龄/职业/痛点/预算/期待）。",
        "25-35岁的一线和新一线职场人，关注效率、成长和副业机会",
    ),
    (
        "content_lane",
        "4/5 你主要做哪些内容赛道？以及偏好的笔记结构（如：清单体、教程体、案例体、复盘体）。",
        "AI效率工具 + 职场成长；偏好教程体和复盘体",
    ),
    (
        "tone_and_constraints",
        "5/5 最后确认表达风格和边界：你希望文案语气、禁用词、合规边界、发布频率、成功指标分别是什么？",
        "语气真实克制；避免夸张承诺；每周3-5篇；成功指标看收藏率与私信转化",
    ),
];

fn redclaw_onboarding_state_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(redclaw_profile_root(state)?.join("onboarding-state.json"))
}

pub(crate) fn load_redclaw_onboarding_state(state: &State<'_, AppState>) -> Result<Value, String> {
    ensure_redclaw_profile_files(state)?;
    let path = redclaw_onboarding_state_path(state)?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(default_onboarding_state_value))
}

fn save_redclaw_onboarding_state(state: &State<'_, AppState>, data: &Value) -> Result<(), String> {
    let mut next = data.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert("updatedAt".to_string(), json!(now_iso()));
    }
    let raw = serde_json::to_string_pretty(&next).map_err(|error| error.to_string())?;
    fs::write(redclaw_onboarding_state_path(state)?, raw).map_err(|error| error.to_string())
}

fn normalize_onboarding_answer(input: &str) -> String {
    input.trim().to_string()
}

fn is_redclaw_onboarding_skip_command(input: &str) -> bool {
    let normalized = normalize_onboarding_answer(input).to_lowercase();
    ["跳过", "先跳过", "使用默认", "默认", "/skip", "skip"].contains(&normalized.as_str())
}

fn get_onboarding_answer(state_value: &Value, key: &str, fallback: &str) -> String {
    state_value
        .get("answers")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
        .map(normalize_onboarding_answer)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn finalize_redclaw_onboarding(
    state: &State<'_, AppState>,
    onboarding: &mut Value,
) -> Result<(), String> {
    let style = get_onboarding_answer(
        onboarding,
        REDCLAW_ONBOARDING_STEPS[0].0,
        REDCLAW_ONBOARDING_STEPS[0].2,
    );
    let goal = get_onboarding_answer(
        onboarding,
        REDCLAW_ONBOARDING_STEPS[1].0,
        REDCLAW_ONBOARDING_STEPS[1].2,
    );
    let audience = get_onboarding_answer(
        onboarding,
        REDCLAW_ONBOARDING_STEPS[2].0,
        REDCLAW_ONBOARDING_STEPS[2].2,
    );
    let lane = get_onboarding_answer(
        onboarding,
        REDCLAW_ONBOARDING_STEPS[3].0,
        REDCLAW_ONBOARDING_STEPS[3].2,
    );
    let constraints = get_onboarding_answer(
        onboarding,
        REDCLAW_ONBOARDING_STEPS[4].0,
        REDCLAW_ONBOARDING_STEPS[4].2,
    );

    let identity = [
        "# identity.md".to_string(),
        "".to_string(),
        "- Name: RedClaw".to_string(),
        "- Role: 小红书创作自动化 Agent".to_string(),
        format!("- Vibe: {style}"),
        "- Signature: 🦀".to_string(),
        format!("- UpdatedAt: {}", now_iso()),
    ]
    .join("\n");
    let user = [
        "# user.md".to_string(),
        "".to_string(),
        "## 用户创作档案".to_string(),
        format!("- 核心创作目标: {goal}"),
        format!("- 目标用户画像: {audience}"),
        format!("- 内容赛道与结构偏好: {lane}"),
        format!("- 语气/边界/节奏/指标: {constraints}"),
        "".to_string(),
        "## 更新原则".to_string(),
        "- 当用户提出新的长期偏好时，及时覆盖旧偏好。".to_string(),
        "- 当用户临时任务与长期偏好冲突，以用户最新明确指令优先。".to_string(),
    ]
    .join("\n");
    let soul = [
        "# Soul.md".to_string(),
        "".to_string(),
        "## 当前人格与协作偏好（来自首次设定）".to_string(),
        format!("- 协作风格: {style}"),
        "".to_string(),
        "## 执行原则".to_string(),
        "- 先明确目标，再拆解步骤。".to_string(),
        "- 每一步要有“产物”和“下一步动作”。".to_string(),
        "- 对小红书创作要关注内容价值、可传播性、合规性。".to_string(),
        "- 不臆测文件状态；先工具验证再回答。".to_string(),
    ]
    .join("\n");
    let creator_profile = [
        "# CreatorProfile.md".to_string(),
        "".to_string(),
        "## 定位总览".to_string(),
        "- 自媒体定位: 小红书创作与增长".to_string(),
        format!("- 核心目标: {goal}"),
        "- 商业目标: 建立可信个人品牌并逐步提升转化".to_string(),
        "".to_string(),
        "## 目标群体".to_string(),
        format!("- 核心受众: {audience}"),
        "- 主要痛点: 需要明确选题、结构化内容与持续更新节奏".to_string(),
        "- 愿意付费的原因: 需要可执行的方法、模板和复盘体系".to_string(),
        "".to_string(),
        "## 内容风格".to_string(),
        format!("- 内容赛道: {lane}"),
        format!("- 文案风格: {style}"),
        format!("- 执行边界: {constraints}"),
        "- 封面/视觉倾向: 优先真实、清晰、可点击，不做廉价夸张风".to_string(),
        "".to_string(),
        "## 运营策略".to_string(),
        "- 发布节奏: 以后续用户明确更新为准".to_string(),
        "- 成功指标: 以收藏率、互动率、私信转化等业务指标为准".to_string(),
        "- 禁区与边界: 不夸大、不虚假承诺、不违反平台合规".to_string(),
        "".to_string(),
        format!("- UpdatedAt: {}", now_iso()),
    ]
    .join("\n");

    let profile_root = redclaw_profile_root(state)?;
    fs::write(profile_root.join("identity.md"), identity).map_err(|error| error.to_string())?;
    fs::write(profile_root.join("user.md"), user).map_err(|error| error.to_string())?;
    fs::write(profile_root.join("Soul.md"), soul).map_err(|error| error.to_string())?;
    fs::write(profile_root.join("CreatorProfile.md"), creator_profile)
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(profile_root.join("BOOTSTRAP.md"));

    if let Some(object) = onboarding.as_object_mut() {
        object.insert(
            "stepIndex".to_string(),
            json!(REDCLAW_ONBOARDING_STEPS.len() as i64),
        );
        object.insert("completedAt".to_string(), json!(now_iso()));
    }
    save_redclaw_onboarding_state(state, onboarding)?;
    Ok(())
}

pub(crate) fn handle_redclaw_onboarding_turn(
    state: &State<'_, AppState>,
    user_input: &str,
) -> Result<Option<(String, bool)>, String> {
    ensure_redclaw_profile_files(state)?;
    let mut onboarding = load_redclaw_onboarding_state(state)?;
    let completed = onboarding
        .get("completedAt")
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if completed {
        return Ok(None);
    }

    let asked_first_question = onboarding
        .get("askedFirstQuestion")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let mut step_index = onboarding
        .get("stepIndex")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        .clamp(0, REDCLAW_ONBOARDING_STEPS.len() as i64);
    if !asked_first_question {
        if let Some(object) = onboarding.as_object_mut() {
            object.insert("askedFirstQuestion".to_string(), json!(true));
            if object
                .get("startedAt")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                object.insert("startedAt".to_string(), json!(now_iso()));
            }
            object.insert("stepIndex".to_string(), json!(0));
        }
        save_redclaw_onboarding_state(state, &onboarding)?;
        return Ok(Some((
            [
                "在开始创作前，我们先做一次 RedClaw 个性化设定（只需 1-2 分钟）。",
                REDCLAW_ONBOARDING_STEPS[0].1,
                "",
                "你也可以回复“跳过”使用默认配置，后续随时可再改。",
            ]
            .join("\n"),
            false,
        )));
    }

    let normalized = normalize_onboarding_answer(user_input);
    if normalized.is_empty() {
        let idx = step_index.clamp(0, REDCLAW_ONBOARDING_STEPS.len() as i64 - 1) as usize;
        return Ok(Some((
            format!(
                "我需要你先回答这个设定问题：\n{}",
                REDCLAW_ONBOARDING_STEPS[idx].1
            ),
            false,
        )));
    }

    if is_redclaw_onboarding_skip_command(&normalized) {
        if let Some(object) = onboarding.as_object_mut() {
            let answers = object
                .entry("answers".to_string())
                .or_insert_with(|| json!({}));
            if let Some(answers_obj) = answers.as_object_mut() {
                for (key, _question, default_value) in REDCLAW_ONBOARDING_STEPS {
                    let current = answers_obj
                        .get(key)
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if current.is_empty() {
                        answers_obj.insert(key.to_string(), json!(default_value));
                    }
                }
            }
            object.insert(
                "stepIndex".to_string(),
                json!(REDCLAW_ONBOARDING_STEPS.len() as i64),
            );
        }
        finalize_redclaw_onboarding(state, &mut onboarding)?;
        return Ok(Some((
            "已按默认配置完成 RedClaw 设定，并写入当前空间档案。现在可以直接给我创作目标。"
                .to_string(),
            true,
        )));
    }

    if let Some(object) = onboarding.as_object_mut() {
        let answers = object
            .entry("answers".to_string())
            .or_insert_with(|| json!({}));
        if let Some(answers_obj) = answers.as_object_mut() {
            let idx = step_index.clamp(0, REDCLAW_ONBOARDING_STEPS.len() as i64 - 1) as usize;
            let key = REDCLAW_ONBOARDING_STEPS[idx].0;
            answers_obj.insert(key.to_string(), json!(normalized));
        }
        step_index = (step_index + 1).clamp(0, REDCLAW_ONBOARDING_STEPS.len() as i64);
        object.insert("stepIndex".to_string(), json!(step_index));
    }

    if step_index >= REDCLAW_ONBOARDING_STEPS.len() as i64 {
        finalize_redclaw_onboarding(state, &mut onboarding)?;
        return Ok(Some((
            "设定完成。我已经更新了 Agent/Soul/identity/user/CreatorProfile 档案。接下来直接告诉我你的创作目标即可。".to_string(),
            true,
        )));
    }

    save_redclaw_onboarding_state(state, &onboarding)?;
    let next_idx = step_index as usize;
    Ok(Some((
        [
            format!(
                "已记录（{}/{})。",
                step_index,
                REDCLAW_ONBOARDING_STEPS.len()
            ),
            REDCLAW_ONBOARDING_STEPS[next_idx].1.to_string(),
            "".to_string(),
            "你也可以回复“跳过”直接使用默认配置。".to_string(),
        ]
        .join("\n"),
        false,
    )))
}

pub(crate) fn ensure_redclaw_onboarding_completed_with_defaults(
    state: &State<'_, AppState>,
) -> Result<bool, String> {
    ensure_redclaw_profile_files(state)?;
    let mut onboarding = load_redclaw_onboarding_state(state)?;
    let completed = onboarding
        .get("completedAt")
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if completed {
        return Ok(false);
    }

    if let Some(object) = onboarding.as_object_mut() {
        let answers = object
            .entry("answers".to_string())
            .or_insert_with(|| json!({}));
        if let Some(answers_obj) = answers.as_object_mut() {
            for (key, _question, default_value) in REDCLAW_ONBOARDING_STEPS {
                let current = answers_obj
                    .get(key)
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if current.is_empty() {
                    answers_obj.insert(key.to_string(), json!(default_value));
                }
            }
        }
        object.insert("askedFirstQuestion".to_string(), json!(true));
        object.insert(
            "stepIndex".to_string(),
            json!(REDCLAW_ONBOARDING_STEPS.len() as i64),
        );
        object.insert("completedAt".to_string(), json!(now_iso()));
    }

    save_redclaw_onboarding_state(state, &onboarding)?;
    let profile_root = redclaw_profile_root(state)?;
    let _ = fs::remove_file(profile_root.join("BOOTSTRAP.md"));
    Ok(true)
}

pub(crate) fn ensure_redclaw_profile_files(state: &State<'_, AppState>) -> Result<(), String> {
    let profile_root = redclaw_profile_root(state)?;
    let agent_path = profile_root.join("Agent.md");
    let soul_path = profile_root.join("Soul.md");
    let identity_path = profile_root.join("identity.md");
    let user_path = profile_root.join("user.md");
    let creator_path = profile_root.join("CreatorProfile.md");
    let bootstrap_path = profile_root.join("BOOTSTRAP.md");
    let onboarding_path = profile_root.join("onboarding-state.json");

    ensure_file_if_missing(&agent_path, &build_default_agent_profile_doc())?;
    ensure_file_if_missing(&soul_path, &build_default_soul_profile_doc())?;
    ensure_file_if_missing(&identity_path, &build_default_identity_profile_doc())?;
    ensure_file_if_missing(&user_path, &build_default_user_profile_doc())?;
    ensure_file_if_missing(&creator_path, &build_default_creator_profile_doc())?;
    ensure_file_if_missing(
        &onboarding_path,
        &serde_json::to_string_pretty(&default_onboarding_state_value())
            .unwrap_or_else(|_| "{}".to_string()),
    )?;

    let onboarding_state = fs::read_to_string(&onboarding_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(default_onboarding_state_value);
    let completed = onboarding_state
        .get("completedAt")
        .and_then(|value| value.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if completed {
        let _ = fs::remove_file(&bootstrap_path);
    } else {
        ensure_file_if_missing(&bootstrap_path, &build_default_bootstrap_profile_doc())?;
    }

    Ok(())
}

pub(crate) fn load_redclaw_profile_prompt_bundle(
    state: &State<'_, AppState>,
) -> Result<RedclawProfilePromptBundle, String> {
    ensure_redclaw_profile_files(state)?;
    let profile_root = redclaw_profile_root(state)?;
    let onboarding_state = fs::read_to_string(profile_root.join("onboarding-state.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(default_onboarding_state_value);

    Ok(RedclawProfilePromptBundle {
        profile_root: profile_root.clone(),
        agent: read_text_if_exists(&profile_root.join("Agent.md")),
        soul: read_text_if_exists(&profile_root.join("Soul.md")),
        identity: read_text_if_exists(&profile_root.join("identity.md")),
        user: read_text_if_exists(&profile_root.join("user.md")),
        creator_profile: read_text_if_exists(&profile_root.join("CreatorProfile.md")),
        bootstrap: read_text_if_exists(&profile_root.join("BOOTSTRAP.md")),
        onboarding_state,
    })
}

pub(crate) fn profile_doc_target(doc_type: &str) -> Option<(&'static str, &'static str)> {
    match doc_type {
        "agent" => Some(("Agent.md", "Agent.md")),
        "soul" => Some(("Soul.md", "Soul.md")),
        "user" => Some(("user.md", "user.md")),
        "creator_profile" => Some(("CreatorProfile.md", "CreatorProfile.md")),
        _ => None,
    }
}

fn normalize_profile_doc_markdown(title: &str, markdown: &str) -> Result<String, String> {
    let normalized = markdown.trim();
    if normalized.is_empty() {
        return Err(format!("{title} 文档不能为空"));
    }
    if normalized.starts_with('#') {
        Ok(normalized.to_string())
    } else {
        Ok(format!("# {title}\n\n{normalized}"))
    }
}

pub(crate) fn update_redclaw_profile_doc(
    state: &State<'_, AppState>,
    doc_type: &str,
    markdown: &str,
) -> Result<Value, String> {
    let Some((file_name, title)) = profile_doc_target(doc_type) else {
        return Err(format!("unsupported profile doc type: {doc_type}"));
    };
    ensure_redclaw_profile_files(state)?;
    let profile_root = redclaw_profile_root(state)?;
    let file_path = profile_root.join(file_name);
    let content = normalize_profile_doc_markdown(title, markdown)?;
    fs::write(&file_path, &content).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "docType": doc_type,
        "fileName": file_name,
        "path": file_path.display().to_string(),
        "content": content
    }))
}
