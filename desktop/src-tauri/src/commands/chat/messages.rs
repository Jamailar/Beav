use serde_json::{json, Value};
use tauri::State;

use super::references::chat_user_message_metadata;
use crate::persistence::with_store_mut;
use crate::{append_session_transcript, make_id, now_iso, AppState, ChatMessageRecord};

pub(super) fn payload_member_mention_advisor_id(payload: &Value) -> Option<String> {
    payload
        .get("memberMention")
        .and_then(|value| value.as_object())
        .and_then(|object| {
            object
                .get("advisorId")
                .and_then(Value::as_str)
                .or_else(|| object.get("id").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn persist_chat_user_message_before_run(
    state: &State<'_, AppState>,
    session_id: &str,
    message: &str,
    display_content: &str,
    attachment: Option<Value>,
    advisor_id: Option<&str>,
    knowledge_references: &[Value],
    asset_references: &[Value],
    task_intent: Option<&str>,
) -> Result<(), String> {
    let metadata = chat_user_message_metadata(
        advisor_id,
        knowledge_references,
        asset_references,
        task_intent,
    );
    with_store_mut(state, |store| {
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session_id.to_string(),
            role: "user".to_string(),
            content: message.to_string(),
            display_content: if display_content.trim().is_empty() {
                None
            } else {
                Some(display_content.to_string())
            },
            attachment: attachment.clone(),
            metadata: metadata.clone(),
            created_at: now_iso(),
        });
        if let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        {
            session.updated_at = now_iso();
        }
        append_session_transcript(
            store,
            session_id,
            "message",
            "user",
            message.to_string(),
            Some(json!({
                "displayContent": display_content,
                "attachment": attachment,
                "metadata": metadata,
            })),
        );
        Ok(())
    })
}
