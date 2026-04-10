use serde_json::{json, Value};
use tauri::State;

use crate::{
    make_id, now_iso, now_ms, AppState, AppStore, ChatMessageRecord, ChatRuntimeStateRecord,
    ChatSessionRecord,
};

pub fn update_chat_runtime_state(
    state: &State<'_, AppState>,
    session_id: &str,
    is_processing: bool,
    partial_response: String,
    error: Option<String>,
) -> Result<(), String> {
    let mut guard = state
        .chat_runtime_states
        .lock()
        .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
    guard.insert(
        session_id.to_string(),
        ChatRuntimeStateRecord {
            session_id: session_id.to_string(),
            is_processing,
            partial_response,
            updated_at: now_ms(),
            error,
            cancel_requested: false,
        },
    );
    Ok(())
}

pub fn request_chat_runtime_cancel(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let mut guard = state
        .chat_runtime_states
        .lock()
        .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
    let entry = guard
        .entry(session_id.to_string())
        .or_insert(ChatRuntimeStateRecord {
            session_id: session_id.to_string(),
            is_processing: false,
            partial_response: String::new(),
            updated_at: now_ms(),
            error: None,
            cancel_requested: false,
        });
    entry.is_processing = false;
    entry.cancel_requested = true;
    entry.error = Some("cancelled".to_string());
    entry.updated_at = now_ms();
    Ok(())
}

pub fn is_chat_runtime_cancel_requested(state: &State<'_, AppState>, session_id: &str) -> bool {
    state
        .chat_runtime_states
        .lock()
        .ok()
        .and_then(|guard| guard.get(session_id).map(|entry| entry.cancel_requested))
        .unwrap_or(false)
}

pub fn ensure_chat_session<'a>(
    sessions: &'a mut Vec<ChatSessionRecord>,
    session_id: Option<String>,
    title_hint: Option<String>,
) -> (&'a mut ChatSessionRecord, bool) {
    let id = session_id.unwrap_or_else(|| make_id("session"));
    if let Some(index) = sessions.iter().position(|item| item.id == id) {
        return (&mut sessions[index], false);
    }

    let timestamp = now_iso();
    let metadata = build_session_metadata_from_session_id(&id);
    sessions.push(ChatSessionRecord {
        id: id.clone(),
        title: title_hint
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(|| "New Chat".to_string()),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        metadata,
    });
    let last_index = sessions.len() - 1;
    (&mut sessions[last_index], true)
}

pub fn latest_session_id(store: &AppStore) -> String {
    store
        .chat_sessions
        .iter()
        .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
        .map(|item| item.id.clone())
        .unwrap_or_else(|| "tool-confirmation".to_string())
}

pub fn infer_context_type_from_session_id(session_id: &str) -> Option<String> {
    let mut parts = session_id.splitn(3, ':');
    let prefix = parts.next().unwrap_or_default();
    let context_type = parts.next().unwrap_or_default();
    if prefix == "context-session" && !context_type.trim().is_empty() {
        return Some(context_type.trim().to_string());
    }
    if session_id.starts_with("file-session:") {
        return Some("file".to_string());
    }
    None
}

pub fn infer_context_id_from_session_id(session_id: &str) -> Option<String> {
    let mut parts = session_id.splitn(3, ':');
    let prefix = parts.next().unwrap_or_default();
    let _context_type = parts.next().unwrap_or_default();
    let context_id = parts.next().unwrap_or_default();
    if prefix == "context-session" && !context_id.trim().is_empty() {
        return Some(context_id.trim().to_string());
    }
    if session_id.starts_with("file-session:") {
        return session_id
            .split_once(':')
            .map(|(_, value)| value.to_string())
            .filter(|value| !value.trim().is_empty());
    }
    None
}

pub fn build_session_metadata_from_session_id(session_id: &str) -> Option<Value> {
    let context_type = infer_context_type_from_session_id(session_id)?;
    let context_id = infer_context_id_from_session_id(session_id);
    Some(json!({
        "contextType": context_type,
        "contextId": context_id,
        "isContextBound": true
    }))
}

pub fn resolve_runtime_mode_for_session(store: &AppStore, session_id: &str) -> String {
    let session_metadata = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .and_then(|session| session.metadata.as_ref());
    if let Some(agent_profile) = session_metadata
        .and_then(|metadata| metadata.get("agentProfile"))
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "video-editor" | "audio-editor"))
    {
        return agent_profile.to_string();
    }
    let context_type_from_metadata = session_metadata
        .and_then(|metadata| metadata.get("contextType"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let context_type = context_type_from_metadata
        .or_else(|| infer_context_type_from_session_id(session_id))
        .unwrap_or_else(|| "chat".to_string());
    crate::resolve_runtime_mode_from_context_type(Some(&context_type)).to_string()
}

pub fn session_context_type_and_id(store: &AppStore, session_id: &str) -> (String, Option<String>) {
    let context_type_from_metadata = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .and_then(|session| {
            session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("contextType"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        });
    let context_id_from_metadata = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)
        .and_then(|session| {
            session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("contextId"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        });
    let context_type = context_type_from_metadata
        .or_else(|| infer_context_type_from_session_id(session_id))
        .unwrap_or_else(|| "chat".to_string());
    let context_id =
        context_id_from_metadata.or_else(|| infer_context_id_from_session_id(session_id));
    (context_type, context_id)
}

pub fn is_first_assistant_turn_for_session(store: &AppStore, session_id: &str) -> bool {
    let history: Vec<&ChatMessageRecord> = store
        .chat_messages
        .iter()
        .filter(|item| {
            item.session_id == session_id && (item.role == "user" || item.role == "assistant")
        })
        .collect();
    let assistant_count = history
        .iter()
        .filter(|item| item.role == "assistant")
        .count();
    assistant_count == 0 && history.len() <= 1
}

pub fn should_handle_redclaw_onboarding_for_session(store: &AppStore, session_id: &str) -> bool {
    let (context_type, context_id) = session_context_type_and_id(store, session_id);
    if context_type.trim().to_lowercase() != "redclaw" {
        return false;
    }
    let id = context_id.unwrap_or_default();
    id.starts_with("redclaw-singleton:") || id.trim() == "redclaw-singleton"
}
