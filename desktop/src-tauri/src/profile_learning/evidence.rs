use crate::json_util::{json_string, read_json_value};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub(crate) struct NormalizedPost {
    pub id: String,
    pub title: String,
    pub content: String,
    pub url: String,
    pub published_at: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub stats: PostStats,
    pub media_count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PostStats {
    pub likes: i64,
    pub collects: i64,
    pub comments: i64,
    pub shares: i64,
    pub views: i64,
}

fn json_i64(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|item| {
            item.as_i64().or_else(|| {
                item.as_str()
                    .and_then(|text| text.replace(',', "").parse::<i64>().ok())
            })
        })
        .unwrap_or(0)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn load_account_posts(root: &Path, limit: usize) -> Vec<NormalizedPost> {
    let mut values = Vec::new();
    let Ok(entries) = fs::read_dir(root.join("posts")) else {
        return values;
    };
    for entry in entries.filter_map(Result::ok) {
        if values.len() >= limit {
            break;
        }
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(value) = read_json_value(&entry.path()) {
            values.push(normalize_post(&value));
        }
    }
    values.sort_by(|left, right| {
        right
            .stats
            .likes
            .cmp(&left.stats.likes)
            .then_with(|| right.stats.collects.cmp(&left.stats.collects))
            .then_with(|| left.title.cmp(&right.title))
    });
    values
}

pub(crate) fn normalize_post(value: &Value) -> NormalizedPost {
    let stats = value.get("stats").unwrap_or(&Value::Null);
    let media_count = value
        .get("media")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    NormalizedPost {
        id: json_string(value, "platformPostId")
            .or_else(|| json_string(value, "noteId"))
            .or_else(|| json_string(value, "id"))
            .or_else(|| json_string(value, "url"))
            .unwrap_or_default(),
        title: json_string(value, "title").unwrap_or_default(),
        content: json_string(value, "content")
            .or_else(|| json_string(value, "text"))
            .or_else(|| json_string(value, "description"))
            .unwrap_or_default(),
        url: json_string(value, "url").unwrap_or_default(),
        published_at: json_string(value, "publishedAt").unwrap_or_default(),
        kind: json_string(value, "kind")
            .or_else(|| json_string(value, "type"))
            .unwrap_or_else(|| {
                if media_count > 0 {
                    "media".to_string()
                } else {
                    "post".to_string()
                }
            }),
        tags: string_array(value.get("tags")),
        stats: PostStats {
            likes: json_i64(stats, "likes"),
            collects: json_i64(stats, "collects").max(json_i64(stats, "favorites")),
            comments: json_i64(stats, "comments"),
            shares: json_i64(stats, "shares"),
            views: json_i64(stats, "views"),
        },
        media_count,
    }
}
