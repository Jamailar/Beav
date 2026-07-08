use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::store::spaces as spaces_store;
use crate::{
    complete_redclaw_mvp_onboarding, complete_redclaw_style_definition_from_interview,
    emit_space_changed, handle_redclaw_onboarding_turn, load_redclaw_onboarding_state,
    load_redclaw_profile_prompt_bundle, load_redclaw_style_profile,
    mark_redclaw_style_definition_started, payload_field, payload_string,
    save_redclaw_mvp_onboarding_progress, update_redclaw_profile_doc, AppState,
};

pub(super) fn handle_redclaw_profile_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "redclaw:profile:get-bundle" => get_profile_bundle(state),
        "redclaw:profile:update-doc" => update_profile_doc(state, payload),
        "redclaw:profile:onboarding-status" => onboarding_status(state),
        "redclaw:profile:onboarding-turn" => onboarding_turn(state, payload),
        "redclaw:profile:save-initialization-progress" => {
            save_initialization_progress(state, payload)
        }
        "redclaw:profile:complete-initialization" => complete_initialization(app, state, payload),
        "redclaw:profile:start-style-definition" => start_style_definition(state, payload),
        "redclaw:profile:complete-style-definition" => complete_style_definition(app, state, payload),
        _ => return None,
    };
    Some(result)
}

fn get_profile_bundle(state: &State<'_, AppState>) -> Result<Value, String> {
    let bundle = load_redclaw_profile_prompt_bundle(state)?;
    let active_space_id =
        crate::with_store(state, |store| Ok(spaces_store::active_space_id(&store)))?;
    Ok(json!({
        "success": true,
        "activeSpaceId": active_space_id,
        "profileRoot": bundle.profile_root.display().to_string(),
        "agent": bundle.agent,
        "soul": bundle.soul,
        "identity": bundle.identity,
        "user": bundle.user,
        "creatorProfile": bundle.creator_profile,
        "bootstrap": bundle.bootstrap,
        "styleProfile": load_redclaw_style_profile(state)?,
        "files": {
            "agent": bundle.agent,
            "soul": bundle.soul,
            "identity": bundle.identity,
            "user": bundle.user,
            "creatorProfile": bundle.creator_profile,
            "bootstrap": bundle.bootstrap
        },
        "onboardingState": bundle.onboarding_state
    }))
}

fn update_profile_doc(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let doc_type =
        payload_string(payload, "docType").ok_or_else(|| "docType is required".to_string())?;
    let markdown =
        payload_string(payload, "markdown").ok_or_else(|| "markdown is required".to_string())?;
    let reason = payload_string(payload, "reason");
    let mut result = update_redclaw_profile_doc(state, &doc_type, &markdown)?;
    if let Some(reason_text) = reason {
        if let Some(object) = result.as_object_mut() {
            object.insert("reason".to_string(), json!(reason_text));
        }
    }
    Ok(result)
}

fn onboarding_status(state: &State<'_, AppState>) -> Result<Value, String> {
    let onboarding_state = load_redclaw_onboarding_state(state)?;
    let completed = onboarding_state
        .get("completedAt")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    Ok(json!({
        "success": true,
        "completed": completed,
        "state": onboarding_state
    }))
}

fn onboarding_turn(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let input = payload_string(payload, "input").unwrap_or_default();
    let result = handle_redclaw_onboarding_turn(state, &input)?;
    Ok(json!({
        "success": true,
        "handled": result.is_some(),
        "result": result.map(|(response, completed)| json!({
            "responseText": response,
            "completed": completed
        }))
    }))
}

fn save_initialization_progress(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let step_index = payload_field(payload, "stepIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let answers = payload_field(payload, "answers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let onboarding_state = save_redclaw_mvp_onboarding_progress(state, step_index, &answers)?;
    Ok(json!({
        "success": true,
        "state": onboarding_state
    }))
}

fn complete_initialization(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let answers = payload_field(payload, "answers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    complete_redclaw_mvp_onboarding(app, state, &answers)
}

fn start_style_definition(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let force_restart = payload_field(payload, "forceRestart")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let source = payload_string(payload, "source").unwrap_or_else(|| "manual".to_string());
    let session_id = payload_string(payload, "sessionId");
    let onboarding_state = mark_redclaw_style_definition_started(
        state,
        session_id.as_deref(),
        &source,
        force_restart,
    )?;
    Ok(json!({
        "success": true,
        "state": onboarding_state
    }))
}

fn complete_style_definition(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let mut result = complete_redclaw_style_definition_from_interview(state, payload)?;
    if let Some(space_init_state) =
        crate::commands::space_init::complete_space_init_after_profile_definition(state, &result)?
    {
        let active_space_id =
            crate::with_store(state, |store| Ok(spaces_store::active_space_id(&store)))?;
        emit_space_changed(app, &active_space_id);
        if let Some(object) = result.as_object_mut() {
            object.insert("spaceInitialization".to_string(), space_init_state);
        }
    }
    Ok(result)
}
