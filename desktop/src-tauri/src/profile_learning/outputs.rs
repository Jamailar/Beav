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

pub(crate) fn write_ai_distillation_task(
    distillation_root: &Path,
    profile: &Value,
    model: &DistillationModel,
    generated_at: &str,
) -> Result<(), String> {
    let username = json_string(profile, "username").unwrap_or_else(|| "未命名账号".to_string());
    let text = format!(
        r#"# AI 蒸馏任务：@{username}

生成时间：{generated_at}
模式：B — 用户自己的账号提炼

## 任务

请基于 `evidence-pack.json`、`stats.json` 和 `data-draft.md`，提炼这个账号的长期创作资产。不要编造没有证据的经历、观点或数据。

## 必须输出的判断

1. 认知层：核心信念、观点张力、价值立场、与读者的关系。
2. 策略层：内容支柱、系列化机会、发布/互动习惯、运营 If-Then 准则。
3. 内容层：标题公式、开头模板、正文骨架、CTA、标签、视觉/视频偏好。
4. 创作禁区：至少 3 条，每条必须说明证据或缺失证据。
5. 对比示例：普通版 vs 本账号风格版，说明关键区别。
6. 记忆候选：只保留稳定、跨任务有价值的信息。

## 当前自动分析摘要

- 样本数：{} 条
- 正文完整：{} 条
- Runtime 可用：{}

## 自检标准

- 所有结论都应能追溯到证据内容。
- 标题公式必须有历史标题作为示例。
- 禁区不能写成通用建议。
- 超出样本范围的方向必须标注不确定。
"#,
        model.post_count,
        model.content_complete_count,
        quality_ready_for_runtime(model)
    );
    fs::write(distillation_root.join("ai-distillation-task.md"), text)
        .map_err(|error| error.to_string())
}

pub(crate) fn write_creator_profile_md(
    root: &Path,
    profile: &Value,
    model: &DistillationModel,
    generated_at: &str,
    ai_result: Option<&Value>,
) -> Result<(), String> {
    let path = root.join("CreatorProfile.md");
    let manual_section = preserve_manual_section(&path, "## 人工修订");
    let username = json_string(profile, "username").unwrap_or_else(|| "未命名账号".to_string());
    let platform = json_string(profile, "platform").unwrap_or_default();
    let homepage_url = json_string(profile, "homepageUrl").unwrap_or_default();
    let platform_user_id = json_string(profile, "platformUserId").unwrap_or_default();
    let cognitive_text = if let Some(ai) = ai_result {
        render_ai_cognitive_layer(ai)
    } else {
        render_cognitive_layer(model)
    };
    let pillar_text = if let Some(ai) = ai_result {
        render_ai_content_pillars(ai)
    } else {
        render_pattern_bullets(&model.topic_tags, "暂未识别稳定内容支柱。")
    };
    let title_opening_text = if let Some(ai) = ai_result {
        render_ai_title_and_opening(ai)
    } else {
        render_title_and_opening(model)
    };
    let body_style_text = if let Some(ai) = ai_result {
        render_ai_body_structure(ai)
    } else {
        render_lines(
            &[model.structure_rules.clone(), model.style_rules.clone()].concat(),
            "历史内容不足，暂未形成稳定正文结构。",
        )
    };
    let guardrails_text = if let Some(ai) = ai_result {
        render_ai_guardrails(ai)
    } else {
        render_lines(&model.guardrails, "暂无自动识别的禁区，建议人工补充。")
    };
    let opp_text = if let Some(ai) = ai_result {
        render_ai_opportunities(ai)
    } else {
        render_lines(&model.opportunities, "继续导入更多历史内容后生成。")
    };
    let limitations_text = if let Some(ai) = ai_result {
        render_ai_limitations(ai)
    } else {
        render_lines(
            &model.quality_warnings,
            "样本质量足够支撑当前初步创作档案。",
        )
    };
    let auto_body = format!(
        r#"<!-- redbox:auto:start account-profile -->
更新时间：{generated_at}

## 基础信息
- 平台：{platform}
- 账号：{username}
- 账号 ID：{platform_user_id}
- 主页：{homepage_url}
- 已导入历史内容：{} 条
- 证据包：distillation/evidence-pack.json
- 质量报告：distillation/quality-report.json

## 账号定位
{}

## 认知层
{}

## 内容支柱
{}

## 历史高表现内容
{}

## 标题与开头公式
{}

## 正文结构与语气
{}

## 视觉/视频风格
{}

## 创作禁区
{}

## 下一步内容机会
{}

## 局限性
{}
<!-- redbox:auto:end account-profile -->
"#,
        model.post_count,
        account_profile_lines(profile).join("\n"),
        cognitive_text,
        pillar_text,
        render_top_posts(model),
        title_opening_text,
        body_style_text,
        render_lines(&model.media_rules, "素材信息不足，暂未形成稳定视觉偏好。"),
        guardrails_text,
        opp_text,
        limitations_text,
    );
    let text = format!(
        "# 创作档案：@{username}\n\n{auto_body}\n{}",
        manual_section.unwrap_or_else(|| "## 人工修订\n\n".to_string())
    );
    fs::write(path, text).map_err(|error| error.to_string())
}

pub(crate) fn write_writing_style_skill(
    root: &Path,
    profile: &Value,
    model: &DistillationModel,
    generated_at: &str,
    ai_result: Option<&Value>,
) -> Result<(), String> {
    let skill_root = root.join("writing-style-skill");
    fs::create_dir_all(&skill_root).map_err(|error| error.to_string())?;
    let username = json_string(profile, "username").unwrap_or_else(|| "未命名账号".to_string());
    let platform = json_string(profile, "platform").unwrap_or_default();
    let cognitive_text = if let Some(ai) = ai_result {
        render_ai_cognitive_layer(ai)
    } else {
        render_cognitive_layer(model)
    };
    let strategy_text = if let Some(ai) = ai_result {
        render_ai_strategy_layer(ai)
    } else {
        render_lines(&model.opportunities, "继续导入更多历史内容后生成策略层。")
    };
    let content_text = if let Some(ai) = ai_result {
        render_ai_content_layer(ai)
    } else {
        render_lines(
            &[
                model.style_rules.clone(),
                model.structure_rules.clone(),
                model.media_rules.clone(),
            ]
            .concat(),
            "暂未形成稳定内容层。",
        )
    };
    let guardrails_text = if let Some(ai) = ai_result {
        render_ai_guardrails(ai)
    } else {
        render_lines(
            &model.guardrails,
            "不编造账号历史，不夸大未经证实的数据表现。",
        )
    };
    let contrast_text = if let Some(ai) = ai_result {
        render_ai_contrast_example(ai)
    } else {
        render_contrast_example(model)
    };
    let text = format!(
        r#"---
name: {username}-账号写作风格
description: >
  基于 @{username} 的历史内容提炼而成。当前空间绑定该账号时，用于选题、标题、正文、脚本、改稿和 RedClaw 运营。
---

# 账号写作风格技能：@{username}

更新时间：{generated_at}

## 使用说明

当用户要求为当前空间创作内容时：
1. 先查认知层：这个话题是否符合账号长期立场和价值词。
2. 再查策略层：匹配内容支柱、系列机会和可复用选题方向。
3. 最后查内容层：选择标题模式、开头模板、正文结构和视觉表达。
4. 输出前检查创作禁区，不要编造账号没有表达过的经历或数据。

## 适用范围
- 平台：{platform}
- 这是用户自己的账号风格，不是外部对标博主风格。
- 当用户明确要求临时模仿外部风格时，需要说明会偏离当前账号档案。

## 认知层
{}

## 策略层
{}

## 内容层
{}

## 创作禁区
{}

## 对比示例
{}

## 自检清单
- 是否引用了当前账号的内容支柱？
- 标题是否符合历史标题模式，而不是泛泛标题？
- 正文是否遵守历史长度、结构和语气？
- 是否避免了创作禁区？
- 如果样本没有覆盖该方向，是否标注了不确定性？
"#,
        cognitive_text, strategy_text, content_text, guardrails_text, contrast_text,
    );
    fs::write(skill_root.join("SKILL.md"), text).map_err(|error| error.to_string())
}

pub(crate) fn write_memory_candidates(
    root: &Path,
    profile: &Value,
    model: &DistillationModel,
    schema_version: i64,
    generated_at: &str,
) -> Result<(), String> {
    let account_id = json_string(profile, "id").unwrap_or_default();
    let candidates = model
        .memory_candidates
        .iter()
        .map(|item| {
            json!({
                "kind": item.kind,
                "scope": "space",
                "accountId": account_id,
                "text": item.text,
                "confidence": item.confidence,
                "evidencePostIds": item.evidence_post_ids,
                "source": "profile_learning",
                "status": "pending",
                "createdAt": generated_at,
            })
        })
        .collect::<Vec<_>>();
    write_json_pretty(
        &root.join("memory-candidates.json"),
        &json!({
            "schemaVersion": schema_version,
            "updatedAt": generated_at,
            "candidates": candidates,
        }),
    )
}

pub(crate) fn write_learning_summary_md(
    root: &Path,
    profile: &Value,
    model: &DistillationModel,
    generated_at: &str,
) -> Result<(), String> {
    let username = json_string(profile, "username").unwrap_or_else(|| "未命名账号".to_string());
    let text = format!(
        r#"# 账号学习摘要

账号：@{username}
更新时间：{generated_at}
已导入历史内容：{} 条

## 当前结论
{}

## 证据与质量
- 数据底稿：`distillation/data-draft.md`
- 证据包：`distillation/evidence-pack.json`
- 质量报告：`distillation/quality-report.json`

## 记忆同步
见 `memory-candidates.json`。系统会把稳定、可复用、跨任务有价值的信息同步到长期记忆，并保留候选来源便于复查。
"#,
        model.post_count,
        render_lines(&model.style_rules, "历史内容不足，暂未形成稳定结论。"),
    );
    fs::write(root.join("learning-summary.md"), text).map_err(|error| error.to_string())
}

// --- Deterministic render helpers (fallback) ---

fn render_cognitive_layer(model: &DistillationModel) -> String {
    let mut lines = Vec::new();
    if model.opinion_candidates.is_empty() {
        lines.push("- 暂未提取到足够观点句；先把认知层标记为低置信度。".to_string());
    } else {
        for candidate in model.opinion_candidates.iter().take(5) {
            lines.push(format!(
                "- 观点候选：{}（来源：《{}》，{}赞）",
                candidate.sentence, candidate.source_title, candidate.source_likes
            ));
        }
    }
    if !model.value_words.is_empty() {
        let words = model
            .value_words
            .iter()
            .take(8)
            .map(|item| format!("{}({})", item.name, item.count))
            .collect::<Vec<_>>()
            .join(" / ");
        lines.push(format!("- 高频价值词候选：{words}"));
    }
    lines.join("\n")
}

fn render_top_posts(model: &DistillationModel) -> String {
    if model.top_posts.is_empty() {
        return "- 暂无可排序的高表现内容。".to_string();
    }
    model
        .top_posts
        .iter()
        .take(8)
        .map(|post| {
            format!(
                "- 《{}》：赞 {} / 藏 {} / 评 {}",
                if post.title.trim().is_empty() {
                    "未命名内容"
                } else {
                    &post.title
                },
                post.stats.likes,
                post.stats.collects,
                post.stats.comments
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_title_and_opening(model: &DistillationModel) -> String {
    let mut lines = Vec::new();
    if !model.title_patterns.is_empty() {
        lines.push("标题模式：".to_string());
        lines.push(render_pattern_bullets(&model.title_patterns, ""));
    }
    if !model.opening_patterns.is_empty() {
        lines.push("开头模式：".to_string());
        lines.push(render_pattern_bullets(&model.opening_patterns, ""));
    }
    if lines.is_empty() {
        "- 历史标题和正文不足，暂未形成稳定公式。".to_string()
    } else {
        lines.join("\n")
    }
}

fn render_contrast_example(model: &DistillationModel) -> String {
    let topic = model
        .topic_tags
        .first()
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "一个历史高频主题".to_string());
    let title_pattern = model
        .title_patterns
        .first()
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "清晰具体".to_string());
    format!(
        r#"普通版：
标题：关于{topic}的一些想法
开头：今天聊聊这个话题，希望对你有帮助。

本账号风格版：
标题：用「{title_pattern}」重新包装 {topic} 的具体问题
开头：先给出一个明确判断或真实场景，再展开原因和步骤。

关键区别：普通版只有主题，本账号风格版需要沿用历史内容支柱、标题模式和证据表达。"#
    )
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

fn render_pattern_bullets(items: &[PatternStat], placeholder: &str) -> String {
    if items.is_empty() {
        if placeholder.is_empty() {
            return String::new();
        }
        return format!("- {placeholder}");
    }
    render_pattern_list(items, placeholder)
}

fn render_lines(items: &[String], placeholder: &str) -> String {
    if items.is_empty() {
        format!("- {placeholder}")
    } else {
        items.join("\n")
    }
}

fn account_profile_lines(profile: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(bio) = json_string(profile, "bio") {
        lines.push(format!("- 账号简介：{bio}"));
    }
    if let Some(positioning) = json_string(profile, "positioning") {
        lines.push(format!("- 定位：{positioning}"));
    }
    if lines.is_empty() {
        lines.push("- 暂未形成稳定定位，建议导入更多历史内容后再次学习。".to_string());
    }
    lines
}

fn preserve_manual_section(path: &Path, heading: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let index = text.find(heading)?;
    Some(text[index..].trim_end().to_string() + "\n")
}

// --- AI render helpers ---

fn render_ai_cognitive_layer(ai: &Value) -> String {
    let layer = ai.get("cognitiveLayer").unwrap_or(&Value::Null);
    if layer.is_null() {
        return String::new();
    }
    let mut lines = Vec::new();
    for (label, key) in &[
        ("核心信念", "coreBeliefs"),
        ("观点张力", "opinionTensions"),
        ("价值立场", "valuePositions"),
        ("思维模式", "thinkingPatterns"),
    ] {
        if let Some(items) = layer.get(*key).and_then(|v| v.as_array()) {
            for item in items {
                if let Some(text) = item.as_str() {
                    lines.push(format!("- {label}：{text}"));
                }
            }
        }
    }
    if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n")
    }
}

fn render_ai_content_pillars(ai: &Value) -> String {
    let layer = ai.get("strategyLayer").unwrap_or(&Value::Null);
    if layer.is_null() {
        return "- 暂未识别稳定内容支柱。".to_string();
    }
    if let Some(items) = layer.get("contentPillars").and_then(|v| v.as_array()) {
        if items.is_empty() {
            return "- 暂未识别稳定内容支柱。".to_string();
        }
        return items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|text| format!("- {text}"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    "- 暂未识别稳定内容支柱。".to_string()
}

fn render_ai_title_and_opening(ai: &Value) -> String {
    let layer = ai.get("contentLayer").unwrap_or(&Value::Null);
    if layer.is_null() {
        return "- 暂无 AI 提炼的标题与开头公式。".to_string();
    }
    let mut lines = Vec::new();
    if let Some(formulas) = layer.get("titleFormulas").and_then(|v| v.as_array()) {
        lines.push("标题公式：".to_string());
        for formula in formulas {
            let name = formula
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名");
            let template = formula
                .get("template")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let rate = formula
                .get("usageRate")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            lines.push(format!("- {name}：{template}（使用率 {rate}）"));
        }
    }
    if let Some(templates) = layer.get("openingTemplates").and_then(|v| v.as_array()) {
        lines.push("开头模板：".to_string());
        for template in templates {
            let name = template
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名");
            let tpl = template
                .get("template")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            lines.push(format!("- {name}：{tpl}"));
        }
    }
    if lines.is_empty() {
        "- 暂无 AI 提炼的标题与开头公式。".to_string()
    } else {
        lines.join("\n")
    }
}

fn render_ai_body_structure(ai: &Value) -> String {
    let layer = ai.get("contentLayer").unwrap_or(&Value::Null);
    let mut lines = Vec::new();
    if let Some(structure) = layer.get("bodyStructure").and_then(|v| v.as_str()) {
        if !structure.trim().is_empty() {
            lines.push(format!("- 正文骨架：{structure}"));
        }
    }
    if let Some(cta) = layer.get("ctaStyle").and_then(|v| v.as_str()) {
        if !cta.trim().is_empty() {
            lines.push(format!("- CTA 风格：{cta}"));
        }
    }
    if let Some(tags) = layer.get("tagStrategy").and_then(|v| v.as_str()) {
        if !tags.trim().is_empty() {
            lines.push(format!("- 标签策略：{tags}"));
        }
    }
    if lines.is_empty() {
        "- 暂无 AI 提炼的正文骨架。".to_string()
    } else {
        lines.join("\n")
    }
}

fn render_ai_guardrails(ai: &Value) -> String {
    if let Some(items) = ai.get("guardrails").and_then(|v| v.as_array()) {
        if items.is_empty() {
            return "- 暂无 AI 提炼的创作禁区。".to_string();
        }
        return items
            .iter()
            .map(|item| {
                let rule = item.get("rule").and_then(|v| v.as_str()).unwrap_or("");
                let evidence = item.get("evidence").and_then(|v| v.as_str()).unwrap_or("");
                if evidence.is_empty() {
                    format!("- {rule}")
                } else {
                    format!("- {rule}（证据：{evidence}）")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    "- 暂无 AI 提炼的创作禁区。".to_string()
}

fn render_ai_opportunities(ai: &Value) -> String {
    let layer = ai.get("strategyLayer").unwrap_or(&Value::Null);
    let mut lines = Vec::new();
    if let Some(items) = layer.get("seriesOpportunities").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(text) = item.as_str() {
                lines.push(format!("- 系列机会：{text}"));
            }
        }
    }
    if let Some(items) = layer.get("ifThenRules").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(text) = item.as_str() {
                lines.push(format!("- If-Then 准则：{text}"));
            }
        }
    }
    if let Some(rhythm) = layer.get("postingRhythm").and_then(|v| v.as_str()) {
        if !rhythm.trim().is_empty() {
            lines.push(format!("- 发布节奏：{rhythm}"));
        }
    }
    if lines.is_empty() {
        "- 暂无 AI 提炼的内容机会。".to_string()
    } else {
        lines.join("\n")
    }
}

fn render_ai_limitations(ai: &Value) -> String {
    if let Some(items) = ai.get("limitations").and_then(|v| v.as_array()) {
        if items.is_empty() {
            return "- 暂无 AI 提炼的局限性分析。".to_string();
        }
        return items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|text| format!("- {text}"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    "- 暂无 AI 提炼的局限性分析。".to_string()
}

fn render_ai_strategy_layer(ai: &Value) -> String {
    render_ai_opportunities(ai)
}

fn render_ai_content_layer(ai: &Value) -> String {
    let layer = ai.get("contentLayer").unwrap_or(&Value::Null);
    let mut lines = Vec::new();
    // 标题公式
    if let Some(formulas) = layer.get("titleFormulas").and_then(|v| v.as_array()) {
        if !formulas.is_empty() {
            lines.push("标题公式：".to_string());
            for formula in formulas {
                let name = formula
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名");
                let template = formula
                    .get("template")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                lines.push(format!("- {name}：{template}"));
            }
        }
    }
    // 开头模板
    if let Some(templates) = layer.get("openingTemplates").and_then(|v| v.as_array()) {
        if !templates.is_empty() {
            lines.push("开头模板：".to_string());
            for template in templates {
                let name = template
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名");
                let tpl = template
                    .get("template")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                lines.push(format!("- {name}：{tpl}"));
            }
        }
    }
    // 正文骨架
    if let Some(structure) = layer.get("bodyStructure").and_then(|v| v.as_str()) {
        if !structure.trim().is_empty() {
            lines.push(format!("正文骨架：{structure}"));
        }
    }
    // CTA
    if let Some(cta) = layer.get("ctaStyle").and_then(|v| v.as_str()) {
        if !cta.trim().is_empty() {
            lines.push(format!("CTA 风格：{cta}"));
        }
    }
    // 标签策略
    if let Some(tags) = layer.get("tagStrategy").and_then(|v| v.as_str()) {
        if !tags.trim().is_empty() {
            lines.push(format!("标签策略：{tags}"));
        }
    }
    if lines.is_empty() {
        "- 暂无 AI 提炼的内容层规范。".to_string()
    } else {
        lines.join("\n")
    }
}

fn render_ai_contrast_example(ai: &Value) -> String {
    if let Some(examples) = ai.get("contrastExamples").as_ref() {
        let generic_title = json_string(examples, "genericTitle").unwrap_or_default();
        let style_title = json_string(examples, "accountStyleTitle").unwrap_or_default();
        let generic_opening = json_string(examples, "genericOpening").unwrap_or_default();
        let style_opening = json_string(examples, "accountStyleOpening").unwrap_or_default();
        if !style_title.is_empty() || !style_opening.is_empty() {
            return format!(
                r#"普通版：
标题：{}
开头：{}

本账号风格版：
标题：{}
开头：{}

关键区别：普通版只有主题，本账号风格版需要沿用历史内容支柱、标题模式和证据表达。"#,
                if generic_title.is_empty() {
                    "（未提供）"
                } else {
                    &generic_title
                },
                if generic_opening.is_empty() {
                    "（未提供）"
                } else {
                    &generic_opening
                },
                if style_title.is_empty() {
                    "（未提供）"
                } else {
                    &style_title
                },
                if style_opening.is_empty() {
                    "（未提供）"
                } else {
                    &style_opening
                },
            );
        }
    }
    "- 暂无 AI 提炼的对比示例。".to_string()
}
