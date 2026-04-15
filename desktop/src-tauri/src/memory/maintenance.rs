use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{make_id, now_i64, now_iso, AppStore, MemoryHistoryRecord};

use super::store::{canonical_memory_key, memory_is_active, normalize_memory_record};
use super::types::MEMORY_TYPE_TASK_LEARNING;

const TASK_LEARNING_STALE_AFTER_MS: i64 = 45 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MemoryMaintenanceSummary {
    pub normalized: i64,
    pub deduped: i64,
    pub compressed: i64,
    pub archived_task_learnings: i64,
    pub updated_at: String,
}

fn push_history(store: &mut AppStore, memory_id: &str, action: &str, reason: &str) {
    store.memory_history.push(MemoryHistoryRecord {
        id: make_id("memory-history"),
        memory_id: memory_id.to_string(),
        origin_id: memory_id.to_string(),
        action: action.to_string(),
        reason: Some(reason.to_string()),
        timestamp: now_i64(),
        before: None,
        after: None,
        archived_memory_id: None,
    });
}

pub fn apply_structured_memory_maintenance(store: &mut AppStore) -> MemoryMaintenanceSummary {
    let mut summary = MemoryMaintenanceSummary {
        updated_at: now_iso(),
        ..MemoryMaintenanceSummary::default()
    };

    for item in &mut store.memories {
        if normalize_memory_record(item) {
            item.last_maintained_at = Some(now_i64());
            summary.normalized += 1;
        }
        if item
            .summary
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
            && item.content.chars().count() > 280
        {
            item.summary = Some(crate::truncate_chars(item.content.trim(), 220));
            item.last_maintained_at = Some(now_i64());
            summary.compressed += 1;
        }
        if item.canonical_key.is_none() {
            item.canonical_key = Some(canonical_memory_key(
                &item.content,
                &item.tags,
                &item.r#type,
            ));
        }
    }

    let mut seen = std::collections::HashMap::<String, String>::new();
    let mut dedupe_actions = Vec::new();
    for item in &mut store.memories {
        if !memory_is_active(item) {
            continue;
        }
        let key = item
            .canonical_key
            .clone()
            .unwrap_or_else(|| canonical_memory_key(&item.content, &item.tags, &item.r#type));
        if let Some(existing_id) = seen.get(&key) {
            item.status = Some("archived".to_string());
            item.archived_at = Some(now_i64());
            item.archive_reason = Some("dedupe".to_string());
            item.last_maintained_at = Some(now_i64());
            dedupe_actions.push((item.id.clone(), format!("duplicate-of:{existing_id}")));
            summary.deduped += 1;
        } else {
            seen.insert(key, item.id.clone());
        }
    }
    for (memory_id, reason) in &dedupe_actions {
        push_history(store, memory_id, "dedupe", reason);
    }

    let now = now_i64();
    let mut archive_ids = Vec::new();
    for item in &mut store.memories {
        if !memory_is_active(item) {
            continue;
        }
        if item.r#type == MEMORY_TYPE_TASK_LEARNING {
            let updated_at = item.updated_at.unwrap_or(item.created_at);
            if now.saturating_sub(updated_at) > TASK_LEARNING_STALE_AFTER_MS {
                item.status = Some("archived".to_string());
                item.archived_at = Some(now);
                item.archive_reason = Some("stale-task-learning".to_string());
                item.last_maintained_at = Some(now);
                archive_ids.push(item.id.clone());
                summary.archived_task_learnings += 1;
            }
        }
    }
    for memory_id in archive_ids {
        push_history(store, &memory_id, "archive", "stale-task-learning");
    }
    for (memory_id, _) in dedupe_actions {
        if store
            .memory_history
            .iter()
            .all(|entry| entry.memory_id != memory_id || entry.action != "compress")
        {
            push_history(store, &memory_id, "compress", "structured-summary");
        }
    }

    summary
}

pub fn build_structured_memory_summary_markdown(memories: &[crate::UserMemoryRecord]) -> String {
    let mut active = memories
        .iter()
        .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
        .cloned()
        .collect::<Vec<_>>();
    active.sort_by(|a, b| {
        b.updated_at
            .unwrap_or(b.created_at)
            .cmp(&a.updated_at.unwrap_or(a.created_at))
    });

    let render_group = |title: &str, memory_type: &str| -> Vec<String> {
        let mut lines = vec![format!("## {title}")];
        let group = active
            .iter()
            .filter(|item| item.r#type == memory_type)
            .take(12)
            .collect::<Vec<_>>();
        if group.is_empty() {
            lines.push("- （暂无）".to_string());
        } else {
            for item in group {
                let summary = item
                    .summary
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| crate::truncate_chars(item.content.trim(), 220));
                lines.push(format!("- {}", summary));
            }
        }
        lines
    };

    [
        "# MEMORY.md".to_string(),
        String::new(),
        format!("自动生成时间：{}", now_iso()),
        String::new(),
        render_group("User Profile", super::types::MEMORY_TYPE_USER_PROFILE).join("\n"),
        String::new(),
        render_group("Workspace Facts", super::types::MEMORY_TYPE_WORKSPACE_FACT).join("\n"),
        String::new(),
        render_group("Task Learnings", super::types::MEMORY_TYPE_TASK_LEARNING).join("\n"),
        String::new(),
        format!(
            "> counts {}",
            json!({
                "userProfile": active.iter().filter(|item| item.r#type == super::types::MEMORY_TYPE_USER_PROFILE).count(),
                "workspaceFacts": active.iter().filter(|item| item.r#type == super::types::MEMORY_TYPE_WORKSPACE_FACT).count(),
                "taskLearnings": active.iter().filter(|item| item.r#type == super::types::MEMORY_TYPE_TASK_LEARNING).count(),
            })
        ),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_memory(
        id: &str,
        content: &str,
        memory_type: &str,
        updated_at: i64,
    ) -> crate::UserMemoryRecord {
        crate::UserMemoryRecord {
            id: id.to_string(),
            content: content.to_string(),
            r#type: memory_type.to_string(),
            tags: Vec::new(),
            created_at: updated_at,
            updated_at: Some(updated_at),
            last_accessed: None,
            status: Some("active".to_string()),
            archived_at: None,
            archive_reason: None,
            origin_id: None,
            canonical_key: None,
            revision: Some(1),
            last_conflict_at: None,
            summary: None,
            scope_key: None,
            source_session_id: None,
            source_checkpoint_id: None,
            source_tool_result_id: None,
            confidence: None,
            expires_at: None,
            last_maintained_at: None,
        }
    }

    #[test]
    fn structured_maintenance_dedupes_and_archives_stale_task_learnings() {
        let now = crate::now_i64();
        let mut store = crate::AppStore::default();
        store
            .memories
            .push(test_memory("m1", "use rg before grep", "general", now));
        store.memories.push(test_memory(
            "m2",
            "use rg before grep",
            "workspace_fact",
            now,
        ));
        store.memories.push(test_memory(
            "m3",
            "old lesson",
            MEMORY_TYPE_TASK_LEARNING,
            now - (46 * 24 * 60 * 60 * 1000),
        ));

        let summary = apply_structured_memory_maintenance(&mut store);
        assert!(summary.deduped >= 1);
        assert!(
            summary.archived_task_learnings >= 1
                || store.memories.iter().any(|item| item.id == "m3"
                    && item.status.as_deref() == Some("archived")
                    && item.archive_reason.as_deref() == Some("stale-task-learning"))
        );
        assert_eq!(
            store
                .memories
                .iter()
                .find(|item| item.id == "m1")
                .map(|item| item.r#type.clone()),
            Some(super::super::types::MEMORY_TYPE_WORKSPACE_FACT.to_string())
        );
    }
}
