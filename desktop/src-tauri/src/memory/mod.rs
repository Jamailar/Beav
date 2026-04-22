use serde_json::{json, Value};
use tauri::State;

mod maintenance;
mod prompt;
mod recall;
mod store;
mod types;

pub(crate) use maintenance::{
    bump_memory_maintenance_mutation, default_memory_maintenance_status,
    memory_maintenance_status_from_settings, memory_maintenance_status_from_workspace,
    run_memory_maintenance_with_reason, write_memory_maintenance_status_for_workspace,
};
pub(crate) use prompt::build_memory_prompt_section;
pub(crate) use store::{
    archive_memory_record, list_active_memories, list_archived_memories, list_memory_history,
    persist_memory_workspace_state, search_memory_records,
};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    log_timing_event, make_id, now_i64, now_ms, payload_field, payload_string, AppState,
    MemoryHistoryRecord, UserMemoryRecord,
};

pub(crate) fn handle_memory_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "memory:list"
            | "memory:archived"
            | "memory:history"
            | "memory:maintenance-status"
            | "memory:maintenance-run"
            | "memory:search"
            | "memory:add"
            | "memory:delete"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "memory:list" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("memory:list:{}", started_at);
                let items = list_active_memories(&store);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:list",
                    started_at,
                    Some(format!("items={}", items.len())),
                );
                Ok(json!(items))
            }),
            "memory:archived" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("memory:archived:{}", started_at);
                let items = list_archived_memories(&store);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:archived",
                    started_at,
                    Some(format!("items={}", items.len())),
                );
                Ok(json!(items))
            }),
            "memory:history" => with_store(state, |store| {
                let started_at = now_ms();
                let request_id = format!("memory:history:{}", started_at);
                let items = list_memory_history(&store);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:history",
                    started_at,
                    Some(format!("items={}", items.len())),
                );
                Ok(json!(items))
            }),
            "memory:maintenance-status" => {
                let started_at = now_ms();
                let request_id = format!("memory:maintenance-status:{}", started_at);
                let workspace_status = memory_maintenance_status_from_workspace(state)?;
                let fallback_status = with_store(state, |store| {
                    Ok(memory_maintenance_status_from_settings(&store.settings))
                })?;
                let response = json!(workspace_status
                    .or(fallback_status)
                    .unwrap_or_else(default_memory_maintenance_status));
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:maintenance-status",
                    started_at,
                    None,
                );
                Ok(response)
            }
            "memory:maintenance-run" => run_memory_maintenance_with_reason(state, "manual"),
            "memory:search" => {
                let query = payload_string(payload, "query").unwrap_or_default();
                with_store(state, |store| {
                    Ok(json!(search_memory_records(&store, &query)))
                })
            }
            "memory:add" => {
                let content = payload_string(payload, "content").unwrap_or_default();
                let memory_type =
                    payload_string(payload, "type").unwrap_or_else(|| "general".to_string());
                let tags = payload_field(payload, "tags")
                    .and_then(|value| value.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|entry| entry.as_str().map(ToString::to_string))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let memory = with_store_mut(state, |store| {
                    let item = UserMemoryRecord {
                        id: make_id("memory"),
                        content: content.clone(),
                        r#type: memory_type.clone(),
                        tags,
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
                    store.memories.push(item.clone());
                    store.memory_history.push(MemoryHistoryRecord {
                        id: make_id("memory-history"),
                        memory_id: item.id.clone(),
                        origin_id: item.id.clone(),
                        action: "create".to_string(),
                        reason: None,
                        timestamp: now_i64(),
                        before: None,
                        after: Some(json!(item.clone())),
                        archived_memory_id: None,
                    });
                    bump_memory_maintenance_mutation(state, store, "mutation");
                    persist_memory_workspace_state(state, store)?;
                    Ok(item)
                })?;
                let pending = with_store(state, |store| {
                    Ok(memory_maintenance_status_from_workspace(state)?
                        .or_else(|| memory_maintenance_status_from_settings(&store.settings))
                        .and_then(|value| value.get("pendingMutations").and_then(|v| v.as_i64()))
                        .unwrap_or(0))
                })?;
                if pending >= 5 {
                    let _ = run_memory_maintenance_with_reason(state, "mutation");
                }
                Ok(json!(memory))
            }
            "memory:delete" => {
                let id = payload
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| payload_string(payload, "id"))
                    .unwrap_or_default();
                with_store_mut(state, |store| {
                    archive_memory_record(store, &id, "manual-delete");
                    persist_memory_workspace_state(state, store)?;
                    Ok(json!({ "success": true }))
                })?;
                let pending = with_store(state, |store| {
                    Ok(memory_maintenance_status_from_workspace(state)?
                        .or_else(|| memory_maintenance_status_from_settings(&store.settings))
                        .and_then(|value| value.get("pendingMutations").and_then(|v| v.as_i64()))
                        .unwrap_or(0))
                })?;
                if pending >= 5 {
                    let _ = run_memory_maintenance_with_reason(state, "mutation");
                }
                Ok(json!({ "success": true }))
            }
            _ => unreachable!(),
        }
    })())
}
