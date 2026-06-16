use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    apply_session_export_bundle_to_store, build_session_export_bundle,
    checkpoints_value_for_session, load_session_bundle_messages, load_transcript_entries,
    persist_imported_session_export_files, read_session_export_package, runtime_approval_snapshot,
    runtime_events_value_for_session, session_export_bundle_value, tool_results_value_for_session,
    trace_value_for_session, write_session_export_package,
};
use crate::session_manager::fork_session;
use crate::{now_ms, payload_string, payload_value_as_string, AppState};
use std::path::PathBuf;

pub fn runtime_state_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let requested_session_id = payload_value_as_string(payload).unwrap_or_default();
    let guard = state
        .chat_runtime_states
        .lock()
        .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
    if let Some(current) = guard.get(&requested_session_id) {
        Ok(json!({
            "success": true,
            "sessionId": current.session_id,
            "isProcessing": current.is_processing,
            "partialResponse": current.partial_response,
            "updatedAt": current.updated_at,
            "error": current.error,
            "cancelRequested": current.cancel_requested,
        }))
    } else {
        Ok(json!({
            "success": true,
            "sessionId": requested_session_id,
            "isProcessing": false,
            "partialResponse": "",
            "updatedAt": now_ms(),
            "cancelRequested": false,
        }))
    }
}

pub fn runtime_resume_value(payload: &Value) -> Value {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    json!({ "success": true, "sessionId": session_id })
}

pub fn runtime_trace_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(trace_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            limit,
        ))
    })
}

pub fn runtime_checkpoints_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runtime_id = payload_string(payload, "runtimeId");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(checkpoints_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            runtime_id.as_deref(),
            limit,
        ))
    })
}

pub fn runtime_tool_results_value(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let runtime_id = payload_string(payload, "runtimeId");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        let direct = tool_results_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            runtime_id.as_deref(),
            limit,
        );
        Ok(direct)
    })
}

pub fn runtime_events_value(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let category = payload_string(payload, "category");
    let event_type = payload_string(payload, "eventType");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    with_store(state, |store| {
        Ok(runtime_events_value_for_session(
            &store,
            &session_id,
            include_child_sessions,
            category.as_deref(),
            event_type.as_deref(),
            limit,
        ))
    })
}

pub fn runtime_approvals_value(state: &State<'_, AppState>) -> Result<Value, String> {
    Ok(json!(runtime_approval_snapshot(state)?))
}

pub fn fork_runtime_session(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    with_store_mut(state, |store| {
        let Some(forked) = fork_session(store, &session_id) else {
            return Ok(json!({ "success": false, "error": "会话不存在" }));
        };
        Ok(json!({
            "success": true,
            "sessionId": session_id,
            "forkedSessionId": forked.session.id
        }))
    })
}

pub fn export_runtime_session(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let session_id = payload_string(payload, "sessionId").unwrap_or_default();
    if session_id.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "sessionId is required" }));
    }
    let include_child_sessions = payload
        .get("includeChildSessions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let write_package = payload
        .get("writePackage")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let session_ids = with_store(state, |store| {
        let mut ids = vec![session_id.clone()];
        if include_child_sessions {
            ids.extend(
                store
                    .chat_sessions
                    .iter()
                    .filter(|item| {
                        item.metadata
                            .as_ref()
                            .and_then(|metadata| metadata.get("parentSessionId"))
                            .and_then(Value::as_str)
                            == Some(session_id.as_str())
                    })
                    .map(|item| item.id.clone()),
            );
        }
        ids.sort();
        ids.dedup();
        Ok(ids)
    })?;
    let mut transcript_entries = Vec::new();
    for id in &session_ids {
        transcript_entries.extend(load_transcript_entries(state, id).unwrap_or_default());
    }
    let bundle_messages = load_session_bundle_messages(state, &session_id).unwrap_or_default();
    let bundle = with_store(state, |store| {
        Ok(build_session_export_bundle(
            &store,
            &session_id,
            include_child_sessions,
            transcript_entries,
            bundle_messages,
        ))
    })?;
    let Some(bundle) = bundle else {
        return Ok(json!({ "success": false, "error": "会话不存在" }));
    };

    if write_package {
        write_session_export_package(state, &bundle)
    } else {
        Ok(session_export_bundle_value(&bundle))
    }
}

pub fn import_runtime_session(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let package_path = payload_string(payload, "packagePath").unwrap_or_default();
    if package_path.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "packagePath is required" }));
    }
    let overwrite = payload
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let bundle = read_session_export_package(&PathBuf::from(package_path.trim()))?;
    let outcome = with_store_mut(state, |store| {
        apply_session_export_bundle_to_store(store, &bundle, overwrite)
    })?;
    persist_imported_session_export_files(state, &bundle, overwrite)?;
    Ok(json!({
        "success": true,
        "sessionId": outcome.session_id,
        "importedSessionIds": outcome.imported_session_ids,
        "messageCount": outcome.message_count,
        "transcriptRecordCount": outcome.transcript_record_count,
        "transcriptFileEntryCount": outcome.transcript_file_entry_count,
        "checkpointCount": outcome.checkpoint_count,
        "toolResultCount": outcome.tool_result_count,
        "runtimeEventCount": outcome.runtime_event_count,
        "bundleMessageCount": outcome.bundle_message_count,
        "overwritten": outcome.overwritten,
    }))
}
