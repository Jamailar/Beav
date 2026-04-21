use serde_json::Value;

use crate::runtime::SkillRecord;
use crate::skills::{
    apply_skill_tool_permissions, build_skill_catalog_snapshot, build_skill_hook_output,
    normalized_activation_scope, requested_session_skill_names, skill_allows_runtime_mode,
    LoadedSkillRecord, SkillHookOutput,
};

#[derive(Debug, Clone, Default)]
pub struct ResolvedSkillSet {
    pub catalog: Vec<LoadedSkillRecord>,
    pub visible_skills: Vec<LoadedSkillRecord>,
    pub active_skills: Vec<LoadedSkillRecord>,
    pub allowed_tools: Vec<String>,
    pub hooks: SkillHookOutput,
    pub can_invoke_skill: bool,
}

fn resolve_active_skills(
    catalog: &[LoadedSkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<LoadedSkillRecord> {
    let requested = requested_session_skill_names(metadata);
    let mut active = Vec::new();
    for skill in catalog {
        if !skill_allows_runtime_mode(skill, runtime_mode) {
            continue;
        }
        let requested_match = requested.iter().any(|item| item == &skill.name);
        let session_scoped =
            normalized_activation_scope(skill.metadata.activation_scope.as_deref()) == "session";
        if (requested_match && session_scoped) || skill.metadata.auto_activate {
            active.push(skill.clone());
        }
    }
    active
}

fn visible_catalog(catalog: &[LoadedSkillRecord], runtime_mode: &str) -> Vec<LoadedSkillRecord> {
    catalog
        .iter()
        .filter(|skill| skill_allows_runtime_mode(skill, runtime_mode))
        .cloned()
        .collect()
}

pub fn resolve_skill_set(
    skills: &[SkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
    base_tools: &[String],
) -> ResolvedSkillSet {
    let catalog_snapshot = build_skill_catalog_snapshot(skills);
    let catalog = catalog_snapshot.entries;
    let visible_skills = visible_catalog(&catalog, runtime_mode);
    let active_skills = resolve_active_skills(&catalog, runtime_mode, metadata);
    let allowed_tools = apply_skill_tool_permissions(base_tools, &active_skills);
    let hooks = build_skill_hook_output(&active_skills);
    let can_invoke_skill = base_tools
        .iter()
        .any(|item| item == "redbox_skill" || item == "app_cli");
    ResolvedSkillSet {
        catalog,
        visible_skills,
        active_skills,
        allowed_tools,
        hooks,
        can_invoke_skill,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, runtime_modes: &str, auto_activate: bool) -> SkillRecord {
        SkillRecord {
            name: name.to_string(),
            description: "desc".to_string(),
            location: format!("redbox://skills/{name}"),
            body: format!(
                "---\nallowedRuntimeModes: {runtime_modes}\nautoActivate: {auto_activate}\nhookMode: inline\n---\n# Skill\n\nBody"
            ),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        }
    }

    #[test]
    fn resolve_skill_set_reads_typed_session_skill_state() {
        let resolved = resolve_skill_set(
            &[skill("session-writer", "[wander]", false)],
            "wander",
            Some(&serde_json::json!({
                "sessionSkillState": {
                    "requested": [{
                        "skillName": "session-writer",
                        "requestedScope": "session"
                    }],
                    "active": [{
                        "skillName": "session-writer",
                        "requestedScope": "session"
                    }]
                }
            })),
            &["app_cli".to_string()],
        );
        assert_eq!(resolved.active_skills.len(), 1);
        assert_eq!(resolved.visible_skills.len(), 1);
    }
}
