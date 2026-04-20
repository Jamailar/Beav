use serde_json::{Value, json};
use tauri::State;

use crate::agent::{ChatExchangeContext, ChatExchangePersistenceStage, SessionAgentTurnKind};
use crate::commands::chat_state::{ensure_chat_session, infer_context_type_from_session_id};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_session_checkpoint, chat_messages_for_session, load_session_bundle_messages,
    save_session_bundle_messages, update_session_context_record,
};
use crate::{
    AppState, ChatMessageRecord, ChatSessionRecord, append_session_transcript,
    default_memory_maintenance_status, make_id, memory_maintenance_status_from_workspace,
    next_memory_maintenance_at_ms, now_i64, now_iso, resolve_runtime_mode_from_context_type,
    session_title_from_message, value_to_i64_string, write_memory_maintenance_status_for_workspace,
};

pub fn persist_chat_exchange(
    state: &State<'_, AppState>,
    context: &ChatExchangeContext,
    message: &str,
    display_content: &str,
    attachment: Option<Value>,
    response: &str,
    turn_kind: SessionAgentTurnKind,
    checkpoint_summary: String,
    session_title_override: Option<String>,
) -> Result<ChatExchangePersistenceStage, String> {
    let title_hint = session_title_override.or_else(|| {
        if turn_kind == SessionAgentTurnKind::ChatSend {
            None
        } else {
            Some(session_title_from_message(display_content))
        }
    });
    let mut title_update: Option<(String, String)> = None;
    let mut final_session_id = String::new();
    let mut runtime_mode_snapshot = String::new();
    let mut bundle_messages_snapshot = Vec::<Value>::new();

    with_store_mut(state, |store| {
        let (session, is_new) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(context.working_session_id.clone()),
            title_hint.clone(),
        );
        final_session_id = session.id.clone();
        let next_title = title_hint.clone().unwrap_or_else(|| "New Chat".to_string());
        let should_replace_title =
            is_new || session.title == "New Chat" || session.title.trim().is_empty();
        if should_replace_title && session.title != next_title {
            session.title = next_title.clone();
            title_update = Some((session.id.clone(), next_title));
        }
        session.updated_at = now_iso();
        let runtime_mode = session_runtime_mode(session);
        runtime_mode_snapshot = runtime_mode.clone();

        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "user".to_string(),
            content: message.to_string(),
            display_content: if display_content.trim().is_empty()
                || display_content.trim() == message.trim()
            {
                None
            } else {
                Some(display_content.to_string())
            },
            attachment: attachment.clone(),
            created_at: now_iso(),
        });
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "assistant".to_string(),
            content: response.to_string(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "user",
            message.to_string(),
            Some(json!({
                "displayContent": display_content,
                "attachment": attachment,
                "runtimeMode": runtime_mode.clone(),
            })),
        );
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "assistant",
            response.to_string(),
            Some(json!({ "runtimeMode": runtime_mode.clone() })),
        );
        append_session_checkpoint(
            store,
            &final_session_id,
            turn_kind.checkpoint_type(),
            checkpoint_summary,
            Some(exchange_checkpoint_payload(response, &runtime_mode)),
        );
        let _ = update_session_context_record(store, &final_session_id, "auto", false);
        bundle_messages_snapshot = chat_messages_for_session(store, &final_session_id)
            .into_iter()
            .map(|item| {
                json!({
                    "role": item.role,
                    "content": item.content
                })
            })
            .collect::<Vec<_>>();
        Ok(())
    })?;
    let should_sync_bundle = load_session_bundle_messages(state, &final_session_id)
        .map(|messages| {
            messages
                .last()
                .and_then(|item| item.get("role"))
                .and_then(Value::as_str)
                != Some("assistant")
                || messages
                    .last()
                    .and_then(|item| item.get("content"))
                    .and_then(Value::as_str)
                    != Some(response)
        })
        .unwrap_or(true);
    if should_sync_bundle {
        let _ = save_session_bundle_messages(
            state,
            &final_session_id,
            "chat",
            &runtime_mode_snapshot,
            None,
            &bundle_messages_snapshot,
        );
    }
    Ok(ChatExchangePersistenceStage {
        final_session_id,
        title_update,
    })
}

pub fn update_post_exchange_maintenance(
    state: &State<'_, AppState>,
    response: &str,
) -> Result<(), String> {
    let next_scheduled_at = next_memory_maintenance_at_ms(response, now_i64());
    let current = with_store(state, |store| {
        Ok(memory_maintenance_status_from_workspace(state)?
            .or_else(|| crate::memory_maintenance_status_from_settings(&store.settings))
            .unwrap_or_else(default_memory_maintenance_status))
    })?;
    let status = build_post_exchange_maintenance_status(&current, next_scheduled_at);
    write_memory_maintenance_status_for_workspace(state, &status)?;
    with_store_mut(state, |store| {
        if let Some(object) = store.settings.as_object_mut() {
            object.remove("redbox_memory_maintenance_status_json");
        }
        store.redclaw_state.next_maintenance_at =
            value_to_i64_string(status.get("nextScheduledAt"));
        Ok(())
    })
}

fn exchange_checkpoint_payload(response: &str, runtime_mode: &str) -> Value {
    json!({
        "responsePreview": response.chars().take(80).collect::<String>(),
        "runtimeMode": runtime_mode,
    })
}

fn build_post_exchange_maintenance_status(current: &Value, next_scheduled_at: i64) -> Value {
    json!({
        "started": true,
        "running": false,
        "lockState": current.get("lockState").cloned().unwrap_or_else(|| json!("owner")),
        "blockedBy": current.get("blockedBy").cloned().unwrap_or(Value::Null),
        "pendingMutations": current.get("pendingMutations").cloned().unwrap_or_else(|| json!(0)),
        "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
        "lastScanAt": now_i64(),
        "lastReason": "query-after",
        "lastSummary": current.get("lastSummary").cloned().unwrap_or_else(|| json!("RedBox memory maintenance has not run yet.")),
        "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
        "nextScheduledAt": next_scheduled_at,
    })
}

fn session_runtime_mode(session: &ChatSessionRecord) -> String {
    session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("agentProfile"))
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "video-editor" | "audio-editor"))
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            let context_type = session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("contextType"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| infer_context_type_from_session_id(&session.id))
                .unwrap_or_else(|| "chat".to_string());
            resolve_runtime_mode_from_context_type(Some(&context_type)).to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_checkpoint_payload_truncates_preview_and_keeps_runtime_mode() {
        let payload = exchange_checkpoint_payload(&"a".repeat(120), "chatroom");
        assert_eq!(
            payload
                .get("responsePreview")
                .and_then(Value::as_str)
                .map(|v| v.len()),
            Some(80)
        );
        assert_eq!(
            payload.get("runtimeMode").and_then(Value::as_str),
            Some("chatroom")
        );
    }

    #[test]
    fn build_post_exchange_maintenance_status_preserves_current_fields_and_sets_next_time() {
        let current = json!({
            "lockState": "owner",
            "blockedBy": null,
            "pendingMutations": 2,
            "lastRunAt": 123,
            "lastSummary": "ok",
            "lastError": null
        });
        let status = build_post_exchange_maintenance_status(&current, 999);
        assert_eq!(
            status.get("lockState").and_then(Value::as_str),
            Some("owner")
        );
        assert_eq!(
            status.get("pendingMutations").and_then(Value::as_i64),
            Some(2)
        );
        assert_eq!(
            status.get("nextScheduledAt").and_then(Value::as_i64),
            Some(999)
        );
        assert_eq!(
            status.get("lastReason").and_then(Value::as_str),
            Some("query-after")
        );
    }

    #[test]
    fn session_runtime_mode_prefers_agent_profile_override() {
        let session = ChatSessionRecord {
            id: "session-1".to_string(),
            title: "Test".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "agentProfile": "video-editor",
                "contextType": "chat"
            })),
        };
        assert_eq!(session_runtime_mode(&session), "video-editor");
    }
}
