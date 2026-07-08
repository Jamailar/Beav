#[path = "chat/control.rs"]
mod control;
#[path = "chat/messages.rs"]
mod messages;
#[path = "chat/references.rs"]
mod references;
#[path = "chat/session_metadata.rs"]
mod session_metadata;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::agent::{build_chat_send_turn, run_chat_send_turn, PreparedSessionAgentTurn};
use crate::commands::chat_state::ensure_chat_session_record;
use crate::skills::requested_skill_names_from_task_hints;
use crate::{
    append_debug_log_state, append_debug_trace_state, log_timing_event, now_ms, payload_field,
    payload_string, session_title_from_message, AppState, REDCLAW_STYLE_DEFINITION_SKILL_NAME,
};
use control::handle_chat_control_send_channel;
use messages::{payload_member_mention_advisor_id, persist_chat_user_message_before_run};
use references::{
    infer_media_task_intent, merge_inline_asset_mentions, payload_asset_references,
    payload_knowledge_references,
};
use session_metadata::{
    apply_chat_turn_session_metadata, clear_stale_task_hints_from_session_metadata,
    collect_active_skill_items_for_session, maybe_activate_redclaw_style_definition_for_turn,
    merge_task_hints_into_session_metadata, restore_chat_turn_session_metadata,
};

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
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
            let hidden_user_message = payload_bool(&payload, "hiddenUserMessage");
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
                if maybe_activate_redclaw_style_definition_for_turn(state, active_session_id)? {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][skills][chat][{}] auto_activated={}",
                            active_session_id, REDCLAW_STYLE_DEFINITION_SKILL_NAME
                        ),
                    );
                }
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
            let payload_asset_references = payload_asset_references(&payload);
            let asset_references = merge_inline_asset_mentions(
                state,
                &message,
                &display_content,
                &payload_asset_references,
            )?;
            let task_intent = payload_field(&payload, "taskHints")
                .and_then(|value| value.get("taskIntent"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .or_else(|| infer_media_task_intent(&message, &display_content));
            let advisor_id = payload_member_mention_advisor_id(&payload);
            let turn_metadata_restore = if let Some(active_session_id) = session_id.as_deref() {
                if advisor_id.is_some()
                    || !knowledge_references.is_empty()
                    || !asset_references.is_empty()
                    || task_intent.is_some()
                {
                    Some((
                        active_session_id.to_string(),
                        apply_chat_turn_session_metadata(
                            state,
                            active_session_id,
                            advisor_id.as_deref(),
                            &knowledge_references,
                            &asset_references,
                            task_intent.as_deref(),
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
            if let Some(active_session_id) = session_id.as_deref().filter(|_| !hidden_user_message)
            {
                persist_chat_user_message_before_run(
                    state,
                    active_session_id,
                    &message,
                    &display_content,
                    runtime_attachment.clone(),
                    advisor_id.as_deref(),
                    &knowledge_references,
                    &asset_references,
                    task_intent.as_deref(),
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
        "chat:cancel" | "ai:cancel" | "chat:confirm-tool" | "ai:confirm-tool" => {
            handle_chat_control_send_channel(app, state, channel, &payload)
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
    use super::references::{
        chat_user_message_metadata, extract_inline_asset_mention_names, infer_media_task_intent,
        merge_inline_asset_mentions_from_store,
    };
    use crate::{AppStore, SubjectRecord};
    use serde_json::json;

    fn subject(id: &str, name: &str) -> SubjectRecord {
        SubjectRecord {
            id: id.to_string(),
            name: name.to_string(),
            category_id: None,
            description: None,
            tags: Vec::new(),
            attributes: Vec::new(),
            image_paths: Vec::new(),
            voice_path: None,
            video_path: None,
            voice_script: None,
            voice: None,
            brand_id: None,
            skus: Vec::new(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            absolute_image_paths: Vec::new(),
            preview_urls: Vec::new(),
            primary_preview_url: None,
            absolute_voice_path: None,
            voice_preview_url: None,
            absolute_video_path: None,
            video_preview_url: None,
        }
    }

    #[test]
    fn extracts_inline_asset_mentions_from_plain_text() {
        assert_eq!(
            extract_inline_asset_mention_names("做一个 @Jamba 的口播视频"),
            vec!["Jamba".to_string()]
        );
        assert_eq!(
            extract_inline_asset_mention_names("@Jamba，做视频 @Jamba"),
            vec!["Jamba".to_string()]
        );
    }

    #[test]
    fn resolves_unique_inline_asset_mentions_from_store() {
        let mut store = AppStore::default();
        store
            .subjects
            .push(subject("subject_1774704234274_53536cc0", "Jamba"));

        let refs =
            merge_inline_asset_mentions_from_store(&store, "做一个 @Jamba 的口播视频", "", &[]);

        assert_eq!(refs.len(), 1);
        assert_eq!(
            refs[0].get("assetId").and_then(|value| value.as_str()),
            Some("subject_1774704234274_53536cc0")
        );
        assert_eq!(
            refs[0].get("name").and_then(|value| value.as_str()),
            Some("Jamba")
        );
    }

    #[test]
    fn skips_ambiguous_inline_asset_mentions() {
        let mut store = AppStore::default();
        store.subjects.push(subject("subject-a", "Jamba"));
        store.subjects.push(subject("subject-b", "jamba"));

        let refs = merge_inline_asset_mentions_from_store(&store, "@Jamba 做视频", "", &[]);

        assert!(refs.is_empty());
    }

    #[test]
    fn infers_generic_media_task_intent() {
        assert_eq!(
            infer_media_task_intent("做一个 @Jamba 的口播视频", "").as_deref(),
            Some("video")
        );
        assert_eq!(
            infer_media_task_intent("生成一张封面", "").as_deref(),
            Some("image")
        );
        assert_eq!(
            infer_media_task_intent("合成一段语音", "").as_deref(),
            Some("voice")
        );
    }

    #[test]
    fn user_message_metadata_carries_task_intent_without_references() {
        let metadata = chat_user_message_metadata(None, &[], &[], Some("video"))
            .expect("metadata should include task intent");

        assert_eq!(metadata.get("taskIntent"), Some(&json!("video")));
        assert!(metadata.get("explicitAssetRefs").is_none());
    }
}
