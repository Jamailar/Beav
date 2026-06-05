use super::member_skills::{member_skill_distillation_enabled, publish_member_skill_if_enabled};
use crate::member_skill::remove_member_skill_package;
use crate::persistence::{with_store, with_store_mut};
use crate::{
    append_debug_log_state, make_id, normalize_optional_string, now_iso, payload_field,
    payload_string, payload_value_as_string, AdvisorRecord, AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

pub(super) fn handle_crud_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    Some(match channel {
        "advisors:create" => create_advisor_value(app, state, payload),
        "advisors:update" => update_advisor_value(app, state, payload),
        "advisors:delete" => delete_advisor_value(app, state, payload),
        _ => return None,
    })
}

fn create_advisor_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor = with_store_mut(state, |store| {
        let timestamp = now_iso();
        let redclaw_order = store.advisors.len() as i64;
        let advisor = AdvisorRecord {
            id: make_id("advisor"),
            name: payload_string(payload, "name").unwrap_or_else(|| "未命名成员".to_string()),
            avatar: payload_string(payload, "avatar").unwrap_or_else(|| "🧠".to_string()),
            personality: payload_string(payload, "personality").unwrap_or_default(),
            system_prompt: payload_string(payload, "systemPrompt").unwrap_or_default(),
            knowledge_language: normalize_optional_string(payload_string(
                payload,
                "knowledgeLanguage",
            )),
            knowledge_files: Vec::new(),
            youtube_channel: payload_field(payload, "youtubeChannel").cloned(),
            member_skill_ref: None,
            member_skill_status: Some("pending".to_string()),
            member_skill_version: None,
            member_skill_last_distilled_at: None,
            member_skill_last_error: None,
            member_skill_candidate_version: None,
            member_skill_candidate_path: None,
            member_skill_candidate_created_at: None,
            member_skill_candidate_source_event: None,
            detected_knowledge_language: None,
            language_detection_status: None,
            language_confidence: None,
            redclaw_visible: Some(true),
            redclaw_order: Some(redclaw_order),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        store.advisors.push(advisor.clone());
        Ok(advisor)
    })?;
    let should_distill_member_skill = advisor.youtube_channel.is_some()
        || !advisor.personality.trim().is_empty()
        || !advisor.system_prompt.trim().is_empty();
    let distillation_enabled = member_skill_distillation_enabled(state).unwrap_or(true);
    let member_skill = if should_distill_member_skill {
        publish_member_skill_if_enabled(state, &advisor.id, "advisor-create")
    } else {
        None
    };
    let member_skill_ref_missing = with_store(state, |store| {
        Ok(store
            .advisors
            .iter()
            .find(|item| item.id == advisor.id)
            .and_then(|item| item.member_skill_ref.as_deref())
            .map(str::trim)
            .unwrap_or_default()
            .is_empty())
    })?;
    if should_distill_member_skill && distillation_enabled && member_skill_ref_missing {
        append_debug_log_state(
            state,
            format!(
                "member_skill_missing_after_create advisorId={} memberSkill={}",
                advisor.id,
                member_skill
                    .as_ref()
                    .map(Value::to_string)
                    .unwrap_or_else(|| "null".to_string())
            ),
        );
    }
    let _ = app.emit(
        "advisors:changed",
        json!({ "advisorId": advisor.id.clone() }),
    );
    Ok(json!({ "success": true, "id": advisor.id, "memberSkill": member_skill }))
}

fn update_advisor_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor_id = payload_string(payload, "id").unwrap_or_default();
    let should_refresh_member_skill = payload_field(payload, "personality").is_some()
        || payload_field(payload, "systemPrompt").is_some()
        || payload_field(payload, "knowledgeLanguage").is_some()
        || payload_field(payload, "youtubeChannel").is_some();
    let result = with_store_mut(state, |store| {
        let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id) else {
            return Ok(json!({ "success": false, "error": "成员不存在" }));
        };
        if let Some(name) = payload_string(payload, "name") {
            advisor.name = name;
        }
        if let Some(avatar) = payload_string(payload, "avatar") {
            advisor.avatar = avatar;
        }
        if let Some(personality) = payload_string(payload, "personality") {
            advisor.personality = personality;
        }
        if let Some(system_prompt) = payload_string(payload, "systemPrompt") {
            advisor.system_prompt = system_prompt;
        }
        if payload_field(payload, "knowledgeLanguage").is_some() {
            advisor.knowledge_language =
                normalize_optional_string(payload_string(payload, "knowledgeLanguage"));
        }
        if let Some(youtube_channel) = payload_field(payload, "youtubeChannel") {
            advisor.youtube_channel = Some(youtube_channel.clone());
        }
        if let Some(value) = payload_field(payload, "redclawVisible") {
            advisor.redclaw_visible = value.as_bool();
        }
        if let Some(value) = payload_field(payload, "redclawOrder") {
            advisor.redclaw_order = value.as_i64();
        }
        advisor.updated_at = now_iso();
        Ok(json!({ "success": true, "advisor": advisor.clone() }))
    })?;
    if should_refresh_member_skill {
        let _ = publish_member_skill_if_enabled(state, &advisor_id, "advisor-update");
    }
    let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
    Ok(result)
}

fn delete_advisor_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let advisor_id = payload_value_as_string(payload).unwrap_or_default();
    let member_skill_ref = with_store(state, |store| {
        Ok(store
            .advisors
            .iter()
            .find(|item| item.id == advisor_id)
            .and_then(|item| item.member_skill_ref.clone()))
    })?;
    let result = with_store_mut(state, |store| {
        store.advisors.retain(|item| item.id != advisor_id);
        store
            .advisor_videos
            .retain(|item| item.advisor_id != advisor_id);
        for room in &mut store.chat_rooms {
            room.advisor_ids.retain(|item| item != &advisor_id);
        }
        Ok(json!({ "success": true }))
    })?;
    let _ = remove_member_skill_package(state, member_skill_ref);
    let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
    Ok(result)
}
