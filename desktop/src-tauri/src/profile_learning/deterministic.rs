use super::evidence::NormalizedPost;
use super::{DistillationModel, MemoryCandidateDraft, OpinionCandidate, PatternStat};
use crate::truncate_chars;
use std::collections::{BTreeMap, HashMap};

pub(crate) fn detect_title_patterns(posts: &[NormalizedPost]) -> Vec<PatternStat> {
    let patterns = [
        (
            "数字型",
            ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].as_slice(),
        ),
        (
            "疑问型",
            ["?", "？", "怎么", "如何", "为什么", "什么"].as_slice(),
        ),
        (
            "教程型",
            ["教程", "手把手", "保姆级", "步骤", "方法", "攻略"].as_slice(),
        ),
        (
            "避坑提醒型",
            ["避坑", "别", "不要", "千万", "踩坑"].as_slice(),
        ),
        (
            "经验复盘型",
            ["经验", "心得", "复盘", "总结", "分享"].as_slice(),
        ),
        (
            "强语气型",
            ["太", "真的", "绝了", "必须", "建议"].as_slice(),
        ),
    ];
    pattern_stats(posts, &patterns, |post| post.title.as_str())
}

pub(crate) fn detect_opening_patterns(posts: &[NormalizedPost]) -> Vec<PatternStat> {
    let patterns = [
        (
            "故事开头",
            ["那天", "有一次", "最近", "上周", "去年", "刚开始"].as_slice(),
        ),
        (
            "反问开头",
            ["你有没有", "你是不是", "为什么", "难道", "吗"].as_slice(),
        ),
        (
            "观点直抛",
            ["我觉得", "我认为", "其实", "本质上", "说白了"].as_slice(),
        ),
        (
            "结果先行",
            ["终于", "已经", "拿到", "做到了", "涨了"].as_slice(),
        ),
        (
            "教程直入",
            ["今天", "分享", "教你", "步骤", "方法"].as_slice(),
        ),
    ];
    pattern_stats(posts, &patterns, |post| {
        post.content
            .char_indices()
            .nth(80)
            .map(|(index, _)| &post.content[..index])
            .unwrap_or(post.content.as_str())
    })
}

pub(crate) fn detect_cta_patterns(posts: &[NormalizedPost]) -> Vec<PatternStat> {
    let patterns = [
        ("收藏引导", ["收藏", "码住", "先存", "mark"].as_slice()),
        (
            "评论引导",
            ["评论", "留言", "告诉我", "你们觉得"].as_slice(),
        ),
        ("关注引导", ["关注", "点个关注", "持续更新"].as_slice()),
        ("私信引导", ["私信", "后台", "回复"].as_slice()),
    ];
    pattern_stats(posts, &patterns, |post| post.content.as_str())
}

fn pattern_stats<F>(
    posts: &[NormalizedPost],
    patterns: &[(&str, &[&str])],
    text_for_post: F,
) -> Vec<PatternStat>
where
    F: Fn(&NormalizedPost) -> &str,
{
    let mut output = Vec::new();
    for (name, keywords) in patterns {
        let mut examples = Vec::new();
        let mut count = 0_usize;
        for post in posts {
            let text = text_for_post(post);
            if keywords.iter().any(|keyword| text.contains(keyword)) {
                count += 1;
                if examples.len() < 3 {
                    examples.push(non_empty_or(&post.title, &truncate_chars(text, 40)).to_string());
                }
            }
        }
        if count > 0 {
            output.push(PatternStat {
                name: name.to_string(),
                count,
                percent: percent(count, posts.len()),
                examples,
            });
        }
    }
    output.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    output
}

pub(crate) fn detect_topic_tags(posts: &[NormalizedPost]) -> Vec<PatternStat> {
    let mut counts = BTreeMap::<String, (usize, Vec<String>)>::new();
    for post in posts {
        for tag in &post.tags {
            let tag = tag.trim().trim_start_matches('#');
            if tag.is_empty() {
                continue;
            }
            let entry = counts
                .entry(tag.to_string())
                .or_insert_with(|| (0, Vec::new()));
            entry.0 += 1;
            if entry.1.len() < 3 {
                entry.1.push(post.title.clone());
            }
        }
    }
    let mut items = counts
        .into_iter()
        .map(|(name, (count, examples))| PatternStat {
            name,
            count,
            percent: percent(count, posts.len()),
            examples,
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    items.truncate(12);
    items
}

pub(crate) fn top_posts(posts: &[NormalizedPost], limit: usize) -> Vec<NormalizedPost> {
    let mut items = posts.to_vec();
    items.sort_by(|left, right| {
        engagement_score(right)
            .cmp(&engagement_score(left))
            .then_with(|| right.stats.likes.cmp(&left.stats.likes))
    });
    items.truncate(limit);
    items
}

fn engagement_score(post: &NormalizedPost) -> i64 {
    post.stats.likes + post.stats.collects * 2 + post.stats.comments * 3 + post.stats.shares * 4
}

pub(crate) fn extract_opinion_candidates(posts: &[NormalizedPost]) -> Vec<OpinionCandidate> {
    let keyword_groups = [
        (
            "判断词",
            [
                "我觉得",
                "我认为",
                "其实",
                "本质上",
                "说白了",
                "核心是",
                "关键在于",
            ]
            .as_slice(),
        ),
        (
            "转折",
            ["但其实", "然而", "与其", "看起来", "实际上", "不是"].as_slice(),
        ),
        (
            "总结",
            ["所以", "因此", "这说明", "这意味着", "总结一下", "换句话说"].as_slice(),
        ),
    ];
    let mut output = Vec::new();
    for post in posts {
        for sentence in split_sentences(&post.content) {
            if sentence.chars().count() < 8 {
                continue;
            }
            for (match_type, keywords) in &keyword_groups {
                if keywords.iter().any(|keyword| sentence.contains(keyword)) {
                    output.push(OpinionCandidate {
                        sentence: truncate_chars(&sentence, 120),
                        source_post_id: post.id.clone(),
                        source_title: truncate_chars(&post.title, 40),
                        source_likes: post.stats.likes,
                        match_type: (*match_type).to_string(),
                    });
                    break;
                }
            }
            if output.len() >= 40 {
                return output;
            }
        }
    }
    output
}

pub(crate) fn extract_value_words(posts: &[NormalizedPost]) -> Vec<PatternStat> {
    let stopwords = [
        "时候", "自己", "觉得", "一个", "一些", "一下", "一样", "一直", "一起", "可以", "没有",
        "什么", "这个", "那个", "这样", "如果", "因为", "所以", "但是", "然后", "还是", "已经",
        "非常", "真的", "感觉", "知道", "现在", "时间", "东西", "事情", "问题", "方法", "内容",
        "大家", "我们", "他们", "很多", "一点", "其实", "只是",
    ];
    let mut counts = HashMap::<String, usize>::new();
    for post in posts {
        let mut text = post.content.replace('#', " ");
        text.push(' ');
        text.push_str(&post.title);
        for token in text.split(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '，' | '。'
                        | '！'
                        | '？'
                        | '、'
                        | '；'
                        | '：'
                        | '"'
                        | '\''
                        | '（'
                        | '）'
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                        | '《'
                        | '》'
                        | '-'
                        | '/'
                )
        }) {
            let token = token.trim();
            let len = token.chars().count();
            if !(2..=6).contains(&len) || stopwords.contains(&token) {
                continue;
            }
            if !token
                .chars()
                .all(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
            {
                continue;
            }
            *counts.entry(token.to_string()).or_insert(0) += 1;
        }
    }
    let mut items = counts
        .into_iter()
        .map(|(name, count)| PatternStat {
            name,
            count,
            percent: percent(count, posts.len().max(1)),
            examples: Vec::new(),
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.cmp(&right.name))
    });
    items.truncate(15);
    items
}

pub(crate) fn derive_structure_rules(posts: &[NormalizedPost]) -> Vec<String> {
    if posts.is_empty() {
        return Vec::new();
    }
    let avg_len = posts
        .iter()
        .map(|post| post.content.chars().count())
        .sum::<usize>()
        / posts.len().max(1);
    let list_count = posts
        .iter()
        .filter(|post| {
            post.content.contains("1.")
                || post.content.contains("1、")
                || post.content.contains('①')
        })
        .count();
    let mut rules = Vec::new();
    if avg_len >= 450 {
        rules.push(format!(
            "- 历史正文平均约 {avg_len} 字，偏信息密度型；生成内容时要保留分段、步骤和具体细节。"
        ));
    } else if avg_len >= 180 {
        rules.push(format!(
            "- 历史正文平均约 {avg_len} 字，适合中等长度的经验分享；避免把观点写成过短口号。"
        ));
    } else {
        rules.push(format!(
            "- 历史正文平均约 {avg_len} 字，偏短表达；生成内容时用核心观点先行，避免长篇铺陈。"
        ));
    }
    if list_count * 3 >= posts.len() {
        rules.push("- 历史内容经常使用列表/编号结构，适合把方法拆成可执行步骤。".to_string());
    }
    rules
}

pub(crate) fn derive_style_rules(
    posts: &[NormalizedPost],
    model: &DistillationModel,
) -> Vec<String> {
    let mut rules = Vec::new();
    if let Some(top) = model.title_patterns.first() {
        rules.push(format!(
            "- 标题优先参考「{}」模式；历史样本中出现 {} 次，占比 {}%。",
            top.name, top.count, top.percent
        ));
    }
    if let Some(opening) = model.opening_patterns.first() {
        rules.push(format!(
            "- 开头可优先采用「{}」；先给读者一个明确进入点，再展开细节。",
            opening.name
        ));
    }
    if !model.topic_tags.is_empty() {
        let topics = model
            .topic_tags
            .iter()
            .take(5)
            .map(|item| format!("#{}", item.name))
            .collect::<Vec<_>>()
            .join(" ");
        rules.push(format!("- 选题优先围绕已验证的内容支柱：{topics}。"));
    }
    if model.cta_patterns.is_empty() && posts.len() >= 5 {
        rules.push("- 历史内容较少依赖显式 CTA，优先让正文自身具备收藏或评论价值。".to_string());
    }
    if rules.is_empty() && posts.len() >= 3 {
        rules.push("- 保持历史内容中反复出现的主题和表达方式，避免突然切换账号人设。".to_string());
    }
    rules
}

pub(crate) fn derive_media_rules(posts: &[NormalizedPost]) -> Vec<String> {
    if posts.is_empty() {
        return Vec::new();
    }
    let with_media = posts.iter().filter(|post| post.media_count > 0).count();
    let videos = posts
        .iter()
        .filter(|post| post.kind.contains("video") || post.media_count > 1)
        .count();
    let mut rules = Vec::new();
    if with_media * 2 >= posts.len() {
        rules.push(
            "- 历史内容经常依赖图片或视频素材，生成稿件时同步规划封面、画面和脚本。".to_string(),
        );
    }
    if videos * 3 >= posts.len() {
        rules.push("- 视频/多媒体内容占比较高，脚本要把前三秒钩子和画面承接写清楚。".to_string());
    }
    rules
}

pub(crate) fn derive_guardrails(
    posts: &[NormalizedPost],
    model: &DistillationModel,
) -> Vec<String> {
    let mut rules = vec![
        "- 不要编造该账号从未表达过的个人经历、数据或产品效果。".to_string(),
        "- 不要把外部对标账号的风格误当成本账号风格。".to_string(),
    ];
    if model.cta_patterns.is_empty() && posts.len() >= 5 {
        rules.push(
            "- 不要突然加入大量\u{201C}点赞收藏关注\u{201D}等强 CTA，历史内容并不依赖这种口吻。"
                .to_string(),
        );
    }
    if !model.opinion_candidates.is_empty() {
        rules.push(
            "- 不要把单条内容里的观点过度上升为账号长期立场；至少需要多条证据支撑。".to_string(),
        );
    }
    rules
}

pub(crate) fn derive_opportunities(model: &DistillationModel) -> Vec<String> {
    let mut items = Vec::new();
    if let Some(topic) = model.topic_tags.first() {
        items.push(format!(
            "- 围绕 #{} 做更细的系列化选题，把历史高频主题拆成入门、进阶、案例、复盘四类。",
            topic.name
        ));
    }
    if let Some(title) = model.title_patterns.first() {
        items.push(format!(
            "- 用「{}」标题模式复用到新的细分问题上，验证是否仍然稳定。",
            title.name
        ));
    }
    if items.is_empty() {
        items.push("- 继续导入更多历史内容后，再生成更具体的选题机会。".to_string());
    }
    items
}

pub(crate) fn derive_memory_candidates(model: &DistillationModel) -> Vec<MemoryCandidateDraft> {
    let evidence = model
        .top_posts
        .iter()
        .take(5)
        .map(|post| post.id.clone())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for rule in model.style_rules.iter().take(4) {
        candidates.push(MemoryCandidateDraft {
            kind: "account_preference".to_string(),
            text: rule.trim_start_matches("- ").to_string(),
            confidence: 0.74,
            evidence_post_ids: evidence.clone(),
        });
    }
    for guardrail in model.guardrails.iter().take(3) {
        candidates.push(MemoryCandidateDraft {
            kind: "account_guardrail".to_string(),
            text: guardrail.trim_start_matches("- ").to_string(),
            confidence: 0.7,
            evidence_post_ids: evidence.clone(),
        });
    }
    candidates
}

fn split_sentences(value: &str) -> Vec<String> {
    value
        .split(|ch| matches!(ch, '。' | '！' | '？' | '\n' | '!' | '?'))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn percent(count: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        (count as f64 / total as f64 * 1000.0).round() / 10.0
    }
}

fn non_empty_or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}
