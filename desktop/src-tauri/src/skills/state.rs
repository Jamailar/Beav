use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{now_iso, ChatSessionRecord};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillActivationSource {
    Explicit,
    RoutePolicy,
    TaskHints,
    Conditional,
    SessionRestore,
    ContextDefault,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionSkillRecord {
    pub skill_name: String,
    pub source: Option<SkillActivationSource>,
    pub requested_scope: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RejectedSkillRecord {
    pub skill_name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionSkillState {
    pub requested: Vec<SessionSkillRecord>,
    pub active: Vec<SessionSkillRecord>,
    pub rejected: Vec<RejectedSkillRecord>,
    pub updated_at: String,
}

fn normalize_skill_name(value: &str) -> Option<String> {
    let normalized = value.trim();
    (!normalized.is_empty()).then(|| normalized.to_string())
}

fn dedupe_skill_names(items: Vec<String>) -> Vec<String> {
    let mut deduped = Vec::<String>::new();
    for item in items {
        if !deduped
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&item))
        {
            deduped.push(item);
        }
    }
    deduped.sort_by_key(|item| item.to_ascii_lowercase());
    deduped
}

fn requested_skill_names_from_legacy_metadata(metadata: &Value) -> Vec<String> {
    let mut items = Vec::<String>::new();
    for field in ["activeSkills", "skillNames", "skills"] {
        if let Some(array) = metadata.get(field).and_then(Value::as_array) {
            for value in array.iter().filter_map(Value::as_str) {
                if let Some(normalized) = normalize_skill_name(value) {
                    items.push(normalized);
                }
            }
        }
        if let Some(single) = metadata.get(field).and_then(Value::as_str) {
            if let Some(normalized) = normalize_skill_name(single) {
                items.push(normalized);
            }
        }
    }
    dedupe_skill_names(items)
}

pub fn requested_skill_names_from_task_hints(task_hints: &Value) -> Vec<String> {
    requested_skill_names_from_legacy_metadata(task_hints)
}

pub fn session_skill_state_from_metadata(metadata: Option<&Value>) -> SessionSkillState {
    let Some(metadata) = metadata else {
        return SessionSkillState::default();
    };
    let typed = metadata
        .get("sessionSkillState")
        .cloned()
        .and_then(|value| serde_json::from_value::<SessionSkillState>(value).ok())
        .unwrap_or_default();
    if !typed.requested.is_empty() || !typed.active.is_empty() || !typed.rejected.is_empty() {
        return typed;
    }
    let requested = requested_skill_names_from_legacy_metadata(metadata)
        .into_iter()
        .map(|skill_name| SessionSkillRecord {
            skill_name,
            source: None,
            requested_scope: Some("session".to_string()),
            reason: Some("legacy-active-skills".to_string()),
        })
        .collect::<Vec<_>>();
    SessionSkillState {
        active: requested.clone(),
        requested,
        rejected: Vec::new(),
        updated_at: String::new(),
    }
}

pub fn requested_session_skill_names(metadata: Option<&Value>) -> Vec<String> {
    dedupe_skill_names(
        session_skill_state_from_metadata(metadata)
            .requested
            .into_iter()
            .filter_map(|item| normalize_skill_name(&item.skill_name))
            .collect(),
    )
}

pub fn active_session_skill_names(metadata: Option<&Value>) -> Vec<String> {
    let state = session_skill_state_from_metadata(metadata);
    let active = dedupe_skill_names(
        state
            .active
            .into_iter()
            .filter_map(|item| normalize_skill_name(&item.skill_name))
            .collect(),
    );
    if active.is_empty() {
        requested_session_skill_names(metadata)
    } else {
        active
    }
}

pub fn merge_requested_skills_into_metadata(
    metadata: Option<&Value>,
    requested_skills: &[String],
    source: SkillActivationSource,
    reason: &str,
) -> Value {
    let mut metadata_object = metadata
        .cloned()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let mut skill_state =
        session_skill_state_from_metadata(Some(&Value::Object(metadata_object.clone())));
    for skill_name in requested_skills
        .iter()
        .filter_map(|item| normalize_skill_name(item))
    {
        if !skill_state
            .requested
            .iter()
            .any(|item| item.skill_name.eq_ignore_ascii_case(&skill_name))
        {
            skill_state.requested.push(SessionSkillRecord {
                skill_name: skill_name.clone(),
                source: Some(source.clone()),
                requested_scope: Some("session".to_string()),
                reason: Some(reason.to_string()),
            });
        }
        if !skill_state
            .active
            .iter()
            .any(|item| item.skill_name.eq_ignore_ascii_case(&skill_name))
        {
            skill_state.active.push(SessionSkillRecord {
                skill_name,
                source: Some(source.clone()),
                requested_scope: Some("session".to_string()),
                reason: Some(reason.to_string()),
            });
        }
    }
    skill_state.updated_at = now_iso();
    skill_state
        .requested
        .sort_by_key(|item| item.skill_name.to_ascii_lowercase());
    skill_state
        .active
        .sort_by_key(|item| item.skill_name.to_ascii_lowercase());
    let active_skills = skill_state
        .active
        .iter()
        .map(|item| item.skill_name.clone())
        .collect::<Vec<_>>();
    metadata_object.insert(
        "sessionSkillState".to_string(),
        serde_json::to_value(&skill_state).unwrap_or_else(|_| json!({})),
    );
    metadata_object.insert("activeSkills".to_string(), json!(active_skills));
    Value::Object(metadata_object)
}

pub fn merge_requested_skills_into_session(
    session: &mut ChatSessionRecord,
    requested_skills: &[String],
    source: SkillActivationSource,
    reason: &str,
) -> Vec<String> {
    let metadata = merge_requested_skills_into_metadata(
        session.metadata.as_ref(),
        requested_skills,
        source,
        reason,
    );
    let active = active_session_skill_names(Some(&metadata));
    session.metadata = Some(metadata);
    session.updated_at = now_iso();
    active
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_with_metadata(metadata: Value) -> ChatSessionRecord {
        ChatSessionRecord {
            id: "session-1".to_string(),
            title: "Session".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            metadata: Some(metadata),
        }
    }

    #[test]
    fn session_skill_state_from_metadata_reads_legacy_active_skills() {
        let state = session_skill_state_from_metadata(Some(&json!({
            "activeSkills": ["writing-style", "cover-builder"]
        })));
        assert_eq!(state.requested.len(), 2);
        assert_eq!(state.active.len(), 2);
    }

    #[test]
    fn merge_requested_skills_into_session_writes_typed_state_and_legacy_shadow() {
        let mut session = session_with_metadata(json!({
            "contextType": "wander"
        }));
        let active = merge_requested_skills_into_session(
            &mut session,
            &["writing-style".to_string()],
            SkillActivationSource::TaskHints,
            "unit-test",
        );
        assert_eq!(active, vec!["writing-style".to_string()]);
        let metadata = session.metadata.expect("metadata should exist");
        assert_eq!(
            metadata.get("activeSkills"),
            Some(&json!(["writing-style"]))
        );
        assert_eq!(
            requested_session_skill_names(Some(&metadata)),
            vec!["writing-style".to_string()]
        );
    }
}
