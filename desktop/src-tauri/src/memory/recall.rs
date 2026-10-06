use tauri::State;

use super::index::{recall_memory_matches_indexed, MemorySearchOptions};
use super::types::{MemoryRecallItem, MemoryRecallSummary};
use crate::memory::store::list_active_memories;
use crate::persistence::with_store;
use crate::{payload_string, truncate_chars, AppState};

pub(crate) fn recall_memory_matches(
    state: &State<'_, AppState>,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryRecallItem>, String> {
    if !query.trim().is_empty() {
        let options = MemorySearchOptions {
            query: query.to_string(),
            limit,
            ..MemorySearchOptions::default()
        };
        if let Ok(items) = recall_memory_matches_indexed(state, &options) {
            if !items.is_empty() {
                return Ok(items);
            }
        }
    }
    with_store(state, |store| {
        let lowered_query = query.trim().to_lowercase();
        let mut items = list_active_memories(&store)
            .into_iter()
            .filter_map(|item| {
                let mut score = 0.0_f64;
                let mut reasons = Vec::<String>::new();
                if lowered_query.is_empty() {
                    score = 0.35;
                    reasons.push("recent".to_string());
                } else {
                    if item.content.to_lowercase().contains(&lowered_query) {
                        score += 0.9;
                        reasons.push("content".to_string());
                    }
                    if item.r#type.to_lowercase().contains(&lowered_query) {
                        score += 0.4;
                        reasons.push("type".to_string());
                    }
                    if item
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&lowered_query))
                    {
                        score += 0.5;
                        reasons.push("tags".to_string());
                    }
                }
                if score <= 0.0 {
                    return None;
                }
                Some(MemoryRecallItem {
                    id: item.id,
                    memory_type: item.r#type,
                    content_preview: truncate_chars(item.content.trim(), 180),
                    score,
                    match_reasons: reasons,
                    tags: item.tags,
                    updated_at: item.updated_at.unwrap_or(item.created_at),
                })
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(right.updated_at.cmp(&left.updated_at))
        });
        items.truncate(limit.max(1));
        Ok(items)
    })
}

pub(crate) fn build_memory_recall_summary(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    limit: usize,
) -> Result<MemoryRecallSummary, String> {
    let query = with_store(state, |store| {
        let session_query = session_id
            .and_then(|id| {
                store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == id)
                    .and_then(|item| item.metadata.as_ref())
            })
            .map(|metadata| {
                [
                    payload_string(metadata, "advisorId"),
                    payload_string(metadata, "contextType"),
                    payload_string(metadata, "intent"),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
            })
            .unwrap_or_default();
        let query = [runtime_mode.to_string(), session_query]
            .into_iter()
            .filter(|item| !item.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let total_active = list_active_memories(&store).len();
        Ok((query, total_active))
    })?;
    let items = recall_memory_matches(state, &query.0, limit)?;
    let rendered_summary = if items.is_empty() {
        "当前没有可注入的长期记忆。".to_string()
    } else {
        items
            .iter()
            .map(|item| format!("- [{}] {}", item.memory_type, item.content_preview))
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(MemoryRecallSummary {
        query: query.0,
        total_active: query.1,
        matched_count: items.len(),
        items,
        rendered_summary,
    })
}

#[cfg(test)]
mod tests {
    use crate::{now_i64, AppStore, UserMemoryRecord};

    #[test]
    fn recall_matches_rank_content_and_tags() {
        let now = now_i64();
        let store = AppStore {
            memories: vec![
                UserMemoryRecord {
                    id: "memory-1".to_string(),
                    content: "用户长期偏好讲实操和复盘".to_string(),
                    r#type: "creator-profile".to_string(),
                    tags: vec!["复盘".to_string()],
                    entities: Vec::new(),
                    scope: Some("user".to_string()),
                    space_id: None,
                    project_id: None,
                    session_id: None,
                    source: None,
                    confidence: Some(0.75),
                    created_at: now,
                    updated_at: Some(now),
                    last_accessed: None,
                    status: Some("active".to_string()),
                    archived_at: None,
                    archive_reason: None,
                    origin_id: None,
                    canonical_key: None,
                    revision: Some(1),
                    last_conflict_at: None,
                },
                UserMemoryRecord {
                    id: "memory-2".to_string(),
                    content: "普通背景信息".to_string(),
                    r#type: "general".to_string(),
                    tags: vec!["其他".to_string()],
                    entities: Vec::new(),
                    scope: Some("user".to_string()),
                    space_id: None,
                    project_id: None,
                    session_id: None,
                    source: None,
                    confidence: Some(0.75),
                    created_at: now - 1,
                    updated_at: Some(now - 1),
                    last_accessed: None,
                    status: Some("active".to_string()),
                    archived_at: None,
                    archive_reason: None,
                    origin_id: None,
                    canonical_key: None,
                    revision: Some(1),
                    last_conflict_at: None,
                },
            ],
            ..AppStore::default()
        };
        let items = crate::memory::store::list_active_memories(&store);
        assert_eq!(items.len(), 2);
        let mut matches = items
            .into_iter()
            .filter_map(|item| {
                if item.content.contains("复盘") || item.tags.iter().any(|tag| tag == "复盘") {
                    Some(item.id)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        matches.sort();
        assert_eq!(matches, vec!["memory-1".to_string()]);
    }
}
