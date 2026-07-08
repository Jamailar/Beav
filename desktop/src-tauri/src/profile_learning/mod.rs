use crate::json_util::{json_string, read_json_value, write_json_pretty};
use crate::knowledge::{
    ingest_entry, KnowledgeEntryContentInput, KnowledgeEntryIngestRequest,
    KnowledgeEntryStatsInput, KnowledgeIngestOptionsInput, KnowledgeSourceInput,
};
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

    outputs::write_quality_report(&distillation_root, &model, schema_version, &generated_at)?;

    // 知识索引投影（失败不影响主流程）
    project_posts_to_knowledge(state, account_root, &profile, &posts);

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
                    comments: Some(post.stats.comments),
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
