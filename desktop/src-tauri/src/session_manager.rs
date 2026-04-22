use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::chat_state::{
    apply_context_binding_metadata, build_context_session_id, ensure_chat_session,
    infer_context_id_from_session_id, infer_context_type_from_session_id, latest_session_id,
    resolve_runtime_mode_for_session, session_matches_context_binding,
};
use crate::runtime::{
    chat_messages_for_session, checkpoint_count_for_session, checkpoints_for_session,
    last_checkpoint_for_session, runtime_context_messages_for_session,
    session_context_value_for_session, session_summary_text_for_session, tool_results_for_session,
    trace_for_session, transcript_count_for_session, SessionCheckpointRecord,
    SessionTranscriptFileMeta, SESSION_CONTEXT_TAIL_MESSAGES,
};
use crate::{make_id, now_iso, AppStore, ChatSessionContextRecord, ChatSessionRecord};

pub(crate) const SESSION_RETENTION_MAX_SESSIONS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionContextSummary {
    pub context_type: String,
    pub context_id: Option<String>,
    pub is_context_bound: bool,
    pub initial_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionChatSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionSummary {
    pub chat_session: SessionChatSummary,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub runtime_mode: String,
    pub context: Option<SessionContextSummary>,
    pub message_count: i64,
    pub summary: String,
    pub transcript_count: i64,
    pub checkpoint_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: SessionSummary,
    pub context_record: Value,
    pub resume_messages: Vec<Value>,
    pub last_checkpoint: Option<SessionCheckpointRecord>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionRetentionOutcome {
    pub removed_session_ids: Vec<String>,
}

pub(crate) struct ForkSessionOutcome {
    pub session: ChatSessionRecord,
    pub transcript_count: i64,
    pub checkpoint_count: i64,
}

pub(crate) fn list_sessions(store: &AppStore) -> Vec<ChatSessionRecord> {
    let mut sessions = store.chat_sessions.clone();
    sessions.sort_by(|a, b| compare_session_updated_at_desc(a, b));
    sessions
}

pub(crate) fn list_context_sessions(
    store: &AppStore,
    context_type: &str,
    context_id: &str,
) -> Vec<ChatSessionRecord> {
    let mut sessions = store
        .chat_sessions
        .iter()
        .filter(|session| session_matches_context_binding(session, context_type, context_id))
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by(|a, b| compare_session_updated_at_desc(a, b));
    sessions
}

pub(crate) fn create_session(
    store: &mut AppStore,
    title: impl Into<String>,
    metadata: Option<Value>,
) -> ChatSessionRecord {
    let timestamp = now_iso();
    let session = ChatSessionRecord {
        id: make_id("session"),
        title: normalize_title(title.into()),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        metadata,
    };
    store.chat_sessions.push(session.clone());
    session
}

pub(crate) fn create_context_session(
    store: &mut AppStore,
    context_type: &str,
    context_id: &str,
    title: impl Into<String>,
    initial_context: Option<&str>,
) -> ChatSessionRecord {
    let mut session = create_session(store, title, None);
    apply_context_binding_metadata(&mut session, context_type, context_id, initial_context);
    if let Some(existing) = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == session.id)
    {
        *existing = session.clone();
    }
    session
}

pub(crate) fn ensure_context_session(
    store: &mut AppStore,
    context_type: &str,
    context_id: &str,
    title: impl Into<String>,
    initial_context: Option<&str>,
) -> ChatSessionRecord {
    let session_id = build_context_session_id(context_type, context_id);
    let title = normalize_title(title.into());
    let (session, _) = ensure_chat_session(&mut store.chat_sessions, Some(session_id), Some(title));
    apply_context_binding_metadata(session, context_type, context_id, initial_context);
    session.updated_at = now_iso();
    session.clone()
}

pub(crate) fn update_metadata(
    store: &mut AppStore,
    session_id: &str,
    metadata: Option<Value>,
) -> bool {
    if let Some(session) = store
        .chat_sessions
        .iter_mut()
        .find(|item| item.id == session_id)
    {
        session.metadata = metadata;
        session.updated_at = now_iso();
        return true;
    }
    false
}

pub(crate) fn delete_session(store: &mut AppStore, session_id: &str) -> bool {
    let had_session = store.chat_sessions.iter().any(|item| item.id == session_id);
    if !had_session {
        return false;
    }
    remove_session_artifacts(store, session_id);
    true
}

pub(crate) fn fork_session(
    store: &mut AppStore,
    source_session_id: &str,
) -> Option<ForkSessionOutcome> {
    let source = store
        .chat_sessions
        .iter()
        .find(|item| item.id == source_session_id)
        .cloned()?;
    let timestamp = now_iso();
    let new_session = ChatSessionRecord {
        id: make_id("session"),
        title: format!("{} (Fork)", source.title),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        metadata: source.metadata.clone(),
    };
    let transcript_count = transcript_count_for_session(store, source_session_id);
    let checkpoint_count = checkpoint_count_for_session(store, source_session_id);
    store.chat_sessions.push(new_session.clone());
    for item in store
        .chat_messages
        .iter()
        .filter(|entry| entry.session_id == source.id)
        .cloned()
        .collect::<Vec<_>>()
    {
        let mut copy = item;
        copy.id = make_id("message");
        copy.session_id = new_session.id.clone();
        copy.created_at = timestamp.clone();
        store.chat_messages.push(copy);
    }
    if let Some(context) = store
        .session_context_records
        .iter()
        .find(|item| item.session_id == source.id)
        .cloned()
    {
        store.session_context_records.push(fork_context_record(
            context,
            &new_session.id,
            &timestamp,
        ));
    }
    Some(ForkSessionOutcome {
        session: new_session,
        transcript_count,
        checkpoint_count,
    })
}

pub(crate) fn enforce_default_retention(store: &mut AppStore) -> SessionRetentionOutcome {
    enforce_retention(store, SESSION_RETENTION_MAX_SESSIONS)
}

pub(crate) fn enforce_retention(
    store: &mut AppStore,
    max_sessions: usize,
) -> SessionRetentionOutcome {
    if max_sessions == 0 {
        let removed_ids = store
            .chat_sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        for session_id in &removed_ids {
            remove_session_artifacts(store, session_id);
        }
        return SessionRetentionOutcome {
            removed_session_ids: removed_ids,
        };
    }

    let mut retained = list_sessions(store);
    if retained.len() <= max_sessions {
        return SessionRetentionOutcome::default();
    }
    let removed_ids = retained
        .drain(max_sessions..)
        .map(|session| session.id)
        .collect::<Vec<_>>();
    for session_id in &removed_ids {
        remove_session_artifacts(store, session_id);
    }
    SessionRetentionOutcome {
        removed_session_ids: removed_ids,
    }
}

pub(crate) fn resolve_resume_target_session_id(
    store: &AppStore,
    requested_session_id: Option<&str>,
) -> Option<String> {
    match requested_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("latest") | None => resolve_current_session_id(store),
        Some(session_id) => Some(session_id.to_string()),
    }
}

pub(crate) fn resolve_current_session_id(store: &AppStore) -> Option<String> {
    if store.chat_sessions.is_empty() {
        None
    } else {
        Some(latest_session_id(store))
    }
}

pub(crate) fn build_session_summary(
    store: &AppStore,
    session: &ChatSessionRecord,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> SessionSummary {
    SessionSummary {
        chat_session: SessionChatSummary {
            id: session.id.clone(),
            title: session.title.clone(),
            created_at: session.created_at.clone(),
            updated_at: session.updated_at.clone(),
        },
        provider: resolve_session_provider(session, transcript_meta),
        model: resolve_session_model(session, transcript_meta),
        runtime_mode: resolve_runtime_mode_for_session(store, &session.id),
        context: session_context_summary(session),
        message_count: chat_messages_for_session(store, &session.id).len() as i64,
        summary: session_summary_text_for_session(store, &session.id),
        transcript_count: transcript_count_for_session(store, &session.id),
        checkpoint_count: checkpoint_count_for_session(store, &session.id),
    }
}

pub(crate) fn build_session_snapshot(
    store: &AppStore,
    session_id: &str,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
    resume_messages: Option<Vec<Value>>,
) -> Option<SessionSnapshot> {
    let session = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)?;
    let summary = build_session_summary(store, session, transcript_meta);
    Some(SessionSnapshot {
        session: summary,
        context_record: session_context_value_for_session(store, session_id),
        resume_messages: resume_messages.unwrap_or_else(|| {
            runtime_context_messages_for_session(
                None,
                store,
                session_id,
                SESSION_CONTEXT_TAIL_MESSAGES,
            )
        }),
        last_checkpoint: last_checkpoint_for_session(store, session_id),
    })
}

pub(crate) fn session_list_item_value(
    store: &AppStore,
    session: &ChatSessionRecord,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> Value {
    let summary = build_session_summary(store, session, transcript_meta);
    json!({
        "id": summary.chat_session.id,
        "provider": summary.provider,
        "model": summary.model,
        "runtimeMode": summary.runtime_mode,
        "contextBinding": summary.context,
        "messageCount": summary.message_count,
        "summary": summary.summary,
        "transcriptCount": summary.transcript_count,
        "checkpointCount": summary.checkpoint_count,
        "context": session_context_value_for_session(store, &summary.chat_session.id),
        "chatSession": summary.chat_session,
    })
}

pub(crate) fn session_detail_value(
    store: &AppStore,
    session_id: &str,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> Value {
    let Some(snapshot) = build_session_snapshot(store, session_id, transcript_meta, None) else {
        return Value::Null;
    };
    json!({
        "session": snapshot.session,
        "chatSession": snapshot.session.chat_session,
        "provider": snapshot.session.provider,
        "model": snapshot.session.model,
        "runtimeMode": snapshot.session.runtime_mode,
        "contextBinding": snapshot.session.context,
        "context": snapshot.context_record,
        "transcript": trace_for_session(store, session_id),
        "checkpoints": checkpoints_for_session(store, session_id),
        "toolResults": tool_results_for_session(store, session_id),
    })
}

pub(crate) fn session_resume_value(
    store: &AppStore,
    session_id: &str,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
    resume_messages: Option<Vec<Value>>,
) -> Value {
    let Some(snapshot) =
        build_session_snapshot(store, session_id, transcript_meta, resume_messages)
    else {
        return Value::Null;
    };
    json!({
        "session": snapshot.session,
        "chatSession": snapshot.session.chat_session,
        "provider": snapshot.session.provider,
        "model": snapshot.session.model,
        "runtimeMode": snapshot.session.runtime_mode,
        "contextBinding": snapshot.session.context,
        "summary": snapshot.session.summary,
        "messageCount": snapshot.session.message_count,
        "context": snapshot.context_record,
        "resumeMessages": snapshot.resume_messages,
        "lastCheckpoint": snapshot.last_checkpoint,
    })
}

pub(crate) fn session_bridge_summary_value(
    store: &AppStore,
    session: &ChatSessionRecord,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> Value {
    let summary = build_session_summary(store, session, transcript_meta);
    let updated_at = summary.chat_session.updated_at.parse::<i64>().unwrap_or(0);
    let created_at = summary.chat_session.created_at.parse::<i64>().unwrap_or(0);
    let owner_task_count = store
        .runtime_tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(summary.chat_session.id.as_str()))
        .count() as i64;
    json!({
        "id": summary.chat_session.id,
        "title": summary.chat_session.title,
        "updatedAt": updated_at,
        "createdAt": created_at,
        "contextType": summary
            .context
            .as_ref()
            .map(|context| context.context_type.clone())
            .unwrap_or_else(|| "chat".to_string()),
        "runtimeMode": summary.runtime_mode,
        "provider": summary.provider,
        "model": summary.model,
        "isBackgroundSession": false,
        "ownerTaskCount": owner_task_count,
        "backgroundTaskCount": 0,
    })
}

pub(crate) fn session_bridge_detail_value(
    store: &AppStore,
    session_id: &str,
    background_tasks: &[Value],
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> Value {
    let Some(snapshot) = build_session_snapshot(store, session_id, transcript_meta, None) else {
        return Value::Null;
    };
    let tasks: Vec<Value> = store
        .runtime_tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(session_id))
        .map(crate::runtime::runtime_task_value)
        .collect();
    json!({
        "session": {
            "id": snapshot.session.chat_session.id,
            "title": snapshot.session.chat_session.title,
            "updatedAt": snapshot.session.chat_session.updated_at.parse::<i64>().unwrap_or(0),
            "createdAt": snapshot.session.chat_session.created_at.parse::<i64>().unwrap_or(0),
            "contextType": snapshot
                .session
                .context
                .as_ref()
                .map(|context| context.context_type.clone())
                .unwrap_or_else(|| "chat".to_string()),
            "runtimeMode": snapshot.session.runtime_mode,
            "provider": snapshot.session.provider,
            "model": snapshot.session.model,
            "isBackgroundSession": false,
            "ownerTaskCount": tasks.len(),
            "backgroundTaskCount": background_tasks.len(),
            "metadata": store
                .chat_sessions
                .iter()
                .find(|item| item.id == session_id)
                .and_then(|item| item.metadata.clone()),
        },
        "snapshot": snapshot,
        "transcript": trace_for_session(store, session_id),
        "checkpoints": checkpoints_for_session(store, session_id),
        "toolResults": tool_results_for_session(store, session_id),
        "tasks": tasks,
        "backgroundTasks": background_tasks,
        "permissionRequests": [],
    })
}

fn remove_session_artifacts(store: &mut AppStore, session_id: &str) {
    store.chat_sessions.retain(|item| item.id != session_id);
    store
        .chat_messages
        .retain(|item| item.session_id != session_id);
    store
        .session_context_records
        .retain(|item| item.session_id != session_id);
    store
        .session_transcript_records
        .retain(|item| item.session_id != session_id);
    store
        .session_checkpoints
        .retain(|item| item.session_id != session_id);
    store
        .session_tool_results
        .retain(|item| item.session_id != session_id);
}

fn session_context_summary(session: &ChatSessionRecord) -> Option<SessionContextSummary> {
    let metadata = session.metadata.as_ref().and_then(Value::as_object);
    let context_type = metadata
        .and_then(|value| value.get("contextType"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| infer_context_type_from_session_id(&session.id))?;
    let context_id = metadata
        .and_then(|value| value.get("contextId"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| infer_context_id_from_session_id(&session.id));
    let is_context_bound = metadata
        .and_then(|value| value.get("isContextBound"))
        .and_then(Value::as_bool)
        .unwrap_or(context_id.is_some() || context_type != "chat");
    let initial_context = metadata
        .and_then(|value| value.get("initialContext"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    Some(SessionContextSummary {
        context_type,
        context_id,
        is_context_bound,
        initial_context,
    })
}

fn resolve_session_provider(
    session: &ChatSessionRecord,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> Option<String> {
    session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("provider"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            transcript_meta
                .map(|meta| meta.protocol.trim())
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn resolve_session_model(
    session: &ChatSessionRecord,
    transcript_meta: Option<&SessionTranscriptFileMeta>,
) -> Option<String> {
    session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("model"))
        .and_then(Value::as_str)
        .or_else(|| {
            session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("modelName"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            transcript_meta
                .and_then(|meta| meta.model_name.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn fork_context_record(
    mut record: ChatSessionContextRecord,
    session_id: &str,
    updated_at: &str,
) -> ChatSessionContextRecord {
    record.session_id = session_id.to_string();
    record.updated_at = updated_at.to_string();
    record
}

fn compare_session_updated_at_desc(
    left: &ChatSessionRecord,
    right: &ChatSessionRecord,
) -> std::cmp::Ordering {
    right.updated_at.cmp(&left.updated_at)
}

fn normalize_title(title: String) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "New Chat".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{load_store, persist_store};
    use crate::{ChatMessageRecord, SessionCheckpointRecord, SessionTranscriptRecord};
    use serde_json::json;
    use std::fs;

    fn test_session(id: &str, updated_at: &str, metadata: Option<Value>) -> ChatSessionRecord {
        ChatSessionRecord {
            id: id.to_string(),
            title: "Session".to_string(),
            created_at: "1".to_string(),
            updated_at: updated_at.to_string(),
            metadata,
        }
    }

    fn test_message(
        session_id: &str,
        role: &str,
        content: &str,
        created_at: &str,
    ) -> ChatMessageRecord {
        ChatMessageRecord {
            id: format!("message-{created_at}"),
            session_id: session_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            display_content: None,
            attachment: None,
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn list_context_sessions_filters_by_metadata_and_sorts() {
        let mut store = AppStore::default();
        store.chat_sessions.push(test_session(
            "session-1",
            "1",
            Some(json!({"contextType": "redclaw", "contextId": "space-a"})),
        ));
        store.chat_sessions.push(test_session(
            "session-2",
            "3",
            Some(json!({"contextType": "redclaw", "contextId": "space-a"})),
        ));
        store.chat_sessions.push(test_session(
            "session-3",
            "2",
            Some(json!({"contextType": "redclaw", "contextId": "space-b"})),
        ));

        let sessions = list_context_sessions(&store, "redclaw", "space-a");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, "session-2");
        assert_eq!(sessions[1].id, "session-1");
    }

    #[test]
    fn create_context_session_applies_binding_and_initial_context() {
        let mut store = AppStore::default();
        let session = create_context_session(
            &mut store,
            "redclaw",
            "space-a",
            " RedClaw ",
            Some("seeded"),
        );
        assert_eq!(session.title, "RedClaw");
        assert_eq!(
            session
                .metadata
                .as_ref()
                .and_then(|value| value.get("contextType"))
                .and_then(Value::as_str),
            Some("redclaw")
        );
        assert_eq!(
            session
                .metadata
                .as_ref()
                .and_then(|value| value.get("initialContext"))
                .and_then(Value::as_str),
            Some("seeded")
        );
    }

    #[test]
    fn build_session_summary_collects_runtime_metadata() {
        let mut store = AppStore::default();
        let session = ChatSessionRecord {
            id: "session-1".to_string(),
            title: "RedClaw".to_string(),
            created_at: "1".to_string(),
            updated_at: "2".to_string(),
            metadata: Some(json!({
                "contextType": "redclaw",
                "contextId": "space-a",
                "isContextBound": true,
                "provider": "openai",
                "modelName": "gpt-4.1"
            })),
        };
        store.chat_sessions.push(session.clone());
        store
            .chat_messages
            .push(test_message("session-1", "user", "hello", "1"));

        let summary = build_session_summary(&store, &session, None);
        assert_eq!(summary.provider.as_deref(), Some("openai"));
        assert_eq!(summary.model.as_deref(), Some("gpt-4.1"));
        assert_eq!(summary.runtime_mode, "redclaw");
        assert_eq!(summary.message_count, 1);
        assert_eq!(
            summary
                .context
                .as_ref()
                .map(|value| value.context_type.as_str()),
            Some("redclaw")
        );
    }

    #[test]
    fn delete_session_removes_session_artifacts() {
        let mut store = AppStore::default();
        store
            .chat_sessions
            .push(test_session("session-1", "1", None));
        store
            .chat_messages
            .push(test_message("session-1", "user", "hello", "1"));
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

        assert!(delete_session(&mut store, "session-1"));
        assert!(store.chat_sessions.is_empty());
        assert!(store.chat_messages.is_empty());
        assert!(store.session_transcript_records.is_empty());
    }

    #[test]
    fn enforce_retention_prunes_oldest_session_artifacts() {
        let mut store = AppStore::default();
        for item in 0..3 {
            let session_id = format!("session-{item}");
            store.chat_sessions.push(ChatSessionRecord {
                id: session_id.clone(),
                title: format!("Session {item}"),
                created_at: item.to_string(),
                updated_at: item.to_string(),
                metadata: None,
            });
            store.chat_messages.push(test_message(
                &session_id,
                "user",
                "hello",
                &item.to_string(),
            ));
        }

        let outcome = enforce_retention(&mut store, 2);
        assert_eq!(outcome.removed_session_ids, vec!["session-0".to_string()]);
        assert_eq!(store.chat_sessions.len(), 2);
        assert!(store
            .chat_messages
            .iter()
            .all(|message| message.session_id != "session-0"));
    }

    #[test]
    fn persisted_store_can_resume_and_continue_session_after_reload() {
        let path =
            std::env::temp_dir().join(format!("redbox-session-manager-{}.json", crate::now_ms()));
        let mut store = AppStore::default();
        let session = create_context_session(
            &mut store,
            "redclaw",
            "space-a",
            "Reloadable",
            Some("seed prompt"),
        );
        store
            .chat_messages
            .push(test_message(&session.id, "user", "hello", "1"));
        store
            .chat_messages
            .push(test_message(&session.id, "assistant", "world", "2"));
        store.session_checkpoints.push(SessionCheckpointRecord {
            id: "checkpoint-1".to_string(),
            session_id: session.id.clone(),
            runtime_id: None,
            parent_runtime_id: None,
            source_task_id: None,
            checkpoint_type: "turn".to_string(),
            summary: "first turn".to_string(),
            payload: None,
            created_at: 2,
        });

        persist_store(&path, &store).expect("persist store");
        let mut reloaded = load_store(&path);
        let resumed_id =
            resolve_resume_target_session_id(&reloaded, None).expect("resume target session");
        let resumed = build_session_snapshot(&reloaded, &resumed_id, None, None).expect("snapshot");
        assert_eq!(resumed.session.chat_session.title, "Reloadable");
        assert_eq!(resumed.session.message_count, 2);
        assert_eq!(
            resumed
                .resume_messages
                .first()
                .and_then(|item| item.get("content"))
                .and_then(Value::as_str),
            Some("[Session initial context]\nseed prompt")
        );

        reloaded
            .chat_messages
            .push(test_message(&resumed_id, "user", "continue", "3"));
        reloaded
            .chat_messages
            .push(test_message(&resumed_id, "assistant", "done", "4"));
        if let Some(session_record) = reloaded
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == resumed_id)
        {
            session_record.updated_at = "4".to_string();
        }
        let continued =
            build_session_snapshot(&reloaded, &resumed_id, None, None).expect("continued");
        assert_eq!(continued.session.message_count, 4);
        assert_eq!(
            continued
                .last_checkpoint
                .as_ref()
                .map(|item| item.summary.as_str()),
            Some("first turn")
        );

        let _ = fs::remove_file(path);
    }
}
