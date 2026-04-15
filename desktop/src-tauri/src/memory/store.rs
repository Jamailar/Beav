use serde_json::{json, Value};

use crate::runtime::last_checkpoint_for_session;
use crate::{
    truncate_chars, AppStore, ChatSessionContextRecord, ChatSessionRecord, UserMemoryRecord,
};

use super::types::{
    normalize_memory_type, SessionLineageSummary, MEMORY_TYPE_TASK_LEARNING,
    MEMORY_TYPE_USER_PROFILE, MEMORY_TYPE_WORKSPACE_FACT,
};

pub fn memory_is_active(record: &UserMemoryRecord) -> bool {
    record.status.as_deref().unwrap_or("active") == "active"
}

pub fn normalized_memory_type(record: &UserMemoryRecord) -> String {
    normalize_memory_type(Some(&record.r#type))
}

pub fn normalize_memory_record(record: &mut UserMemoryRecord) -> bool {
    let normalized_type = normalize_memory_type(Some(&record.r#type));
    let canonical_key = record
        .canonical_key
        .clone()
        .unwrap_or_else(|| canonical_memory_key(&record.content, &record.tags, &normalized_type));
    let mut changed = false;
    if record.r#type != normalized_type {
        record.r#type = normalized_type;
        changed = true;
    }
    if record.canonical_key.as_deref() != Some(canonical_key.as_str()) {
        record.canonical_key = Some(canonical_key);
        changed = true;
    }
    changed
}

pub fn canonical_memory_key(content: &str, tags: &[String], memory_type: &str) -> String {
    let mut normalized = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if normalized.chars().count() > 180 {
        normalized = truncate_chars(&normalized, 180);
    }
    let tag_part = if tags.is_empty() {
        String::new()
    } else {
        format!("|{}", tags.join(",").to_lowercase())
    };
    format!("{memory_type}|{normalized}{tag_part}")
}

fn recent_memories_for_type(store: &AppStore, memory_type: &str) -> Vec<UserMemoryRecord> {
    let mut items = store
        .memories
        .iter()
        .filter(|item| memory_is_active(item) && normalized_memory_type(item) == memory_type)
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        b.updated_at
            .unwrap_or(b.created_at)
            .cmp(&a.updated_at.unwrap_or(a.created_at))
    });
    items
}

pub fn build_prompt_memory_snapshot(store: &AppStore, max_chars: usize) -> String {
    let mut sections = Vec::new();
    for (memory_type, title) in [
        (MEMORY_TYPE_USER_PROFILE, "User Profile"),
        (MEMORY_TYPE_WORKSPACE_FACT, "Workspace Facts"),
        (MEMORY_TYPE_TASK_LEARNING, "Task Learnings"),
    ] {
        let items = recent_memories_for_type(store, memory_type);
        let mut lines = vec![format!("## {title}")];
        if items.is_empty() {
            lines.push("- (none)".to_string());
        } else {
            for item in items.iter().take(6) {
                let summary = item
                    .summary
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| truncate_chars(item.content.trim(), 220));
                lines.push(format!("- {}", summary));
            }
        }
        sections.push(lines.join("\n"));
    }
    let rendered = ["# Structured Memory", &sections.join("\n\n")].join("\n\n");
    truncate_chars(&rendered, max_chars)
}

pub fn memory_type_counts_value(store: &AppStore) -> Value {
    let mut user_profile = 0_i64;
    let mut workspace_fact = 0_i64;
    let mut task_learning = 0_i64;
    let mut archived = 0_i64;
    let mut legacy_other = 0_i64;
    for item in &store.memories {
        if !memory_is_active(item) {
            archived += 1;
            continue;
        }
        match normalized_memory_type(item).as_str() {
            MEMORY_TYPE_USER_PROFILE => user_profile += 1,
            MEMORY_TYPE_WORKSPACE_FACT => workspace_fact += 1,
            MEMORY_TYPE_TASK_LEARNING => task_learning += 1,
            _ => legacy_other += 1,
        }
    }
    json!({
        "userProfile": user_profile,
        "workspaceFacts": workspace_fact,
        "taskLearnings": task_learning,
        "archived": archived,
        "legacyOther": legacy_other,
    })
}

fn context_record_for_session<'a>(
    store: &'a AppStore,
    session_id: &str,
) -> Option<&'a ChatSessionContextRecord> {
    store
        .session_context_records
        .iter()
        .find(|item| item.session_id == session_id)
}

fn session_record_for_session<'a>(
    store: &'a AppStore,
    session_id: &str,
) -> Option<&'a ChatSessionRecord> {
    store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
}

pub fn session_lineage_summary(store: &AppStore, session_id: &str) -> SessionLineageSummary {
    let session = session_record_for_session(store, session_id);
    let metadata = session.and_then(|item| item.metadata.as_ref());
    let context = context_record_for_session(store, session_id);
    let parent_session_id = metadata
        .and_then(|value| value.get("parentSessionId"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let root_session_id = metadata
        .and_then(|value| value.get("rootSessionId"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| parent_session_id.clone())
        .or_else(|| Some(session_id.to_string()));
    let mut lineage_path = vec![session_id.to_string()];
    let mut cursor = parent_session_id.clone();
    let mut guard = 0;
    while let Some(current) = cursor {
        lineage_path.push(current.clone());
        cursor = session_record_for_session(store, &current)
            .and_then(|item| item.metadata.as_ref())
            .and_then(|value| value.get("parentSessionId"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        guard += 1;
        if guard >= 12 {
            break;
        }
    }
    SessionLineageSummary {
        session_id: session_id.to_string(),
        parent_session_id,
        root_session_id,
        runtime_id: metadata
            .and_then(|value| value.get("runtimeId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        parent_runtime_id: metadata
            .and_then(|value| value.get("parentRuntimeId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        source_task_id: metadata
            .and_then(|value| value.get("sourceTaskId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        forked_from_checkpoint_id: metadata
            .and_then(|value| value.get("forkedFromCheckpointId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        resumed_from_checkpoint_id: metadata
            .and_then(|value| value.get("resumedFromCheckpointId"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| last_checkpoint_for_session(store, session_id).map(|item| item.id)),
        compacted_checkpoint_id: metadata
            .and_then(|value| value.get("compactedCheckpointId"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        compact_rounds: context.map(|item| item.compact_rounds).unwrap_or(0),
        compacted_message_count: context
            .map(|item| item.compacted_message_count)
            .unwrap_or(0),
        last_compacted_at: context
            .filter(|item| item.compact_rounds > 0)
            .map(|item| item.updated_at.clone()),
        lineage_path,
    }
}

pub fn session_lineage_summary_value(store: &AppStore, session_id: &str) -> Value {
    serde_json::to_value(session_lineage_summary(store, session_id))
        .unwrap_or_else(|_| json!({ "sessionId": session_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_memory_record_maps_legacy_types() {
        let mut record = crate::UserMemoryRecord {
            id: "memory-1".to_string(),
            content: "I prefer concise answers".to_string(),
            r#type: "preference".to_string(),
            tags: vec!["style".to_string()],
            created_at: 1,
            updated_at: Some(2),
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
        };
        assert!(normalize_memory_record(&mut record));
        assert_eq!(record.r#type, MEMORY_TYPE_USER_PROFILE);
        assert!(record.canonical_key.is_some());
    }
}
