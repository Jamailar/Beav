use super::source_normalizers::{derive_note_title, normalize_entry_kind, truncated_plain_text};
use super::{
    ingest_entry, normalize_string, normalize_vec, note_entry_dir_for_kind, note_entry_id,
    refresh_knowledge_projection_and_emit, source_domain_from_input, source_link_from_input,
    KnowledgeEntryAssetsInput, KnowledgeEntryContentInput, KnowledgeEntryIngestRequest,
    KnowledgeEntryStatsInput, KnowledgeIngestOptionsInput, KnowledgeSourceInput,
};
use crate::{now_iso, read_json_value_or, write_json_value, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeEntryImportV2Request {
    pub space_id: Option<String>,
    pub source: KnowledgeSourceInput,
    pub note: XhsKnowledgeNoteInput,
    pub comments: XhsKnowledgeCommentsInput,
    pub options: KnowledgeIngestOptionsInput,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeAuthorInput {
    pub user_id: Option<String>,
    pub nickname: Option<String>,
    pub profile_url: Option<String>,
    pub avatar_url: Option<String>,
    pub is_note_author: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeNoteInput {
    pub note_id: Option<String>,
    pub note_type: Option<String>,
    pub r#type: Option<String>,
    pub title: Option<String>,
    pub author: Option<XhsKnowledgeAuthorInput>,
    pub author_name: Option<String>,
    pub author_id: Option<String>,
    pub author_profile_url: Option<String>,
    pub author_avatar_url: Option<String>,
    pub text: Option<String>,
    pub content: Option<String>,
    pub stats: Option<KnowledgeEntryStatsInput>,
    pub assets: Option<KnowledgeEntryAssetsInput>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeCommentContentInput {
    pub text: Option<String>,
    pub segments: Vec<Value>,
    pub emoji_urls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeCommentMetricsInput {
    pub likes: Option<i64>,
    pub replies: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeCommentTimeInput {
    pub display: Option<String>,
    pub normalized_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeCommentInput {
    pub id: Option<String>,
    pub comment_id: Option<String>,
    pub platform_comment_id: Option<String>,
    pub note_id: Option<String>,
    pub parent_comment_id: Option<String>,
    pub root_comment_id: Option<String>,
    pub level: Option<i64>,
    pub author: Option<XhsKnowledgeAuthorInput>,
    pub content: Option<XhsKnowledgeCommentContentInput>,
    pub text: Option<String>,
    pub metrics: Option<XhsKnowledgeCommentMetricsInput>,
    pub likes: Option<i64>,
    pub replies: Option<i64>,
    pub time: Option<XhsKnowledgeCommentTimeInput>,
    pub created_at: Option<String>,
    pub location: Option<String>,
    pub captured_at: Option<String>,
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct XhsKnowledgeCommentsInput {
    pub total_text: Option<String>,
    pub total: Option<i64>,
    pub visible_count: Option<i64>,
    pub has_more: Option<bool>,
    pub items: Vec<XhsKnowledgeCommentInput>,
}

fn xhs_author_value(author: Option<&XhsKnowledgeAuthorInput>, field: &str) -> Option<String> {
    author.and_then(|item| match field {
        "userId" => normalize_string(item.user_id.clone()),
        "nickname" => normalize_string(item.nickname.clone()),
        "profileUrl" => normalize_string(item.profile_url.clone()),
        "avatarUrl" => normalize_string(item.avatar_url.clone()),
        _ => None,
    })
}

fn xhs_note_has_payload(note: &XhsKnowledgeNoteInput) -> bool {
    normalize_string(note.note_id.clone()).is_some()
        || normalize_string(note.title.clone()).is_some()
        || normalize_string(note.text.clone()).is_some()
        || normalize_string(note.content.clone()).is_some()
}

fn xhs_comments_has_payload(comments: &XhsKnowledgeCommentsInput) -> bool {
    !comments.items.is_empty()
        || comments.total.is_some()
        || comments.visible_count.is_some()
        || normalize_string(comments.total_text.clone()).is_some()
}

fn xhs_note_entry_kind(note: &XhsKnowledgeNoteInput) -> String {
    let note_type = normalize_string(note.note_type.clone())
        .or_else(|| normalize_string(note.r#type.clone()))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if note_type == "video" || note_type == "xhs-video" {
        "xhs-video".to_string()
    } else {
        "xhs-note".to_string()
    }
}

fn xhs_v2_note_id(request: &XhsKnowledgeEntryImportV2Request) -> Option<String> {
    normalize_string(request.note.note_id.clone())
        .or_else(|| normalize_string(request.source.external_id.clone()))
        .or_else(|| {
            source_link_from_input(&request.source)
                .as_deref()
                .map(note_entry_id)
        })
}

fn xhs_v2_entry_request(
    request: &XhsKnowledgeEntryImportV2Request,
) -> Result<KnowledgeEntryIngestRequest, String> {
    let note_id = xhs_v2_note_id(request);
    let source_link = source_link_from_input(&request.source);
    let source_domain = source_domain_from_input(&request.source)
        .or_else(|| Some("www.xiaohongshu.com".to_string()));
    let note_kind = xhs_note_entry_kind(&request.note);
    let text = normalize_string(request.note.text.clone())
        .or_else(|| normalize_string(request.note.content.clone()));
    let author = request.note.author.as_ref();
    let author_name = xhs_author_value(author, "nickname")
        .or_else(|| normalize_string(request.note.author_name.clone()));
    let author_id = xhs_author_value(author, "userId")
        .or_else(|| normalize_string(request.note.author_id.clone()));
    let author_profile_url = xhs_author_value(author, "profileUrl")
        .or_else(|| normalize_string(request.note.author_profile_url.clone()));
    let author_avatar_url = xhs_author_value(author, "avatarUrl")
        .or_else(|| normalize_string(request.note.author_avatar_url.clone()));
    let assets = request.note.assets.clone().unwrap_or_default();
    let mut options = request.options.clone();
    if options
        .dedupe_key
        .as_ref()
        .and_then(|value| normalize_string(Some(value.clone())))
        .is_none()
    {
        options.dedupe_key = note_id.clone().or_else(|| source_link.clone());
    }
    let comment_total = request
        .comments
        .total
        .or(request.comments.visible_count)
        .or_else(|| {
            if request.comments.items.is_empty() {
                None
            } else {
                Some(request.comments.items.len() as i64)
            }
        });
    let mut stats = request.note.stats.clone().unwrap_or_default();
    if stats.comments.is_none() {
        stats.comments = comment_total;
    }
    let note_type = normalize_string(request.note.note_type.clone())
        .or_else(|| normalize_string(request.note.r#type.clone()))
        .unwrap_or_else(|| {
            if note_kind == "xhs-video" {
                "video".to_string()
            } else {
                "image".to_string()
            }
        });
    let metadata = json!({
        "xhs": {
            "apiVersion": 2,
            "noteId": note_id.clone(),
            "noteType": note_type,
        }
    });

    if !xhs_note_has_payload(&request.note) {
        return Err("xhs knowledge import v2 缺少 note 内容".to_string());
    }

    Ok(KnowledgeEntryIngestRequest {
        space_id: request.space_id.clone(),
        kind: note_kind,
        source: KnowledgeSourceInput {
            source_link: source_link.clone(),
            source_url: source_link,
            source_domain,
            external_id: note_id,
            captured_at: request.source.captured_at.clone(),
            app_id: request.source.app_id.clone(),
            plugin_id: request.source.plugin_id.clone(),
        },
        content: KnowledgeEntryContentInput {
            title: normalize_string(request.note.title.clone())
                .unwrap_or_else(|| "小红书内容".to_string()),
            author: author_name,
            author_id,
            author_profile_url,
            author_avatar_url,
            text: text.clone(),
            excerpt: text
                .as_deref()
                .map(|value| truncated_plain_text(value, 180)),
            description: text
                .as_deref()
                .map(|value| truncated_plain_text(value, 500)),
            site_name: Some("www.xiaohongshu.com".to_string()),
            tags: vec!["小红书".to_string()],
            stats: Some(stats),
            metadata: Some(metadata),
            ..Default::default()
        },
        assets,
        options,
    })
}

fn normalize_xhs_comment_id(item: &XhsKnowledgeCommentInput, fallback_seed: &str) -> String {
    normalize_string(item.id.clone())
        .or_else(|| normalize_string(item.comment_id.clone()))
        .or_else(|| normalize_string(item.platform_comment_id.clone()))
        .unwrap_or_else(|| note_entry_id(fallback_seed))
}

fn xhs_comment_text(item: &XhsKnowledgeCommentInput) -> Option<String> {
    item.content
        .as_ref()
        .and_then(|content| normalize_string(content.text.clone()))
        .or_else(|| normalize_string(item.text.clone()))
}

fn normalized_xhs_comment_values(
    comments: &XhsKnowledgeCommentsInput,
    note_id: &str,
    captured_at: &str,
) -> Vec<Value> {
    comments
        .items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let text = xhs_comment_text(item)?;
            let author = item.author.as_ref();
            let author_name = xhs_author_value(author, "nickname");
            let fallback_seed = format!(
                "{}:{}:{}:{}",
                note_id,
                author_name.clone().unwrap_or_default(),
                text,
                index
            );
            let comment_id = normalize_xhs_comment_id(item, &fallback_seed);
            let parent_comment_id = normalize_string(item.parent_comment_id.clone());
            let root_comment_id = normalize_string(item.root_comment_id.clone())
                .or_else(|| parent_comment_id.clone())
                .unwrap_or_else(|| comment_id.clone());
            let level = item
                .level
                .unwrap_or_else(|| if parent_comment_id.is_some() { 1 } else { 0 });
            let metrics = item.metrics.clone().unwrap_or_default();
            let time = item.time.clone().unwrap_or_default();
            Some(json!({
                "id": comment_id,
                "platformCommentId": normalize_string(item.platform_comment_id.clone())
                    .or_else(|| normalize_string(item.comment_id.clone()))
                    .unwrap_or_else(|| comment_id.clone()),
                "noteId": normalize_string(item.note_id.clone()).unwrap_or_else(|| note_id.to_string()),
                "parentCommentId": parent_comment_id,
                "rootCommentId": root_comment_id,
                "level": level,
                "author": {
                    "userId": xhs_author_value(author, "userId"),
                    "nickname": author_name,
                    "profileUrl": xhs_author_value(author, "profileUrl"),
                    "avatarUrl": xhs_author_value(author, "avatarUrl"),
                    "isNoteAuthor": author.and_then(|value| value.is_note_author).unwrap_or(false),
                },
                "content": {
                    "text": text,
                    "segments": item.content.as_ref().map(|value| value.segments.clone()).unwrap_or_default(),
                    "emojiUrls": item.content.as_ref().map(|value| normalize_vec(value.emoji_urls.clone())).unwrap_or_default(),
                },
                "metrics": {
                    "likes": metrics.likes.or(item.likes).unwrap_or(0),
                    "replies": metrics.replies.or(item.replies).unwrap_or(0),
                },
                "time": {
                    "display": normalize_string(time.display),
                    "normalizedAt": normalize_string(time.normalized_at),
                },
                "location": normalize_string(item.location.clone()),
                "capturedAt": normalize_string(item.captured_at.clone()).unwrap_or_else(|| captured_at.to_string()),
            }))
        })
        .collect()
}

fn xhs_comment_markdown_line(index: usize, item: &Value) -> String {
    let author = item
        .pointer("/author/nickname")
        .and_then(Value::as_str)
        .unwrap_or("未知用户");
    let location = item.get("location").and_then(Value::as_str).unwrap_or("");
    let time = item
        .pointer("/time/display")
        .and_then(Value::as_str)
        .unwrap_or("");
    let likes = item
        .pointer("/metrics/likes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let replies = item
        .pointer("/metrics/replies")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let text = item
        .pointer("/content/text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let meta = [
        author.to_string(),
        location.to_string(),
        time.to_string(),
        if likes > 0 {
            format!("赞 {likes}")
        } else {
            String::new()
        },
        if replies > 0 {
            format!("回复 {replies}")
        } else {
            String::new()
        },
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let indent = if item.get("level").and_then(Value::as_i64).unwrap_or(0) > 0 {
        "  "
    } else {
        ""
    };
    format!("{indent}{}. {}\n{indent}{}", index + 1, meta, text)
}

fn xhs_comments_markdown(
    title: &str,
    total: i64,
    visible_count: i64,
    has_more: bool,
    comments: &[Value],
) -> String {
    let mut lines = vec![
        format!("# {} - 评论快照", title.trim()),
        String::new(),
        format!(
            "共 {} 条评论，已采集 {} 条{}。",
            total,
            visible_count,
            if has_more {
                "，页面仍有未展开评论"
            } else {
                ""
            }
        ),
    ];
    if !comments.is_empty() {
        lines.push(String::new());
        lines.extend(
            comments
                .iter()
                .enumerate()
                .map(|(index, item)| xhs_comment_markdown_line(index, item)),
        );
    }
    lines.join("\n\n")
}

fn persist_xhs_comments_for_entry(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    entry_id: &str,
    note_kind: &str,
    note_title: &str,
    request: &XhsKnowledgeEntryImportV2Request,
) -> Result<Option<Value>, String> {
    if request.comments.items.is_empty() {
        return Ok(None);
    }
    let entry_dir = note_entry_dir_for_kind(state, note_kind, entry_id)?;
    let captured_at = normalize_string(request.source.captured_at.clone()).unwrap_or_else(now_iso);
    let note_id = xhs_v2_note_id(request).unwrap_or_else(|| entry_id.to_string());
    let comments = normalized_xhs_comment_values(&request.comments, &note_id, &captured_at);
    let total = request
        .comments
        .total
        .or_else(|| {
            normalize_string(request.comments.total_text.clone()).and_then(|text| {
                let digits = text
                    .chars()
                    .filter(|ch| ch.is_ascii_digit())
                    .collect::<String>();
                digits.parse::<i64>().ok()
            })
        })
        .unwrap_or(comments.len() as i64);
    let visible_count = request
        .comments
        .visible_count
        .unwrap_or(comments.len() as i64);
    let has_more = request.comments.has_more.unwrap_or(total > visible_count);
    let top_level = comments
        .iter()
        .filter(|item| item.get("level").and_then(Value::as_i64).unwrap_or(0) == 0)
        .count() as i64;
    let replies = comments.len() as i64 - top_level;
    let comments_doc = json!({
        "schemaVersion": 1,
        "platform": "xiaohongshu",
        "noteId": note_id,
        "entryId": entry_id,
        "sourceLink": source_link_from_input(&request.source),
        "total": total,
        "visibleCount": visible_count,
        "hasMore": has_more,
        "capturedAt": captured_at,
        "comments": comments,
    });
    write_json_value(&entry_dir.join("comments.json"), &comments_doc)?;
    fs::write(
        entry_dir.join("comments.md"),
        xhs_comments_markdown(
            note_title,
            total,
            visible_count,
            has_more,
            comments_doc
                .get("comments")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        ),
    )
    .map_err(|error| error.to_string())?;

    let meta_path = entry_dir.join("meta.json");
    let mut meta = read_json_value_or(&meta_path, json!({}));
    if let Some(object) = meta.as_object_mut() {
        let mut metadata = object
            .remove("metadata")
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        if let Some(metadata_object) = metadata.as_object_mut() {
            let mut xhs = metadata_object
                .remove("xhs")
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            if let Some(xhs_object) = xhs.as_object_mut() {
                xhs_object.insert(
                    "comments".to_string(),
                    json!({
                        "total": total,
                        "captured": visible_count,
                        "topLevel": top_level,
                        "replies": replies,
                        "hasMore": has_more,
                        "file": "comments.json",
                        "markdownFile": "comments.md",
                        "capturedAt": captured_at,
                    }),
                );
            }
            metadata_object.insert("xhs".to_string(), xhs);
        }
        object.insert("metadata".to_string(), metadata);
        object.insert("updatedAt".to_string(), json!(now_iso()));
    }
    write_json_value(&meta_path, &meta)?;
    refresh_knowledge_projection_and_emit(
        app,
        state,
        Some((
            "knowledge:note-updated",
            json!({
                "noteId": entry_id,
                "kind": note_kind,
                "hasComments": true,
            }),
        )),
    )?;
    Ok(Some(json!({
        "total": total,
        "captured": visible_count,
        "topLevel": top_level,
        "replies": replies,
        "hasMore": has_more,
        "file": "comments.json",
        "markdownFile": "comments.md",
    })))
}

pub(crate) fn ingest_xhs_entry_v2(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &XhsKnowledgeEntryImportV2Request,
) -> Result<Value, String> {
    let has_note_payload = xhs_note_has_payload(&request.note);
    let has_comments_payload = xhs_comments_has_payload(&request.comments);
    if !has_note_payload && !has_comments_payload {
        return Err("xhs knowledge import v2 payload 不能为空".to_string());
    }
    if !has_note_payload {
        return Err("xhs knowledge import v2 当前需要 note 内容才能保存评论".to_string());
    }

    let note_request = xhs_v2_entry_request(request)?;
    let note_kind = normalize_entry_kind(&note_request.kind);
    let note_title = derive_note_title(&note_request, &note_kind);
    let note_response = ingest_entry(app, state, &note_request)?;
    let entry_id = note_response
        .get("entryId")
        .and_then(Value::as_str)
        .ok_or_else(|| "xhs knowledge import v2 未返回 entryId".to_string())?
        .to_string();
    let comments =
        persist_xhs_comments_for_entry(app, state, &entry_id, &note_kind, &note_title, request)?;
    Ok(json!({
        "success": true,
        "platform": "xiaohongshu",
        "apiVersion": 2,
        "stub": false,
        "persisted": true,
        "entryId": entry_id,
        "kind": note_kind,
        "duplicate": note_response.get("duplicate").and_then(Value::as_bool).unwrap_or(false),
        "updated": note_response.get("updated").and_then(Value::as_bool).unwrap_or(false),
        "comments": comments,
        "received": {
            "spaceId": request.space_id,
            "sourceLink": source_link_from_input(&request.source),
            "sourceDomain": source_domain_from_input(&request.source),
            "hasNote": has_note_payload,
            "hasComments": has_comments_payload,
            "allowUpdate": request.options.allow_update,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xhs_entry_v2_request_maps_note_and_comments_to_contract() {
        let request: XhsKnowledgeEntryImportV2Request = serde_json::from_value(json!({
            "source": {
                "sourceLink": "https://www.xiaohongshu.com/explore/demo",
                "capturedAt": "2026-06-05T00:00:00Z"
            },
            "note": {
                "noteId": "demo",
                "noteType": "image",
                "title": "demo",
                "author": {
                    "userId": "author-1",
                    "nickname": "Nano",
                    "profileUrl": "https://www.xiaohongshu.com/user/profile/author-1",
                    "avatarUrl": "https://example.com/avatar.jpg"
                },
                "text": "正文 #标签",
                "stats": {
                    "likes": 5,
                    "collects": 2
                },
                "assets": {
                    "coverUrl": "https://example.com/cover.jpg",
                    "imageUrls": ["https://example.com/cover.jpg"]
                }
            },
            "comments": {
                "total": 23,
                "visibleCount": 2,
                "hasMore": true,
                "items": [
                    {
                        "id": "6a1d7019000000002a0277af",
                        "author": {
                            "userId": "user-1",
                            "nickname": "Z派大鑫",
                            "profileUrl": "https://www.xiaohongshu.com/user/profile/user-1",
                            "avatarUrl": "https://example.com/u1.jpg"
                        },
                        "content": {
                            "text": "[呃R]我以为你这么火的产品，应该不止 8000+用户吧",
                            "segments": [{ "type": "text", "text": "[呃R]" }],
                            "emojiUrls": ["https://example.com/emoji.png"]
                        },
                        "metrics": { "likes": 3, "replies": 2 },
                        "time": { "display": "3天前" },
                        "location": "广东"
                    },
                    {
                        "id": "6a1d721c000000002a007525",
                        "parentCommentId": "6a1d7019000000002a0277af",
                        "author": {
                            "userId": "author-1",
                            "nickname": "Nano",
                            "isNoteAuthor": true
                        },
                        "content": { "text": "哈哈哈哈哈" },
                        "time": { "display": "3天前" },
                        "location": "重庆"
                    }
                ]
            }
        }))
        .expect("request should parse");

        let entry = xhs_v2_entry_request(&request).expect("request should map");
        let comments =
            normalized_xhs_comment_values(&request.comments, "demo", "2026-06-05T00:00:00Z");

        assert_eq!(entry.kind, "xhs-note");
        assert_eq!(entry.options.dedupe_key.as_deref(), Some("demo"));
        assert_eq!(entry.source.external_id.as_deref(), Some("demo"));
        assert_eq!(entry.content.author.as_deref(), Some("Nano"));
        assert_eq!(entry.content.author_id.as_deref(), Some("author-1"));
        assert_eq!(
            entry
                .content
                .stats
                .as_ref()
                .and_then(|stats| stats.comments),
            Some(23)
        );
        assert_eq!(
            entry.assets.cover_url.as_deref(),
            Some("https://example.com/cover.jpg")
        );
        assert_eq!(comments.len(), 2);
        assert_eq!(
            comments[0]
                .pointer("/author/nickname")
                .and_then(Value::as_str),
            Some("Z派大鑫")
        );
        assert_eq!(
            comments[0]
                .pointer("/metrics/likes")
                .and_then(Value::as_i64),
            Some(3)
        );
        assert_eq!(
            comments[1].get("parentCommentId").and_then(Value::as_str),
            Some("6a1d7019000000002a0277af")
        );
        assert_eq!(
            comments[1]
                .pointer("/author/isNoteAuthor")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn xhs_entry_v2_rejects_empty_payload_shape() {
        let request = XhsKnowledgeEntryImportV2Request::default();
        assert!(!xhs_note_has_payload(&request.note));
        assert!(!xhs_comments_has_payload(&request.comments));
    }
}
