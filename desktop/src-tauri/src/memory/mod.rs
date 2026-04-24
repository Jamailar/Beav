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
            "memory:list" => {
                let started_at = now_ms();
                let request_id = format!("memory:list:{}", started_at);
                let items = with_store(state, |store| Ok(list_active_memories(&store)))?;
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:list",
                    started_at,
                    Some(format!("items={}", items.len())),
                );
                Ok(json!(items))
            }
            "memory:archived" => {
                let started_at = now_ms();
                let request_id = format!("memory:archived:{}", started_at);
                let items = with_store(state, |store| Ok(list_archived_memories(&store)))?;
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:archived",
                    started_at,
                    Some(format!("items={}", items.len())),
                );
                Ok(json!(items))
            }
            "memory:history" => {
                let started_at = now_ms();
                let request_id = format!("memory:history:{}", started_at);
                let items = with_store(state, |store| Ok(list_memory_history(&store)))?;
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "memory:history",
                    started_at,
                    Some(format!("items={}", items.len())),
                );
                Ok(json!(items))
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        startup_migration, AppStore, ApprovalRuntimeState, AuthRuntimeState, DiagnosticsState,
        RuntimeWarmState,
    };
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::{Arc, Mutex};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    fn unique_test_dir(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "redbox-memory-tests-{label}-{}-{}",
            std::process::id(),
            now_i64()
        ));
        fs::create_dir_all(&root).expect("test dir should be created");
        root
    }

    fn build_test_app(
        store: AppStore,
        workspace_root: PathBuf,
    ) -> tauri::App<tauri::test::MockRuntime> {
        let store_root = workspace_root.join(".test-store");
        fs::create_dir_all(&store_root).expect("store root should be created");
        let store_path = store_root.join("redbox-state.json");
        let shared_store = Arc::new(Mutex::new(store));
        mock_builder()
            .manage(AppState {
                store_path,
                store: shared_store,
                workspace_root_cache: Mutex::new(workspace_root),
                startup_migration: Mutex::new(startup_migration::StartupMigrationStatus::default()),
                store_persist_version: Arc::new(AtomicU64::new(0)),
                store_persist_scheduled: Arc::new(AtomicBool::new(false)),
                auth_runtime: Mutex::new(AuthRuntimeState::default()),
                official_auth_refresh_lock: Mutex::new(()),
                official_wechat_status_lock: Mutex::new(()),
                official_cache_refresh_inflight: AtomicBool::new(false),
                mcp_manager: crate::mcp::McpManager::default(),
                chat_runtime_states: Mutex::new(HashMap::new()),
                editor_runtime_states: Mutex::new(HashMap::new()),
                active_chat_requests: Mutex::new(HashMap::new()),
                creative_chat_cancellations: Mutex::new(HashSet::new()),
                assistant_runtime: Mutex::new(None),
                assistant_sidecar: Mutex::new(None),
                redclaw_runtime: Mutex::new(None),
                media_generation_runtime: Mutex::new(None),
                runtime_warm: Mutex::new(RuntimeWarmState::default()),
                approval_runtime: Mutex::new(ApprovalRuntimeState::default()),
                skill_watch: Mutex::new(crate::skills::SkillWatcherSnapshot::default()),
                diagnostics: Mutex::new(DiagnosticsState::default()),
                knowledge_index_state: Mutex::new(
                    crate::knowledge_index::KnowledgeIndexRuntimeState::default(),
                ),
            })
            .build(mock_context(noop_assets()))
            .expect("mock tauri app should build")
    }

    fn empty_store_for_workspace(workspace_root: &PathBuf) -> AppStore {
        let mut store = AppStore::default();
        store.settings = json!({
            "workspace_dir": workspace_root.display().to_string()
        });
        store.active_space_id = "default".to_string();
        store
    }

    fn sample_memory(
        id: &str,
        content: &str,
        memory_type: &str,
        tags: &[&str],
        status: Option<&str>,
    ) -> UserMemoryRecord {
        let now = now_i64();
        UserMemoryRecord {
            id: id.to_string(),
            content: content.to_string(),
            r#type: memory_type.to_string(),
            tags: tags.iter().map(|item| item.to_string()).collect(),
            created_at: now,
            updated_at: Some(now),
            last_accessed: None,
            status: status.map(ToString::to_string),
            archived_at: None,
            archive_reason: None,
            origin_id: None,
            canonical_key: None,
            revision: Some(1),
            last_conflict_at: None,
        }
    }

    #[test]
    fn memory_list_channel_returns_empty_array_without_hanging() {
        let workspace_root = unique_test_dir("list-empty");
        let store = empty_store_for_workspace(&workspace_root);
        let app = build_test_app(store, workspace_root);
        let state = app.state::<AppState>();

        let response = handle_memory_channel(&state, "memory:list", &json!({}))
            .expect("memory:list should be handled")
            .expect("memory:list should succeed");
        let items = response
            .as_array()
            .expect("memory:list should return an array");
        assert!(items.is_empty());
    }

    #[test]
    fn memory_search_channel_matches_content_and_tags() {
        let workspace_root = unique_test_dir("search");
        let mut store = empty_store_for_workspace(&workspace_root);
        store.memories = vec![
            sample_memory(
                "memory-1",
                "用户长期偏好实操、复盘和可复制方法",
                "preference",
                &["复盘", "方法论"],
                Some("active"),
            ),
            sample_memory(
                "memory-2",
                "普通背景资料",
                "fact",
                &["其他"],
                Some("active"),
            ),
        ];
        let app = build_test_app(store, workspace_root);
        let state = app.state::<AppState>();

        let response = handle_memory_channel(&state, "memory:search", &json!({ "query": "复盘" }))
            .expect("memory:search should be handled")
            .expect("memory:search should succeed");
        let items = response
            .as_array()
            .expect("memory:search should return an array");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("id"), Some(&json!("memory-1")));
    }

    #[test]
    fn memory_add_channel_persists_workspace_files() {
        let workspace_root = unique_test_dir("add");
        let store = empty_store_for_workspace(&workspace_root);
        let app = build_test_app(store, workspace_root.clone());
        let state = app.state::<AppState>();

        let response = handle_memory_channel(
            &state,
            "memory:add",
            &json!({
                "content": "用户偏好简洁、可执行的技术方案",
                "type": "preference",
                "tags": ["style", "execution"]
            }),
        )
        .expect("memory:add should be handled")
        .expect("memory:add should succeed");

        assert_eq!(
            response.get("content"),
            Some(&json!("用户偏好简洁、可执行的技术方案"))
        );
        assert!(workspace_root.join("memory").join("catalog.json").exists());
        assert!(workspace_root.join("memory").join("history.json").exists());
        assert!(workspace_root.join("memory").join("MEMORY.md").exists());
    }
}
