use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::{
    make_id, now_i64, now_iso, truncate_chars, workspace_root, write_json_value, AppState,
    AppStore, MemoryHistoryRecord, UserMemoryRecord,
};

#[derive(Clone)]
pub(crate) struct MemoryWorkspaceSnapshot {
    pub memories: Vec<UserMemoryRecord>,
    pub memory_history: Vec<MemoryHistoryRecord>,
}

pub(crate) fn memory_workspace_snapshot(store: &AppStore) -> MemoryWorkspaceSnapshot {
    MemoryWorkspaceSnapshot {
        memories: store.memories.clone(),
        memory_history: store.memory_history.clone(),
    }
}

pub(crate) fn memory_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("memory");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn memory_catalog_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("catalog.json"))
}

fn memory_history_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("history.json"))
}

fn memory_summary_markdown(memories: &[UserMemoryRecord]) -> String {
    let mut lines = vec![
        "# MEMORY.md".to_string(),
        "".to_string(),
        format!("自动生成时间：{}", now_iso()),
        "".to_string(),
        "## Active Memories".to_string(),
    ];
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
    if active.is_empty() {
        lines.push("- （暂无）".to_string());
    } else {
        for item in active.iter().take(80) {
            let preview = truncate_chars(item.content.trim(), 220);
            lines.push(format!("- [{}] {}", item.r#type, preview));
        }
    }
    lines.join("\n")
}

pub(crate) fn persist_memory_workspace_state(
    state: &State<'_, AppState>,
    snapshot: &MemoryWorkspaceSnapshot,
) -> Result<(), String> {
    write_json_value(
        &memory_catalog_path(state)?,
        &json!({ "memories": &snapshot.memories }),
    )?;
    write_json_value(
        &memory_history_path(state)?,
        &json!({ "items": &snapshot.memory_history }),
    )?;
    fs::write(
        memory_root(state)?.join("MEMORY.md"),
        memory_summary_markdown(&snapshot.memories),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn list_active_memories(store: &AppStore) -> Vec<UserMemoryRecord> {
    let mut items: Vec<UserMemoryRecord> = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
        .cloned()
        .collect();
    items.sort_by(|a, b| {
        b.updated_at
            .unwrap_or(b.created_at)
            .cmp(&a.updated_at.unwrap_or(a.created_at))
    });
    items
}

pub(crate) fn list_archived_memories(store: &AppStore) -> Vec<UserMemoryRecord> {
    let mut items: Vec<UserMemoryRecord> = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref() == Some("archived"))
        .cloned()
        .collect();
    items.sort_by(|a, b| b.archived_at.unwrap_or(0).cmp(&a.archived_at.unwrap_or(0)));
    items
}

pub(crate) fn list_memory_history(store: &AppStore) -> Vec<MemoryHistoryRecord> {
    let mut items = store.memory_history.clone();
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    items
}

pub(crate) fn search_memory_records(store: &AppStore, query: &str) -> Vec<Value> {
    let lowered_query = query.trim().to_lowercase();
    let mut results = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
        .filter_map(|item| {
            if lowered_query.is_empty() {
                let mut value = json!(item);
                if let Some(object) = value.as_object_mut() {
                    object.insert("score".to_string(), json!(0.5));
                    object.insert("matchReasons".to_string(), json!(["recent"]));
                }
                return Some(value);
            }
            let mut score = 0.0_f64;
            let mut reasons = Vec::<String>::new();
            if item.content.to_lowercase().contains(&lowered_query) {
                score += 0.88;
                reasons.push("content".to_string());
            }
            if item.r#type.to_lowercase().contains(&lowered_query) {
                score += 0.35;
                reasons.push("type".to_string());
            }
            if item
                .tags
                .iter()
                .any(|tag| tag.to_lowercase().contains(&lowered_query))
            {
                score += 0.45;
                reasons.push("tags".to_string());
            }
            if score <= 0.0 {
                return None;
            }
            let mut value = json!(item);
            if let Some(object) = value.as_object_mut() {
                object.insert("score".to_string(), json!(score));
                object.insert("matchReasons".to_string(), json!(reasons));
            }
            Some(value)
        })
        .collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .get("score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .partial_cmp(&left.get("score").and_then(Value::as_f64).unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results
}

pub(crate) fn archive_memory_record(store: &mut AppStore, id: &str, reason: &str) -> bool {
    let Some(item) = store.memories.iter_mut().find(|entry| entry.id == id) else {
        return false;
    };
    item.status = Some("archived".to_string());
    item.archived_at = Some(now_i64());
    item.archive_reason = Some(reason.to_string());
    store.memory_history.push(MemoryHistoryRecord {
        id: make_id("memory-history"),
        memory_id: item.id.clone(),
        origin_id: item.id.clone(),
        action: "archive".to_string(),
        reason: Some(reason.to_string()),
        timestamp: now_i64(),
        before: None,
        after: Some(json!(item.clone())),
        archived_memory_id: Some(item.id.clone()),
    });
    true
}
