use crate::persistence::with_store;
use crate::process_utils::background_command;
use crate::runtime::{append_session_checkpoint, SessionCheckpointRecord};
#[cfg(test)]
use crate::ChatSessionRecord;
use crate::{
    make_id, now_iso, slug_from_relative_path, storage_safe_file_stem, store_root, AppState,
    AppStore, ChatMessageRecord, ChatSessionContextRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub const SESSION_CONTEXT_TAIL_MESSAGES: usize = 8;
pub const SESSION_AUTO_COMPACT_MIN_MESSAGES: usize = 12;
pub const DEFAULT_SESSION_COMPACT_TARGET_TOKENS: i64 = 256_000;
pub const MIN_SESSION_COMPACT_TARGET_TOKENS: i64 = 16_000;
const SESSION_CONTEXT_SUMMARY_MAX_CHARS: usize = 1200;
const SESSION_BUNDLE_MAX_SESSIONS: usize = 200;
const SESSION_RESOURCE_MAX_DEPTH: usize = 8;

#[path = "session_runtime/bundle_store.rs"]
mod bundle_store;
#[path = "session_runtime/checkpoint_events.rs"]
mod checkpoint_events;
#[path = "session_runtime/context.rs"]
mod context;
#[path = "session_runtime/export.rs"]
mod export;
#[path = "session_runtime/history.rs"]
mod history;
#[path = "session_runtime/query.rs"]
mod query;
#[path = "session_runtime/reference_resolver.rs"]
mod reference_resolver;
#[path = "session_runtime/resources.rs"]
mod resources;
#[path = "session_runtime/transcript_api.rs"]
mod transcript_api;
#[path = "session_runtime/transcript_store.rs"]
mod transcript_store;
#[path = "session_runtime/transcript_sync.rs"]
mod transcript_sync;

use bundle_store::{
    load_session_runtime_bundle, persist_session_runtime_bundle, remove_session_bundle_meta,
    resolve_session_id_or_latest, session_runtime_bundle_path,
};
pub use checkpoint_events::{persist_runtime_query_checkpoints, runtime_query_checkpoint_events};
pub use context::{
    append_compact_boundary_entry, bundle_messages_for_runtime,
    runtime_context_messages_for_session, session_context_usage_value,
    session_context_value_for_session, session_message_count_for_session,
    session_summary_text_for_session, update_session_context_record,
};
pub use export::{
    apply_session_export_bundle_to_store, build_session_export_bundle,
    canonical_item_for_transcript_record, persist_imported_session_export_files,
    read_session_export_package, session_export_bundle_value, write_session_export_package,
};
pub use history::sanitize_runtime_history_messages;
use history::{
    build_session_context_summary, estimate_tokens_from_chars,
    runtime_history_message_from_chat_record, session_bundle_summary_from_messages, snippet,
};
use query::session_ids_for_query;
pub use query::{
    checkpoints_for_session, checkpoints_value_for_session, runtime_events_value_for_session,
    tool_results_for_session, tool_results_value_for_session, trace_for_session,
    trace_value_for_session,
};
pub use reference_resolver::resolve_session_file_reference_inputs;
#[cfg(test)]
use reference_resolver::{
    resolve_reference_from_value_tree, resolve_session_file_reference_input_from_store,
};
pub use resources::{session_resources_prompt_for_session, session_resources_value_for_session};
pub use transcript_api::{
    duplicate_session_bundle, list_transcript_sessions, load_session_bundle_messages,
    load_session_bundle_chat_messages, merge_chat_messages_with_bundle_history,
    remove_session_bundle, save_session_bundle_messages, transcript_resume_messages,
    transcript_session_meta_by_id, transcript_session_meta_value,
};
pub(crate) use transcript_store::load_transcript_entries;
use transcript_store::{
    append_transcript_entry, load_session_transcript_file_index,
    persist_session_transcript_file_index, remove_session_transcript_meta,
    session_transcript_metadata_snapshot, session_transcript_path, update_session_transcript_index,
};
use transcript_sync::{
    rebuild_messages_after_last_compaction, sync_transcript_from_bundle, transcript_message_entries,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRuntimeBundle {
    pub session_id: String,
    pub created_at: String,
    pub protocol: String,
    pub runtime_mode: String,
    pub model_name: Option<String>,
    pub message_count: i64,
    pub updated_at: String,
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRuntimeBundleMeta {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub protocol: String,
    pub runtime_mode: String,
    pub model_name: Option<String>,
    pub summary: String,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRuntimeBundleIndex {
    pub sessions: Vec<SessionRuntimeBundleMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionTranscriptFileMeta {
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub summary: String,
    pub protocol: String,
    pub runtime_mode: String,
    pub mode: Option<String>,
    pub model_name: Option<String>,
    pub tag: Option<String>,
    pub git_branch: Option<String>,
    pub worktree_path: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub message_count: i64,
    pub has_compaction: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionTranscriptFileIndex {
    pub sessions: Vec<SessionTranscriptFileMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionTranscriptFileEntry {
    Message {
        entry_id: String,
        session_id: String,
        message: Value,
        created_at: String,
    },
    Metadata {
        entry_id: String,
        session_id: String,
        title: Option<String>,
        tag: Option<String>,
        git_branch: Option<String>,
        worktree_path: Option<String>,
        pr_number: Option<i64>,
        pr_url: Option<String>,
        mode: Option<String>,
        runtime_mode: Option<String>,
        protocol: Option<String>,
        model_name: Option<String>,
        created_at: String,
    },
    CompactBoundary {
        entry_id: String,
        session_id: String,
        summary: String,
        preserved_entry_ids: Vec<String>,
        preserved_message_count: i64,
        created_at: String,
    },
}

pub fn transcript_count_for_session(store: &AppStore, session_id: &str) -> i64 {
    store
        .session_transcript_records
        .iter()
        .filter(|item| item.session_id == session_id)
        .count() as i64
}

pub fn checkpoint_count_for_session(store: &AppStore, session_id: &str) -> i64 {
    store
        .session_checkpoints
        .iter()
        .filter(|item| item.session_id == session_id)
        .count() as i64
}

pub fn last_checkpoint_for_session(
    store: &AppStore,
    session_id: &str,
) -> Option<SessionCheckpointRecord> {
    checkpoints_for_session(store, session_id)
        .into_iter()
        .max_by_key(|item| item.created_at)
}

#[cfg(test)]
pub fn session_list_item_value(store: &AppStore, session: &ChatSessionRecord) -> Value {
    crate::session_manager::session_list_item_value(store, session, None)
}

#[cfg(test)]
pub fn session_detail_value(store: &AppStore, session_id: &str) -> Value {
    crate::session_manager::session_detail_value(store, session_id, None)
}

#[cfg(test)]
pub fn session_resume_value(
    store: &AppStore,
    session_id: &str,
    resume_messages: Option<Vec<Value>>,
) -> Value {
    crate::session_manager::session_resume_value(store, session_id, None, resume_messages)
}

pub fn chat_messages_for_session(store: &AppStore, session_id: &str) -> Vec<ChatMessageRecord> {
    let mut items: Vec<ChatMessageRecord> = store
        .chat_messages
        .iter()
        .filter(|item| {
            item.session_id == session_id && (item.role == "user" || item.role == "assistant")
        })
        .cloned()
        .collect();
    items.sort_by(|a, b| compare_created_at(&a.created_at, &b.created_at));
    items
}

#[cfg(test)]
pub fn session_bridge_summary_value(session: &ChatSessionRecord, store: &AppStore) -> Value {
    crate::session_manager::session_bridge_summary_value(store, session, None)
}

fn session_compact_target_tokens(store: &AppStore) -> i64 {
    store
        .settings
        .get("redclaw_compact_target_tokens")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|item| i64::try_from(item).ok()))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|item| item.trim().parse::<i64>().ok())
                })
        })
        .map(|value| value.max(MIN_SESSION_COMPACT_TARGET_TOKENS))
        .unwrap_or(DEFAULT_SESSION_COMPACT_TARGET_TOKENS)
}

fn compare_created_at(left: &str, right: &str) -> std::cmp::Ordering {
    match (left.parse::<i64>(), right.parse::<i64>()) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => left.cmp(right),
    }
}

fn compare_iso_or_numeric(left: &str, right: &str) -> std::cmp::Ordering {
    compare_created_at(left, right)
}

fn session_transcript_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let dir = store_root(state)?.join("session-transcripts");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn storage_file_path(dir: &PathBuf, session_id: &str, ext: &str) -> PathBuf {
    dir.join(format!("{}.{}", storage_safe_file_stem(session_id), ext))
}

fn legacy_storage_file_path(dir: &PathBuf, session_id: &str, ext: &str) -> PathBuf {
    dir.join(format!("{}.{}", slug_from_relative_path(session_id), ext))
}

fn resolve_storage_file_path(
    dir: &PathBuf,
    session_id: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    let primary = storage_file_path(dir, session_id, ext);
    let legacy = legacy_storage_file_path(dir, session_id, ext);
    if primary == legacy || primary.exists() || !legacy.exists() {
        return Ok(primary);
    }
    fs::rename(&legacy, &primary).map_err(|error| error.to_string())?;
    Ok(primary)
}

#[cfg(test)]
pub fn session_bridge_detail_value(
    store: &AppStore,
    session_id: &str,
    background_tasks: &[Value],
) -> Value {
    crate::session_manager::session_bridge_detail_value(store, session_id, background_tasks, None)
}

#[cfg(test)]
mod tests {
    use super::bundle_store::{
        rebuild_session_runtime_bundle_index_from_dir, update_session_bundle_index,
    };
    use super::*;
    use crate::runtime::{
        RuntimeEventRecord, SessionCheckpointRecord, SessionToolResultRecord,
        SessionTranscriptRecord,
    };

    fn test_session(id: &str) -> ChatSessionRecord {
        ChatSessionRecord {
            id: id.to_string(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({ "contextType": "chat" })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        }
    }

    fn test_chat_message(
        session_id: &str,
        role: &str,
        content: &str,
        created_at: &str,
    ) -> crate::ChatMessageRecord {
        crate::ChatMessageRecord {
            id: format!("message-{}-{}", role, created_at),
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            display_content: None,
            attachment: None,
            metadata: None,
            created_at: created_at.to_string(),
        }
    }

    fn large_test_message(index: usize) -> String {
        format!("message {index} {}", "x".repeat(5000))
    }

    #[test]
    fn session_list_item_value_includes_counts_and_summary() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(test_session("session-1"));
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-1".to_string(),
                session_id: "session-1".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                payload: None,
                created_at: 1,
            });
        store.session_checkpoints.push(SessionCheckpointRecord {
            id: "checkpoint-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            checkpoint_type: "runtime.route".to_string(),
            summary: "route".to_string(),
            payload: None,
            created_at: 2,
        });

        let value = session_list_item_value(&store, &store.chat_sessions[0]);
        assert_eq!(
            value.get("transcriptCount").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            value.get("checkpointCount").and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            value
                .get("chatSession")
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("session-1")
        );
    }

    #[test]
    fn session_detail_and_resume_return_null_for_missing_session() {
        let store = crate::AppStore::default();
        assert_eq!(session_detail_value(&store, "missing"), Value::Null);
        assert_eq!(session_resume_value(&store, "missing", None), Value::Null);
    }

    #[test]
    fn session_bridge_values_include_counts_and_tasks() {
        let mut store = crate::AppStore::default();
        let session = test_session("session-1");
        store.chat_sessions.push(session.clone());
        crate::store::runtime_tasks::push_task(
            &mut store,
            crate::runtime::create_runtime_task(
                "manual",
                "pending",
                "default".to_string(),
                Some("session-1".to_string()),
                Some("draft".to_string()),
                crate::runtime::runtime_direct_route_record("default", "draft", None),
                None,
            ),
        );

        let summary = session_bridge_summary_value(&session, &store);
        assert_eq!(
            summary.get("ownerTaskCount").and_then(Value::as_i64),
            Some(1)
        );

        let detail = session_bridge_detail_value(&store, "session-1", &[json!({"id": "bg-1"})]);
        assert_eq!(
            detail
                .get("session")
                .and_then(|item| item.get("backgroundTaskCount"))
                .and_then(Value::as_i64),
            Some(1)
        );
        assert_eq!(
            detail
                .get("tasks")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
    }

    #[test]
    fn session_value_helpers_preserve_array_shapes() {
        let mut store = crate::AppStore::default();
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-1".to_string(),
                session_id: "session-1".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                payload: None,
                created_at: 1,
            });
        store.session_tool_results.push(SessionToolResultRecord {
            id: "tool-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            call_id: "call-1".to_string(),
            tool_name: "resource".to_string(),
            command: None,
            success: true,
            result_text: Some("ok".to_string()),
            summary_text: None,
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: None,
            created_at: 1,
            updated_at: 1,
        });

        assert!(trace_value_for_session(&store, "session-1", false, None).is_array());
        assert!(tool_results_value_for_session(&store, "session-1", false, None, None).is_array());
        assert!(checkpoints_value_for_session(&store, "session-1", false, None, None).is_array());
        assert!(
            runtime_events_value_for_session(&store, "session-1", false, None, None, None)
                .is_array()
        );
    }

    #[test]
    fn session_queries_can_include_child_sessions() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-parent".to_string(),
            title: "Parent".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({"contextType": "chat"})),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-child".to_string(),
            title: "Child".to_string(),
            created_at: "2".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({
                "contextType": "chat",
                "parentSessionId": "session-parent"
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-parent".to_string(),
                session_id: "session-parent".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "parent".to_string(),
                payload: None,
                created_at: 1,
            });
        store
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-child".to_string(),
                session_id: "session-child".to_string(),
                record_type: "message".to_string(),
                role: "assistant".to_string(),
                content: "child".to_string(),
                payload: None,
                created_at: 2,
            });

        let traces = trace_value_for_session(&store, "session-parent", true, None);
        assert_eq!(traces.as_array().map(|items| items.len()), Some(2));
    }

    #[test]
    fn runtime_events_query_filters_and_includes_child_sessions() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-parent".to_string(),
            title: "Parent".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({"contextType": "chat"})),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-child".to_string(),
            title: "Child".to_string(),
            created_at: "2".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({
                "contextType": "chat",
                "parentSessionId": "session-parent"
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store.runtime_events.push(RuntimeEventRecord {
            id: "event-parent".to_string(),
            category: "media_generation".to_string(),
            event_type: "request.started".to_string(),
            session_id: Some("session-parent".to_string()),
            created_at: 1,
            ..RuntimeEventRecord::default()
        });
        store.runtime_events.push(RuntimeEventRecord {
            id: "event-child".to_string(),
            category: "media_generation".to_string(),
            event_type: "request.completed".to_string(),
            session_id: Some("session-child".to_string()),
            created_at: 2,
            ..RuntimeEventRecord::default()
        });
        store.runtime_events.push(RuntimeEventRecord {
            id: "event-other".to_string(),
            category: "other".to_string(),
            event_type: "request.completed".to_string(),
            session_id: Some("session-child".to_string()),
            created_at: 3,
            ..RuntimeEventRecord::default()
        });

        let direct = runtime_events_value_for_session(
            &store,
            "session-parent",
            false,
            Some("media_generation"),
            None,
            None,
        );
        assert_eq!(direct.as_array().map(|items| items.len()), Some(1));

        let children = runtime_events_value_for_session(
            &store,
            "session-parent",
            true,
            Some("media_generation"),
            Some("request.completed"),
            None,
        );
        assert_eq!(children.as_array().map(|items| items.len()), Some(1));
        assert_eq!(
            children
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("event-child")
        );
    }

    #[test]
    fn session_export_bundle_includes_canonical_items_and_child_lineage() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-parent".to_string(),
            title: "Parent".to_string(),
            created_at: "1".to_string(),
            updated_at: "3".to_string(),
            metadata: Some(json!({"contextType": "chat", "runtimeMode": "default"})),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-child".to_string(),
            title: "Child".to_string(),
            created_at: "2".to_string(),
            updated_at: "4".to_string(),
            metadata: Some(json!({
                "contextType": "chat",
                "parentSessionId": "session-parent"
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store.chat_messages.push(test_chat_message(
            "session-parent",
            "user",
            "parent asks",
            "10",
        ));
        store.chat_messages.push(crate::ChatMessageRecord {
            id: "message-child".to_string(),
            session_id: "session-child".to_string(),
            role: "assistant".to_string(),
            content: "child replies".to_string(),
            display_content: None,
            attachment: None,
            metadata: Some(json!({ "turnId": "turn-child" })),
            created_at: "11".to_string(),
        });
        store.session_checkpoints.push(SessionCheckpointRecord {
            id: "checkpoint-1".to_string(),
            session_id: "session-parent".to_string(),
            checkpoint_type: "runtime.route".to_string(),
            summary: "route".to_string(),
            payload: Some(json!({ "turnId": "turn-parent" })),
            created_at: 12,
            ..SessionCheckpointRecord::default()
        });
        store.runtime_events.push(RuntimeEventRecord {
            id: "event-child".to_string(),
            category: "media_generation".to_string(),
            event_type: "request.completed".to_string(),
            session_id: Some("session-child".to_string()),
            payload: Some(json!({ "turnId": "turn-child" })),
            created_at: 13,
            ..RuntimeEventRecord::default()
        });

        let bundle = build_session_export_bundle(
            &store,
            "session-parent",
            true,
            vec![SessionTranscriptFileEntry::Message {
                entry_id: "entry-1".to_string(),
                session_id: "session-parent".to_string(),
                message: json!({
                    "role": "user",
                    "content": "file transcript",
                    "turnId": "turn-parent"
                }),
                created_at: "14".to_string(),
            }],
            vec![json!({
                "role": "assistant",
                "content": "bundle snapshot"
            })],
        )
        .unwrap();

        assert_eq!(
            bundle.manifest.child_session_ids,
            vec!["session-child".to_string()]
        );
        assert_eq!(bundle.manifest.message_count, 2);
        assert_eq!(bundle.manifest.checkpoint_count, 1);
        assert_eq!(bundle.manifest.runtime_event_count, 1);
        assert_eq!(bundle.manifest.transcript_file_entry_count, 1);
        assert!(bundle
            .manifest
            .files
            .iter()
            .any(|item| item == "sessions.jsonl"));
        assert_eq!(
            bundle.manifest.item_count,
            bundle.canonical_items.len() as i64
        );

        let kinds = bundle
            .canonical_items
            .iter()
            .map(|item| item.kind.as_str())
            .collect::<Vec<_>>();
        assert!(kinds.contains(&"session_meta"));
        assert!(kinds.contains(&"message"));
        assert!(kinds.contains(&"checkpoint"));
        assert!(kinds.contains(&"runtime_event"));
        assert!(kinds.contains(&"transcript_file_entry"));
        assert!(kinds.contains(&"bundle_message"));
        assert!(bundle.canonical_items.iter().any(|item| {
            item.item_id == "event-child" && item.turn_id.as_deref() == Some("turn-child")
        }));
    }

    #[test]
    fn session_export_bundle_import_restores_records_and_guards_overwrite() {
        let mut source = crate::AppStore::default();
        source.chat_sessions.push(ChatSessionRecord {
            id: "session-restore".to_string(),
            title: "Restore".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({"contextType": "chat"})),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        source.chat_messages.push(test_chat_message(
            "session-restore",
            "user",
            "restore me",
            "10",
        ));
        source
            .session_transcript_records
            .push(SessionTranscriptRecord {
                id: "trace-restore".to_string(),
                session_id: "session-restore".to_string(),
                record_type: "message".to_string(),
                role: "user".to_string(),
                content: "restore me".to_string(),
                payload: Some(json!({ "turnId": "turn-restore" })),
                created_at: 11,
            });
        source.session_checkpoints.push(SessionCheckpointRecord {
            id: "checkpoint-restore".to_string(),
            session_id: "session-restore".to_string(),
            checkpoint_type: "runtime.route".to_string(),
            summary: "route".to_string(),
            payload: None,
            created_at: 12,
            ..SessionCheckpointRecord::default()
        });
        source.runtime_events.push(RuntimeEventRecord {
            id: "event-restore".to_string(),
            category: "runtime".to_string(),
            event_type: "turn.completed".to_string(),
            session_id: Some("session-restore".to_string()),
            created_at: 13,
            ..RuntimeEventRecord::default()
        });
        let bundle = build_session_export_bundle(
            &source,
            "session-restore",
            false,
            Vec::new(),
            vec![json!({ "role": "user", "content": "restore me" })],
        )
        .unwrap();

        let mut imported = crate::AppStore::default();
        let outcome = apply_session_export_bundle_to_store(&mut imported, &bundle, false).unwrap();
        assert_eq!(outcome.session_id, "session-restore");
        assert_eq!(imported.chat_sessions.len(), 1);
        assert_eq!(imported.chat_messages.len(), 1);
        assert_eq!(imported.session_transcript_records.len(), 1);
        assert_eq!(imported.session_checkpoints.len(), 1);
        assert_eq!(imported.runtime_events.len(), 1);

        let duplicate = apply_session_export_bundle_to_store(&mut imported, &bundle, false);
        assert!(duplicate.is_err());

        imported.chat_messages[0].content = "stale".to_string();
        let overwrite = apply_session_export_bundle_to_store(&mut imported, &bundle, true).unwrap();
        assert!(overwrite.overwritten);
        assert_eq!(imported.chat_sessions.len(), 1);
        assert_eq!(imported.chat_messages.len(), 1);
        assert_eq!(imported.chat_messages[0].content, "restore me");
        assert_eq!(imported.runtime_events.len(), 1);
    }

    #[test]
    fn resolve_session_file_reference_prefers_recent_chat_attachment_paths() {
        let mut store = crate::AppStore::default();
        store.chat_messages.push(crate::ChatMessageRecord {
            id: "message-1".to_string(),
            session_id: "session-1".to_string(),
            role: "user".to_string(),
            content: "use prior image".to_string(),
            display_content: None,
            attachment: Some(json!({
                "name": "WechatIMG174.jpg",
                "absolutePath": "/tmp/session-image.jpg",
                "originalAbsolutePath": "/Users/jam/Desktop/WechatIMG174.jpg",
                "workspaceRelativePath": ".redbox/chat-attachments/WechatIMG174.jpg"
            })),
            metadata: None,
            created_at: "10".to_string(),
        });

        let resolved = resolve_session_file_reference_input_from_store(
            &store,
            "session-1",
            "WechatIMG174.jpg",
            &[],
        );

        assert_eq!(resolved, "/tmp/session-image.jpg");
    }

    #[test]
    fn resolve_session_file_reference_reads_recent_tool_result_artifacts() {
        let mut store = crate::AppStore::default();
        store.session_tool_results.push(SessionToolResultRecord {
            id: "tool-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            call_id: "call-1".to_string(),
            tool_name: "workflow".to_string(),
            command: Some("image.generate".to_string()),
            success: true,
            result_text: None,
            summary_text: None,
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: Some(json!({
                "data": {
                    "artifacts": [
                        {
                            "title": "封面主图",
                            "absolutePath": "/tmp/generated/cover.png",
                            "previewUrl": "file:///tmp/generated/cover.png"
                        }
                    ]
                }
            })),
            created_at: 20,
            updated_at: 20,
        });

        let resolved =
            resolve_session_file_reference_input_from_store(&store, "session-1", "cover.png", &[]);

        assert_eq!(resolved, "/tmp/generated/cover.png");
    }

    #[test]
    fn session_resources_list_includes_attachments_and_tool_artifacts() {
        let mut store = crate::AppStore::default();
        store.chat_messages.push(crate::ChatMessageRecord {
            id: "message-1".to_string(),
            session_id: "session-1".to_string(),
            role: "user".to_string(),
            content: "use image".to_string(),
            display_content: None,
            attachment: Some(json!({
                "name": "product.png",
                "absolutePath": "/tmp/product.png",
                "mimeType": "image/png"
            })),
            metadata: None,
            created_at: "10".to_string(),
        });
        store.session_tool_results.push(SessionToolResultRecord {
            id: "tool-1".to_string(),
            session_id: "session-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            call_id: "call-1".to_string(),
            tool_name: "workflow".to_string(),
            command: Some("image.generate".to_string()),
            success: true,
            result_text: None,
            summary_text: None,
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: Some(json!({
                "assets": [
                    {
                        "artifactId": "artifact-1",
                        "kind": "image",
                        "absolutePath": "/tmp/generated/storyboard.png",
                        "previewUrl": "file:///tmp/generated/storyboard.png"
                    }
                ]
            })),
            created_at: 20,
            updated_at: 20,
        });

        let value = session_resources_value_for_session(
            &store,
            "session-1",
            false,
            None,
            Some("image"),
            None,
        );
        let items = value.get("items").and_then(Value::as_array).unwrap();

        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].get("reference").and_then(Value::as_str),
            Some("/tmp/generated/storyboard.png")
        );
        assert!(items.iter().any(|item| {
            item.get("reference").and_then(Value::as_str) == Some("/tmp/product.png")
        }));
        assert!(items.iter().any(|item| {
            item.get("reference").and_then(Value::as_str) == Some("/tmp/generated/storyboard.png")
        }));
    }

    #[test]
    fn resolve_session_file_reference_falls_back_to_known_directories() {
        let unique = format!("redbox-session-ref-{}", crate::now_ms());
        let temp_root = std::env::temp_dir().join(unique);
        let target = temp_root.join("WechatIMG174.jpg");
        fs::create_dir_all(&temp_root).unwrap();
        fs::write(&target, b"test").unwrap();

        let resolved = resolve_session_file_reference_input_from_store(
            &crate::AppStore::default(),
            "session-1",
            "WechatIMG174.jpg",
            &[temp_root.clone()],
        );

        assert_eq!(resolved, target.display().to_string());

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn resolve_session_file_reference_uses_workspace_relative_path_from_attachment() {
        let unique = format!("redbox-session-workspace-ref-{}", crate::now_ms());
        let workspace_root = std::env::temp_dir().join(unique);
        let nested_dir = workspace_root.join("docs").join("assets");
        let target = nested_dir.join("brief.pdf");
        fs::create_dir_all(&nested_dir).unwrap();
        fs::write(&target, b"pdf").unwrap();

        let attachment = json!({
            "name": "brief.pdf",
            "workspaceRelativePath": "docs/assets/brief.pdf"
        });
        let resolved = resolve_reference_from_value_tree(
            &attachment,
            "brief.pdf",
            "brief.pdf",
            std::slice::from_ref(&workspace_root),
            0,
        );

        assert_eq!(resolved.as_deref(), Some(target.to_string_lossy().as_ref()));

        let _ = fs::remove_file(&target);
        let _ = fs::remove_dir_all(&workspace_root);
    }

    #[test]
    fn resolve_session_file_reference_converts_file_url_to_local_path() {
        let payload = json!({
            "title": "封面主图",
            "previewUrl": "file:///tmp/generated/cover.png"
        });
        let resolved =
            resolve_reference_from_value_tree(&payload, "cover.png", "cover.png", &[], 0);

        assert_eq!(resolved.as_deref(), Some("/tmp/generated/cover.png"));
    }

    #[test]
    fn runtime_query_checkpoint_events_include_route_and_optional_orchestration() {
        let events = runtime_query_checkpoint_events(
            "route resolved",
            json!({ "intent": "direct_answer" }),
            Some(json!({ "outputs": [{"roleId": "planner"}] })),
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "runtime.route");
        assert_eq!(events[1].0, "runtime.orchestration");
    }

    #[test]
    fn persist_runtime_query_checkpoints_writes_route_and_orchestration_records() {
        let mut store = crate::AppStore::default();

        persist_runtime_query_checkpoints(
            &mut store,
            "session-1",
            "route resolved",
            json!({ "intent": "direct_answer" }),
            Some(json!({ "outputs": [{ "roleId": "planner" }] })),
        );

        assert_eq!(store.session_checkpoints.len(), 2);
        assert_eq!(
            store.session_checkpoints[0].checkpoint_type,
            "runtime.route"
        );
        assert_eq!(
            store.session_checkpoints[1].checkpoint_type,
            "runtime.orchestration"
        );
    }

    #[test]
    fn session_context_snapshot_tracks_archived_history() {
        let mut store = crate::AppStore::default();
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-ctx",
                role,
                &format!("message {index}"),
                &index.to_string(),
            ));
        }

        let record = update_session_context_record(&mut store, "session-ctx", "manual", true)
            .expect("snapshot should be created");
        assert_eq!(record.compacted_message_count, 6);
        assert_eq!(record.tail_message_count, 8);
        assert_eq!(record.compact_rounds, 1);

        let usage = session_context_usage_value(&store, "session-ctx");
        assert_eq!(
            usage.get("compactedMessageCount").and_then(Value::as_i64),
            Some(6)
        );
        assert_eq!(
            usage.get("recentMessageCount").and_then(Value::as_u64),
            Some(8)
        );
        assert_eq!(
            usage.get("compactThreshold").and_then(Value::as_i64),
            Some(DEFAULT_SESSION_COMPACT_TARGET_TOKENS)
        );
    }

    #[test]
    fn runtime_context_messages_prepend_resume_summary_when_snapshot_exists() {
        let mut store = crate::AppStore::default();
        store.settings = json!({
            "redclaw_compact_target_tokens": MIN_SESSION_COMPACT_TARGET_TOKENS
        });
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-ctx",
                role,
                &large_test_message(index),
                &index.to_string(),
            ));
        }
        update_session_context_record(&mut store, "session-ctx", "auto", false);

        let messages = runtime_context_messages_for_session(None, &store, "session-ctx", 8);
        assert_eq!(messages.len(), 9);
        let summary = messages[0]
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(summary.contains("Archived 6 messages"));
        assert!(summary.contains("Conversation started with: message 0"));
        assert!(summary.contains("Latest archived user intent: message 4"));
        assert!(summary.contains("Latest archived assistant reply: message 5"));
        assert_eq!(
            messages[1]
                .get("content")
                .and_then(Value::as_str)
                .map(|item| item.starts_with("message 6 ")),
            Some(true)
        );
    }

    #[test]
    fn sanitize_runtime_history_messages_strips_tool_protocol_messages() {
        let messages = vec![
            json!({ "role": "user", "content": "原始用户需求" }),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call-old-1",
                    "type": "function",
                    "function": {
                        "name": "resource",
                        "arguments": "{\"action\":\"workspace.read\",\"path\":\"knowledge/a.md\"}"
                    }
                }]
            }),
            json!({
                "role": "tool",
                "tool_call_id": "call-old-1",
                "content": "{\"ok\":true}",
                "tool_name": "resource"
            }),
            json!({
                "role": "user",
                "content": "系统状态更新：以下技能已激活并写入当前会话：writing-style。不要向用户复述技能激活过程，不要输出 `<tool_call>`、`<activated_skill>` 或其他协议标签，也不要再次激活相同技能。基于更新后的技能上下文继续当前任务；如果下一步需要工具，直接发起真实工具调用。"
            }),
            json!({
                "role": "user",
                "content": "系统状态更新：以下技能已激活并加入当前轮上下文：writing-style。不要向用户复述技能激活过程，不要输出 `<tool_call>`、`<activated_skill>` 或其他协议标签，也不要再次激活相同技能。基于更新后的技能上下文继续当前任务；如果下一步需要工具，直接发起真实工具调用。"
            }),
            json!({
                "role": "user",
                "content": "你刚才发送了空的 `workflow` 调用，说明这次没有提供 `payload.content`。当前写稿工程已经绑定为 `wander/demo`。下一步先输出完整正文。"
            }),
            json!({
                "role": "assistant",
                "content": "这是最终答复"
            }),
        ];

        let sanitized = sanitize_runtime_history_messages(&messages);

        assert_eq!(sanitized.len(), 2);
        assert_eq!(
            sanitized[0].get("role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            sanitized[0].get("content").and_then(Value::as_str),
            Some("原始用户需求")
        );
        assert_eq!(
            sanitized[1].get("content").and_then(Value::as_str),
            Some("这是最终答复")
        );
    }

    #[test]
    fn sanitize_runtime_history_messages_keeps_assistant_text_but_drops_tool_calls() {
        let messages = vec![json!({
            "role": "assistant",
            "content": "先记录一个中间说明",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "workflow",
                    "arguments": "{\"action\":\"skills.invoke\",\"payload\":{\"name\":\"writing-style\"}}"
                }
            }]
        })];

        let sanitized = sanitize_runtime_history_messages(&messages);

        assert_eq!(sanitized.len(), 1);
        assert_eq!(
            sanitized[0].get("content").and_then(Value::as_str),
            Some("先记录一个中间说明")
        );
        assert!(sanitized[0].get("tool_calls").is_none());
    }

    #[test]
    fn sanitize_runtime_history_messages_keeps_compact_asset_context() {
        let messages = vec![json!({
            "role": "user",
            "content": "做一个 @Jamba 的口播视频",
            "metadata": {
                "explicitAssetRefs": [{
                    "assetId": "subject_1774704234274_53536cc0",
                    "name": "Jamba",
                    "imagePaths": ["/private/huge/path.png"],
                    "voicePath": "/private/voice.wav"
                }]
            }
        })];

        let sanitized = sanitize_runtime_history_messages(&messages);
        let content = sanitized[0]
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();

        assert!(content.contains("做一个 @Jamba 的口播视频"));
        assert!(content.contains("Referenced assets from this user message"));
        assert!(content.contains("name: Jamba"));
        assert!(content.contains("id: subject_1774704234274_53536cc0"));
        assert!(!content.contains("imagePaths"));
        assert!(!content.contains("voicePath"));
        assert!(!content.contains("/private/huge/path.png"));
    }

    #[test]
    fn runtime_context_messages_preserve_initial_context_for_context_bound_sessions() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "session-redclaw".to_string(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({
                "contextType": "redclaw",
                "contextId": "redclaw-singleton:default",
                "initialContext": "RedClaw seeded context"
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });
        store
            .chat_messages
            .push(test_chat_message("session-redclaw", "user", "hello", "1"));

        let messages = runtime_context_messages_for_session(None, &store, "session-redclaw", 8);
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].get("content").and_then(Value::as_str),
            Some("[Session initial context]\nRedClaw seeded context")
        );
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn session_resume_value_includes_context_and_resume_messages() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(test_session("session-1"));
        store.settings = json!({
            "redclaw_compact_target_tokens": MIN_SESSION_COMPACT_TARGET_TOKENS
        });
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-1",
                role,
                &large_test_message(index),
                &index.to_string(),
            ));
        }
        update_session_context_record(&mut store, "session-1", "auto", false);

        let value = session_resume_value(&store, "session-1", None);
        assert_eq!(value.get("messageCount").and_then(Value::as_i64), Some(14));
        assert!(value.get("context").is_some());
        assert_eq!(
            value
                .get("resumeMessages")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(9)
        );
    }

    #[test]
    fn auto_compaction_requires_token_threshold_but_manual_compaction_still_works() {
        let mut store = crate::AppStore::default();
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-compact-threshold",
                role,
                &format!("short message {index}"),
                &index.to_string(),
            ));
        }

        assert!(update_session_context_record(
            &mut store,
            "session-compact-threshold",
            "auto",
            false,
        )
        .is_none());

        let manual =
            update_session_context_record(&mut store, "session-compact-threshold", "manual", true)
                .expect(
                "manual compaction should archive history once there are more than tail messages",
            );
        assert_eq!(manual.compacted_message_count, 6);
    }

    #[test]
    fn context_usage_uses_effective_tokens_against_configured_threshold() {
        let mut store = crate::AppStore::default();
        store.settings = json!({
            "redclaw_compact_target_tokens": MIN_SESSION_COMPACT_TARGET_TOKENS
        });
        for index in 0..14 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            store.chat_messages.push(test_chat_message(
                "session-usage",
                role,
                &large_test_message(index),
                &index.to_string(),
            ));
        }

        let record = update_session_context_record(&mut store, "session-usage", "auto", false)
            .expect("auto compaction should trigger once tokens exceed threshold");
        let usage = session_context_usage_value(&store, "session-usage");
        let effective_tokens = usage
            .get("estimatedEffectiveTokens")
            .and_then(Value::as_i64)
            .expect("effective tokens should be present");
        let compact_ratio = usage
            .get("compactRatio")
            .and_then(Value::as_f64)
            .expect("compact ratio should be present");

        assert_eq!(
            usage.get("compactThreshold").and_then(Value::as_i64),
            Some(MIN_SESSION_COMPACT_TARGET_TOKENS)
        );
        assert_eq!(
            usage.get("estimatedTotalTokens").and_then(Value::as_i64),
            Some(record.estimated_total_tokens)
        );
        assert!(effective_tokens < record.estimated_total_tokens);
        assert!(compact_ratio > 0.0);
        assert!(compact_ratio < 1.0);
    }

    #[test]
    fn session_bundle_index_updates_summary_and_prunes_oldest_entries() {
        let mut index = SessionRuntimeBundleIndex::default();
        for item in 0..(SESSION_BUNDLE_MAX_SESSIONS + 2) {
            let bundle = SessionRuntimeBundle {
                session_id: format!("session-{item}"),
                created_at: item.to_string(),
                updated_at: item.to_string(),
                protocol: "openai".to_string(),
                runtime_mode: "chat".to_string(),
                model_name: Some("gpt".to_string()),
                message_count: 2,
                messages: vec![
                    json!({ "role": "user", "content": format!("hello {item}") }),
                    json!({ "role": "assistant", "content": "ok" }),
                ],
            };
            let _removed = update_session_bundle_index(&mut index, &bundle);
        }

        assert_eq!(index.sessions.len(), SESSION_BUNDLE_MAX_SESSIONS);
        assert_eq!(
            index.sessions.first().map(|item| item.session_id.as_str()),
            Some("session-2")
        );
        assert_eq!(
            index.sessions.last().map(|item| item.summary.as_str()),
            Some("hello 201")
        );
    }

    #[test]
    fn session_bundle_index_rebuilds_from_valid_bundle_files() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("redbox-session-bundle-index-rebuild-{timestamp}"));
        std::fs::create_dir_all(&dir).expect("temp dir should be created");

        let bundle = SessionRuntimeBundle {
            session_id: "session-valid".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            protocol: "openai".to_string(),
            runtime_mode: "image-generation".to_string(),
            model_name: Some("qwen".to_string()),
            message_count: 2,
            messages: vec![
                json!({ "role": "user", "content": "hello" }),
                json!({ "role": "assistant", "content": "ok" }),
            ],
        };
        std::fs::write(
            dir.join("session-valid.json"),
            serde_json::to_string_pretty(&bundle).expect("bundle should serialize"),
        )
        .expect("bundle should be written");
        std::fs::write(dir.join("session-corrupt.json"), "{\"sessionId\":").unwrap();
        std::fs::write(dir.join("index.json"), "{\"sessions\": []}trailing").unwrap();

        let index = rebuild_session_runtime_bundle_index_from_dir(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(index.sessions.len(), 1);
        assert_eq!(index.sessions[0].session_id, "session-valid");
        assert_eq!(index.sessions[0].summary, "hello");
    }

    #[test]
    fn rebuild_messages_after_last_compaction_keeps_preserved_and_post_boundary_messages() {
        let entries = vec![
            SessionTranscriptFileEntry::Message {
                entry_id: "m1".to_string(),
                session_id: "session-1".to_string(),
                message: json!({ "role": "user", "content": "hello" }),
                created_at: "1".to_string(),
            },
            SessionTranscriptFileEntry::Message {
                entry_id: "m2".to_string(),
                session_id: "session-1".to_string(),
                message: json!({ "role": "assistant", "content": "hi" }),
                created_at: "2".to_string(),
            },
            SessionTranscriptFileEntry::CompactBoundary {
                entry_id: "b1".to_string(),
                session_id: "session-1".to_string(),
                summary: "summary text".to_string(),
                preserved_entry_ids: vec!["m2".to_string()],
                preserved_message_count: 1,
                created_at: "3".to_string(),
            },
            SessionTranscriptFileEntry::Message {
                entry_id: "m3".to_string(),
                session_id: "session-1".to_string(),
                message: json!({ "role": "user", "content": "after" }),
                created_at: "4".to_string(),
            },
        ];
        let (messages, summary, preserved) = rebuild_messages_after_last_compaction(&entries);
        assert_eq!(summary.as_deref(), Some("summary text"));
        assert_eq!(preserved, vec!["m2".to_string()]);
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].get("content").and_then(Value::as_str),
            Some("hi")
        );
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("after")
        );
    }
}
