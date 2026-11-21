use serde_json::{json, Value};
use tauri::State;

mod index;
mod maintenance;
mod prompt;
mod recall;
mod store;
mod types;

pub(crate) use maintenance::{
    default_memory_maintenance_status, memory_maintenance_mutation_status,
    memory_maintenance_status_from_settings, memory_maintenance_status_from_workspace,
    run_memory_maintenance_with_reason, write_memory_maintenance_status_for_workspace,
};
pub(crate) use prompt::build_memory_prompt_section;
pub(crate) use store::{
    append_memory_record, archive_memory_record, list_active_memories, list_archived_memories,
    list_memory_history, memory_workspace_snapshot, persist_memory_workspace_state,
    search_memory_records,
};

use crate::persistence::{with_store, with_store_mut};
use crate::store::{settings as settings_store, spaces as spaces_store};
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
            | "memory:recall"
            | "memory:add"
            | "memory:update"
            | "memory:archive"
            | "memory:delete"
            | "memory:rebuild-index"
            | "memory:diagnostics"
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
                    let settings = settings_store::settings_snapshot(&store);
                    Ok(memory_maintenance_status_from_settings(&settings))
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
                let options = memory_search_options_from_payload(payload, 50);
                match index::search_memory_records_indexed(state, &options) {
                    Ok(items) => Ok(json!(items)),
                    Err(_) => with_store(state, |store| {
                        let mut items = search_memory_records(&store, &options.query);
                        items.retain(|value| memory_value_matches_options(value, &options));
                        items.truncate(options.limit.max(1));
                        Ok(json!(items))
                    }),
                }
            }
            "memory:recall" => {
                let options = memory_search_options_from_payload(payload, 8);
                let items =
                    index::search_memory_records_indexed(state, &options).or_else(|_| {
                        with_store(state, |store| {
                            let mut items = search_memory_records(&store, &options.query);
                            items.retain(|value| memory_value_matches_options(value, &options));
                            items.truncate(options.limit.max(1));
                            Ok(items)
                        })
                    })?;
                Ok(json!({
                    "query": options.query,
                    "matchedCount": items.len(),
                    "items": items,
                    "retrievalEngine": "sqlite-fts5-bm25"
                }))
            }
            "memory:add" => {
                let current_status = memory_maintenance_status_from_workspace(state)?;
                let content = payload_string(payload, "content").unwrap_or_default();
                let memory_type = payload_string(payload, "type")
                    .or_else(|| payload_string(payload, "memoryType"))
                    .unwrap_or_else(|| "general".to_string());
                let tags = payload_string_list(payload, "tags");
                let entities = payload_string_list(payload, "entities");
                let source = payload_field(payload, "source").cloned();
                let scope = normalized_optional_string(
                    payload_string(payload, "scope")
                        .or_else(|| payload_string(payload, "category")),
                )
                .or_else(|| Some("user".to_string()));
                let (memory, workspace_snapshot, maintenance_status) =
                    with_store_mut(state, |store| {
                        let item = UserMemoryRecord {
                            id: make_id("memory"),
                            content: content.clone(),
                            r#type: memory_type.clone(),
                            tags,
                            entities,
                            scope,
                            space_id: normalized_optional_string(payload_string(
                                payload, "spaceId",
                            ))
                            .or_else(|| Some(spaces_store::active_space_id(store))),
                            project_id: normalized_optional_string(payload_string(
                                payload,
                                "projectId",
                            )),
                            session_id: normalized_optional_string(payload_string(
                                payload,
                                "sessionId",
                            )),
                            source: source.clone().or_else(|| Some(json!({ "kind": "tool" }))),
                            confidence: payload_f64(payload, "confidence").or(Some(0.75)),
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
                        let maintenance_status =
                            memory_maintenance_mutation_status(current_status, store, "mutation");
                        Ok((item, memory_workspace_snapshot(store), maintenance_status))
                    })?;
                let _ = write_memory_maintenance_status_for_workspace(state, &maintenance_status);
                persist_memory_workspace_state(state, &workspace_snapshot)?;
                let pending = maintenance_status
                    .get("pendingMutations")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if pending >= 5 {
                    let _ = run_memory_maintenance_with_reason(state, "mutation");
                }
                let _ = index::rebuild_memory_index_from_store(state);
                Ok(json!(memory))
            }
            "memory:update" => {
                let id = payload_string(payload, "id")
                    .or_else(|| payload_string(payload, "memoryId"))
                    .or_else(|| payload_string(payload, "targetMemoryId"))
                    .unwrap_or_default();
                let (updated, workspace_snapshot) = with_store_mut(state, |store| {
                    let Some(item) = store.memories.iter_mut().find(|entry| entry.id == id) else {
                        return Err(format!("memory not found: {id}"));
                    };
                    let before = json!(item.clone());
                    apply_memory_patch(item, payload);
                    item.updated_at = Some(now_i64());
                    item.revision = Some(item.revision.unwrap_or(1) + 1);
                    let after = json!(item.clone());
                    store.memory_history.push(MemoryHistoryRecord {
                        id: make_id("memory-history"),
                        memory_id: item.id.clone(),
                        origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                        action: "update".to_string(),
                        reason: payload_string(payload, "reason"),
                        timestamp: now_i64(),
                        before: Some(before),
                        after: Some(after),
                        archived_memory_id: None,
                    });
                    let updated = item.clone();
                    Ok((updated, memory_workspace_snapshot(store)))
                })?;
                persist_memory_workspace_state(state, &workspace_snapshot)?;
                let _ = index::rebuild_memory_index_from_store(state);
                Ok(json!(updated))
            }
            "memory:archive" => {
                let id = payload_string(payload, "id")
                    .or_else(|| payload_string(payload, "memoryId"))
                    .unwrap_or_default();
                let reason = payload_string(payload, "reason")
                    .unwrap_or_else(|| "manual-archive".to_string());
                let workspace_snapshot = with_store_mut(state, |store| {
                    archive_memory_record(store, &id, &reason);
                    Ok(memory_workspace_snapshot(store))
                })?;
                persist_memory_workspace_state(state, &workspace_snapshot)?;
                let _ = index::rebuild_memory_index_from_store(state);
                Ok(json!({ "success": true }))
            }
            "memory:delete" => {
                let id = payload
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| payload_string(payload, "id"))
                    .unwrap_or_default();
                let workspace_snapshot = with_store_mut(state, |store| {
                    archive_memory_record(store, &id, "manual-delete");
                    Ok(memory_workspace_snapshot(store))
                })?;
                persist_memory_workspace_state(state, &workspace_snapshot)?;
                let workspace_status = memory_maintenance_status_from_workspace(state)?;
                let pending = with_store(state, |store| {
                    let settings = settings_store::settings_snapshot(&store);
                    Ok(workspace_status
                        .or_else(|| memory_maintenance_status_from_settings(&settings))
                        .and_then(|value| value.get("pendingMutations").and_then(|v| v.as_i64()))
                        .unwrap_or(0))
                })?;
                if pending >= 5 {
                    let _ = run_memory_maintenance_with_reason(state, "mutation");
                }
                let _ = index::rebuild_memory_index_from_store(state);
                Ok(json!({ "success": true }))
            }
            "memory:rebuild-index" => {
                index::rebuild_memory_index_from_store(state)?;
                Ok(json!({ "success": true }))
            }
            "memory:diagnostics" => index::memory_index_diagnostics(state),
            _ => unreachable!(),
        }
    })())
}

fn memory_search_options_from_payload(
    payload: &Value,
    default_limit: usize,
) -> index::MemorySearchOptions {
    index::MemorySearchOptions {
        query: payload_string(payload, "query").unwrap_or_default(),
        limit: payload_field(payload, "limit")
            .and_then(Value::as_i64)
            .unwrap_or(default_limit as i64)
            .clamp(1, 200) as usize,
        include_archived: payload_field(payload, "includeArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        scopes: payload_string_list_alias(payload, &["scopes", "scope"]),
        memory_types: payload_string_list_alias(payload, &["memoryTypes", "types", "type"]),
        project_id: normalized_optional_string(payload_string(payload, "projectId")),
        session_id: normalized_optional_string(payload_string(payload, "sessionId")),
    }
}

fn memory_value_matches_options(value: &Value, options: &index::MemorySearchOptions) -> bool {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    if !options.include_archived && status != "active" {
        return false;
    }
    if !options.scopes.is_empty() {
        let scope = value.get("scope").and_then(Value::as_str).unwrap_or("user");
        if !options.scopes.iter().any(|item| item == scope) {
            return false;
        }
    }
    if !options.memory_types.is_empty() {
        let memory_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("general");
        if !options.memory_types.iter().any(|item| item == memory_type) {
            return false;
        }
    }
    if let Some(project_id) = options.project_id.as_deref() {
        if value.get("projectId").and_then(Value::as_str) != Some(project_id) {
            return false;
        }
    }
    if let Some(session_id) = options.session_id.as_deref() {
        if value.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            return false;
        }
    }
    true
}

fn apply_memory_patch(item: &mut UserMemoryRecord, payload: &Value) {
    if let Some(content) =
        payload_string(payload, "content").filter(|value| !value.trim().is_empty())
    {
        item.content = content;
    }
    if let Some(memory_type) =
        payload_string(payload, "type").or_else(|| payload_string(payload, "memoryType"))
    {
        item.r#type = memory_type;
    }
    if payload_field(payload, "tags").is_some() {
        item.tags = payload_string_list(payload, "tags");
    }
    if payload_field(payload, "entities").is_some() {
        item.entities = payload_string_list(payload, "entities");
    }
    if let Some(scope) = normalized_optional_string(payload_string(payload, "scope")) {
        item.scope = Some(scope);
    }
    if payload_field(payload, "spaceId").is_some() {
        item.space_id = normalized_optional_string(payload_string(payload, "spaceId"));
    }
    if payload_field(payload, "projectId").is_some() {
        item.project_id = normalized_optional_string(payload_string(payload, "projectId"));
    }
    if payload_field(payload, "sessionId").is_some() {
        item.session_id = normalized_optional_string(payload_string(payload, "sessionId"));
    }
    if payload_field(payload, "source").is_some() {
        item.source = payload_field(payload, "source").cloned();
    }
    if let Some(confidence) = payload_f64(payload, "confidence") {
        item.confidence = Some(confidence.clamp(0.0, 1.0));
    }
}

fn payload_string_list(payload: &Value, key: &str) -> Vec<String> {
    payload_field(payload, key)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|entry| entry.as_str().map(str::trim))
                .filter(|entry| !entry.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .or_else(|| {
            payload_string(payload, key).map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default()
}

fn payload_string_list_alias(payload: &Value, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .map(|key| payload_string_list(payload, key))
        .find(|items| !items.is_empty())
        .unwrap_or_default()
}

fn payload_f64(payload: &Value, key: &str) -> Option<f64> {
    payload_field(payload, key).and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        startup_migration, AppStore, ApprovalRuntimeState, AuthRuntimeState, DiagnosticsState,
        RuntimeWarmState,
    };
    use std::collections::HashMap;
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
                visual_index_enabled_runtime: Arc::new(AtomicBool::new(false)),
                mcp_manager: crate::mcp::McpManager::default(),
                chat_runtime_states: Mutex::new(HashMap::new()),
                editor_runtime_states: Mutex::new(HashMap::new()),
                active_chat_requests: Mutex::new(HashMap::new()),
                active_team_member_wakes: Mutex::new(std::collections::HashSet::new()),
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
            entities: Vec::new(),
            scope: Some("user".to_string()),
            space_id: None,
            project_id: None,
            session_id: None,
            source: Some(json!({ "kind": "test" })),
            confidence: Some(0.75),
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
    fn memory_search_channel_uses_bm25_index_when_available() {
        let workspace_root = unique_test_dir("search-bm25");
        let mut store = empty_store_for_workspace(&workspace_root);
        store.memories = vec![
            sample_memory(
                "memory-1",
                "User prefers concise execution plans with verification evidence.",
                "preference",
                &["writing", "execution"],
                Some("active"),
            ),
            sample_memory(
                "memory-2",
                "User keeps background notes about unrelated media assets.",
                "fact",
                &["media"],
                Some("active"),
            ),
        ];
        let app = build_test_app(store, workspace_root);
        let state = app.state::<AppState>();

        let response =
            handle_memory_channel(&state, "memory:search", &json!({ "query": "verification" }))
                .expect("memory:search should be handled")
                .expect("memory:search should succeed");
        let items = response
            .as_array()
            .expect("memory:search should return an array");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("id"), Some(&json!("memory-1")));
        assert_eq!(items[0].get("matchReasons"), Some(&json!(["bm25"])));
        assert_eq!(items[0].get("retrievalLanes"), Some(&json!(["bm25"])));
        assert!(
            items[0]
                .get("bm25Score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                > 0.0
        );
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
        assert!(workspace_root.join("memory").join("index.sqlite").exists());
    }

    #[test]
    fn memory_delete_channel_removes_record_from_bm25_recall() {
        let workspace_root = unique_test_dir("delete-bm25");
        let mut store = empty_store_for_workspace(&workspace_root);
        store.memories = vec![sample_memory(
            "memory-1",
            "User prefers verification evidence in every implementation summary.",
            "preference",
            &["verification"],
            Some("active"),
        )];
        let app = build_test_app(store, workspace_root);
        let state = app.state::<AppState>();

        let before =
            handle_memory_channel(&state, "memory:search", &json!({ "query": "verification" }))
                .expect("memory:search should be handled")
                .expect("memory:search should succeed");
        assert_eq!(
            before
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item.get("id")),
            Some(&json!("memory-1"))
        );

        handle_memory_channel(&state, "memory:delete", &json!("memory-1"))
            .expect("memory:delete should be handled")
            .expect("memory:delete should succeed");

        let after =
            handle_memory_channel(&state, "memory:search", &json!({ "query": "verification" }))
                .expect("memory:search should be handled")
                .expect("memory:search should succeed");
        assert!(after
            .as_array()
            .expect("memory:search should return an array")
            .is_empty());
    }

    #[test]
    fn memory_add_structured_payload_supports_scope_entities_and_source() {
        let workspace_root = unique_test_dir("add-structured");
        let store = empty_store_for_workspace(&workspace_root);
        let app = build_test_app(store, workspace_root);
        let state = app.state::<AppState>();

        let response = handle_memory_channel(
            &state,
            "memory:add",
            &json!({
                "content": "Project alpha prefers evidence-first implementation summaries.",
                "type": "preference",
                "scope": "project",
                "projectId": "alpha",
                "entities": ["Project Alpha"],
                "tags": ["summary", "verification"],
                "confidence": 0.91,
                "source": { "kind": "test", "id": "source-1" }
            }),
        )
        .expect("memory:add should be handled")
        .expect("memory:add should succeed");

        assert_eq!(response.get("scope"), Some(&json!("project")));
        assert_eq!(response.get("projectId"), Some(&json!("alpha")));
        assert_eq!(response.get("entities"), Some(&json!(["Project Alpha"])));
        assert_eq!(response.pointer("/source/id"), Some(&json!("source-1")));

        let project_hits = handle_memory_channel(
            &state,
            "memory:search",
            &json!({
                "query": "evidence",
                "scope": "project",
                "projectId": "alpha"
            }),
        )
        .expect("memory:search should be handled")
        .expect("memory:search should succeed");
        assert_eq!(
            project_hits
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item.get("id")),
            response.get("id")
        );

        let user_hits = handle_memory_channel(
            &state,
            "memory:search",
            &json!({ "query": "evidence", "scope": "user" }),
        )
        .expect("memory:search should be handled")
        .expect("memory:search should succeed");
        assert!(user_hits
            .as_array()
            .expect("memory:search should return an array")
            .is_empty());
    }

    #[test]
    fn memory_update_archive_recall_and_diagnostics_work_together() {
        let workspace_root = unique_test_dir("full-actions");
        let mut store = empty_store_for_workspace(&workspace_root);
        store.memories = vec![sample_memory(
            "memory-1",
            "User prefers concise implementation summaries.",
            "preference",
            &["summary"],
            Some("active"),
        )];
        let app = build_test_app(store, workspace_root);
        let state = app.state::<AppState>();

        let updated = handle_memory_channel(
            &state,
            "memory:update",
            &json!({
                "id": "memory-1",
                "content": "User prefers concise implementation summaries with verification evidence.",
                "entities": ["verification evidence"],
                "confidence": 0.92,
                "reason": "test update"
            }),
        )
        .expect("memory:update should be handled")
        .expect("memory:update should succeed");
        assert_eq!(updated.get("revision"), Some(&json!(2)));
        assert_eq!(updated.get("confidence"), Some(&json!(0.92)));

        let recalled = handle_memory_channel(
            &state,
            "memory:recall",
            &json!({ "query": "verification", "limit": 3 }),
        )
        .expect("memory:recall should be handled")
        .expect("memory:recall should succeed");
        assert_eq!(recalled.get("matchedCount"), Some(&json!(1)));
        assert_eq!(recalled.pointer("/items/0/id"), Some(&json!("memory-1")));

        let diagnostics = handle_memory_channel(&state, "memory:diagnostics", &json!({}))
            .expect("memory:diagnostics should be handled")
            .expect("memory:diagnostics should succeed");
        assert_eq!(
            diagnostics.get("retrievalEngine"),
            Some(&json!("sqlite-fts5-bm25"))
        );
        assert_eq!(diagnostics.get("fingerprintMatches"), Some(&json!(true)));

        handle_memory_channel(
            &state,
            "memory:archive",
            &json!({ "id": "memory-1", "reason": "test archive" }),
        )
        .expect("memory:archive should be handled")
        .expect("memory:archive should succeed");
        handle_memory_channel(&state, "memory:rebuild-index", &json!({}))
            .expect("memory:rebuild-index should be handled")
            .expect("memory:rebuild-index should succeed");

        let active_recall = handle_memory_channel(
            &state,
            "memory:recall",
            &json!({ "query": "verification", "limit": 3 }),
        )
        .expect("memory:recall should be handled")
        .expect("memory:recall should succeed");
        assert_eq!(active_recall.get("matchedCount"), Some(&json!(0)));

        let archived_recall = handle_memory_channel(
            &state,
            "memory:recall",
            &json!({ "query": "verification", "includeArchived": true, "limit": 3 }),
        )
        .expect("memory:recall should be handled")
        .expect("memory:recall should succeed");
        assert_eq!(archived_recall.get("matchedCount"), Some(&json!(1)));
    }
}
