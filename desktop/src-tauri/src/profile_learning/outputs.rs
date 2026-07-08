use super::evidence::NormalizedPost;
use super::quality::quality_ready_for_runtime;
use super::{DistillationModel, PatternStat};
use crate::json_util::{json_string, write_json_pretty};
use crate::truncate_chars;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub(crate) fn write_evidence_pack(
    distillation_root: &Path,
    profile: &Value,
    posts: &[NormalizedPost],
    model: &DistillationModel,
    schema_version: i64,
    generated_at: &str,
) -> Result<(), String> {
    let evidence_posts = posts
        .iter()
        .take(80)
        .map(|post| {
            json!({
                "id": post.id,
                "title": post.title,
                "contentExcerpt": truncate_chars(&post.content, 900),
                "url": post.url,
                "publishedAt": post.published_at,
                "kind": post.kind,
                "tags": post.tags,
                "stats": post.stats,
                "mediaCount": post.media_count,
            })
        })
        .collect::<Vec<_>>();
    write_json_pretty(
        &distillation_root.join("evidence-pack.json"),
        &json!({
            "schemaVersion": schema_version,
            "sourceType": "own_account",
            "generatedAt": generated_at,
            "profile": profile,
            "posts": evidence_posts,
            "opinionCandidates": model.opinion_candidates,
            "topPosts": model.top_posts.iter().map(|post| post.id.clone()).collect::<Vec<_>>(),
        }),
    )
}

pub(crate) fn write_stats(
    distillation_root: &Path,
    model: &DistillationModel,
    schema_version: i64,
    generated_at: &str,
) -> Result<(), String> {
    write_json_pretty(
        &distillation_root.join("stats.json"),
        &json!({
            "schemaVersion": schema_version,
            "generatedAt": generated_at,
            "postCount": model.post_count,
            "contentCompleteCount": model.content_complete_count,
            "titlePatterns": model.title_patterns,
            "openingPatterns": model.opening_patterns,
            "ctaPatterns": model.cta_patterns,
            "topicTags": model.topic_tags,
            "valueWords": model.value_words,
        }),
    )
}

pub(crate) fn write_quality_report(
    distillation_root: &Path,
    model: &DistillationModel,
    schema_version: i64,
    generated_at: &str,
) -> Result<(), String> {
    let completeness = if model.post_count == 0 {
        0.0
    } else {
        (model.content_complete_count as f64 / model.post_count as f64 * 100.0).round() / 100.0
    };
    write_json_pretty(
        &distillation_root.join("quality-report.json"),
        &json!({
            "schemaVersion": schema_version,
            "generatedAt": generated_at,
            "sourceType": "own_account",
            "sampleSize": model.post_count,
            "contentCompleteness": completeness,
            "hasTitlePatterns": !model.title_patterns.is_empty(),
            "hasOpinionCandidates": !model.opinion_candidates.is_empty(),
            "hasStyleRules": !model.style_rules.is_empty(),
            "hasGuardrails": !model.guardrails.is_empty(),
            "readyForRuntime": quality_ready_for_runtime(model),
            "warnings": model.quality_warnings,
        }),
    )
}

pub(crate) fn write_data_draft(
    distillation_root: &Path,
    profile: &Value,
    model: &DistillationModel,
    generated_at: &str,
) -> Result<(), String> {
    let username = json_string(profile, "username").unwrap_or_else(|| "未命名账号".to_string());
    let mut lines = vec![
        format!("# @{username} 数据底稿"),
        String::new(),
        format!("生成时间：{generated_at}"),
        "来源类型：用户自己的运营账号".to_string(),
        String::new(),
        "## 基础统计".to_string(),
        format!("- 已导入内容：{} 条", model.post_count),
        format!("- 正文完整内容：{} 条", model.content_complete_count),
        String::new(),
        "## 内容支柱".to_string(),
        render_pattern_list(&model.topic_tags, "暂无稳定内容支柱。"),
        String::new(),
        "## 标题模式".to_string(),
        render_pattern_list(&model.title_patterns, "暂无稳定标题模式。"),
        String::new(),
        "## 开头模式".to_string(),
        render_pattern_list(&model.opening_patterns, "暂无稳定开头模式。"),
        String::new(),
        "## CTA 模式".to_string(),
        render_pattern_list(&model.cta_patterns, "较少使用显式 CTA。"),
        String::new(),
        "## 观点句候选".to_string(),
    ];
    if model.opinion_candidates.is_empty() {
        lines.push("- 暂无。".to_string());
    } else {
        for item in &model.opinion_candidates {
            lines.push(format!(
                "- [{}] {} — 《{}》({}赞)",
                item.match_type, item.sentence, item.source_title, item.source_likes
            ));
        }
    }
    lines.push(String::new());
    lines.push("## TOP 内容".to_string());
    for post in model.top_posts.iter().take(10) {
        lines.push(format!(
            "- 《{}》：赞 {} / 藏 {} / 评 {}",
            if post.title.trim().is_empty() {
                "未命名内容"
            } else {
                &post.title
            },
            post.stats.likes,
            post.stats.collects,
            post.stats.comments
        ));
    }
    fs::write(distillation_root.join("data-draft.md"), lines.join("\n"))
        .map_err(|error| error.to_string())
}

fn render_pattern_list(items: &[PatternStat], placeholder: &str) -> String {
    if items.is_empty() {
        return format!("- {placeholder}");
    }
    items
        .iter()
        .map(|item| {
            let examples = if item.examples.is_empty() {
                String::new()
            } else {
                format!("；示例：{}", item.examples.join(" / "))
            };
            format!(
                "- {}：{} 次，占比 {}%{}",
                item.name, item.count, item.percent, examples
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
