use super::*;

pub(super) fn note_content_markdown(content: &KnowledgeEntryContentInput) -> Option<String> {
    normalize_string(content.text.clone())
        .or_else(|| normalize_string(content.description.clone()))
        .or_else(|| normalize_string(content.excerpt.clone()))
}

pub(super) fn normalize_entry_kind(kind: &str) -> String {
    match kind.trim() {
        "text" => "text-note".to_string(),
        other => other.to_string(),
    }
}

const SOCIAL_ENTRY_KINDS: &[&str] = &[
    "bilibili-video",
    "bilibili-profile",
    "bilibili-search",
    "bilibili-page",
    "kuaishou-video",
    "kuaishou-page",
    "tiktok-video",
    "tiktok-page",
    "reddit-post",
    "reddit-page",
    "x-post",
    "x-page",
    "instagram-post",
    "instagram-page",
];

pub(super) fn is_supported_social_entry_kind(kind: &str) -> bool {
    SOCIAL_ENTRY_KINDS.contains(&kind)
}

pub(super) fn note_meta_type(kind: &str) -> String {
    if kind == "text-note" {
        "text".to_string()
    } else {
        kind.to_string()
    }
}

pub(super) fn truncated_plain_text(value: &str, max_chars: usize) -> String {
    let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = trimmed.chars();
    let compact = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

pub(super) fn title_from_source_url(source_url: &str) -> Option<String> {
    let parsed = Url::parse(source_url).ok()?;
    let last_segment = parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).last())
        .unwrap_or_default();
    let stem = Path::new(last_segment)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    stem.or_else(|| parsed.host_str().map(ToString::to_string))
}

pub(super) fn derive_note_title(
    request: &KnowledgeEntryIngestRequest,
    normalized_kind: &str,
) -> String {
    if let Some(title) = normalize_string(Some(request.content.title.clone())) {
        return title;
    }
    for candidate in [
        request.content.excerpt.clone(),
        request.content.text.clone(),
        request.content.description.clone(),
        request.content.summary.clone(),
        request.content.transcript.clone(),
    ] {
        if let Some(value) = normalize_string(candidate) {
            return truncated_plain_text(&value, 48);
        }
    }
    if let Some(source_url) = source_link_from_input(&request.source) {
        if let Some(title) = title_from_source_url(&source_url) {
            return title;
        }
    }
    if normalized_kind == "text-note" {
        "未命名文本摘录".to_string()
    } else {
        "未命名知识内容".to_string()
    }
}

pub(super) fn derive_note_author(
    request: &KnowledgeEntryIngestRequest,
    normalized_kind: &str,
) -> String {
    normalize_string(request.content.author.clone()).unwrap_or_else(|| {
        if normalized_kind == "text-note" {
            "文本摘录".to_string()
        } else if source_link_from_input(&request.source).is_some() {
            "原文链接".to_string()
        } else {
            "手动导入".to_string()
        }
    })
}

pub(super) fn zhihu_answer_url(
    question_id: Option<&str>,
    answer_id: &str,
    fallback: Option<&str>,
) -> Option<String> {
    fallback.map(ToString::to_string).or_else(|| {
        question_id.map(|id| format!("https://www.zhihu.com/question/{id}/answer/{answer_id}"))
    })
}

pub(super) fn zhihu_answer_text(request: &ZhihuAnswerIngestRequest) -> String {
    let question_title = normalize_string(Some(request.question.title.clone()))
        .unwrap_or_else(|| "知乎问题".to_string());
    let question_detail = normalize_string(request.question.detail.clone());
    let answer_text = normalize_string(request.answer.text.clone())
        .or_else(|| normalize_string(request.answer.excerpt.clone()))
        .unwrap_or_default();
    let mut sections = vec![format!("# {question_title}")];
    if let Some(detail) = question_detail {
        sections.push(format!("## 问题描述\n{detail}"));
    }
    sections.push(format!("## 最高赞回答\n{answer_text}"));
    sections.join("\n\n")
}

pub(super) fn zhihu_answer_metadata(
    request: &ZhihuAnswerIngestRequest,
    answer_url: Option<&str>,
    question_url: Option<&str>,
) -> Value {
    json!({
        "zhihu": {
            "contentType": "answer",
            "question": {
                "id": normalize_string(request.question.id.clone()),
                "url": question_url,
                "title": normalize_string(Some(request.question.title.clone())),
                "detail": normalize_string(request.question.detail.clone()),
                "topics": normalize_vec(request.question.topics.clone()),
                "followers": request.question.followers,
                "views": request.question.views,
            },
            "answer": {
                "id": normalize_string(Some(request.answer.id.clone())),
                "url": answer_url,
                "publishedAt": normalize_string(request.answer.published_at.clone()),
                "updatedAt": normalize_string(request.answer.updated_at.clone()),
                "location": normalize_string(request.answer.location.clone()),
                "stats": {
                    "upvotes": request.answer.stats.upvotes,
                    "comments": request.answer.stats.comments,
                    "collects": request.answer.stats.collects,
                    "likes": request.answer.stats.likes,
                },
            }
        }
    })
}

pub(crate) fn zhihu_answer_to_entry_request(
    request: &ZhihuAnswerIngestRequest,
) -> Result<KnowledgeEntryIngestRequest, String> {
    let answer_id = normalize_string(Some(request.answer.id.clone()))
        .ok_or_else(|| "zhihu answer 缺少 answer.id".to_string())?;
    let question_title = normalize_string(Some(request.question.title.clone()))
        .ok_or_else(|| "zhihu answer 缺少 question.title".to_string())?;
    let answer_text = normalize_string(request.answer.text.clone())
        .or_else(|| normalize_string(request.answer.excerpt.clone()));
    let answer_html = normalize_string(request.answer.html.clone());
    if answer_text.is_none() && answer_html.is_none() {
        return Err("zhihu answer 缺少 answer.text 或 answer.html".to_string());
    }

    let question_id = normalize_string(request.question.id.clone());
    let answer_url = zhihu_answer_url(
        question_id.as_deref(),
        &answer_id,
        normalize_string(request.answer.url.clone())
            .or_else(|| source_link_from_input(&request.source))
            .as_deref(),
    );
    let question_url = normalize_string(request.question.url.clone()).or_else(|| {
        question_id
            .as_ref()
            .map(|id| format!("https://www.zhihu.com/question/{id}"))
    });
    let mut source = request.source.clone();
    source.source_domain = source
        .source_domain
        .clone()
        .or_else(|| Some("www.zhihu.com".to_string()));
    source.source_link = source.source_link.clone().or_else(|| answer_url.clone());
    source.source_url = source.source_url.clone().or_else(|| answer_url.clone());
    source.external_id = source
        .external_id
        .clone()
        .or_else(|| Some(answer_id.clone()));

    let tags = {
        let mut values = vec!["知乎".to_string(), "知乎回答".to_string()];
        values.extend(normalize_vec(request.question.topics.clone()));
        values
    };
    let text = zhihu_answer_text(request);
    let excerpt = normalize_string(request.answer.excerpt.clone())
        .or_else(|| answer_text.clone())
        .map(|value| truncated_plain_text(&value, 180));
    let metadata = zhihu_answer_metadata(request, answer_url.as_deref(), question_url.as_deref());
    let options = KnowledgeIngestOptionsInput {
        dedupe_key: request
            .options
            .dedupe_key
            .clone()
            .or_else(|| Some(format!("zhihu-answer:{answer_id}"))),
        allow_update: request.options.allow_update,
        summarize: request.options.summarize,
        transcribe: false,
    };

    Ok(KnowledgeEntryIngestRequest {
        space_id: request.space_id.clone(),
        kind: "zhihu-answer".to_string(),
        source,
        content: KnowledgeEntryContentInput {
            title: question_title,
            author: normalize_string(Some(request.answer.author.name.clone())),
            author_id: normalize_string(request.answer.author.id.clone()),
            author_url: normalize_string(request.answer.author.url.clone()),
            author_profile_url: normalize_string(request.answer.author.url.clone()),
            author_avatar_url: normalize_string(request.answer.author.avatar_url.clone()),
            author_description: normalize_string(request.answer.author.headline.clone()),
            text: Some(text),
            excerpt,
            html: answer_html,
            description: normalize_string(request.question.detail.clone()),
            site_name: Some("知乎".to_string()),
            tags,
            stats: Some(KnowledgeEntryStatsInput {
                likes: request.answer.stats.upvotes.or(request.answer.stats.likes),
                collects: request.answer.stats.collects,
                comments: request.answer.stats.comments,
            }),
            metadata: Some(metadata),
            ..KnowledgeEntryContentInput::default()
        },
        assets: KnowledgeEntryAssetsInput::default(),
        options,
    })
}

pub(super) fn zhihu_article_url(article_id: &str, fallback: Option<&str>) -> Option<String> {
    fallback
        .map(ToString::to_string)
        .or_else(|| Some(format!("https://zhuanlan.zhihu.com/p/{article_id}")))
}

pub(super) fn zhihu_article_text(request: &ZhihuArticleIngestRequest) -> String {
    let title = normalize_string(Some(request.article.title.clone()))
        .unwrap_or_else(|| "知乎专栏文章".to_string());
    let text = normalize_string(request.article.text.clone())
        .or_else(|| normalize_string(request.article.excerpt.clone()))
        .unwrap_or_default();
    format!("# {title}\n\n{text}")
}

pub(super) fn zhihu_article_metadata(
    request: &ZhihuArticleIngestRequest,
    article_url: Option<&str>,
) -> Value {
    json!({
        "zhihu": {
            "contentType": "article",
            "article": {
                "id": normalize_string(Some(request.article.id.clone())),
                "url": article_url,
                "title": normalize_string(Some(request.article.title.clone())),
                "publishedAt": normalize_string(request.article.published_at.clone()),
                "updatedAt": normalize_string(request.article.updated_at.clone()),
                "location": normalize_string(request.article.location.clone()),
                "stats": {
                    "upvotes": request.article.stats.upvotes,
                    "comments": request.article.stats.comments,
                    "collects": request.article.stats.collects,
                    "likes": request.article.stats.likes
                }
            },
            "column": {
                "id": normalize_string(request.article.column.id.clone()),
                "name": normalize_string(request.article.column.name.clone()),
                "url": normalize_string(request.article.column.url.clone()),
                "description": normalize_string(request.article.column.description.clone()),
                "coverUrl": normalize_string(request.article.column.cover_url.clone())
            }
        }
    })
}

pub(crate) fn zhihu_article_to_entry_request(
    request: &ZhihuArticleIngestRequest,
) -> Result<KnowledgeEntryIngestRequest, String> {
    let article_id = normalize_string(Some(request.article.id.clone()))
        .ok_or_else(|| "zhihu article 缺少 article.id".to_string())?;
    let title = normalize_string(Some(request.article.title.clone()))
        .ok_or_else(|| "zhihu article 缺少 article.title".to_string())?;
    let article_text = normalize_string(request.article.text.clone())
        .or_else(|| normalize_string(request.article.excerpt.clone()));
    let article_html = normalize_string(request.article.html.clone());
    if article_text.is_none() && article_html.is_none() {
        return Err("zhihu article 缺少 article.text 或 article.html".to_string());
    }

    let article_url = zhihu_article_url(
        &article_id,
        normalize_string(request.article.url.clone()).as_deref(),
    );
    let mut source = request.source.clone();
    source.source_domain = source
        .source_domain
        .clone()
        .or_else(|| Some("zhuanlan.zhihu.com".to_string()));
    source.source_link = source.source_link.clone().or_else(|| article_url.clone());
    source.source_url = source.source_url.clone().or_else(|| article_url.clone());
    source.external_id = source
        .external_id
        .clone()
        .or_else(|| Some(article_id.clone()));
    let mut tags = vec!["知乎".to_string(), "知乎文章".to_string()];
    if let Some(column_name) = normalize_string(request.article.column.name.clone()) {
        tags.push(column_name);
    }
    let excerpt = normalize_string(request.article.excerpt.clone())
        .or_else(|| article_text.clone())
        .map(|value| truncated_plain_text(&value, 180));
    let metadata = zhihu_article_metadata(request, article_url.as_deref());
    let options = KnowledgeIngestOptionsInput {
        dedupe_key: request
            .options
            .dedupe_key
            .clone()
            .or_else(|| Some(format!("zhihu-article:{article_id}"))),
        allow_update: request.options.allow_update,
        summarize: request.options.summarize,
        transcribe: false,
    };

    Ok(KnowledgeEntryIngestRequest {
        space_id: request.space_id.clone(),
        kind: "zhihu-article".to_string(),
        source,
        content: KnowledgeEntryContentInput {
            title,
            author: normalize_string(Some(request.article.author.name.clone())),
            author_id: normalize_string(request.article.author.id.clone()),
            author_url: normalize_string(request.article.author.url.clone()),
            author_profile_url: normalize_string(request.article.author.url.clone()),
            author_avatar_url: normalize_string(request.article.author.avatar_url.clone()),
            author_description: normalize_string(request.article.author.headline.clone()),
            text: Some(zhihu_article_text(request)),
            excerpt,
            html: article_html,
            site_name: Some("知乎专栏".to_string()),
            tags,
            stats: Some(KnowledgeEntryStatsInput {
                likes: request
                    .article
                    .stats
                    .upvotes
                    .or(request.article.stats.likes),
                collects: request.article.stats.collects,
                comments: request.article.stats.comments,
            }),
            metadata: Some(metadata),
            ..KnowledgeEntryContentInput::default()
        },
        assets: KnowledgeEntryAssetsInput {
            cover_url: normalize_string(request.article.cover_url.clone()),
            image_urls: normalize_vec(request.article.image_urls.clone()),
            ..KnowledgeEntryAssetsInput::default()
        },
        options,
    })
}

pub(super) fn resolve_note_seed(request: &KnowledgeEntryIngestRequest) -> String {
    normalize_string(request.source.external_id.clone())
        .or_else(|| normalize_string(request.options.dedupe_key.clone()))
        .or_else(|| source_link_from_input(&request.source))
        .or_else(|| normalize_string(Some(request.content.title.clone())))
        .or_else(|| normalize_string(request.content.excerpt.clone()))
        .or_else(|| normalize_string(request.content.text.clone()))
        .unwrap_or_else(|| make_id("knowledge"))
}
