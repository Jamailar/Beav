use serde_json::{json, Value};
use tauri::State;

#[path = "chat/runtime_state.rs"]
mod runtime_state;

use crate::persistence::with_store_mut;
use crate::{
    make_id, now_iso, slug_from_relative_path, AppState, AppStore, ChatMessageRecord,
    ChatSessionRecord,
};
pub use runtime_state::{
    begin_chat_runtime_state, is_chat_runtime_cancel_requested, request_chat_runtime_cancel,
    update_chat_runtime_state,
};

pub const DIAGNOSTICS_CONTEXT_TYPE: &str = "diagnostics";
pub const DIAGNOSTICS_CONTEXT_ID: &str = "developer-diagnostics";
pub const DIAGNOSTICS_SESSION_TITLE: &str = "Developer Diagnostics";

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
        starred: false,
        archived: false,
        archived_at: None,
        deleted_at: None,
    });
    let last_index = sessions.len() - 1;
    (&mut sessions[last_index], true)
}

pub fn ensure_chat_session_record(
    state: &State<'_, AppState>,
    session_id: Option<String>,
    title_hint: Option<String>,
) -> Result<String, String> {
    with_store_mut(state, |store| {
        let (session, _) = ensure_chat_session(&mut store.chat_sessions, session_id, title_hint);
        session.updated_at = now_iso();
        Ok(session.id.clone())
    })
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
    Some(build_context_bound_metadata(
        &context_type,
        context_id.as_deref(),
    ))
}

pub fn build_context_bound_metadata(context_type: &str, context_id: Option<&str>) -> Value {
    json!({
        "contextType": context_type,
        "contextId": context_id,
        "isContextBound": true
    })
}

pub fn apply_context_binding_metadata(
    session: &mut ChatSessionRecord,
    context_type: &str,
    context_id: &str,
    initial_context: Option<&str>,
) {
    let mut metadata = session
        .metadata
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    metadata.insert(
        "contextType".to_string(),
        Value::String(context_type.to_string()),
    );
    metadata.insert(
        "contextId".to_string(),
        Value::String(context_id.to_string()),
    );
    if context_type.trim() == "advisor-discussion" {
        metadata.insert(
            "advisorId".to_string(),
            Value::String(context_id.to_string()),
        );
    }
    metadata.insert("isContextBound".to_string(), Value::Bool(true));
    if let Some(initial_context_value) = initial_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        metadata.insert(
            "initialContext".to_string(),
            Value::String(initial_context_value.to_string()),
        );
    }
    session.metadata = Some(Value::Object(metadata));
}

pub fn session_matches_context_binding(
    session: &ChatSessionRecord,
    context_type: &str,
    context_id: &str,
) -> bool {
    let metadata = match session.metadata.as_ref().and_then(Value::as_object) {
        Some(metadata) => metadata,
        None => return false,
    };
    metadata
        .get("contextType")
        .and_then(Value::as_str)
        .map(str::trim)
        == Some(context_type.trim())
        && metadata
            .get("contextId")
            .and_then(Value::as_str)
            .map(str::trim)
            == Some(context_id.trim())
}

fn context_session_id_slug(context_id: &str) -> String {
    let slug = slug_from_relative_path(context_id);
    let mut normalized = String::with_capacity(slug.len());
    let mut previous_was_dash = false;
    for ch in slug.chars() {
        let next = if ch.is_whitespace() { '-' } else { ch };
        if next == '-' {
            if previous_was_dash {
                continue;
            }
            previous_was_dash = true;
        } else {
            previous_was_dash = false;
        }
        normalized.push(next);
    }
    normalized.trim_matches('-').to_string()
}

pub fn build_context_session_id(context_type: &str, context_id: &str) -> String {
    format!(
        "context-session:{context_type}:{}",
        context_session_id_slug(context_id)
    )
}

pub fn diagnostics_session_defaults() -> (String, String, String) {
    (
        DIAGNOSTICS_CONTEXT_TYPE.to_string(),
        DIAGNOSTICS_CONTEXT_ID.to_string(),
        DIAGNOSTICS_SESSION_TITLE.to_string(),
    )
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
        .filter(|value| *value == "manuscript-editor")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_context_session_id_slugs_context_id() {
        assert_eq!(
            build_context_session_id("diagnostics", "Developer Diagnostics"),
            "context-session:diagnostics:Developer-Diagnostics"
        );
    }

    #[test]
    fn diagnostics_defaults_match_expected_context() {
        let (context_type, context_id, title) = diagnostics_session_defaults();
        assert_eq!(context_type, "diagnostics");
        assert_eq!(context_id, "developer-diagnostics");
        assert_eq!(title, "Developer Diagnostics");
    }

    #[test]
    fn apply_context_binding_metadata_preserves_existing_fields() {
        let mut session = ChatSessionRecord {
            id: "session-1".to_string(),
            title: "Test".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "allowedTools": ["resource"]
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        };

        apply_context_binding_metadata(
            &mut session,
            "redclaw",
            "redclaw-singleton:default",
            Some("seed context"),
        );

        let metadata = session.metadata.expect("metadata");
        assert_eq!(
            metadata.get("contextType").and_then(Value::as_str),
            Some("redclaw")
        );
        assert_eq!(
            metadata.get("contextId").and_then(Value::as_str),
            Some("redclaw-singleton:default")
        );
        assert_eq!(
            metadata.get("initialContext").and_then(Value::as_str),
            Some("seed context")
        );
        assert_eq!(
            metadata
                .get("allowedTools")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(1)
        );
    }

    #[test]
    fn resolve_runtime_mode_uses_manuscript_editor_agent_profile() {
        let mut store = AppStore::default();
        store.chat_sessions.push(ChatSessionRecord {
            id: "file-session:demo".to_string(),
            title: "Demo".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "contextType": "file",
                "contextId": "manuscripts/demo",
                "agentProfile": "manuscript-editor"
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });

        assert_eq!(
            resolve_runtime_mode_for_session(&store, "file-session:demo"),
            "manuscript-editor"
        );
    }

    #[test]
    fn session_matches_context_binding_reads_metadata_only() {
        let session = ChatSessionRecord {
            id: "context-session:redclaw:legacy".to_string(),
            title: "Test".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "contextType": "knowledge",
                "contextId": "note-1",
                "isContextBound": true
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        };

        assert!(session_matches_context_binding(
            &session,
            "knowledge",
            "note-1"
        ));
        assert!(!session_matches_context_binding(
            &session, "redclaw", "legacy"
        ));
    }
}
