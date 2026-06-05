use crate::json_util::{json_string, read_json_value, write_json_pretty};
use crate::knowledge::{
    ingest_entry, KnowledgeEntryContentInput, KnowledgeEntryIngestRequest,
    KnowledgeEntryStatsInput, KnowledgeIngestOptionsInput, KnowledgeSourceInput,
};
use crate::llm_transport::run_openai_json_chat_completion_transport;
use crate::persistence::with_store;
use crate::runtime::resolve_chat_config;
use crate::store::settings as settings_store;
use crate::{now_iso, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::State;

pub(crate) mod deterministic;
pub(crate) mod evidence;
pub(crate) mod outputs;
pub(crate) mod quality;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileLearningResult {
    pub generated_at: String,
    pub post_count: usize,
    pub quality_ready_for_runtime: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DistillationModel {
    pub post_count: usize,
    pub content_complete_count: usize,
    pub title_patterns: Vec<PatternStat>,
    pub opening_patterns: Vec<PatternStat>,
    pub cta_patterns: Vec<PatternStat>,
    pub structure_rules: Vec<String>,
    pub style_rules: Vec<String>,
    pub media_rules: Vec<String>,
    pub guardrails: Vec<String>,
    pub opportunities: Vec<String>,
    pub topic_tags: Vec<PatternStat>,
    pub top_posts: Vec<evidence::NormalizedPost>,
    pub opinion_candidates: Vec<OpinionCandidate>,
    pub value_words: Vec<PatternStat>,
    pub memory_candidates: Vec<MemoryCandidateDraft>,
    pub quality_warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatternStat {
    pub name: String,
    pub count: usize,
    pub percent: f64,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpinionCandidate {
    pub sentence: String,
    pub source_post_id: String,
    pub source_title: String,
    pub source_likes: i64,
    pub match_type: String,
}

#[derive(Debug, Clone)]
pub(crate) struct MemoryCandidateDraft {
    pub kind: String,
    pub text: String,
    pub confidence: f64,
    pub evidence_post_ids: Vec<String>,
}

pub(crate) fn refresh_own_account_profile(
    account_root: &Path,
    schema_version: i64,
    state: &State<'_, AppState>,
) -> Result<ProfileLearningResult, String> {
    let generated_at = now_iso();
    let profile = read_json_value(&account_root.join("profile.json")).unwrap_or_else(|| json!({}));
    let posts = evidence::load_account_posts(account_root, 240);
    let model = analyze_posts(&posts);
    let distillation_root = account_root.join("distillation");
    fs::create_dir_all(&distillation_root).map_err(|error| error.to_string())?;

    outputs::write_evidence_pack(
        &distillation_root,
        &profile,
        &posts,
        &model,
        schema_version,
        &generated_at,
    )?;
    outputs::write_stats(&distillation_root, &model, schema_version, &generated_at)?;
    outputs::write_data_draft(&distillation_root, &profile, &model, &generated_at)?;
    outputs::write_ai_distillation_task(&distillation_root, &profile, &model, &generated_at)?;

    // AI 蒸馏（可降级）
    let ai_result = run_ai_distillation(state, account_root, &model);

    outputs::write_quality_report(&distillation_root, &model, schema_version, &generated_at)?;
    outputs::write_creator_profile_md(
        account_root,
        &profile,
        &model,
        &generated_at,
        ai_result.as_ref(),
    )?;
    outputs::write_writing_style_skill(
        account_root,
        &profile,
        &model,
        &generated_at,
        ai_result.as_ref(),
    )?;
    outputs::write_memory_candidates(
        account_root,
        &profile,
        &model,
        schema_version,
        &generated_at,
    )?;
    outputs::write_learning_summary_md(account_root, &profile, &model, &generated_at)?;

    // 知识索引投影（失败不影响主流程）
    project_posts_to_knowledge(state, account_root, &profile, &posts);
    // 回填 profile.json 字段
    let _ = backfill_profile_json(account_root, &model, ai_result.as_ref(), &generated_at);

    Ok(ProfileLearningResult {
        generated_at,
        post_count: posts.len(),
        quality_ready_for_runtime: quality::quality_ready_for_runtime(&model),
    })
}

fn analyze_posts(posts: &[evidence::NormalizedPost]) -> DistillationModel {
    let post_count = posts.len();
    let content_complete_count = posts
        .iter()
        .filter(|post| post.title.chars().count() + post.content.chars().count() >= 12)
        .count();
    let mut model = DistillationModel {
        post_count,
        content_complete_count,
        title_patterns: deterministic::detect_title_patterns(posts),
        opening_patterns: deterministic::detect_opening_patterns(posts),
        cta_patterns: deterministic::detect_cta_patterns(posts),
        topic_tags: deterministic::detect_topic_tags(posts),
        top_posts: deterministic::top_posts(posts, 10),
        opinion_candidates: deterministic::extract_opinion_candidates(posts),
        value_words: deterministic::extract_value_words(posts),
        ..DistillationModel::default()
    };
    model.structure_rules = deterministic::derive_structure_rules(posts);
    model.style_rules = deterministic::derive_style_rules(posts, &model);
    model.media_rules = deterministic::derive_media_rules(posts);
    model.guardrails = deterministic::derive_guardrails(posts, &model);
    model.opportunities = deterministic::derive_opportunities(&model);
    model.memory_candidates = deterministic::derive_memory_candidates(&model);
    model.quality_warnings = quality::quality_warnings(&model);
    model
}

fn run_ai_distillation(
    state: &State<'_, AppState>,
    account_root: &Path,
    model: &DistillationModel,
) -> Option<Value> {
    // 触发条件
    if model.post_count < 10 {
        return None;
    }
    let completeness = if model.post_count == 0 {
        0.0
    } else {
        model.content_complete_count as f64 / model.post_count as f64
    };
    if completeness < 0.3 {
        return None;
    }

    // 检查缓存：如果 ai-result.json 已存在且 post_count 未变，直接返回
    let cache_path = account_root.join("distillation").join("ai-result.json");
    if cache_path.exists() {
        if let Some(cached) = read_json_value(&cache_path) {
            if cached.get("postCount").and_then(|v| v.as_u64()) == Some(model.post_count as u64) {
                return cached.get("result").cloned();
            }
        }
    }

    // 读取证据文件
    let evidence = read_json_value(&account_root.join("distillation").join("evidence-pack.json"))?;
    let stats = read_json_value(&account_root.join("distillation").join("stats.json"))?;
    let data_draft =
        fs::read_to_string(&account_root.join("distillation").join("data-draft.md")).ok()?;

    // 获取 LLM 配置
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store))).ok()?;
    let config = resolve_chat_config(&settings, None)?;

    // 构建蒸馏 prompt
    let system_prompt = format!(
        r#"你是一个资深内容策略师。你的任务是基于数据分析师提供的证据包，提炼一个社交媒体账号的创作风格。

输出格式：严格 JSON，包含以下字段：
{{
  "cognitiveLayer": {{
    "coreBeliefs": ["信念1（附证据）", ...],  // 3-8条
    "opinionTensions": ["观点张力描述", ...],
    "valuePositions": ["价值立场", ...],
    "thinkingPatterns": ["思维模式", ...]
  }},
  "strategyLayer": {{
    "contentPillars": ["内容支柱1", ...],
    "seriesOpportunities": ["系列化机会", ...],
    "postingRhythm": "发布节奏描述",
    "ifThenRules": ["If-Then 运营准则", ...]
  }},
  "contentLayer": {{
    "titleFormulas": [{{"name": "公式名", "template": "模板", "usageRate": 0.0, "examples": ["原始标题"]}}, ...],
    "openingTemplates": [{{"name": "开头名", "template": "模板", "examples": ["原文示例"]}}, ...],
    "bodyStructure": "正文骨架描述",
    "ctaStyle": "CTA 风格",
    "tagStrategy": "标签策略"
  }},
  "guardrails": [{{"rule": "禁区规则", "evidence": "证据或标注缺失"}}, ...],  // 至少3条
  "contrastExamples": {{
    "genericTitle": "普通标题示例",
    "accountStyleTitle": "本账号风格标题",
    "genericOpening": "普通开头示例",
    "accountStyleOpening": "本账号风格开头"
  }},
  "memoryCandidates": [{{"kind": "account_preference", "text": "...", "confidence": 0.8}}],
  "limitations": ["局限性说明", ...]
}}

要求：
- 每条结论必须能追溯到证据包中的数据
- 标题公式必须有历史标题作为示例
- 禁区不能写成通用建议，要针对此账号
- 超出样本范围的方向必须标注不确定
- 如果证据不足某字段，写空数组或null，不要编造"#
    );

    let user_message = format!(
        r#"请基于以下证据包提炼账号创作风格。

## 统计摘要
{}

## 数据底稿
{}

## 证据包（截取前 3000 字符）
{}"#,
        serde_json::to_string_pretty(&stats).unwrap_or_default(),
        data_draft,
        serde_json::to_string_pretty(&evidence)
            .unwrap_or_default()
            .chars()
            .take(3000)
            .collect::<String>(),
    );

    let body = json!({
        "model": config.model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "temperature": 0.7,
        "max_tokens": 4096,
        "response_format": {"type": "json_object"}
    });

    // 调用 LLM
    let response =
        run_openai_json_chat_completion_transport(state, &config, &body, Some(120), true).ok()?;

    // 提取 content
    let content = response
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?
        .as_str()?;

    let parsed: Value = serde_json::from_str(content).ok()?;

    // 写入缓存
    let cache_entry = json!({
        "postCount": model.post_count,
        "generatedAt": crate::now_iso(),
        "result": parsed,
    });
    let _ = crate::json_util::write_json_pretty(&cache_path, &cache_entry);

    Some(parsed)
}

fn project_posts_to_knowledge(
    state: &State<'_, AppState>,
    account_root: &Path,
    profile: &Value,
    posts: &[evidence::NormalizedPost],
) {
    let tracking_path = account_root
        .join("distillation")
        .join("knowledge-projection.json");
    let mut projected: Vec<String> = read_json_value(&tracking_path)
        .and_then(|v| v.get("projectedPostIds").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let before = projected.len();

    let platform = json_string(profile, "platform").unwrap_or_default();
    let domain = platform_domain(&platform);
    let note_kind = platform_note_kind(&platform);

    for post in posts {
        if post.id.is_empty() || projected.contains(&post.id) {
            continue;
        }
        let request = KnowledgeEntryIngestRequest {
            kind: note_kind.clone(),
            source: KnowledgeSourceInput {
                external_id: Some(post.id.clone()),
                source_domain: Some(domain.clone()),
                source_link: if post.url.is_empty() {
                    None
                } else {
                    Some(post.url.clone())
                },
                source_url: if post.url.is_empty() {
                    None
                } else {
                    Some(post.url.clone())
                },
                ..Default::default()
            },
            content: KnowledgeEntryContentInput {
                title: post.title.clone(),
                text: if post.content.is_empty() {
                    None
                } else {
                    Some(post.content.clone())
                },
                tags: post.tags.clone(),
                stats: Some(KnowledgeEntryStatsInput {
                    likes: Some(post.stats.likes),
                    collects: Some(post.stats.collects),
                }),
                ..Default::default()
            },
            options: KnowledgeIngestOptionsInput {
                dedupe_key: Some(format!("platform:{}:{}", platform, post.id)),
                ..Default::default()
            },
            ..Default::default()
        };
        if ingest_entry(None, state, &request).is_ok() {
            projected.push(post.id.clone());
        }
    }

    if projected.len() > before {
        let _ = write_json_pretty(&tracking_path, &json!({"projectedPostIds": projected}));
    }
}

fn platform_domain(platform: &str) -> String {
    match platform.to_lowercase().as_str() {
        "xiaohongshu" | "red" | "小红书" => "xiaohongshu.com".to_string(),
        "douyin" | "tiktok" | "抖音" => "douyin.com".to_string(),
        "weibo" | "微博" => "weibo.com".to_string(),
        "bilibili" | "b站" => "bilibili.com".to_string(),
        "zhihu" | "知乎" => "zhihu.com".to_string(),
        "wechat" | "微信" => "weixin.qq.com".to_string(),
        "kuaishou" | "快手" => "kuaishou.com".to_string(),
        other => format!("{}.com", other),
    }
}

fn platform_note_kind(platform: &str) -> String {
    match platform.to_lowercase().as_str() {
        "xiaohongshu" | "red" | "小红书" => "xhs-note".to_string(),
        "douyin" | "tiktok" | "抖音" => "douyin-video".to_string(),
        "bilibili" | "b站" => "bilibili-video".to_string(),
        "kuaishou" | "快手" => "kuaishou-video".to_string(),
        "zhihu" | "知乎" => "article".to_string(),
        "wechat" | "微信" => "wechat-article".to_string(),
        "weibo" | "微博" => "x-post".to_string(),
        _ => "text-note".to_string(),
    }
}

fn backfill_profile_json(
    account_root: &Path,
    model: &DistillationModel,
    ai_result: Option<&Value>,
    generated_at: &str,
) -> Result<(), String> {
    let profile_path = account_root.join("profile.json");
    let mut profile = read_json_value(&profile_path).unwrap_or_else(|| json!({}));

    let positioning = ai_result
        .and_then(|ai| ai.get("strategyLayer"))
        .and_then(|s| s.get("contentPillars"))
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(|s| format!("以{}为核心的创作者", s))
        .unwrap_or_else(|| {
            model
                .topic_tags
                .first()
                .map(|t| format!("以#{}为主要创作方向的账号", t.name))
                .unwrap_or_else(|| "内容创作者".to_string())
        });

    let audience = ai_result
        .and_then(|ai| ai.get("cognitiveLayer"))
        .and_then(|c| c.get("valuePositions"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "对相关内容感兴趣的读者".to_string());

    let content_pillars: Vec<String> = ai_result
        .and_then(|ai| ai.get("strategyLayer"))
        .and_then(|s| s.get("contentPillars"))
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_else(|| {
            model
                .topic_tags
                .iter()
                .take(5)
                .map(|t| format!("#{}", t.name))
                .collect()
        });

    let tone_tags: Vec<String> = ai_result
        .and_then(|ai| ai.get("contentLayer"))
        .and_then(|c| c.get("ctaStyle"))
        .and_then(|s| s.as_str())
        .map(|cta| {
            let mut tags = vec![cta.to_string()];
            if let Some(first_title) = model.title_patterns.first() {
                tags.push(first_title.name.clone());
            }
            tags
        })
        .unwrap_or_else(|| {
            model
                .title_patterns
                .iter()
                .take(3)
                .map(|t| t.name.clone())
                .collect()
        });

    let forbidden_topics: Vec<String> = ai_result
        .and_then(|ai| ai.get("guardrails"))
        .and_then(|g| g.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.get("rule")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_else(|| {
            model
                .guardrails
                .iter()
                .take(5)
                .map(|g| g.trim_start_matches("- ").to_string())
                .collect()
        });

    if let Value::Object(ref mut map) = profile {
        map.insert("positioning".to_string(), json!(positioning));
        map.insert("audience".to_string(), json!(audience));
        map.insert("contentPillars".to_string(), json!(content_pillars));
        map.insert("toneTags".to_string(), json!(tone_tags));
        map.insert("forbiddenTopics".to_string(), json!(forbidden_topics));
        map.insert("profileUpdatedAt".to_string(), json!(generated_at));
    }

    write_json_pretty(&profile_path, &profile)
}
