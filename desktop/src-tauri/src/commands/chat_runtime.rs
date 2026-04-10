use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::chat_state::{
    ensure_chat_session, infer_context_type_from_session_id, is_first_assistant_turn_for_session,
    resolve_runtime_mode_for_session, should_handle_redclaw_onboarding_for_session,
    update_chat_runtime_state,
};
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{append_session_checkpoint, ChatExecutionResult};
use crate::{
    append_debug_log_state, append_session_transcript, default_memory_maintenance_status,
    ensure_redclaw_onboarding_completed_with_defaults, generate_chat_response,
    handle_redclaw_onboarding_turn, make_id, memory_maintenance_status_from_settings,
    next_memory_maintenance_at_ms, now_i64, now_iso, resolve_chat_config,
    resolve_runtime_mode_from_context_type, run_openai_interactive_chat_runtime,
    session_title_from_message, value_to_i64_string, write_memory_maintenance_status, AppState,
    ChatMessageRecord,
};

pub fn execute_chat_exchange(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    session_id: Option<String>,
    message: String,
    display_content: String,
    model_config: Option<&Value>,
    attachment: Option<Value>,
    checkpoint_type: &str,
    checkpoint_summary: &str,
) -> Result<ChatExecutionResult, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let working_session_id = session_id.unwrap_or_else(|| make_id("session"));
    let _ = update_chat_runtime_state(state, &working_session_id, true, String::new(), None);
    let (runtime_mode, should_handle_redclaw_onboarding, is_first_assistant_turn) =
        with_store(state, |store| {
            Ok((
                resolve_runtime_mode_for_session(&store, &working_session_id),
                should_handle_redclaw_onboarding_for_session(&store, &working_session_id),
                is_first_assistant_turn_for_session(&store, &working_session_id),
            ))
        })?;
    let allow_redclaw_onboarding = runtime_mode == "redclaw"
        && should_handle_redclaw_onboarding
        && checkpoint_type == "chat-send"
        && is_first_assistant_turn;
    if runtime_mode == "redclaw" && should_handle_redclaw_onboarding && !allow_redclaw_onboarding {
        let _ = ensure_redclaw_onboarding_completed_with_defaults(state);
    }
    let onboarding_response = if allow_redclaw_onboarding {
        handle_redclaw_onboarding_turn(state, &message)?
    } else {
        None
    };
    let response = if let Some((local_response, _completed)) = onboarding_response {
        local_response
    } else if let (Some(app), Some(config)) =
        (app, resolve_chat_config(&settings_snapshot, model_config))
    {
        if config.protocol == "openai" {
            match run_openai_interactive_chat_runtime(
                app,
                state,
                Some(working_session_id.as_str()),
                &config,
                &message,
                &runtime_mode,
            ) {
                Ok(response) => response,
                Err(error) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-failed | {}",
                            runtime_mode, working_session_id, error
                        ),
                    );
                    if runtime_mode == "wander" {
                        return Err(error);
                    }
                    generate_chat_response(&settings_snapshot, model_config, &message)
                }
            }
        } else {
            generate_chat_response(&settings_snapshot, model_config, &message)
        }
    } else {
        generate_chat_response(&settings_snapshot, model_config, &message)
    };
    let title_hint = Some(session_title_from_message(&display_content));
    let mut title_update: Option<(String, String)> = None;
    let mut final_session_id = String::new();

    with_store_mut(state, |store| {
        let (session, is_new) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(working_session_id.clone()),
            title_hint.clone(),
        );
        final_session_id = session.id.clone();
        let next_title = title_hint.clone().unwrap_or_else(|| "New Chat".to_string());
        if is_new || session.title == "New Chat" || session.title.trim().is_empty() {
            session.title = next_title.clone();
            title_update = Some((session.id.clone(), next_title));
        }
        session.updated_at = now_iso();
        let context_type = session
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("contextType"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
            .or_else(|| infer_context_type_from_session_id(&session.id))
            .unwrap_or_else(|| "chat".to_string());
        let runtime_mode = resolve_runtime_mode_from_context_type(Some(&context_type)).to_string();

        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "user".to_string(),
            content: message.clone(),
            display_content: if display_content.trim().is_empty()
                || display_content.trim() == message.trim()
            {
                None
            } else {
                Some(display_content.clone())
            },
            attachment: attachment.clone(),
            created_at: now_iso(),
        });
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "assistant".to_string(),
            content: response.clone(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "user",
            message.clone(),
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
            response.clone(),
            Some(json!({ "runtimeMode": runtime_mode.clone() })),
        );
        append_session_checkpoint(
            store,
            &final_session_id,
            checkpoint_type,
            checkpoint_summary.to_string(),
            Some(json!({
                "responsePreview": response.chars().take(80).collect::<String>(),
                "runtimeMode": runtime_mode,
            })),
        );
        Ok(())
    })?;
    let _ = update_chat_runtime_state(state, &final_session_id, false, response.clone(), None);
    let _ = with_store_mut(state, |store| {
        let next_scheduled_at = next_memory_maintenance_at_ms(&response, now_i64());
        let current = memory_maintenance_status_from_settings(&store.settings)
            .unwrap_or_else(default_memory_maintenance_status);
        let status = json!({
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
        });
        let mut settings = store.settings.clone();
        write_memory_maintenance_status(&mut settings, &status);
        store.settings = settings;
        store.redclaw_state.next_maintenance_at =
            value_to_i64_string(status.get("nextScheduledAt"));
        Ok(())
    });

    Ok(ChatExecutionResult {
        session_id: final_session_id,
        response,
        title_update,
    })
}
