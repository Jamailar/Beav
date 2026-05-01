use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use crate::agent::{execute_prepared_session_agent_turn, PreparedSessionAgentTurn, RedclawRunTurn};
use crate::skills::{
    build_workspace_skill_record, refresh_skill_store_catalog, resolve_skill_file_path,
    write_skill_record_to_path,
};
use crate::{
    now_iso, refresh_runtime_warm_state, slug_from_relative_path, workspace_root, AppState,
};

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

const REDCLAW_ONBOARDING_FLOW_MODE_SCREEN: &str = "screen-flow";
const REDCLAW_ONBOARDING_SCREEN_STEP_COUNT: i64 = 10;

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
        "- 先判断工作形态：默认由 RedClaw 自己直接完成；只有任务明显需要研究、选题、文案、媒体、发布、质检等多角色接力时，才自动激活临时团队。",
        "- 问候、确认、状态查询、简单改写、简单标题/标签/封面文案、小段创作、单一文件微调，都不要组队，直接在当前对话中完成。",
        "- 用户明确要求端到端、多交付物、素材/知识检索、配图/视频、发布包、合规复核、复盘学习或多 Agent 协作时，再由 RedClaw 自己决定团队成员和任务分配。",
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

fn build_default_space_writing_style_skill_doc() -> String {
    [
        "---",
        "description: 当前空间的默认写作风格指导模板，后续会被风格初始化结果覆盖或细化。",
        "allowedRuntimeModes: [wander, redclaw, chatroom]",
        "hookMode: inline",
        "autoActivate: false",
        "activationScope: turn",
        "contextNote: 当前空间提供一份默认 writing-style 模板，必要时可按需激活。完成风格初始化后，这份技能会升级为该空间的专属写作规则。",
        "promptPrefix: 当当前任务明确是写作、改写、润色或选题 framing 时，再应用这份默认 writing-style；若用户尚未完成风格初始化，先按这份基础模板写，保持真实、具体、克制、可执行。",
        "promptSuffix: 如果当前任务不是写作，不要让 writing-style 主导其他决策；如果当前任务是写作，标题、正文、CTA 都要先遵守这份默认模板。标题控制在 20 个汉字以内，禁止模板化 AI 文案、编造经历和非正文占位标记。",
        "maxPromptChars: 2400",
        "---",
        "# Writing Style",
        "",
        "这是当前空间创建时自动生成的默认写作风格指导模板。它不是最终风格画像，只是当前空间在正式初始化前的基础写作底盘。",
        "",
        "## 当前状态",
        "- 这是默认模板，不代表已经完成风格初始化。",
        "- 一旦用户完成风格初始化表单，这份技能应当被当前空间的专属写作规则覆盖。",
        "- 如果用户在真实创作中持续纠偏，也应当继续更新这份空间级技能。",
        "",
        "## 默认写作原则",
        "- 像活人说话，不写报告腔、培训腔、客服腔。",
        "- 标题默认控制在 20 个汉字以内，先追求具体、清楚、有人味。",
        "- 先给判断、场景或问题，再展开解释，不要一上来空讲大道理。",
        "- 没有真实细节时，不要硬装第一手经历或情绪。",
        "- 写正文时避免机械小标题堆砌，优先自然推进和清楚结构。",
        "- 如果任务涉及转化，也先保证内容本身有真实信息量。",
        "",
        "## 默认禁区",
        "- 禁用“首先、其次、最后”“综上所述”“值得注意的是”“让我们来看看”。",
        "- 禁用“本质上”“换句话说”“不可否认”“说白了”“这意味着”。",
        "- 禁止编造案例、数据、用户反馈和个人经历。",
        "- 禁止输出控制字符、孤立分隔线或非正文占位标记。",
        "",
        "## 初始化提示",
        "- 如果用户明确要求定义空间风格，应优先引导完成风格初始化流程。",
        "- 初始化完成后，这份默认模板应被当前空间的专属写作风格替换。",
    ]
    .join("\n")
}

fn default_onboarding_state_value() -> Value {
    json!({
        "version": 2,
        "flowMode": REDCLAW_ONBOARDING_FLOW_MODE_SCREEN,
        "startedAt": Value::Null,
        "updatedAt": now_iso(),
        "askedFirstQuestion": false,
        "stepIndex": 0,
        "answers": {},
        "uiFlow": {
            "version": "mvp-v1",
            "draft": {
                "stepIndex": 0,
                "answers": {}
            },
            "summary": Value::Null
        }
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

fn redclaw_style_profile_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(redclaw_profile_root(state)?.join("style-profile.json"))
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

pub(crate) fn load_redclaw_style_profile(state: &State<'_, AppState>) -> Result<Value, String> {
    ensure_redclaw_profile_files(state)?;
    let path = redclaw_style_profile_path(state)?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({})))
}

fn save_redclaw_style_profile(state: &State<'_, AppState>, data: &Value) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
    fs::write(redclaw_style_profile_path(state)?, raw).map_err(|error| error.to_string())
}

fn normalize_screen_answers(input: &Value) -> Value {
    match input {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({}),
    }
}

fn screen_answer_percent(answers: &Value, key: &str, fallback: i64) -> i64 {
    answers
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(0, 100)
}

fn screen_answer_string(answers: &Value, key: &str, fallback: &str) -> String {
    answers
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn percent_dual_label(value: i64, low_label: &str, high_label: &str) -> String {
    format!("{low_label} {} / {high_label} {}", 100 - value, value)
}

fn label_content_vs_commerce(value: i64) -> &'static str {
    match value {
        0..=20 => "强内容导向",
        21..=40 => "内容优先",
        41..=60 => "内容与商业平衡",
        61..=80 => "商业优先",
        _ => "强商业导向",
    }
}

fn label_persona_vs_brand(value: i64) -> &'static str {
    match value {
        0..=20 => "强品牌驱动",
        21..=40 => "品牌略优先",
        41..=60 => "人设与品牌平衡",
        61..=80 => "人设略优先",
        _ => "强人设驱动",
    }
}

fn label_consistency_vs_virality(value: i64) -> &'static str {
    match value {
        0..=20 => "长期一致性优先",
        21..=40 => "一致性略优先",
        41..=60 => "一致性与爆发力平衡",
        61..=80 => "爆发力略优先",
        _ => "爆发力优先",
    }
}

fn label_authority(value: i64) -> &'static str {
    match value {
        0..=20 => "亲近自然",
        21..=40 => "亲近但有判断",
        41..=60 => "专业与亲近平衡",
        61..=80 => "偏专业判断",
        _ => "强专业判断",
    }
}

fn label_emotion(value: i64) -> &'static str {
    match value {
        0..=20 => "极冷静",
        21..=40 => "偏冷静",
        41..=60 => "冷静与感染平衡",
        61..=80 => "偏有感染力",
        _ => "强情绪感染",
    }
}

fn label_sales(value: i64) -> &'static str {
    match value {
        0..=20 => "极弱转化",
        21..=40 => "偏隐性转化",
        41..=60 => "中性转化",
        61..=80 => "偏显性转化",
        _ => "强转化导向",
    }
}

fn label_structure(value: i64) -> (&'static str, &'static str) {
    match value {
        0..=20 => ("story", "偏故事表达"),
        21..=40 => ("story", "故事略优先"),
        41..=60 => ("balanced", "框架与故事平衡"),
        61..=80 => ("framework", "框架略优先"),
        _ => ("framework", "偏框架拆解"),
    }
}

fn label_opening_style(value: &str) -> (&'static str, &'static str) {
    match value {
        "observational" => ("observational", "偏观察式开头"),
        _ => ("hook", "偏强判断钩子"),
    }
}

fn label_primary_model(value: &str) -> (&'static str, &'static str) {
    match value {
        "persona-commerce" => ("persona-commerce", "人设带货"),
        "brand-commerce" => ("brand-commerce", "品牌带货"),
        "service-conversion" => ("service-conversion", "高客单服务转化"),
        _ => ("content-account", "纯内容账号"),
    }
}

fn label_role_position(value: &str) -> (&'static str, &'static str) {
    match value {
        "experienced" => ("experienced", "有经验的过来人"),
        "experimenter" => ("experimenter", "真实试错者"),
        "founder" => ("founder", "品牌主理人"),
        _ => ("advisor", "专业顾问"),
    }
}

fn humanize_primary_model(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains('-') {
        return label_primary_model(trimmed).1.to_string();
    }
    if trimmed.is_empty() {
        "纯内容账号".to_string()
    } else {
        trimmed.to_string()
    }
}

fn humanize_role_position(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains('-')
        || matches!(
            trimmed,
            "advisor" | "experienced" | "experimenter" | "founder"
        )
    {
        return label_role_position(trimmed).1.to_string();
    }
    if trimmed.is_empty() {
        "专业顾问".to_string()
    } else {
        trimmed.to_string()
    }
}

fn writing_direction_rule(
    content_vs_commerce: i64,
    sales_explicitness: i64,
    primary_model_label: &str,
) -> Vec<String> {
    if content_vs_commerce >= 70 {
        return vec![
            "商业优先。默认先明确用户问题、产品适配关系和行动方向，不要把价值内容和转化完全拆开。".to_string(),
            format!(
                "经营模式按 `{primary_model_label}` 理解，正文里允许更早出现产品、服务或成交线索，但仍要给足用户判断依据。"
            ),
            if sales_explicitness >= 70 {
                "CTA 可以明确，直接写清楚适合谁、为什么现在行动、下一步怎么做。".to_string()
            } else {
                "即使整体偏商业，也不要整篇只剩推销，必须保留可信的信息量和判断过程。".to_string()
            },
        ];
    }
    if content_vs_commerce <= 30 {
        return vec![
            "内容优先。先解决问题、提供判断或建立认知，再考虑露出产品与服务。".to_string(),
            "不要为了转化打断阅读体验，商业信息默认后置或弱化为补充说明。".to_string(),
            "默认把收藏、停留、关注和信任积累放在成交前面。".to_string(),
        ];
    }
    vec![
        "内容与商业并重。每条内容既要有真实信息量，也要让商业目标自然可见。".to_string(),
        "不要把价值段和销售段完全割裂，正文里要能看出这条内容为什么最终会导向转化。".to_string(),
        "CTA 可以出现，但要建立在前文已经给足判断依据的前提上。".to_string(),
    ]
}

fn trust_source_rule(persona_vs_brand: i64, role_position_label: &str) -> Vec<String> {
    if persona_vs_brand >= 70 {
        return vec![
            "信任主要来自“你是谁、你怎么判断”。允许更多第一人称判断、取舍标准和个人视角。".to_string(),
            format!("对外角色按 `{role_position_label}` 经营，文案里要让读者感到这是一个有明确判断的人在做推荐。"),
            "如果提产品，优先写为什么你会这样选，而不是只堆品牌口号。".to_string(),
        ];
    }
    if persona_vs_brand <= 30 {
        return vec![
            "信任主要来自品牌与产品体系。少写过度个人化的人设渲染，多写定位、机制、证据和产品逻辑。".to_string(),
            "优先解释这个品牌、产品或服务为什么成立，而不是反复强调推荐者本人。".to_string(),
            "除非用户明确要强化人设，否则不要把文案写成强烈的个人情绪表达。".to_string(),
        ];
    }
    vec![
        "人设与品牌共同承担信任。既要出现个人判断，也要交代品牌或产品逻辑。".to_string(),
        "不要只讲“我觉得”，也不要只讲抽象品牌话术，两种信任来源都要出现。".to_string(),
        format!("角色姿态维持 `{role_position_label}`，但不要让角色感压过内容本身。"),
    ]
}

fn virality_rule(consistency_vs_virality: i64) -> Vec<String> {
    if consistency_vs_virality >= 70 {
        return vec![
            "爆发力优先。标题、首段和角度可以更猛，但必须有真实支撑，不能只做空钩子。".to_string(),
            "允许更明显的反差、误区、错误认知和结论先行。".to_string(),
            "即使追求传播，也不要为了爆点把长期定位写歪。".to_string(),
        ];
    }
    if consistency_vs_virality <= 30 {
        return vec![
            "一致性优先。优先维护长期识别度、稳定语汇和统一表达姿态。".to_string(),
            "不要为了追热点把语气、结构和价值观写得忽左忽右。".to_string(),
            "选题允许有变化，但账号给人的基本感觉要稳定。".to_string(),
        ];
    }
    vec![
        "一致性与爆发力平衡。标题和切口可以追求张力，但不要牺牲长期识别度。".to_string(),
        "每次可以放大一个矛盾点，但整体表达底盘要保持一致。".to_string(),
    ]
}

fn structure_rule(structure_value: i64, structure_label: &str, opening_label: &str) -> Vec<String> {
    let mut rules = Vec::new();
    if structure_value >= 70 {
        rules.push(
            "正文优先用框架拆解。尽早给结论，再用分层、步骤、判断标准把内容撑开。".to_string(),
        );
        rules.push(
            "段落之间要有明确推进关系，读者应当能看懂“结论 -> 依据 -> 动作”的顺序。".to_string(),
        );
    } else if structure_value <= 30 {
        rules.push(
            "正文优先用故事或过程推进。先把人、处境、动作和变化写出来，再落到判断。".to_string(),
        );
        rules.push("不要把故事硬拆成机械小标题，保留自然推进感和现场感。".to_string());
    } else {
        rules.push(
            "正文采用“场景 + 判断 + 方法”混合结构，既要有可读性，也要有可执行结论。".to_string(),
        );
        rules.push("不要只有情绪，也不要只有提纲，场景和方法两边都要占一点。".to_string());
    }
    rules.push(format!(
        "当前空间偏好：{structure_label}，开头方式：{opening_label}。"
    ));
    rules
}

fn opening_rule(opening_key: &str) -> Vec<String> {
    if opening_key == "observational" {
        return vec![
            "开头优先从一个真实观察、复盘片段、样本比较或具体场景切入。".to_string(),
            "先把读者带进一个判断过程，再给结论，不要第一句就空喊立场。".to_string(),
        ];
    }
    vec![
        "开头优先结论先行、误区先打破、矛盾先抛出。前 1 到 2 句就要出现核心判断。".to_string(),
        "钩子要尖锐，但不能靠夸张承诺和伪紧迫感制造张力。".to_string(),
    ]
}

fn tone_rule(
    authority_posture: i64,
    emotional_temperature: i64,
    role_position_label: &str,
) -> Vec<String> {
    let mut rules = Vec::new();
    if authority_posture >= 70 {
        rules.push(
            "语气偏专业判断。多用明确结论、判断标准和取舍逻辑，少用过度讨好的口吻。".to_string(),
        );
    } else if authority_posture <= 30 {
        rules.push("语气偏亲近自然。允许更口语、更像真实交流，但不能因此失去判断力。".to_string());
    } else {
        rules.push("语气在专业与亲近之间保持平衡。既有判断，也保留交流感。".to_string());
    }
    if emotional_temperature >= 70 {
        rules.push("允许更有情绪感染力的词和节奏，但不要写成廉价煽动或喊口号。".to_string());
    } else if emotional_temperature <= 30 {
        rules.push("整体保持冷静克制。少用感叹号、过热形容词和强烈情绪词。".to_string());
    } else {
        rules.push("情绪适中，用情绪服务判断，不要让情绪盖过信息量。".to_string());
    }
    rules.push(format!(
        "统一维持 `{role_position_label}` 这类账号姿态，不要一会像顾问一会像促销员。"
    ));
    rules
}

fn sales_rule(content_vs_commerce: i64, sales_explicitness: i64) -> Vec<String> {
    if sales_explicitness >= 70 {
        return vec![
            "转化表达可以明确出现。要直接写清楚适合谁、为什么值得行动、下一步动作是什么。"
                .to_string(),
            "CTA 不要只写“想了解私信我”，要尽量具体到咨询、领取、下单、预约或回复动作。"
                .to_string(),
            if content_vs_commerce <= 40 {
                "虽然整体内容偏重，但既然 CTA 已经设为显性，就只在最有资格收口的段落明确推动，不要全篇持续逼单。".to_string()
            } else {
                "偏商业空间里，允许更早埋入成交线索，但正文仍然要先建立信任。".to_string()
            },
        ];
    }
    if sales_explicitness <= 30 {
        return vec![
            "转化表达默认弱化。更适合把产品、服务或动作埋在结尾补充、案例细节或自然延伸里。"
                .to_string(),
            "不要频繁发号施令，也不要把 CTA 写成独立销售段落。".to_string(),
            "优先让读者觉得内容有价值，再让一部分人自然进入下一步。".to_string(),
        ];
    }
    vec![
        "转化表达保持中性。可以明确动作，但不要从头到尾都像在成交。".to_string(),
        "正文里的每次产品露出都要有前文依据，不能突然跳出一个销售口。".to_string(),
    ]
}

fn build_space_writing_style_skill(
    content_vs_commerce: i64,
    persona_vs_brand: i64,
    consistency_vs_virality: i64,
    authority_posture: i64,
    emotional_temperature: i64,
    sales_explicitness: i64,
    structure_value: i64,
    primary_model_label: &str,
    role_position_label: &str,
    structure_label: &str,
    opening_key: &str,
    opening_label: &str,
) -> String {
    let summary_headline = format!(
        "{}，{}，{}",
        label_content_vs_commerce(content_vs_commerce),
        label_persona_vs_brand(persona_vs_brand),
        structure_label
    );
    let mut lines = vec![
        "---".to_string(),
        "description: 当前空间自动生成的写作风格指导，覆盖选题 framing、标题、正文、改写、润色与 CTA 表达。".to_string(),
        "allowedRuntimeModes: [wander, redclaw, chatroom]".to_string(),
        "hookMode: inline".to_string(),
        "autoActivate: false".to_string(),
        "activationScope: turn".to_string(),
        format!(
            "contextNote: 当前空间存在一份可按需激活的 writing-style。当前空间风格画像为 {}；经营模式 {}；账号角色 {}。",
            summary_headline, primary_model_label, role_position_label
        ),
        format!(
            "promptPrefix: 当当前任务明确涉及写作、改写、润色或选题 framing 时，再应用这份 writing-style。写作任务应体现 {}；开头方式 {}；转化表达 {}。",
            summary_headline,
            opening_label,
            label_sales(sales_explicitness)
        ),
        "promptSuffix: 如果当前任务不是写作，不要让 writing-style 主导其他决策；如果当前任务是写作，标题、开头、正文、CTA 都必须体现当前空间设定。标题控制在 20 个汉字以内；禁止模板化 AI 套话、编造经历、控制字符和孤立分隔线。".to_string(),
        "maxPromptChars: 3200".to_string(),
        "---".to_string(),
        "# Writing Style".to_string(),
        "".to_string(),
        "这是当前空间根据风格初始化结果自动生成的写作风格指导。后续涉及选题 framing、标题拟定、正文创作、改写、扩写、润色、转化表达时，可按需激活并遵守这份技能。".to_string(),
        "".to_string(),
        "## 当前空间画像".to_string(),
        format!(
            "- 经营重心: {}",
            percent_dual_label(content_vs_commerce, "内容", "商业")
        ),
        format!(
            "- 信任来源: {}",
            percent_dual_label(persona_vs_brand, "品牌", "人设")
        ),
        format!(
            "- 品牌节奏: {}",
            percent_dual_label(consistency_vs_virality, "一致性", "爆发力")
        ),
        format!("- 经营模式: {primary_model_label}"),
        format!("- 对外角色: {role_position_label}"),
        format!("- 账号气质: {}", label_authority(authority_posture)),
        format!("- 情绪温度: {}", label_emotion(emotional_temperature)),
        format!("- 转化表达: {}", label_sales(sales_explicitness)),
        format!("- 正文组织: {structure_label}"),
        format!("- 开头方式: {opening_label}"),
        "".to_string(),
        "## 强制规则".to_string(),
        "- 涉及写作、改写、扩写、润色、复盘，或选题 framing 的任务，都先遵守这份技能。".to_string(),
        "- 如果当前任务不是写作，不要让本技能主导非写作决策。".to_string(),
        "- 所有标题都必须控制在 20 个汉字以内，或其它语言下等价的简洁长度。".to_string(),
        "- 像活人说话，不写报告腔、培训腔、客服腔。".to_string(),
        "- 不编造经历、数据、案例、情绪，不假装第一手体验。".to_string(),
        "- 禁止输出控制字符、孤立分隔线和非正文占位标记。".to_string(),
        "".to_string(),
        "## 经营方向".to_string(),
    ];
    lines.extend(writing_direction_rule(
        content_vs_commerce,
        sales_explicitness,
        primary_model_label,
    ));
    lines.push("".to_string());
    lines.push("## 信任来源与角色姿态".to_string());
    lines.extend(trust_source_rule(persona_vs_brand, role_position_label));
    lines.push("".to_string());
    lines.push("## 爆发力与长期一致性".to_string());
    lines.extend(virality_rule(consistency_vs_virality));
    lines.push("".to_string());
    lines.push("## 标题与开头".to_string());
    lines.extend(opening_rule(opening_key));
    if consistency_vs_virality >= 70 {
        lines.push("标题可以更强调反差、错误认知和结果导向，但不能只剩刺激性词语。".to_string());
    } else if consistency_vs_virality <= 30 {
        lines.push("标题优先稳定、可信和长期识别度，不要每条都像一次情绪爆点。".to_string());
    } else {
        lines.push(
            "标题在张力和稳定之间取中间值，既要有吸引力，也要和账号长期气质一致。".to_string(),
        );
    }
    lines.push("".to_string());
    lines.push("## 正文推进".to_string());
    lines.extend(structure_rule(
        structure_value,
        structure_label,
        opening_label,
    ));
    lines.push("".to_string());
    lines.push("## 语言与情绪".to_string());
    lines.extend(tone_rule(
        authority_posture,
        emotional_temperature,
        role_position_label,
    ));
    lines.push("".to_string());
    lines.push("## 转化表达".to_string());
    lines.extend(sales_rule(content_vs_commerce, sales_explicitness));
    lines.push("".to_string());
    lines.push("## 绝对禁区".to_string());
    lines.push(
        "- 禁用“首先、其次、最后”“综上所述”“值得注意的是”“不难发现”“让我们来看看”这类模板话术。"
            .to_string(),
    );
    lines.push("- 禁用“本质上”“换句话说”“不可否认”“说白了”“这意味着”这类空转衔接词。".to_string());
    lines.push("- 禁止夸张承诺、伪紧迫感、廉价打鸡血和没有根据的成交承诺。".to_string());
    lines.push("- 不要为了覆盖素材把正文写得生硬，也不要为了爆点把事实写歪。".to_string());
    lines.push("".to_string());
    lines.push("## 自检".to_string());
    lines.push(
        "- 标题、开头、正文、CTA 是否都体现了这个空间的经营重心，而不是只局部满足。".to_string(),
    );
    lines.push("- 有没有具体对象、处境、动作和判断依据。".to_string());
    lines.push("- 有没有太像 AI 模板、课程提纲或空洞总结。".to_string());
    lines.push("- 有没有为了转化牺牲信任，或为了内容感完全忽略商业目标。".to_string());
    lines.join("\n")
}

#[derive(Debug, Deserialize)]
struct GeneratedRedclawInitializationArtifacts {
    markdown: String,
}

fn strip_optional_code_fence(raw: &str) -> String {
    let trimmed = raw.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let without_open = trimmed
        .split_once('\n')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    without_open
        .rsplit_once("```")
        .map(|(content, _)| content.trim().to_string())
        .unwrap_or_else(|| without_open.trim().to_string())
}

fn normalize_generated_skill_markdown(markdown: &str) -> Result<String, String> {
    let normalized = strip_optional_code_fence(markdown);
    if normalized.trim().is_empty() {
        return Err("模型返回的 writing-style 技能为空".to_string());
    }
    if !normalized.trim_start().starts_with("---") {
        return Err("模型返回的 writing-style 技能缺少 frontmatter".to_string());
    }
    if !normalized.contains("# Writing Style") {
        return Err("模型返回的 writing-style 技能缺少主标题".to_string());
    }
    Ok(normalized)
}

fn build_existing_docs_context(existing_docs: &[(&str, &str)]) -> String {
    let sections = existing_docs
        .iter()
        .filter_map(|(title, markdown)| {
            let normalized = markdown.trim();
            if normalized.is_empty() {
                return None;
            }
            Some(format!("### {title}\n{normalized}"))
        })
        .collect::<Vec<_>>();
    if sections.is_empty() {
        String::new()
    } else {
        format!("## 已生成的上游文档\n{}\n\n", sections.join("\n\n"))
    }
}

fn build_redclaw_initialization_artifact_prompt(
    artifact_kind: &str,
    normalized_answers: &Value,
    style_profile: &Value,
    fallback_skill: &str,
    existing_docs: &[(&str, &str)],
) -> Result<String, String> {
    let answers_json =
        serde_json::to_string_pretty(normalized_answers).map_err(|error| error.to_string())?;
    let style_profile_json =
        serde_json::to_string_pretty(style_profile).map_err(|error| error.to_string())?;
    let task_block = match artifact_kind {
        "soul" => [
            "## 当前任务",
            "你现在只负责生成 `Soul.md`。",
            "职责边界：只写 RedClaw 如何与用户协作、反馈、执行，不写标题策略、正文结构、CTA、禁用词等写作技法。",
            "必须突出：高执行、强结构、直接反馈、先结论后细节、给验收标准。",
            "长度要求：控制在 6 条以内的高密度规则，不写长篇说明。",
            "输出要求：只返回完整 Markdown，不要解释，不要代码围栏。",
        ]
        .join("\n"),
        "user" => [
            "## 当前任务",
            "你现在只负责生成 `user.md`。",
            "职责边界：只写用户稳定事实、经营重心、目标、受众、长期偏好摘要，不写逐句写作规则。",
            "必须体现：内容/商业权重、人设/品牌权重、账号角色、风格偏好摘要、转化表达强度。",
            "避免重复：不要复述 Soul.md 里的协作原则，也不要写成 CreatorProfile.md 的品牌策略版。",
            "长度要求：控制在 6 到 8 条关键事实以内。",
            "输出要求：只返回完整 Markdown，不要解释，不要代码围栏。",
        ]
        .join("\n"),
        "creator_profile" => [
            "## 当前任务",
            "你现在只负责生成 `CreatorProfile.md`。",
            "职责边界：只写账号定位、经营模式、品牌策略、内容方向、商业边界，不写逐句写法配方。",
            "必须体现：经营模式、经营重心、信任来源、角色姿态、内容风格、长期策略取向。",
            "避免重复：不要重复 Soul.md 的协作规则，不要重复 user.md 里已经稳定存在的用户事实，只保留品牌/账号层面的长期策略。",
            "长度要求：控制在 3 到 4 个短章节，每章 2 到 3 条要点。",
            "输出要求：只返回完整 Markdown，不要解释，不要代码围栏。",
        ]
        .join("\n"),
        "writing_style_skill" => [
            "## 当前任务",
            "你现在只负责生成当前空间的 `writing-style` 技能 Markdown。",
            "职责边界：只写实际写作执行规则：标题、开头、正文推进、语言、情绪、CTA、禁区、自检。",
            "必须输出合法 frontmatter，并包含 `# Writing Style` 标题。",
            "请沿用下面参考模板的结构层次和 frontmatter 形态，但内容必须按当前问卷结果重新生成，不要照抄。",
            "避免重复：不要把 Soul.md 的协作规则和 user.md 的稳定事实大段抄进 skill，只保留真正影响写作执行的规则。",
            "长度要求：这是四份资产里可以最详细的一份，但仍然只保留高价值规则，不写空话。",
            "输出要求：只返回完整 Markdown，不要解释，不要代码围栏。",
        ]
        .join("\n"),
        _ => return Err(format!("unsupported onboarding artifact kind: {artifact_kind}")),
    };
    let existing_docs_context = build_existing_docs_context(existing_docs);
    Ok(format!(
        concat!(
            "你是 RedClaw。当前正在执行空间风格初始化后的内部档案更新任务。\n",
            "这不是和用户闲聊，也不是让你解释过程。你只需要生成目标文件的最终内容。\n\n",
            "{task_block}\n\n",
            "## 问卷原始答案\n{answers_json}\n\n",
            "## 结构化风格画像\n{style_profile_json}\n\n",
            "{existing_docs_context}",
            "## 写作技能参考模板\n{fallback_skill}\n\n",
            "## 通用约束\n",
            "- 全部使用中文。\n",
            "- 不要编造经历、用户背景、案例、数据。\n",
            "- 只基于给定问卷结果和结构化画像推导。\n",
            "- 如果上游文档已经覆盖某个信息点，当前文档不要重复大段复述。\n",
            "- 文本要具体、可执行、可长期遵守，不能空泛。\n"
        ),
        task_block = task_block,
        answers_json = answers_json,
        style_profile_json = style_profile_json,
        existing_docs_context = existing_docs_context,
        fallback_skill = fallback_skill
    ))
}

fn onboarding_artifact_session_id(space_slug: &str, artifact_kind: &str) -> String {
    format!(
        "context-session:redclaw:{}",
        slug_from_relative_path(&format!("onboarding-init-{space_slug}-{artifact_kind}"))
    )
}

fn generate_redclaw_initialization_artifact_via_agent(
    app: &AppHandle,
    state: &State<'_, AppState>,
    artifact_kind: &str,
    normalized_answers: &Value,
    style_profile: &Value,
    fallback_skill: &str,
    existing_docs: &[(&str, &str)],
) -> Result<GeneratedRedclawInitializationArtifacts, String> {
    let workspace = workspace_root(state)?;
    let space_slug = workspace
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default-space");
    let prompt = build_redclaw_initialization_artifact_prompt(
        artifact_kind,
        normalized_answers,
        style_profile,
        fallback_skill,
        existing_docs,
    )?;
    let session_id = onboarding_artifact_session_id(space_slug, artifact_kind);
    let turn = PreparedSessionAgentTurn::redclaw_run(RedclawRunTurn::new(
        &format!("onboarding-{artifact_kind}"),
        session_id,
        prompt,
    ));
    let execution = execute_prepared_session_agent_turn(Some(app), state, &turn)?;
    Ok(GeneratedRedclawInitializationArtifacts {
        markdown: execution.response().to_string(),
    })
}

fn build_mvp_style_summary(style_profile: &Value) -> Value {
    let content_vs_commerce = style_profile
        .get("workspaceMission")
        .and_then(|value| value.get("contentVsCommerce"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let persona_vs_brand = style_profile
        .get("businessModel")
        .and_then(|value| value.get("personaVsBrand"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let consistency_vs_virality = style_profile
        .get("brandStrategy")
        .and_then(|value| value.get("consistencyVsVirality"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let authority = style_profile
        .get("audienceModel")
        .and_then(|value| value.get("authorityPosture"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let emotional = style_profile
        .get("writingPreferences")
        .and_then(|value| value.get("emotionalTemperature"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let sales = style_profile
        .get("writingPreferences")
        .and_then(|value| value.get("salesExplicitness"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let structure = style_profile
        .get("writingPreferences")
        .and_then(|value| value.get("structureValue"))
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(0, 100);
    let role_position = style_profile
        .get("audienceModel")
        .and_then(|value| {
            value
                .get("rolePositionLabel")
                .or_else(|| value.get("rolePosition"))
        })
        .and_then(Value::as_str)
        .map(humanize_role_position)
        .unwrap_or_else(|| "专业顾问".to_string());
    let primary_model = style_profile
        .get("businessModel")
        .and_then(|value| {
            value
                .get("primaryModelLabel")
                .or_else(|| value.get("primaryModel"))
        })
        .and_then(Value::as_str)
        .map(humanize_primary_model)
        .unwrap_or_else(|| "纯内容账号".to_string());
    let opening_style = style_profile
        .get("writingPreferences")
        .and_then(|value| value.get("openingStyle"))
        .and_then(Value::as_str)
        .unwrap_or("hook");
    let (_structure_key, structure_label) = label_structure(structure);
    let (_opening_key, opening_label) = label_opening_style(opening_style);
    json!({
        "headline": format!(
            "{}，{}，{}",
            label_content_vs_commerce(content_vs_commerce),
            label_persona_vs_brand(persona_vs_brand),
            structure_label
        ),
        "chips": [
            percent_dual_label(content_vs_commerce, "内容", "商业"),
            percent_dual_label(persona_vs_brand, "品牌", "人设"),
            percent_dual_label(consistency_vs_virality, "一致性", "爆发力"),
            label_authority(authority),
            label_emotion(emotional),
            label_sales(sales),
            opening_label,
            primary_model,
            role_position
        ],
        "lines": [
            format!("经营重心：{}", label_content_vs_commerce(content_vs_commerce)),
            format!("信任来源：{}", label_persona_vs_brand(persona_vs_brand)),
            format!("品牌节奏：{}", label_consistency_vs_virality(consistency_vs_virality)),
            format!("账号气质：{}", label_authority(authority)),
            format!("情绪浓度：{}", label_emotion(emotional)),
            format!("转化表达：{}", label_sales(sales)),
            format!("正文组织：{}", structure_label),
            format!("开头方式：{}", opening_label),
            format!("经营模式：{}", primary_model),
            format!("账号角色：{}", role_position)
        ]
    })
}

pub(crate) fn save_redclaw_mvp_onboarding_progress(
    state: &State<'_, AppState>,
    step_index: i64,
    answers: &Value,
) -> Result<Value, String> {
    ensure_redclaw_profile_files(state)?;
    let mut onboarding = load_redclaw_onboarding_state(state)?;
    let normalized_answers = normalize_screen_answers(answers);
    if let Some(object) = onboarding.as_object_mut() {
        object.insert("version".to_string(), json!(2));
        object.insert(
            "flowMode".to_string(),
            json!(REDCLAW_ONBOARDING_FLOW_MODE_SCREEN),
        );
        if object
            .get("startedAt")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            object.insert("startedAt".to_string(), json!(now_iso()));
        }
        let ui_flow = object.entry("uiFlow".to_string()).or_insert_with(|| {
            json!({
                "version": "mvp-v1",
                "draft": {
                    "stepIndex": 0,
                    "answers": {}
                },
                "summary": Value::Null
            })
        });
        if let Some(ui_flow_obj) = ui_flow.as_object_mut() {
            ui_flow_obj.insert("version".to_string(), json!("mvp-v1"));
            ui_flow_obj.insert(
                "draft".to_string(),
                json!({
                    "stepIndex": step_index.clamp(0, REDCLAW_ONBOARDING_SCREEN_STEP_COUNT - 1),
                    "answers": normalized_answers,
                    "updatedAt": now_iso()
                }),
            );
        }
    }
    save_redclaw_onboarding_state(state, &onboarding)?;
    Ok(onboarding)
}

pub(crate) fn ensure_redclaw_space_writing_style_skill(
    state: &State<'_, AppState>,
) -> Result<bool, String> {
    let workspace = workspace_root(state)?;
    let mut skill_record = build_workspace_skill_record("writing-style");
    skill_record.description = "当前空间默认写作风格模板".to_string();
    skill_record.body = build_default_space_writing_style_skill_doc();
    let skill_path = resolve_skill_file_path(&skill_record, Some(workspace.as_path()))
        .ok_or_else(|| "无法解析当前空间 writing-style 技能路径".to_string())?;
    if skill_path.exists() {
        return Ok(false);
    }
    write_skill_record_to_path(&skill_record, &skill_path)?;
    let _ = refresh_skill_store_catalog(state);
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
    Ok(true)
}

pub(crate) fn complete_redclaw_mvp_onboarding(
    app: &AppHandle,
    state: &State<'_, AppState>,
    answers: &Value,
) -> Result<Value, String> {
    ensure_redclaw_profile_files(state)?;
    let normalized_answers = normalize_screen_answers(answers);

    let content_vs_commerce = screen_answer_percent(&normalized_answers, "contentVsCommerce", 50);
    let persona_vs_brand = screen_answer_percent(&normalized_answers, "personaVsBrand", 50);
    let consistency_vs_virality =
        screen_answer_percent(&normalized_answers, "consistencyVsVirality", 50);
    let authority_posture = screen_answer_percent(&normalized_answers, "authorityPosture", 50);
    let emotional_temperature =
        screen_answer_percent(&normalized_answers, "emotionalTemperature", 50);
    let sales_explicitness = screen_answer_percent(&normalized_answers, "salesExplicitness", 50);
    let structure_value = screen_answer_percent(&normalized_answers, "structureValue", 50);
    let primary_model = screen_answer_string(&normalized_answers, "primaryModel", "纯内容账号");
    let role_position = screen_answer_string(&normalized_answers, "rolePosition", "专业顾问");
    let opening_preference = screen_answer_string(&normalized_answers, "openingPreference", "hook");

    let (structure_key, structure_label) = label_structure(structure_value);
    let (opening_key, opening_label) = label_opening_style(&opening_preference);
    let (primary_model_key, primary_model_label) = label_primary_model(&primary_model);
    let (role_position_key, role_position_label) = label_role_position(&role_position);
    let mut style_profile = json!({
        "workspaceMission": {
            "contentVsCommerce": content_vs_commerce
        },
        "businessModel": {
            "personaVsBrand": persona_vs_brand,
            "primaryModel": primary_model_key,
            "primaryModelLabel": primary_model_label
        },
        "audienceModel": {
            "authorityPosture": authority_posture,
            "rolePosition": role_position_key,
            "rolePositionLabel": role_position_label
        },
        "brandStrategy": {
            "consistencyVsVirality": consistency_vs_virality
        },
        "writingPreferences": {
            "emotionalTemperature": emotional_temperature,
            "salesExplicitness": sales_explicitness,
            "ctaIntensity": sales_explicitness,
            "structurePreference": structure_key,
            "structureValue": structure_value,
            "storyRatio": 100 - structure_value,
            "hookStrength": if opening_key == "hook" { 78 } else { 42 },
            "openingStyle": opening_key,
            "openingStyleLabel": opening_label,
            "authorityLevel": authority_posture
        },
        "collaborationPreferences": {
            "executionStyle": "high_execution_structured_direct"
        },
        "metadata": {
            "version": "mvp-v1",
            "updatedAt": now_iso(),
            "generatedSkill": {
                "name": "writing-style",
                "relativePath": "skills/writing-style/SKILL.md",
                "sourceScope": "workspace"
            }
        }
    });
    let summary = build_mvp_style_summary(&style_profile);
    let fallback_writing_style_skill = build_space_writing_style_skill(
        content_vs_commerce,
        persona_vs_brand,
        consistency_vs_virality,
        authority_posture,
        emotional_temperature,
        sales_explicitness,
        structure_value,
        primary_model_label,
        role_position_label,
        structure_label,
        opening_key,
        opening_label,
    );

    let identity_markdown = [
        "# identity.md".to_string(),
        "".to_string(),
        "- Name: RedClaw".to_string(),
        "- Role: 多平台内容创作自动化 Agent".to_string(),
        format!("- Vibe: {}", label_authority(authority_posture)),
        "- Signature: 🦀".to_string(),
        format!("- UpdatedAt: {}", now_iso()),
    ]
    .join("\n");

    let fallback_soul_markdown = [
        "# Soul.md".to_string(),
        "".to_string(),
        "## 当前人格与协作偏好".to_string(),
        "- 协作风格: 高执行 + 强结构 + 直接反馈".to_string(),
        "- 反馈方式: 先结论，后细节；必要时直接指出问题。".to_string(),
        "- 执行姿态: 先拆目标，再给动作和验收点。".to_string(),
        "- 用户未明确要求改动协作方式时，默认保持高执行、强结构、直接反馈。".to_string(),
        format!("- UpdatedAt: {}", now_iso()),
    ]
    .join("\n");

    let fallback_user_markdown = [
        "# user.md".to_string(),
        "".to_string(),
        "## 用户创作档案".to_string(),
        format!(
            "- 空间经营重心: {}",
            percent_dual_label(content_vs_commerce, "内容", "商业")
        ),
        format!(
            "- 长期信任来源: {}",
            percent_dual_label(persona_vs_brand, "品牌", "人设")
        ),
        format!("- 账号角色: {role_position_label}"),
        format!(
            "- 风格偏好摘要: {}、{}、{}、{}",
            label_authority(authority_posture),
            label_emotion(emotional_temperature),
            structure_label,
            opening_label
        ),
        format!("- 转化表达强度: {}", label_sales(sales_explicitness)),
        "- 当用户明确给出新的长期偏好时，及时覆盖旧偏好。".to_string(),
        "- 单次任务中的临时要求，不默认升格为长期规则。".to_string(),
    ]
    .join("\n");

    let fallback_creator_profile_markdown = [
        "# CreatorProfile.md".to_string(),
        "".to_string(),
        "## 定位总览".to_string(),
        format!("- 经营模式: {primary_model_label}"),
        format!(
            "- 经营重心: {}",
            label_content_vs_commerce(content_vs_commerce)
        ),
        format!("- 信任来源: {}", label_persona_vs_brand(persona_vs_brand)),
        "".to_string(),
        "## 账号角色".to_string(),
        format!("- 对外角色: {role_position_label}"),
        format!("- 账号气质: {}", label_authority(authority_posture)),
        "".to_string(),
        "## 内容风格".to_string(),
        format!("- 情绪温度: {}", label_emotion(emotional_temperature)),
        format!("- 转化表达: {}", label_sales(sales_explicitness)),
        format!("- 正文组织: {structure_label}"),
        format!("- 开头方式: {opening_label}"),
        "".to_string(),
        "## 运营策略".to_string(),
        format!(
            "- 长期策略取向: {}",
            label_consistency_vs_virality(consistency_vs_virality)
        ),
        format!("- UpdatedAt: {}", now_iso()),
    ]
    .join("\n");

    let mut generation_errors = Vec::<String>::new();
    let soul_markdown = match generate_redclaw_initialization_artifact_via_agent(
        app,
        state,
        "soul",
        &normalized_answers,
        &style_profile,
        &fallback_writing_style_skill,
        &[],
    ) {
        Ok(generated) => normalize_profile_doc_markdown(
            "Soul.md",
            &strip_optional_code_fence(&generated.markdown),
        )?,
        Err(error) => {
            eprintln!("[redclaw][onboarding] soul agent generation failed: {error}");
            generation_errors.push(format!("soul:{error}"));
            fallback_soul_markdown
        }
    };
    let user_markdown = match generate_redclaw_initialization_artifact_via_agent(
        app,
        state,
        "user",
        &normalized_answers,
        &style_profile,
        &fallback_writing_style_skill,
        &[("Soul.md", &soul_markdown)],
    ) {
        Ok(generated) => normalize_profile_doc_markdown(
            "user.md",
            &strip_optional_code_fence(&generated.markdown),
        )?,
        Err(error) => {
            eprintln!("[redclaw][onboarding] user agent generation failed: {error}");
            generation_errors.push(format!("user:{error}"));
            fallback_user_markdown
        }
    };
    let creator_profile_markdown = match generate_redclaw_initialization_artifact_via_agent(
        app,
        state,
        "creator_profile",
        &normalized_answers,
        &style_profile,
        &fallback_writing_style_skill,
        &[("Soul.md", &soul_markdown), ("user.md", &user_markdown)],
    ) {
        Ok(generated) => normalize_profile_doc_markdown(
            "CreatorProfile.md",
            &strip_optional_code_fence(&generated.markdown),
        )?,
        Err(error) => {
            eprintln!("[redclaw][onboarding] creator profile agent generation failed: {error}");
            generation_errors.push(format!("creator_profile:{error}"));
            fallback_creator_profile_markdown
        }
    };
    let writing_style_skill = match generate_redclaw_initialization_artifact_via_agent(
        app,
        state,
        "writing_style_skill",
        &normalized_answers,
        &style_profile,
        &fallback_writing_style_skill,
        &[
            ("Soul.md", &soul_markdown),
            ("user.md", &user_markdown),
            ("CreatorProfile.md", &creator_profile_markdown),
        ],
    ) {
        Ok(generated) => normalize_generated_skill_markdown(&generated.markdown)?,
        Err(error) => {
            eprintln!("[redclaw][onboarding] writing-style agent generation failed: {error}");
            generation_errors.push(format!("writing_style_skill:{error}"));
            fallback_writing_style_skill
        }
    };
    let generation_mode = if generation_errors.is_empty() {
        "agent-sequential"
    } else {
        "agent-sequential-with-fallback"
    };
    if let Some(metadata) = style_profile
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
    {
        metadata.insert("generationMode".to_string(), json!(generation_mode));
        metadata.insert("generatedAt".to_string(), json!(now_iso()));
        metadata.insert(
            "generationStrategy".to_string(),
            json!("redclaw-agent-sequential-artifact-generation"),
        );
        if !generation_errors.is_empty() {
            metadata.insert("generationFallbackReason".to_string(), json!("agent_error"));
            metadata.insert("generationErrors".to_string(), json!(generation_errors));
        }
    }

    let profile_root = redclaw_profile_root(state)?;
    fs::write(profile_root.join("identity.md"), identity_markdown)
        .map_err(|error| error.to_string())?;
    fs::write(profile_root.join("Soul.md"), soul_markdown).map_err(|error| error.to_string())?;
    fs::write(profile_root.join("user.md"), user_markdown).map_err(|error| error.to_string())?;
    fs::write(
        profile_root.join("CreatorProfile.md"),
        creator_profile_markdown,
    )
    .map_err(|error| error.to_string())?;
    save_redclaw_style_profile(state, &style_profile)?;
    let workspace = workspace_root(state).ok();
    let mut skill_record = build_workspace_skill_record("writing-style");
    skill_record.description = "当前空间自动生成的写作风格指导".to_string();
    skill_record.body = writing_style_skill;
    let skill_path = resolve_skill_file_path(&skill_record, workspace.as_deref())
        .ok_or_else(|| "无法解析当前空间 writing-style 技能路径".to_string())?;
    write_skill_record_to_path(&skill_record, &skill_path)?;
    let _ = refresh_skill_store_catalog(state);
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
    let _ = fs::remove_file(profile_root.join("BOOTSTRAP.md"));

    let mut onboarding = load_redclaw_onboarding_state(state)?;
    if let Some(object) = onboarding.as_object_mut() {
        object.insert("version".to_string(), json!(2));
        object.insert(
            "flowMode".to_string(),
            json!(REDCLAW_ONBOARDING_FLOW_MODE_SCREEN),
        );
        object.insert("askedFirstQuestion".to_string(), json!(true));
        object.insert(
            "stepIndex".to_string(),
            json!(REDCLAW_ONBOARDING_SCREEN_STEP_COUNT),
        );
        object.insert("completedAt".to_string(), json!(now_iso()));
        let ui_flow = object
            .entry("uiFlow".to_string())
            .or_insert_with(|| json!({}));
        if let Some(ui_flow_obj) = ui_flow.as_object_mut() {
            ui_flow_obj.insert("version".to_string(), json!("mvp-v1"));
            ui_flow_obj.insert(
                "draft".to_string(),
                json!({
                    "stepIndex": REDCLAW_ONBOARDING_SCREEN_STEP_COUNT,
                    "answers": normalized_answers,
                    "updatedAt": now_iso()
                }),
            );
            ui_flow_obj.insert("summary".to_string(), summary.clone());
        }
    }
    save_redclaw_onboarding_state(state, &onboarding)?;

    Ok(json!({
        "success": true,
        "summary": summary,
        "styleProfile": style_profile,
        "skill": {
            "name": "writing-style",
            "path": skill_path.display().to_string()
        },
        "onboardingState": onboarding
    }))
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

pub(crate) fn ensure_redclaw_profile_files(state: &State<'_, AppState>) -> Result<(), String> {
    let profile_root = redclaw_profile_root(state)?;
    let agent_path = profile_root.join("Agent.md");
    let soul_path = profile_root.join("Soul.md");
    let identity_path = profile_root.join("identity.md");
    let user_path = profile_root.join("user.md");
    let creator_path = profile_root.join("CreatorProfile.md");
    let bootstrap_path = profile_root.join("BOOTSTRAP.md");
    let onboarding_path = profile_root.join("onboarding-state.json");
    let style_profile_path = profile_root.join("style-profile.json");

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
    ensure_file_if_missing(&style_profile_path, "{}")?;

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
