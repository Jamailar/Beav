use std::collections::HashMap;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::{
    build_session_bridge_turn, emit_session_agent_completion, execute_prepared_session_agent_turn,
    PreparedSessionAgentTurn, SessionAgentTurnKind,
};
use crate::events::emit_runtime_event;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{request_runtime_approval, RuntimeApprovalDetails, RuntimeApprovalRecord};
use crate::{AcpArtifactRecord, AcpMessageRecord, AcpRunRecord, AppState, AppStore};

use super::audit::{acp_events_page_for_run, append_acp_audit_event};
use super::auth::authorize_acp_request;
use super::errors::AcpHttpError;
use super::make_acp_id;
use super::sessions::{
    append_inbound_message, client_for_http, create_or_attach_acp_session, session_public_value,
};
use super::types::{
    pagination_from_path, payload_array_strings, payload_object, payload_string,
    prompt_from_payload, summarize_text,
};

const ACP_APPROVAL_GATED_CAPABILITIES: &[&str] = &[
    "paid_generation",
    "paid_generation_auto",
    "browser_control",
    "delete_assets",
    "delete_asset",
    "publish",
    "publish_or_export_outside_workspace",
    "export_outside_workspace",
    "write_external_file",
    "write_external_files",
];

fn run_public_value(run: &AcpRunRecord) -> Value {
    let artifact_refs = run
        .artifact_ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "url": format!("/acp/v1/artifacts/{id}")
            })
        })
        .collect::<Vec<_>>();
    let approval = run
        .metadata
        .as_ref()
        .and_then(|metadata| {
            let approval_id = metadata.get("approvalId").and_then(Value::as_str)?;
            Some(json!({
                "id": approval_id,
                "status": if run.status == "awaiting_approval" { "pending" } else { run.status.as_str() },
                "requestedCapability": metadata.get("requestedCapability").cloned().unwrap_or(Value::Null),
                "requiresApproval": metadata.get("requiresApproval").cloned().unwrap_or(Value::Null)
            }))
        })
        .unwrap_or(Value::Null);
    json!({
        "id": run.id.clone(),
        "sessionId": run.session_id.clone(),
        "chatSessionId": run.chat_session_id.clone(),
        "collabSessionId": run.collab_session_id.clone(),
        "status": run.status.clone(),
        "statusReason": run.status_reason.clone(),
        "inputMessageId": run.input_message_id.clone(),
        "outputMessageId": run.output_message_id.clone(),
        "prompt": run.prompt.clone(),
        "response": run.response.clone(),
        "artifactIds": run.artifact_ids.clone(),
        "artifactRefs": artifact_refs,
        "approval": approval,
        "metadata": run.metadata.clone(),
        "cancelRequested": run.cancel_requested,
        "createdAt": run.created_at,
        "updatedAt": run.updated_at,
        "startedAt": run.started_at,
        "completedAt": run.completed_at,
        "lastError": run.last_error.clone()
    })
}

fn latest_inbound_prompt(store: &AppStore, session_id: &str) -> Option<(String, String)> {
    store
        .acp_messages
        .iter()
        .rev()
        .find(|message| message.session_id == session_id && message.direction == "inbound")
        .map(|message| (message.id.clone(), message.content.clone()))
}

fn approval_requested_capabilities(payload: &Value) -> Vec<String> {
    let mut capabilities = Vec::new();
    for key in [
        "requestedCapability",
        "requiredCapability",
        "capability",
        "actionCapability",
    ] {
        if let Some(value) = payload_string(payload, key) {
            capabilities.push(value);
        }
    }
    for key in [
        "requestedCapabilities",
        "requiredCapabilities",
        "capabilities",
    ] {
        capabilities.extend(payload_array_strings(payload, key));
    }
    if payload
        .get("requiresApproval")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        capabilities.push("external_agent_requested_approval".to_string());
    }
    if let Some(approval) = payload.get("approval") {
        if let Some(value) = approval
            .get("requestedCapability")
            .or_else(|| approval.get("requiredCapability"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            capabilities.push(value.to_string());
        }
        if let Some(values) = approval
            .get("requestedCapabilities")
            .or_else(|| approval.get("requiredCapabilities"))
            .and_then(Value::as_array)
        {
            capabilities.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
        }
    }
    capabilities.sort();
    capabilities.dedup();
    capabilities
}

fn approval_required_capability(payload: &Value) -> Option<String> {
    approval_requested_capabilities(payload)
        .into_iter()
        .find(|capability| {
            let normalized = capability.trim().to_ascii_lowercase();
            normalized == "external_agent_requested_approval"
                || ACP_APPROVAL_GATED_CAPABILITIES
                    .iter()
                    .any(|item| *item == normalized)
        })
}

fn acp_run_metadata_with_approval(
    payload: &Value,
    approval_id: Option<&str>,
    requested_capability: Option<&str>,
) -> Option<Value> {
    let mut metadata = payload_object(payload, "metadata")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(approval_id) = approval_id {
        metadata.insert("approvalId".to_string(), json!(approval_id));
        metadata.insert("requiresApproval".to_string(), json!(true));
    }
    if let Some(requested_capability) = requested_capability {
        metadata.insert(
            "requestedCapability".to_string(),
            json!(requested_capability),
        );
    }
    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}

pub(crate) fn create_run_http(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    payload: Value,
) -> Result<(AcpRunRecord, Value), AcpHttpError> {
    let state = app.state::<AppState>();
    let outcome = with_store_mut(&state, |store| {
        let result = (|| -> Result<(AcpRunRecord, Value), AcpHttpError> {
            authorize_acp_request(store, method, path, headers)?;
            let client = client_for_http(store, &payload, headers);
            let session = create_or_attach_acp_session(store, &payload, &client)?;
            let run_id = make_acp_id("acp-run");
            let prompt_from_request = prompt_from_payload(&payload);
            let input_message_id = if prompt_from_request.is_some() {
                Some(
                    append_inbound_message(
                        store,
                        &session.id,
                        &payload,
                        &client,
                        Some(run_id.clone()),
                    )?
                    .id,
                )
            } else {
                payload_string(&payload, "inputMessageId")
            };
            let prompt = prompt_from_request
                .or_else(|| {
                    input_message_id.as_ref().and_then(|message_id| {
                        store
                            .acp_messages
                            .iter()
                            .find(|message| &message.id == message_id)
                            .map(|message| message.content.clone())
                    })
                })
                .or_else(|| latest_inbound_prompt(store, &session.id).map(|(_, content)| content))
                .ok_or_else(|| {
                    AcpHttpError::bad_request(
                        "missing_run_prompt",
                        "Run requires prompt/content/message or an existing inbound message.",
                    )
                })?;
            let now = crate::now_i64();
            let approval_capability = approval_required_capability(&payload);
            let approval_id = approval_capability
                .as_ref()
                .map(|_| make_acp_id("acp-approval"));
            let run = AcpRunRecord {
                id: run_id,
                session_id: session.id.clone(),
                collab_session_id: session.collab_session_id.clone(),
                chat_session_id: session.chat_session_id.clone(),
                status: if approval_capability.is_some() {
                    "awaiting_approval".to_string()
                } else {
                    "queued".to_string()
                },
                status_reason: Some(if approval_capability.is_some() {
                    "Run is waiting for RedBox approval before execution.".to_string()
                } else {
                    "Run accepted and queued.".to_string()
                }),
                input_message_id,
                output_message_id: None,
                prompt,
                response: None,
                artifact_ids: Vec::new(),
                metadata: acp_run_metadata_with_approval(
                    &payload,
                    approval_id.as_deref(),
                    approval_capability.as_deref(),
                ),
                cancel_requested: false,
                created_at: now,
                updated_at: now,
                started_at: None,
                completed_at: None,
                last_error: None,
            };
            store.acp_runs.push(run.clone());
            append_acp_audit_event(
                store,
                Some(session.id.clone()),
                Some(run.id.clone()),
                "acp.run.created",
                run.status.as_str(),
                Some(if approval_capability.is_some() {
                    "ACP run is waiting for approval.".to_string()
                } else {
                    "ACP run queued.".to_string()
                }),
                Some(json!({
                    "chatSessionId": session.chat_session_id.clone(),
                    "approvalId": approval_id.clone(),
                    "requestedCapability": approval_capability.clone()
                })),
            );
            if let (Some(approval_id), Some(capability)) =
                (approval_id.as_deref(), approval_capability.as_deref())
            {
                append_acp_audit_event(
                    store,
                    Some(session.id.clone()),
                    Some(run.id.clone()),
                    "acp.approval.required",
                    "awaiting_approval",
                    Some(format!("ACP run requires approval for {capability}.")),
                    Some(json!({
                        "approvalId": approval_id,
                        "requestedCapability": capability
                    })),
                );
            }
            let session_value = session_public_value(store, &session);
            Ok((run, session_value))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)??;
    if outcome.0.status == "awaiting_approval" {
        register_acp_run_approval(&state, &outcome.0)?;
    } else {
        spawn_acp_run(app.clone(), outcome.0.id.clone());
    }
    Ok(outcome)
}

fn register_acp_run_approval(
    state: &tauri::State<'_, AppState>,
    run: &AcpRunRecord,
) -> Result<(), AcpHttpError> {
    let approval_id = run
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("approvalId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&run.id);
    let requested_capability = run
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("requestedCapability"))
        .and_then(Value::as_str)
        .unwrap_or("approval_gated_action");
    let approval = RuntimeApprovalRecord::pending(
        approval_id.to_string(),
        "acp_run",
        run.id.clone(),
        "RedBox ACP run approval",
        RuntimeApprovalDetails {
            r#type: "acp".to_string(),
            title: "外部 Agent 请求需要确认".to_string(),
            description: format!(
                "ACP run {} requested capability `{}` before RedBox executes it.",
                run.id, requested_capability
            ),
            impact: Some("确认前不会启动 RedBox Creator Agent 执行该 run。".to_string()),
        },
    )
    .with_scope(Some(&run.chat_session_id), None, None, Some(approval_id))
    .with_metadata(Some(json!({
        "source": "acp",
        "acpRunId": run.id,
        "acpSessionId": run.session_id,
        "collabSessionId": run.collab_session_id,
        "requestedCapability": requested_capability
    })));
    request_runtime_approval(state, approval).map_err(AcpHttpError::internal)?;
    Ok(())
}

fn spawn_acp_run(app: AppHandle, run_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Err(error) = execute_acp_run(&app, &state, &run_id) {
            let _ = with_store_mut(&state, |store| {
                finalize_run_failure(store, &run_id, error.clone())?;
                Ok(())
            });
            let _ = app.emit(
                "acp:run-error",
                json!({
                    "runId": run_id,
                    "error": error
                }),
            );
        }
    });
}

fn mark_run_running(store: &mut AppStore, run_id: &str) -> Result<Option<AcpRunRecord>, String> {
    let now = crate::now_i64();
    let run_index = store
        .acp_runs
        .iter()
        .position(|item| item.id == run_id)
        .ok_or_else(|| "ACP run not found.".to_string())?;
    if store.acp_runs[run_index].cancel_requested || store.acp_runs[run_index].status == "cancelled"
    {
        let (session_id, run_id) = {
            let run = &mut store.acp_runs[run_index];
            run.status = "cancelled".to_string();
            run.status_reason = Some("Run was cancelled before execution.".to_string());
            run.updated_at = now;
            run.completed_at.get_or_insert(now);
            (run.session_id.clone(), run.id.clone())
        };
        append_acp_audit_event(
            store,
            Some(session_id),
            Some(run_id),
            "acp.run.cancelled",
            "cancelled",
            Some("Run cancelled before execution.".to_string()),
            None,
        );
        return Ok(None);
    }
    {
        let run = &mut store.acp_runs[run_index];
        run.status = "running".to_string();
        run.status_reason = Some("RedBox Creator Agent is processing the request.".to_string());
        run.started_at = Some(now);
        run.updated_at = now;
    }
    let run = store.acp_runs[run_index].clone();
    store.acp_gateway.active_run_count = store.acp_gateway.active_run_count.saturating_add(1);
    append_acp_audit_event(
        store,
        Some(run.session_id.clone()),
        Some(run.id.clone()),
        "acp.run.started",
        "running",
        Some("RedBox Creator Agent started.".to_string()),
        None,
    );
    Ok(Some(run))
}

fn acp_run_prompt(run: &AcpRunRecord) -> String {
    format!(
        "External agent request through RedBox ACP.\n\nACP session: {}\nACP run: {}\nExternal prompt:\n{}",
        run.session_id, run.id, run.prompt
    )
}

fn execute_acp_run(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    run_id: &str,
) -> Result<(), String> {
    let run = with_store_mut(state, |store| mark_run_running(store, run_id))?;
    let Some(run) = run else {
        return Ok(());
    };
    emit_runtime_event(
        app,
        "runtime:acp-run-started",
        Some(&run.chat_session_id),
        None,
        json!({ "runId": run.id, "acpSessionId": run.session_id }),
    );
    let turn = PreparedSessionAgentTurn::session_bridge(build_session_bridge_turn(
        run.chat_session_id.clone(),
        acp_run_prompt(&run),
    ));
    let execution = execute_prepared_session_agent_turn(Some(app), state, &turn)?;
    emit_session_agent_completion(app, state, &execution, SessionAgentTurnKind::SessionBridge)?;
    finalize_run_success(app, state, &run.id, execution.response().to_string())
}

fn merge_message_metadata(existing: Option<Value>, patch: Value) -> Option<Value> {
    let mut object = existing
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            object.insert(key.clone(), value.clone());
        }
    }
    Some(Value::Object(object))
}

fn parse_json_response(response: &str) -> Option<Value> {
    let trimmed = response.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let fence_start = trimmed.find("```json").or_else(|| trimmed.find("```"))?;
    let after_fence = &trimmed[fence_start..];
    let content_start = after_fence.find('\n')? + 1;
    let content = &after_fence[content_start..];
    let content_end = content.find("```")?;
    serde_json::from_str::<Value>(content[..content_end].trim()).ok()
}

fn value_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn value_string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn structured_artifact_records(
    session_id: &str,
    run_id: &str,
    response: &str,
    now: i64,
) -> Vec<AcpArtifactRecord> {
    let Some(parsed) = parse_json_response(response) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    if let Some(items) = parsed.get("artifacts").and_then(Value::as_array) {
        candidates.extend(items.iter().cloned());
    }
    if let Some(item) = parsed.get("artifact").filter(|value| value.is_object()) {
        candidates.push(item.clone());
    }
    candidates
        .into_iter()
        .filter(|item| item.is_object())
        .map(|item| {
            let kind = value_string_field(&item, "kind")
                .or_else(|| value_string_field(&item, "type"))
                .unwrap_or_else(|| "structured_artifact".to_string());
            let title = value_string_field(&item, "title")
                .or_else(|| value_string_field(&item, "name"))
                .unwrap_or_else(|| kind.clone());
            let mut refs = value_string_array_field(&item, "refs");
            refs.extend(value_string_array_field(&item, "references"));
            if let Some(uri) = value_string_field(&item, "uri") {
                refs.push(uri);
            }
            refs.sort();
            refs.dedup();
            AcpArtifactRecord {
                id: make_acp_id("acp-artifact"),
                session_id: session_id.to_string(),
                run_id: Some(run_id.to_string()),
                kind,
                title,
                summary: value_string_field(&item, "summary")
                    .or_else(|| value_string_field(&item, "description")),
                refs,
                payload: Some(item),
                created_at: now,
            }
        })
        .collect()
}

fn acp_artifacts_from_response(
    session_id: &str,
    run_id: &str,
    response: &str,
    now: i64,
) -> Vec<AcpArtifactRecord> {
    let mut artifacts = structured_artifact_records(session_id, run_id, response, now);
    artifacts.push(AcpArtifactRecord {
        id: make_acp_id("acp-artifact"),
        session_id: session_id.to_string(),
        run_id: Some(run_id.to_string()),
        kind: "text_response".to_string(),
        title: "RedBox Creator Agent Response".to_string(),
        summary: Some(summarize_text(response, 240)),
        refs: Vec::new(),
        payload: Some(json!({ "content": response })),
        created_at: now,
    });
    artifacts
}

fn finalize_run_success(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    run_id: &str,
    response: String,
) -> Result<(), String> {
    let run_value = with_store_mut(state, |store| {
        let now = crate::now_i64();
        let run_index = store
            .acp_runs
            .iter()
            .position(|item| item.id == run_id)
            .ok_or_else(|| "ACP run not found.".to_string())?;
        let run_snapshot = store.acp_runs[run_index].clone();
        let assistant_chat_message_id = store
            .chat_messages
            .iter_mut()
            .rev()
            .find(|message| {
                message.session_id == run_snapshot.chat_session_id
                    && message.role == "assistant"
                    && message.content == response
            })
            .map(|message| {
                message.metadata = merge_message_metadata(
                    message.metadata.clone(),
                    json!({
                        "source": "acp",
                        "senderKind": "redbox_creator_agent",
                        "senderLabel": "RedBox Creator Agent",
                        "acpSessionId": run_snapshot.session_id,
                        "acpRunId": run_snapshot.id,
                        "collabSessionId": run_snapshot.collab_session_id
                    }),
                );
                message.id.clone()
            });
        let output_message = AcpMessageRecord {
            id: make_acp_id("acp-message"),
            session_id: run_snapshot.session_id.clone(),
            run_id: Some(run_snapshot.id.clone()),
            direction: "outbound".to_string(),
            role: "assistant".to_string(),
            sender_kind: "redbox_creator_agent".to_string(),
            sender_label: "RedBox Creator Agent".to_string(),
            content: response.clone(),
            content_type: "text/markdown".to_string(),
            attachment_refs: Vec::new(),
            payload: Some(json!({ "source": "acp_run" })),
            chat_message_id: assistant_chat_message_id,
            collab_message_id: None,
            created_at: now,
        };
        let output_message_id = output_message.id.clone();
        let artifacts =
            acp_artifacts_from_response(&run_snapshot.session_id, &run_snapshot.id, &response, now);
        let artifact_ids = artifacts
            .iter()
            .map(|artifact| artifact.id.clone())
            .collect::<Vec<_>>();
        store.acp_messages.push(output_message);
        store.acp_artifacts.extend(artifacts);
        let final_status = if store.acp_runs[run_index].cancel_requested {
            "cancelled"
        } else {
            "completed"
        };
        {
            let run = &mut store.acp_runs[run_index];
            run.status = final_status.to_string();
            run.status_reason = Some(if final_status == "cancelled" {
                "Run completed after cancellation was requested.".to_string()
            } else {
                "Run completed.".to_string()
            });
            run.output_message_id = Some(output_message_id);
            run.response = Some(response.clone());
            run.artifact_ids.extend(artifact_ids);
            run.updated_at = now;
            run.completed_at = Some(now);
        }
        store.acp_gateway.active_run_count = store.acp_gateway.active_run_count.saturating_sub(1);
        let run = store.acp_runs[run_index].clone();
        if let Some(session) = store
            .acp_sessions
            .iter_mut()
            .find(|item| item.id == run.session_id)
        {
            session.updated_at = now;
            session.last_message_at = Some(now);
        }
        append_acp_audit_event(
            store,
            Some(run.session_id.clone()),
            Some(run.id.clone()),
            "acp.run.completed",
            final_status,
            Some("RedBox Creator Agent returned a response.".to_string()),
            Some(json!({ "outputMessageId": run.output_message_id })),
        );
        Ok(run_public_value(&run))
    })?;
    emit_runtime_event(
        app,
        "runtime:acp-run-completed",
        run_value.get("chatSessionId").and_then(Value::as_str),
        None,
        run_value.clone(),
    );
    let _ = app.emit("acp:run-changed", run_value);
    Ok(())
}

fn finalize_run_failure(store: &mut AppStore, run_id: &str, error: String) -> Result<(), String> {
    let now = crate::now_i64();
    let run_index = store
        .acp_runs
        .iter()
        .position(|item| item.id == run_id)
        .ok_or_else(|| "ACP run not found.".to_string())?;
    {
        let run = &mut store.acp_runs[run_index];
        if run.status != "cancelled" {
            run.status = "failed".to_string();
            run.status_reason = Some("Run failed.".to_string());
        }
        run.last_error = Some(error.clone());
        run.updated_at = now;
        run.completed_at = Some(now);
    }
    let run = store.acp_runs[run_index].clone();
    store.acp_gateway.active_run_count = store.acp_gateway.active_run_count.saturating_sub(1);
    append_acp_audit_event(
        store,
        Some(run.session_id.clone()),
        Some(run.id.clone()),
        "acp.run.failed",
        "failed",
        Some(error),
        None,
    );
    Ok(())
}

pub(crate) fn get_run_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    run_id: &str,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(&store, method, path, headers)?;
            let run = store
                .acp_runs
                .iter()
                .find(|item| item.id == run_id)
                .ok_or_else(|| {
                    AcpHttpError::not_found("acp_run_not_found", "ACP run not found.")
                })?;
            Ok(json!({ "success": true, "run": run_public_value(run) }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)?
}

pub(crate) fn run_events_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    run_id: &str,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    with_store(&state, |store| {
        let result = (|| -> Result<Value, AcpHttpError> {
            authorize_acp_request(&store, method, path, headers)?;
            if !store.acp_runs.iter().any(|item| item.id == run_id) {
                return Err(AcpHttpError::not_found(
                    "acp_run_not_found",
                    "ACP run not found.",
                ));
            }
            let (cursor, limit) = pagination_from_path(path, 100, 500);
            let page = acp_events_page_for_run(&store, run_id, cursor.as_deref(), limit);
            Ok(json!({
                "success": true,
                "runId": run_id,
                "cursor": cursor,
                "limit": limit,
                "nextCursor": page.next_cursor,
                "hasMore": page.has_more,
                "events": page.events
            }))
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)?
}

pub(crate) fn cancel_run_value(
    app: &AppHandle,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    run_id: &str,
) -> Result<Value, AcpHttpError> {
    let state = app.state::<AppState>();
    let chat_session_id = with_store_mut(&state, |store| {
        let result = (|| -> Result<String, AcpHttpError> {
            authorize_acp_request(store, method, path, headers)?;
            let now = crate::now_i64();
            let run_index = store
                .acp_runs
                .iter()
                .position(|item| item.id == run_id)
                .ok_or_else(|| {
                    AcpHttpError::not_found("acp_run_not_found", "ACP run not found.")
                })?;
            let (chat_session_id, session_id, run_id) = {
                let run = &mut store.acp_runs[run_index];
                run.cancel_requested = true;
                if matches!(run.status.as_str(), "queued" | "running") {
                    run.status = "cancelled".to_string();
                    run.status_reason = Some("Cancellation requested.".to_string());
                    run.completed_at = Some(now);
                }
                run.updated_at = now;
                (
                    run.chat_session_id.clone(),
                    run.session_id.clone(),
                    run.id.clone(),
                )
            };
            append_acp_audit_event(
                store,
                Some(session_id),
                Some(run_id),
                "acp.run.cancel_requested",
                "cancelled",
                Some("Cancellation requested by ACP client.".to_string()),
                None,
            );
            Ok(chat_session_id)
        })();
        Ok(result)
    })
    .map_err(AcpHttpError::internal)??;
    let _ = crate::commands::chat_state::request_chat_runtime_cancel(&state, &chat_session_id);
    get_run_value(app, "GET", path, headers, run_id)
}

pub(crate) fn run_created_response(run: &AcpRunRecord, session_value: Value) -> Value {
    json!({
        "success": true,
        "run": run_public_value(run),
        "session": session_value
    })
}

pub(crate) fn repair_acp_runs_after_load(store: &mut AppStore) -> usize {
    let now = crate::now_i64();
    let mut repaired = Vec::new();
    for run in &mut store.acp_runs {
        if !matches!(run.status.as_str(), "queued" | "running") {
            continue;
        }
        run.status = "expired".to_string();
        run.status_reason = Some(
            "Run did not complete before RedBox restarted. Start a new run to continue."
                .to_string(),
        );
        run.updated_at = now;
        run.completed_at = Some(now);
        run.last_error = Some("ACP run recovered after app restart.".to_string());
        repaired.push((run.session_id.clone(), run.id.clone()));
    }
    store.acp_gateway.active_run_count = 0;
    for (session_id, run_id) in repaired.iter() {
        append_acp_audit_event(
            store,
            Some(session_id.clone()),
            Some(run_id.clone()),
            "acp.run.recovered_after_restart",
            "expired",
            Some("Run expired during startup recovery.".to_string()),
            None,
        );
    }
    repaired.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_repair_expires_incomplete_runs_and_clears_active_count() {
        let mut store = crate::persistence::default_store();
        store.acp_gateway.active_run_count = 2;
        store.acp_runs.push(AcpRunRecord {
            id: "acp-run-queued".to_string(),
            session_id: "acp-session-1".to_string(),
            status: "queued".to_string(),
            ..Default::default()
        });
        store.acp_runs.push(AcpRunRecord {
            id: "acp-run-completed".to_string(),
            session_id: "acp-session-1".to_string(),
            status: "completed".to_string(),
            ..Default::default()
        });

        let repaired = repair_acp_runs_after_load(&mut store);

        assert_eq!(repaired, 1);
        assert_eq!(store.acp_gateway.active_run_count, 0);
        assert_eq!(store.acp_runs[0].status, "expired");
        assert_eq!(store.acp_runs[1].status, "completed");
        assert!(store
            .acp_audit_events
            .iter()
            .any(|event| event.event_type == "acp.run.recovered_after_restart"));
    }

    #[test]
    fn approval_detection_flags_gated_capabilities() {
        let payload = json!({
            "requestedCapabilities": ["creator_asset_context", "paid_generation"]
        });

        assert_eq!(
            approval_required_capability(&payload).as_deref(),
            Some("paid_generation")
        );

        let safe_payload = json!({
            "requestedCapabilities": ["creator_asset_context"]
        });
        assert!(approval_required_capability(&safe_payload).is_none());
    }

    #[test]
    fn run_public_value_exposes_pending_approval() {
        let run = AcpRunRecord {
            id: "acp-run-1".to_string(),
            session_id: "acp-session-1".to_string(),
            status: "awaiting_approval".to_string(),
            metadata: Some(json!({
                "approvalId": "acp-approval-1",
                "requiresApproval": true,
                "requestedCapability": "paid_generation"
            })),
            ..Default::default()
        };

        let value = run_public_value(&run);

        assert_eq!(value["approval"]["id"], "acp-approval-1");
        assert_eq!(value["approval"]["status"], "pending");
        assert_eq!(value["approval"]["requestedCapability"], "paid_generation");
    }

    #[test]
    fn structured_response_creates_artifact_refs_plus_text_response() {
        let response = r#"```json
{
  "summary": "done",
  "artifacts": [
    {
      "kind": "brief",
      "title": "Video brief",
      "summary": "A short plan",
      "uri": "redbox://brief/1"
    }
  ]
}
```"#;

        let artifacts = acp_artifacts_from_response("acp-session-1", "acp-run-1", response, 10);

        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].kind, "brief");
        assert_eq!(artifacts[0].refs, vec!["redbox://brief/1".to_string()]);
        assert_eq!(artifacts[1].kind, "text_response");
    }
}
