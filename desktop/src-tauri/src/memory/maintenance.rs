use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

use super::index::rebuild_memory_index_from_store;
use super::store::{memory_root, memory_workspace_snapshot, persist_memory_workspace_state};
use crate::persistence::{with_store, with_store_mut};
use crate::store::settings as settings_store;
use crate::{
    app_brand_display_name, load_redbox_prompt, make_id, now_i64, now_iso,
    parse_json_value_from_text, payload_string, render_redbox_prompt,
    run_model_structured_task_with_settings, truncate_chars, value_to_i64_string, AppState,
    AppStore, MemoryHistoryRecord, UserMemoryRecord,
};

fn memory_maintenance_status_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("maintenance-status.json"))
}

pub(crate) fn memory_maintenance_status_from_workspace(
    state: &State<'_, AppState>,
) -> Result<Option<Value>, String> {
    let path = memory_maintenance_status_path(state)?;
    Ok(fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object()))
}

pub(crate) fn write_memory_maintenance_status_for_workspace(
    state: &State<'_, AppState>,
    status: &Value,
) -> Result<(), String> {
    crate::write_json_value(&memory_maintenance_status_path(state)?, status)
}

struct MemoryMaintenancePromptSnapshot {
    active_memories: Vec<UserMemoryRecord>,
    archived_memories: Vec<UserMemoryRecord>,
    history: Vec<MemoryHistoryRecord>,
    recent_conversations: Vec<Value>,
}

fn memory_maintenance_prompt_snapshot(store: &AppStore) -> MemoryMaintenancePromptSnapshot {
    MemoryMaintenancePromptSnapshot {
        active_memories: store
            .memories
            .iter()
            .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
            .cloned()
            .collect(),
        archived_memories: store
            .memories
            .iter()
            .filter(|item| item.status.as_deref() == Some("archived"))
            .cloned()
            .collect(),
        history: store.memory_history.clone(),
        recent_conversations: recent_conversations_for_memory_maintenance(store),
    }
}

fn render_memory_maintenance_prompt(
    snapshot: &MemoryMaintenancePromptSnapshot,
    reason: &str,
    pending_mutation_count: i64,
) -> String {
    let template =
        load_redbox_prompt("runtime/memory/maintenance_manager.txt").unwrap_or_else(|| {
            "You are a memory maintenance manager. Output strict JSON only.".to_string()
        });
    render_redbox_prompt(
        &template,
        &[
            ("trigger_reason", reason.to_string()),
            ("current_date", now_iso()),
            ("pending_mutation_count", pending_mutation_count.to_string()),
            (
                "active_memory_count",
                snapshot.active_memories.len().to_string(),
            ),
            (
                "archived_memory_count",
                snapshot.archived_memories.len().to_string(),
            ),
            ("history_count", snapshot.history.len().to_string()),
            (
                "recent_conversations_count",
                snapshot.recent_conversations.len().to_string(),
            ),
            (
                "active_memories_json",
                serde_json::to_string_pretty(&snapshot.active_memories)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "archived_memories_json",
                serde_json::to_string_pretty(&snapshot.archived_memories)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "history_json",
                serde_json::to_string_pretty(&snapshot.history)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "recent_conversations_json",
                serde_json::to_string_pretty(&snapshot.recent_conversations)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
        ],
    )
}

fn parse_timestamp(value: &str) -> i64 {
    value.trim().parse::<i64>().unwrap_or(0)
}

fn context_type_from_metadata(metadata: Option<&Value>) -> String {
    metadata
        .and_then(|value| value.get("contextType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn should_include_session_in_memory_maintenance(session_id: &str, context_type: &str) -> bool {
    let normalized_context = context_type.trim().to_ascii_lowercase();
    if session_id.starts_with("context-session:") {
        return false;
    }
    !matches!(
        normalized_context.as_str(),
        "file" | "diagnostics" | "chatroom-advisor"
    )
}

fn recent_conversations_for_memory_maintenance(store: &AppStore) -> Vec<Value> {
    let mut sessions = store
        .chat_sessions
        .iter()
        .filter_map(|session| {
            let metadata = session.metadata.as_ref();
            let context_type = context_type_from_metadata(metadata);
            should_include_session_in_memory_maintenance(&session.id, &context_type)
                .then_some((session, context_type))
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|(left, _), (right, _)| {
        parse_timestamp(&right.updated_at).cmp(&parse_timestamp(&left.updated_at))
    });
    sessions
        .into_iter()
        .filter_map(|(session, context_type)| {
            let messages = store
                .chat_messages
                .iter()
                .filter(|item| item.session_id == session.id)
                .take(6)
                .map(|item| {
                    json!({
                        "role": item.role,
                        "content": truncate_chars(&item.content, 180),
                        "timestamp": item.created_at,
                    })
                })
                .collect::<Vec<_>>();
            if messages.is_empty() {
                return None;
            }
            Some(json!({
                "sessionId": session.id,
                "title": session.title,
                "updatedAt": session.updated_at,
                "contextType": context_type,
                "messageCount": messages.len(),
                "messages": messages,
            }))
        })
        .take(5)
        .collect()
}

pub(crate) fn memory_maintenance_mutation_status(
    current: Option<Value>,
    store: &mut AppStore,
    reason: &str,
) -> Value {
    let current = current
        .or_else(|| memory_maintenance_status_from_settings(&store.settings))
        .unwrap_or_else(default_memory_maintenance_status);
    let pending = current
        .get("pendingMutations")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        + 1;
    let next_delay_ms = if pending >= 5 {
        15 * 60 * 1000
    } else {
        90 * 60 * 1000
    };
    let status = json!({
        "started": true,
        "running": false,
        "lockState": current.get("lockState").cloned().unwrap_or_else(|| json!("owner")),
        "blockedBy": current.get("blockedBy").cloned().unwrap_or(Value::Null),
        "pendingMutations": pending,
        "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
        "lastScanAt": current.get("lastScanAt").cloned().unwrap_or(Value::Null),
        "lastReason": reason,
        "lastSummary": current.get("lastSummary").cloned().unwrap_or_else(|| json!(format!("{} memory maintenance has not run yet.", app_brand_display_name()))),
        "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
        "nextScheduledAt": now_i64() + next_delay_ms,
    });
    apply_memory_maintenance_status_to_store(store, &status);
    status
}

fn apply_memory_maintenance_status_to_store(store: &mut AppStore, status: &Value) {
    if let Some(object) = store.settings.as_object_mut() {
        object.remove("redbox_memory_maintenance_status_json");
    }
    store.redclaw_state.next_maintenance_at = value_to_i64_string(status.get("nextScheduledAt"));
}

pub(crate) fn run_memory_maintenance_with_reason(
    state: &State<'_, AppState>,
    reason: &str,
) -> Result<Value, String> {
    let (settings_snapshot, prompt_snapshot) = with_store(state, |store| {
        Ok((
            settings_store::settings_snapshot(&store),
            memory_maintenance_prompt_snapshot(&store),
        ))
    })?;
    let settings_status = memory_maintenance_status_from_settings(&settings_snapshot);
    let workspace_status = memory_maintenance_status_from_workspace(state)?;
    let pending_mutation_count = workspace_status
        .as_ref()
        .or(settings_status.as_ref())
        .and_then(|value| value.get("pendingMutations").and_then(|item| item.as_i64()))
        .unwrap_or(0);
    if reason == "periodic"
        && pending_mutation_count <= 0
        && prompt_snapshot.active_memories.is_empty()
        && prompt_snapshot.archived_memories.is_empty()
        && prompt_snapshot.history.is_empty()
    {
        let next_scheduled = now_i64() + 90 * 60 * 1000;
        let status = json!({
            "started": true,
            "running": false,
            "lockState": "owner",
            "blockedBy": Value::Null,
            "pendingMutations": 0,
            "lastRunAt": now_i64(),
            "lastScanAt": now_i64(),
            "lastReason": reason,
            "lastSummary": "Memory maintenance skipped; no pending memory changes.",
            "lastError": Value::Null,
            "nextScheduledAt": next_scheduled,
        });
        let _ = with_store_mut(state, |store| {
            apply_memory_maintenance_status_to_store(store, &status);
            Ok(())
        });
        let _ = write_memory_maintenance_status_for_workspace(state, &status);
        return Ok(json!({
            "success": true,
            "skipped": true,
            "reason": "no-pending-memory-changes",
            "status": status,
        }));
    }
    let prompt = render_memory_maintenance_prompt(&prompt_snapshot, reason, pending_mutation_count);
    let system_prompt = format!(
        "You are the background long-term memory maintenance manager for {}. Output strict JSON only.",
        app_brand_display_name()
    );
    let raw = run_model_structured_task_with_settings(
        &settings_snapshot,
        None,
        &system_prompt,
        &prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
        json!({
            "summary": "memory-maintenance:no-parse",
            "actions": [{ "type": "noop", "reason": "parse-failed" }]
        })
    });
    let actions = parsed
        .get("actions")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut applied = 0_i64;
    let mut archived = 0_i64;
    let mut deleted = 0_i64;
    let workspace_snapshot = with_store_mut(state, |store| {
        for action in actions {
            let action_type = payload_string(&action, "type").unwrap_or_default();
            match action_type.as_str() {
                "create" => {
                    let content = payload_string(&action, "content").unwrap_or_default();
                    if content.trim().is_empty() {
                        continue;
                    }
                    let memory_type = payload_string(&action, "memoryType")
                        .unwrap_or_else(|| "general".to_string());
                    let tags = action
                        .get("tags")
                        .and_then(|value| value.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(ToString::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let entities = action
                        .get("entities")
                        .and_then(|value| value.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(ToString::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let record = UserMemoryRecord {
                        id: make_id("memory"),
                        content,
                        r#type: memory_type,
                        tags,
                        entities,
                        scope: payload_string(&action, "scope")
                            .or_else(|| Some("user".to_string())),
                        space_id: payload_string(&action, "spaceId"),
                        project_id: payload_string(&action, "projectId"),
                        session_id: payload_string(&action, "sessionId"),
                        source: action.get("source").cloned().or_else(|| {
                            Some(json!({ "kind": "memory_maintenance", "reason": reason }))
                        }),
                        confidence: action
                            .get("confidence")
                            .and_then(|value| {
                                value
                                    .as_f64()
                                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                            })
                            .or(Some(0.75)),
                        created_at: now_i64(),
                        updated_at: Some(now_i64()),
                        last_accessed: None,
                        status: Some("active".to_string()),
                        archived_at: None,
                        archive_reason: None,
                        origin_id: None,
                        canonical_key: None,
                        revision: Some(1),
                        last_conflict_at: None,
                    };
                    store.memories.push(record.clone());
                    store.memory_history.push(MemoryHistoryRecord {
                        id: make_id("memory-history"),
                        memory_id: record.id.clone(),
                        origin_id: record.id.clone(),
                        action: "create".to_string(),
                        reason: payload_string(&action, "reason"),
                        timestamp: now_i64(),
                        before: None,
                        after: Some(json!(record)),
                        archived_memory_id: None,
                    });
                    applied += 1;
                }
                "update" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    let content = payload_string(&action, "content").unwrap_or_default();
                    if let Some(item) = store
                        .memories
                        .iter_mut()
                        .find(|entry| entry.id == target_id)
                    {
                        let before = json!(item.clone());
                        if !content.trim().is_empty() {
                            item.content = content;
                        }
                        if let Some(memory_type) = payload_string(&action, "memoryType") {
                            item.r#type = memory_type;
                        }
                        if let Some(tags) = action.get("tags").and_then(|value| value.as_array()) {
                            item.tags = tags
                                .iter()
                                .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                .collect();
                        }
                        if let Some(entities) =
                            action.get("entities").and_then(|value| value.as_array())
                        {
                            item.entities = entities
                                .iter()
                                .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                .collect();
                        }
                        if let Some(scope) = payload_string(&action, "scope") {
                            item.scope = Some(scope);
                        }
                        if let Some(space_id) = payload_string(&action, "spaceId") {
                            item.space_id = Some(space_id);
                        }
                        if let Some(project_id) = payload_string(&action, "projectId") {
                            item.project_id = Some(project_id);
                        }
                        if let Some(session_id) = payload_string(&action, "sessionId") {
                            item.session_id = Some(session_id);
                        }
                        if let Some(source) = action.get("source").cloned() {
                            item.source = Some(source);
                        }
                        if let Some(confidence) = action.get("confidence").and_then(|value| {
                            value
                                .as_f64()
                                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
                        }) {
                            item.confidence = Some(confidence.clamp(0.0, 1.0));
                        }
                        item.updated_at = Some(now_i64());
                        let after = json!(item.clone());
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: item.id.clone(),
                            origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                            action: "update".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: Some(after),
                            archived_memory_id: None,
                        });
                        applied += 1;
                    }
                }
                "archive" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    if let Some(item) = store
                        .memories
                        .iter_mut()
                        .find(|entry| entry.id == target_id)
                    {
                        let before = json!(item.clone());
                        item.status = Some("archived".to_string());
                        item.archived_at = Some(now_i64());
                        item.archive_reason = payload_string(&action, "reason");
                        let after = json!(item.clone());
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: item.id.clone(),
                            origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                            action: "archive".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: Some(after),
                            archived_memory_id: Some(item.id.clone()),
                        });
                        archived += 1;
                    }
                }
                "delete" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    if let Some(index) = store
                        .memories
                        .iter()
                        .position(|entry| entry.id == target_id)
                    {
                        let before = json!(store.memories[index].clone());
                        let removed = store.memories.remove(index);
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: target_id.clone(),
                            origin_id: removed
                                .origin_id
                                .clone()
                                .unwrap_or_else(|| removed.id.clone()),
                            action: "delete".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: None,
                            archived_memory_id: None,
                        });
                        deleted += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(memory_workspace_snapshot(store))
    })?;
    let next_scheduled = match reason {
        "query-after" => now_i64() + 5 * 60 * 1000,
        "periodic" => now_i64() + 30 * 60 * 1000,
        _ => now_i64() + 20 * 60 * 1000,
    };
    let status = json!({
        "started": true,
        "running": false,
        "lockState": "owner",
        "blockedBy": Value::Null,
        "pendingMutations": 0,
        "lastRunAt": now_i64(),
        "lastScanAt": now_i64(),
        "lastReason": reason,
        "lastSummary": parsed.get("summary").and_then(|value| value.as_str()).unwrap_or("Memory maintenance completed."),
        "lastError": Value::Null,
        "nextScheduledAt": next_scheduled,
        "raw": parsed,
        "applied": applied,
        "archived": archived,
        "deleted": deleted
    });
    let _ = with_store_mut(state, |store| {
        apply_memory_maintenance_status_to_store(store, &status);
        Ok(())
    });
    let _ = write_memory_maintenance_status_for_workspace(state, &status);
    let _ = persist_memory_workspace_state(state, &workspace_snapshot);
    let _ = rebuild_memory_index_from_store(state);
    Ok(status)
}

pub(crate) fn memory_maintenance_status_from_settings(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_memory_maintenance_status_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

pub(crate) fn default_memory_maintenance_status() -> Value {
    json!({
        "started": true,
        "running": false,
        "lockState": "owner",
        "blockedBy": Value::Null,
        "pendingMutations": 0,
        "lastRunAt": Value::Null,
        "lastScanAt": Value::Null,
        "lastReason": Value::Null,
        "lastSummary": format!("{} memory maintenance has not run yet.", app_brand_display_name()),
        "lastError": Value::Null,
        "nextScheduledAt": Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChatMessageRecord, ChatSessionRecord};

    fn session(id: &str, title: &str, updated_at: &str, context_type: &str) -> ChatSessionRecord {
        ChatSessionRecord {
            id: id.to_string(),
            title: title.to_string(),
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            metadata: Some(json!({
                "contextType": context_type
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        }
    }

    fn user_message(session_id: &str, content: &str, created_at: &str) -> ChatMessageRecord {
        ChatMessageRecord {
            id: format!("message-{created_at}"),
            session_id: session_id.to_string(),
            role: "user".to_string(),
            content: content.to_string(),
            display_content: None,
            attachment: None,
            metadata: None,
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn memory_maintenance_recent_conversations_skip_internal_chatroom_sessions() {
        let mut store = AppStore::default();
        store.chat_sessions.push(session(
            "context-session:chatroom-advisor:room:advisor",
            "选题脑爆 · Dan Koe",
            "300",
            "chatroom-advisor",
        ));
        store
            .chat_sessions
            .push(session("session-old", "旧普通会话", "100", "redclaw"));
        store
            .chat_sessions
            .push(session("session-new", "新普通会话", "500", "redclaw"));
        store.chat_messages.push(user_message(
            "context-session:chatroom-advisor:room:advisor",
            "内部成员发言",
            "301",
        ));
        store
            .chat_messages
            .push(user_message("session-old", "旧会话内容", "101"));
        store
            .chat_messages
            .push(user_message("session-new", "新会话内容", "501"));

        let conversations = recent_conversations_for_memory_maintenance(&store);

        assert_eq!(conversations.len(), 2);
        assert_eq!(
            conversations[0].get("sessionId").and_then(Value::as_str),
            Some("session-new")
        );
        assert_eq!(
            conversations[1].get("sessionId").and_then(Value::as_str),
            Some("session-old")
        );
        assert!(!serde_json::to_string(&conversations)
            .unwrap()
            .contains("chatroom-advisor"));
    }
}
