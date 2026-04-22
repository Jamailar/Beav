use tauri::State;

use crate::persistence::{with_store, with_store_mut};
use crate::skills::{
    find_catalog_skill_by_name, merge_requested_skills_into_session, normalized_activation_scope,
    skill_allows_runtime_mode, SkillActivationSource,
};
use crate::AppState;

#[derive(Debug, Clone)]
pub struct SkillInvokeRequest<'a> {
    pub skill_name: &'a str,
    pub session_id: Option<&'a str>,
    pub runtime_mode_hint: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct SkillInvokeOutcome {
    pub skill_name: String,
    pub description: String,
    pub activation_scope: String,
    pub runtime_mode: String,
    pub active_skills: Vec<String>,
    pub persisted_to_session: bool,
}

fn merge_active_skill_into_session(
    state: &State<'_, AppState>,
    session_id: &str,
    skill_name: &str,
) -> Result<Vec<String>, String> {
    with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Err(format!("session not found: {session_id}"));
        };
        let active_skills = merge_requested_skills_into_session(
            session,
            &[skill_name.to_string()],
            SkillActivationSource::Explicit,
            "skills.invoke",
        );
        Ok(active_skills)
    })
}

fn effective_active_skill_names(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    skill_name: &str,
    activation_scope: &str,
) -> Result<(Vec<String>, bool), String> {
    if activation_scope == "turn" {
        return Ok((vec![skill_name.to_string()], false));
    }
    let active = if let Some(session_id) = session_id {
        merge_active_skill_into_session(state, session_id, skill_name)?
    } else {
        vec![skill_name.to_string()]
    };
    Ok((active, session_id.is_some()))
}

pub fn invoke_skill(
    state: &State<'_, AppState>,
    request: SkillInvokeRequest<'_>,
) -> Result<SkillInvokeOutcome, String> {
    let requested_name = request.skill_name.trim();
    if requested_name.is_empty() {
        return Err("技能名称不能为空".to_string());
    }
    let (skill, runtime_mode) = with_store(state, |store| {
        let runtime_mode = request
            .session_id
            .map(|value| {
                crate::commands::chat_state::resolve_runtime_mode_for_session(&store, value)
            })
            .or_else(|| request.runtime_mode_hint.map(ToString::to_string))
            .unwrap_or_else(|| "default".to_string());
        let Some(skill) = find_catalog_skill_by_name(&store.skills, requested_name) else {
            return Err(format!("技能不存在: {requested_name}"));
        };
        Ok((skill, runtime_mode))
    })?;
    if skill.disabled {
        return Err(format!("技能已禁用: {}", skill.name));
    }
    if !skill_allows_runtime_mode(&skill, &runtime_mode) {
        return Err(format!(
            "技能 `{}` 不允许在 runtime mode `{}` 中激活",
            skill.name, runtime_mode
        ));
    }
    let activation_scope = normalized_activation_scope(skill.metadata.activation_scope.as_deref());
    let (active_skills, persisted_to_session) =
        effective_active_skill_names(state, request.session_id, &skill.name, activation_scope)?;
    Ok(SkillInvokeOutcome {
        skill_name: skill.name,
        description: skill.description,
        activation_scope: activation_scope.to_string(),
        runtime_mode,
        active_skills,
        persisted_to_session,
    })
}
