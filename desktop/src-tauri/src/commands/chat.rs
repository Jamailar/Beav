use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{build_chat_send_turn, run_chat_send_turn, PreparedSessionAgentTurn};
use crate::commands::chat_state::{
    ensure_chat_session_record, latest_session_id, request_chat_runtime_cancel,
    resolve_runtime_mode_for_session,
};
use crate::events::{emit_runtime_task_checkpoint_saved, emit_runtime_tool_result};
use crate::member_skill::advisor_member_skill_ref;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    resolve_runtime_approval_by_approval_id, resolve_runtime_approval_by_call_id,
    RuntimeApprovalResolutionPayload, SessionToolResultRecord,
};
use crate::session_lineage_fields;
use crate::skills::{
    active_skill_activation_items, merge_requested_skills_into_session,
    requested_skill_names_from_task_hints, SkillActivationSource,
};
use crate::{
    append_debug_log_state, append_debug_trace_state, append_session_transcript, log_timing_event,
    make_id, now_i64, now_iso, now_ms, payload_field, payload_string, session_title_from_message,
    AppState, ChatMessageRecord,
};

const TASK_SCOPED_METADATA_FIELDS: &[&str] = &[
    "taskHints",
    "intent",
    "platform",
    "taskType",
    "formatTarget",
    "executionProfile",
    "artifactType",
    "writeTarget",
    "requiredSkill",
    "allowedTools",
    "allowedAppCliActions",
    "allowedOperateActions",
    "allowedWriteTargets",
    "saveSubdir",
    "deferredDiscovery",
    "teamEscalation",
    "sourcePlatform",
    "sourceNoteId",
    "sourceMode",
    "sourceTitle",
    "sourceManuscriptPath",
    "forceMultiAgent",
    "forceLongRunningTask",
];

fn payload_member_mention_advisor_id(payload: &Value) -> Option<String> {
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

fn payload_knowledge_references(payload: &Value) -> Vec<Value> {
    payload
        .get("knowledgeReferences")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let id = object
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let mut reference = serde_json::Map::new();
                    reference.insert("type".to_string(), json!("knowledge"));
                    reference.insert("knowledgeId".to_string(), json!(id));
                    for field in [
                        "title",
                        "sourceKind",
                        "summary",
                        "cover",
                        "sourceUrl",
                        "folderPath",
                        "rootPath",
                        "updatedAt",
                    ] {
                        if let Some(value) = object.get(field).and_then(Value::as_str) {
                            let trimmed = value.trim();
                            if !trimmed.is_empty() {
                                reference.insert(field.to_string(), json!(trimmed));
                            }
                        }
                    }
                    if let Some(tags) = object.get("tags").and_then(Value::as_array) {
                        let normalized_tags = tags
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(|value| json!(value))
                            .collect::<Vec<_>>();
                        if !normalized_tags.is_empty() {
                            reference.insert("tags".to_string(), Value::Array(normalized_tags));
                        }
                    }
                    if let Some(value) = object.get("fileCount").and_then(Value::as_i64) {
                        reference.insert("fileCount".to_string(), json!(value));
                    }
                    if let Some(value) = object.get("hasTranscript").and_then(Value::as_bool) {
                        reference.insert("hasTranscript".to_string(), json!(value));
                    }
                    Some(Value::Object(reference))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn chat_user_message_metadata(
    advisor_id: Option<&str>,
    knowledge_references: &[Value],
) -> Option<Value> {
    let mut references = Vec::<Value>::new();
    if let Some(member_id) = advisor_id.map(str::trim).filter(|value| !value.is_empty()) {
        references.push(json!({
            "type": "member",
            "memberId": member_id,
            "routeMode": "respond",
        }));
    }
    references.extend(knowledge_references.iter().cloned());
    if references.is_empty() {
        return None;
    }
    Some(json!({
        "references": references,
        "explicitKnowledgeRefs": knowledge_references,
    }))
}

fn persist_chat_user_message_before_run(
    state: &State<'_, AppState>,
    session_id: &str,
    message: &str,
    display_content: &str,
    attachment: Option<Value>,
    advisor_id: Option<&str>,
    knowledge_references: &[Value],
) -> Result<(), String> {
    let metadata = chat_user_message_metadata(advisor_id, knowledge_references);
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

fn apply_chat_turn_session_metadata(
    state: &State<'_, AppState>,
    session_id: &str,
    advisor_id: Option<&str>,
    knowledge_references: &[Value],
) -> Result<Option<Value>, String> {
    with_store_mut(state, |store| {
        let advisor_snapshot = if let Some(advisor_id) = advisor_id {
            let Some(advisor) = store.advisors.iter().find(|item| item.id == advisor_id) else {
                return Err(format!("未找到 @ 成员：{advisor_id}"));
            };
            Some((
                advisor_id.to_string(),
                advisor.name.clone(),
                advisor.avatar.clone(),
                advisor.personality.clone(),
                advisor.system_prompt.clone(),
                advisor_member_skill_ref(store, advisor_id).or(advisor.member_skill_ref.clone()),
            ))
        } else {
            None
        };
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Err(format!("未找到聊天会话：{session_id}"));
        };
        let previous_metadata = session.metadata.clone();
        let mut metadata = previous_metadata
            .as_ref()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if let Some((
            advisor_id,
            advisor_name,
            advisor_avatar,
            advisor_personality,
            advisor_system_prompt,
            member_skill_ref,
        )) = advisor_snapshot
        {
            metadata.insert("advisorId".to_string(), json!(advisor_id));
            metadata.insert("memberMentionMode".to_string(), json!("single-turn"));
            metadata.insert("memberMentionAdvisorName".to_string(), json!(advisor_name));
            metadata.insert(
                "memberMentionAdvisorAvatar".to_string(),
                json!(advisor_avatar),
            );
            let mut active_speaker = json!({
                "type": "member",
                "speakerId": advisor_id,
                "memberId": advisor_id,
                "displayName": advisor_name,
                "avatar": advisor_avatar,
                "personality": advisor_personality,
                "systemPrompt": advisor_system_prompt,
                "knowledgeScope": {
                    "type": "advisor",
                    "advisorId": advisor_id,
                },
            });
            if let Some(skill_ref) = member_skill_ref {
                metadata.insert("memberSkillRef".to_string(), json!(skill_ref.clone()));
                metadata.insert("activeSkills".to_string(), json!([skill_ref]));
                active_speaker["memberSkillRef"] = json!(skill_ref);
            }
            metadata.insert("activeSpeaker".to_string(), active_speaker);
        }
        if !knowledge_references.is_empty() {
            metadata.insert(
                "explicitKnowledgeRefs".to_string(),
                Value::Array(knowledge_references.to_vec()),
            );
        }
        session.metadata = Some(Value::Object(metadata));
        Ok(previous_metadata)
    })
}

fn restore_chat_turn_session_metadata(
    state: &State<'_, AppState>,
    session_id: &str,
    previous_metadata: Option<Value>,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(());
        };
        session.metadata = previous_metadata;
        Ok(())
    })
}

fn merge_task_hints_into_session_metadata(
    state: &State<'_, AppState>,
    session_id: &str,
    task_hints: &Value,
) -> Result<Vec<String>, String> {
    let requested_skills = requested_skill_names_from_task_hints(task_hints);
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(());
        };
        let mut metadata = session
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if let Some(task_hints_object) = task_hints.as_object() {
            metadata.insert(
                "taskHints".to_string(),
                Value::Object(task_hints_object.clone()),
            );
            for field in TASK_SCOPED_METADATA_FIELDS {
                if let Some(value) = task_hints_object.get(*field) {
                    metadata.insert((*field).to_string(), value.clone());
                }
            }
            if let Some(value) = task_hints_object.get("initialContext") {
                metadata.insert("initialContext".to_string(), value.clone());
            }
        }
        if !requested_skills.is_empty() {
            let active_skills = merge_requested_skills_into_session(
                session,
                &requested_skills,
                SkillActivationSource::TaskHints,
                "chat.task_hints",
            );
            metadata.insert("activeSkills".to_string(), json!(active_skills));
        }
        session.metadata = Some(Value::Object(metadata));
        session.updated_at = now_iso();
        Ok(())
    })?;
    Ok(requested_skills)
}

fn clear_stale_task_hints_from_metadata(metadata: &Value) -> Option<Value> {
    let mut metadata_object = metadata.as_object()?.clone();
    let mut changed = false;
    for field in TASK_SCOPED_METADATA_FIELDS {
        changed |= metadata_object.remove(*field).is_some();
    }
    changed.then(|| Value::Object(metadata_object))
}

fn clear_stale_task_hints_from_session_metadata(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(), String> {
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(());
        };
        let Some(metadata) = session.metadata.as_ref() else {
            return Ok(());
        };
        if let Some(next_metadata) = clear_stale_task_hints_from_metadata(metadata) {
            session.metadata = Some(next_metadata);
            session.updated_at = now_iso();
        }
        Ok(())
    })
}

fn collect_active_skill_items_for_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(String, Vec<(String, String)>), String> {
    with_store(state, |store| {
        let runtime_mode = resolve_runtime_mode_for_session(&store, session_id);
        let metadata = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|item| item.metadata.as_ref());
        let items = active_skill_activation_items(&store.skills, &runtime_mode, metadata);
        Ok((runtime_mode, items))
    })
}

pub fn handle_send_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    match channel {
        "debug:ui-log" => {
            let scope = payload_string(&payload, "scope").unwrap_or_else(|| "unknown".to_string());
            let event = payload_string(&payload, "event").unwrap_or_else(|| "unknown".to_string());
            let payload_text =
                serde_json::to_string(payload_field(&payload, "payload").unwrap_or(&Value::Null))
                    .unwrap_or_else(|_| "null".to_string());
            let truncated_payload = if payload_text.chars().count() > 240 {
                let snippet = payload_text.chars().take(240).collect::<String>();
                format!("{snippet}...")
            } else {
                payload_text
            };
            append_debug_trace_state(
                state,
                format!(
                    "[runtime][ui] scope={} event={} payload={}",
                    scope, event, truncated_payload
                ),
            );
            Ok(())
        }
        "chat:send-message" => {
            let started_at = now_ms();
            let requested_session_id = payload_string(&payload, "sessionId");
            let message = payload_string(&payload, "message").unwrap_or_default();
            let display_content =
                payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone());
            let title_hint = if requested_session_id.is_none() {
                Some(session_title_from_message(&display_content))
            } else {
                None
            };
            let session_id = Some(ensure_chat_session_record(
                state,
                requested_session_id.clone(),
                title_hint,
            )?);
            let request_id = format!(
                "chat:send:{}",
                session_id
                    .clone()
                    .unwrap_or_else(|| "new-session".to_string())
            );
            log_timing_event(
                state,
                "ai",
                &request_id,
                "chat:send-message:start",
                started_at,
                Some(format!("chars={}", message.chars().count())),
            );
            let requested_skills = match payload_field(&payload, "taskHints") {
                Some(task_hints) if task_hints.is_object() => session_id
                    .as_deref()
                    .map(|value| merge_task_hints_into_session_metadata(state, value, task_hints))
                    .transpose()?
                    .unwrap_or_else(|| requested_skill_names_from_task_hints(task_hints)),
                _ => {
                    if let Some(active_session_id) = session_id.as_deref() {
                        clear_stale_task_hints_from_session_metadata(state, active_session_id)?;
                    }
                    Vec::new()
                }
            };
            if !requested_skills.is_empty() {
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][skills][chat][{}] requested={}",
                        session_id.as_deref().unwrap_or("new-session"),
                        requested_skills.join(",")
                    ),
                );
            }
            if let Some(active_session_id) = session_id.as_deref() {
                let (runtime_mode, activated_skills) =
                    collect_active_skill_items_for_session(state, active_session_id)?;
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][skills][chat][{}] activated={} runtimeMode={}",
                        active_session_id,
                        if activated_skills.is_empty() {
                            "none".to_string()
                        } else {
                            activated_skills
                                .iter()
                                .map(|(name, _)| name.as_str())
                                .collect::<Vec<_>>()
                                .join(",")
                        },
                        runtime_mode
                    ),
                );
                let _ = activated_skills;
            }
            let knowledge_references = payload_knowledge_references(&payload);
            let advisor_id = payload_member_mention_advisor_id(&payload);
            let turn_metadata_restore = if let Some(active_session_id) = session_id.as_deref() {
                if advisor_id.is_some() || !knowledge_references.is_empty() {
                    Some((
                        active_session_id.to_string(),
                        apply_chat_turn_session_metadata(
                            state,
                            active_session_id,
                            advisor_id.as_deref(),
                            &knowledge_references,
                        )?,
                    ))
                } else {
                    None
                }
            } else {
                None
            };
            let runtime_attachment = payload_field(&payload, "attachments")
                .and_then(|value| {
                    value
                        .as_array()
                        .filter(|items| !items.is_empty())
                        .map(|_| value)
                })
                .cloned()
                .or_else(|| payload_field(&payload, "attachment").cloned());
            if let Some(active_session_id) = session_id.as_deref() {
                persist_chat_user_message_before_run(
                    state,
                    active_session_id,
                    &message,
                    &display_content,
                    runtime_attachment.clone(),
                    advisor_id.as_deref(),
                    &knowledge_references,
                )?;
            }
            let mut turn = build_chat_send_turn(
                session_id.clone(),
                message.clone(),
                display_content.clone(),
                payload_field(&payload, "modelConfig"),
                runtime_attachment.clone(),
            );
            turn.request.persist_user_message = false;
            let prepared_turn = PreparedSessionAgentTurn::chat_send(turn);
            let completed_result = run_chat_send_turn(app, state, &prepared_turn, &message);
            if let Some((restore_session_id, previous_metadata)) = turn_metadata_restore {
                restore_chat_turn_session_metadata(state, &restore_session_id, previous_metadata)?;
            }
            let completed = completed_result?;
            if prepared_turn.is_redclaw_session() {
                let _ = app.emit(
                    "redclaw:runner-message",
                    completed
                        .redclaw_postprocess
                        .map(|postprocess| postprocess.runner_payload)
                        .unwrap_or(Value::Null),
                );
            }
            crate::commands::chat_sessions_wander::commit_chat_attachments_state(
                state,
                runtime_attachment.as_ref(),
                session_id.as_deref(),
            )?;
            log_timing_event(
                state,
                "ai",
                &request_id,
                "chat:send-message:done",
                started_at,
                Some("status=ok".to_string()),
            );
            Ok(())
        }
        "chat:cancel" | "ai:cancel" => {
            let session_id = payload_string(&payload, "sessionId")
                .or_else(|| payload.as_str().map(ToString::to_string))
                .unwrap_or_else(|| {
                    with_store(state, |store| Ok(latest_session_id(&store))).unwrap_or_default()
                });
            request_chat_runtime_cancel(state, &session_id)?;
            if let Ok(guard) = state.active_chat_requests.lock() {
                if let Some(child) = guard.get(&session_id) {
                    if let Ok(mut child_guard) = child.lock() {
                        let _ = child_guard.kill();
                    }
                }
            }
            emit_runtime_task_checkpoint_saved(
                app,
                None,
                Some(&session_id),
                "chat.cancelled",
                "chat generation cancelled",
                Some(json!({ "sessionId": session_id, "cancelled": true })),
            );
            Ok(())
        }
        "chat:confirm-tool" | "ai:confirm-tool" => {
            let resolution =
                serde_json::from_value::<RuntimeApprovalResolutionPayload>(payload.clone())
                    .unwrap_or_else(|_| {
                        RuntimeApprovalResolutionPayload::new(
                            payload_string(&payload, "callId").unwrap_or_else(|| make_id("call")),
                            payload_field(&payload, "confirmed")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false),
                        )
                    });
            let call_id = resolution.call_id.clone();
            let confirmed = resolution.confirmed;
            let _ = resolve_runtime_approval_by_call_id(state, &call_id, confirmed)?;
            let _ = resolve_runtime_approval_by_approval_id(state, &call_id, confirmed)?;
            let session_id = with_store_mut(state, |store| {
                let session_id = latest_session_id(store);
                let (runtime_id, parent_runtime_id, source_task_id) =
                    session_lineage_fields(store, &session_id);
                store.session_tool_results.push(SessionToolResultRecord {
                    id: make_id("tool-result"),
                    session_id: session_id.clone(),
                    runtime_id,
                    parent_runtime_id,
                    source_task_id,
                    call_id: call_id.clone(),
                    tool_name: "confirmation".to_string(),
                    command: None,
                    success: confirmed,
                    result_text: Some(if confirmed {
                        "User confirmed tool execution".to_string()
                    } else {
                        "User cancelled tool execution".to_string()
                    }),
                    summary_text: Some(if confirmed {
                        "Tool execution confirmed".to_string()
                    } else {
                        "Tool execution cancelled".to_string()
                    }),
                    prompt_text: None,
                    original_chars: None,
                    prompt_chars: None,
                    truncated: false,
                    payload: serde_json::to_value(&resolution)
                        .ok()
                        .or_else(|| Some(json!({ "callId": call_id, "confirmed": confirmed }))),
                    created_at: now_i64(),
                    updated_at: now_i64(),
                });
                Ok(session_id)
            })?;
            emit_runtime_tool_result(
                app,
                Some(&session_id),
                &call_id,
                "confirmation",
                confirmed,
                if confirmed {
                    "用户已确认执行"
                } else {
                    "用户已取消执行"
                },
            );
            Ok(())
        }
        "ai:start-chat" => {
            let message = payload_string(&payload, "message").unwrap_or_default();
            let model_config = payload_field(&payload, "modelConfig").cloned();
            handle_send_channel(
                app,
                "chat:send-message",
                json!({
                    "message": message,
                    "displayContent": payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone()),
                    "modelConfig": model_config
                }),
                state,
            )
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::clear_stale_task_hints_from_metadata;
    use serde_json::json;

    #[test]
    fn clears_task_scoped_metadata_without_dropping_session_context() {
        let metadata = json!({
            "contextType": "redclaw",
            "initialContext": "space bootstrap",
            "taskHints": {
                "intent": "manuscript_creation",
                "requireProfileRead": true,
                "requireSourceRead": true,
                "requireSave": true
            },
            "intent": "manuscript_creation",
            "platform": "xiaohongshu",
            "taskType": "direct_write",
            "formatTarget": "markdown",
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "writeTarget": "manuscripts://current",
            "requiredSkill": "writing-style",
            "allowedTools": ["resource", "workflow"],
            "allowedAppCliActions": ["manuscripts.writeCurrent"],
            "allowedOperateActions": ["skills.invoke", "manuscripts.createProject"],
            "allowedWriteTargets": ["manuscripts://current"],
            "saveSubdir": "wander",
            "deferredDiscovery": false,
            "teamEscalation": "disabled",
            "sourcePlatform": "xiaohongshu",
            "sourceNoteId": "note-1",
            "sourceMode": "knowledge",
            "sourceTitle": "source",
            "sourceManuscriptPath": "wander/source",
            "forceMultiAgent": true,
            "forceLongRunningTask": true,
            "currentAuthoringProjectPath": "wander/demo"
        });

        let cleaned = clear_stale_task_hints_from_metadata(&metadata).expect("cleaned metadata");

        for field in [
            "taskHints",
            "intent",
            "platform",
            "taskType",
            "formatTarget",
            "executionProfile",
            "artifactType",
            "writeTarget",
            "requiredSkill",
            "allowedTools",
            "allowedAppCliActions",
            "allowedOperateActions",
            "allowedWriteTargets",
            "saveSubdir",
            "deferredDiscovery",
            "teamEscalation",
            "sourcePlatform",
            "sourceNoteId",
            "sourceMode",
            "sourceTitle",
            "sourceManuscriptPath",
            "forceMultiAgent",
            "forceLongRunningTask",
        ] {
            assert!(cleaned.get(field).is_none(), "{field} should be cleared");
        }
        assert_eq!(cleaned.get("contextType"), Some(&json!("redclaw")));
        assert_eq!(
            cleaned.get("initialContext"),
            Some(&json!("space bootstrap"))
        );
        assert_eq!(
            cleaned.get("currentAuthoringProjectPath"),
            Some(&json!("wander/demo"))
        );
    }

    #[test]
    fn leaves_metadata_unchanged_when_no_task_fields_exist() {
        let metadata = json!({
            "contextType": "redclaw",
            "initialContext": "space bootstrap"
        });

        assert!(clear_stale_task_hints_from_metadata(&metadata).is_none());
    }
}
