use serde_json::{json, Value};
use tauri::State;

#[path = "task_scope_metadata.rs"]
mod task_scope_metadata;

use crate::commands::chat_state::resolve_runtime_mode_for_session;
use crate::member_skill::advisor_member_skill_ref;
use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    active_skill_activation_items, merge_requested_skills_into_session,
    requested_skill_names_from_task_hints, SkillActivationSource,
};
use crate::{
    load_redclaw_onboarding_state, mark_redclaw_style_definition_started, now_iso,
    redclaw_style_definition_already_handled, AppState, REDCLAW_STYLE_DEFINITION_SKILL_NAME,
};
pub(super) use task_scope_metadata::clear_stale_task_hints_from_metadata;
use task_scope_metadata::TASK_SCOPED_METADATA_FIELDS;

pub(super) fn apply_chat_turn_session_metadata(
    state: &State<'_, AppState>,
    session_id: &str,
    advisor_id: Option<&str>,
    knowledge_references: &[Value],
    asset_references: &[Value],
    task_intent: Option<&str>,
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
                "turnMode": "speak",
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
        if !asset_references.is_empty() {
            metadata.insert(
                "explicitAssetRefs".to_string(),
                Value::Array(asset_references.to_vec()),
            );
        }
        if let Some(task_intent) = task_intent.map(str::trim).filter(|value| !value.is_empty()) {
            metadata.insert("taskIntent".to_string(), json!(task_intent));
        }
        session.metadata = Some(Value::Object(metadata));
        Ok(previous_metadata)
    })
}

pub(super) fn restore_chat_turn_session_metadata(
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

pub(super) fn merge_task_hints_into_session_metadata(
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

pub(super) fn maybe_activate_redclaw_style_definition_for_turn(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<bool, String> {
    let should_activate = with_store(state, |store| {
        Ok(resolve_runtime_mode_for_session(&store, session_id) == "redclaw")
    })?;
    if !should_activate {
        return Ok(false);
    }
    let current_onboarding_state = load_redclaw_onboarding_state(state)?;
    if redclaw_style_definition_already_handled(&current_onboarding_state) {
        return Ok(false);
    }
    let onboarding_state = mark_redclaw_style_definition_started(
        state,
        Some(session_id),
        "first-redclaw-chat",
        false,
    )?;
    let activated_at = onboarding_state
        .get("styleDefinitionSkill")
        .and_then(Value::as_object)
        .and_then(|object| object.get("activatedAt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    let completed = onboarding_state
        .get("completedAt")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if !activated_at || completed {
        return Ok(false);
    }
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(false);
        };
        let active_skills = merge_requested_skills_into_session(
            session,
            &[REDCLAW_STYLE_DEFINITION_SKILL_NAME.to_string()],
            SkillActivationSource::RoutePolicy,
            "redclaw.first_turn_style_definition",
        );
        let mut metadata = session
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        metadata.insert("activeSkills".to_string(), json!(active_skills));
        metadata.insert(
            "allowedOperateActions".to_string(),
            json!([
                "redclaw.profile.bundle",
                "redclaw.profile.read",
                "redclaw.profile.update",
                "redclaw.profile.completeStyleDefinition"
            ]),
        );
        metadata.insert(
            "redclawStyleDefinition".to_string(),
            json!({
                "status": "interviewing",
                "source": "first-redclaw-chat",
                "skillName": REDCLAW_STYLE_DEFINITION_SKILL_NAME
            }),
        );
        session.metadata = Some(Value::Object(metadata));
        session.updated_at = now_iso();
        Ok(true)
    })
}

pub(super) fn clear_stale_task_hints_from_session_metadata(
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

pub(super) fn collect_active_skill_items_for_session(
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
