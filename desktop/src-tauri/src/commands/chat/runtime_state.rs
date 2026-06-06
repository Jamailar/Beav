use tauri::State;

use crate::{append_debug_trace_state, now_ms, AppState, ChatRuntimeStateRecord};

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
    let previous = guard.get(session_id).cloned();
    let cancel_requested = previous
        .as_ref()
        .map(|entry| entry.cancel_requested)
        .unwrap_or(false);
    let should_log_transition = previous
        .as_ref()
        .map(|entry| {
            entry.is_processing != is_processing
                || entry.error != error
                || (entry.partial_response.is_empty() && !partial_response.is_empty())
        })
        .unwrap_or(true);
    let error_for_log = error.clone();
    let partial_chars_for_log = partial_response.chars().count();
    let had_partial_for_log = !partial_response.is_empty();
    guard.insert(
        session_id.to_string(),
        ChatRuntimeStateRecord {
            session_id: session_id.to_string(),
            is_processing,
            partial_response,
            updated_at: now_ms(),
            error,
            cancel_requested,
        },
    );
    if should_log_transition {
        append_debug_trace_state(
            state,
            format!(
                "[runtime][state][chat] session={} processing={} partial_chars={} had_partial={} error={}",
                session_id,
                is_processing,
                partial_chars_for_log,
                had_partial_for_log,
                error_for_log.as_deref().unwrap_or("none"),
            ),
        );
    }
    Ok(())
}

pub fn begin_chat_runtime_state(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    let mut guard = state
        .chat_runtime_states
        .lock()
        .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
    guard.insert(
        session_id.to_string(),
        ChatRuntimeStateRecord {
            session_id: session_id.to_string(),
            is_processing: true,
            partial_response: String::new(),
            updated_at: now_ms(),
            error: None,
            cancel_requested: false,
        },
    );
    append_debug_trace_state(
        state,
        format!(
            "[runtime][state][chat] session={} processing=true cancel_requested=false error=none",
            session_id
        ),
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
    append_debug_trace_state(
        state,
        format!(
            "[runtime][state][chat] session={} processing=false cancel_requested=true error=cancelled",
            session_id
        ),
    );
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
