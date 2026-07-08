use crate::skills::ResolvedSkillSet;

#[derive(Debug, Clone, Default)]
pub struct SkillPromptBundle {
    #[allow(dead_code)]
    pub catalog_section: String,
    #[allow(dead_code)]
    pub active_section: String,
    pub prompt_prefix: String,
    pub prompt_suffix: String,
    pub context_note: String,
    pub skills_section: String,
}

fn build_skill_catalog_prompt_section(resolved: &ResolvedSkillSet) -> String {
    if resolved.visible_skills.is_empty() {
        return "No specialized skills are currently available in this runtime.".to_string();
    }

    let active_names = resolved
        .active_skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>();
    let inactive_visible_skills = resolved
        .visible_skills
        .iter()
        .filter(|skill| {
            !active_names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&skill.name))
        })
        .cloned()
        .collect::<Vec<_>>();

    let list = inactive_visible_skills
        .iter()
        .map(|skill| {
            let mut item = format!("- {}: {}", skill.name, skill.description);
            if let Some(hint) = skill.metadata.activation_hint.as_deref() {
                let hint = hint.trim();
                if !hint.is_empty() {
                    item.push_str("\n  Activate when: ");
                    item.push_str(hint);
                }
            }
            item
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut sections = vec![
        "You have access to specialized skills in this runtime.".to_string(),
        "A skill is a set of local instructions stored in SKILL.md.".to_string(),
        "Trigger rules: if the user names a skill with @skill, $skill, or plain text, or the task clearly matches a skill description below, use that skill for this turn.".to_string(),
        "When a skill is selected, the host injects its SKILL.md as a model-visible <skill> context block before sampling. Treat that injected block as the source of truth for the skill rules.".to_string(),
        "If SKILL.md references relative files such as references/, rules/, templates/, scripts/, or assets/, resolve them relative to that skill directory and read the required files with Read(path=\"skill://<skill>/<relative-path>\") or workflow action skills.readResource before acting on them.".to_string(),
        "Do not treat skill selection alone as compliance; final output must follow the injected SKILL.md contract and report any missing required resource instead of inventing it.".to_string(),
    ];
    if resolved.can_invoke_skill {
        sections.push(
            "Compatibility fallback: if a needed inactive skill was not injected, call `Operate(resource=\"skills\", operation=\"invoke\", input={ \"name\": \"skill-name\" })` once to request activation and hydration.".to_string(),
        );
    }
    if !active_names.is_empty() {
        sections.push(format!(
            "Already selected in this session: {}.",
            active_names.join(", ")
        ));
    }
    if inactive_visible_skills.is_empty() {
        sections.push("All visible skills for this runtime are already selected.".to_string());
    } else {
        sections.push(String::new());
        sections.push("Available skills:".to_string());
        sections.push(list);
    }
    sections.join("\n")
}

fn combine_skills_section(catalog_section: &str, active_section: &str) -> String {
    if active_section.trim().is_empty() {
        return catalog_section.trim().to_string();
    }
    [
        catalog_section.trim(),
        "",
        "Activated skills for this session:",
        active_section.trim(),
    ]
    .join("\n")
}

pub fn build_skill_prompt_bundle(resolved: &ResolvedSkillSet) -> SkillPromptBundle {
    let catalog_section = build_skill_catalog_prompt_section(resolved);
    let active_section = resolved.hooks.skills_section.trim().to_string();
    SkillPromptBundle {
        catalog_section: catalog_section.clone(),
        active_section: active_section.clone(),
        prompt_prefix: resolved.hooks.prompt_prefix.clone(),
        prompt_suffix: resolved.hooks.prompt_suffix.clone(),
        context_note: resolved.hooks.context_note.clone(),
        skills_section: combine_skills_section(&catalog_section, &active_section),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::SkillRecord;
    use crate::skills::resolve_skill_set;

    #[test]
    fn build_skill_prompt_bundle_includes_manual_invoke_copy() {
        let resolved = resolve_skill_set(
            &[SkillRecord {
                name: "session-writer".to_string(),
                description: "desc".to_string(),
                location: "skills://session-writer".to_string(),
                body: "---\nallowedRuntimeModes: [wander]\nautoActivate: false\nactivationScope: session\nactivationHint: when writing\nhookMode: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "wander",
            None,
            &["workflow".to_string()],
        );
        let bundle = build_skill_prompt_bundle(&resolved);
        assert!(bundle
            .catalog_section
            .contains("the host injects its SKILL.md as a model-visible <skill> context block"));
        assert!(bundle.catalog_section.contains("Compatibility fallback"));
        assert!(bundle
            .catalog_section
            .contains("Activate when: when writing"));
    }

    #[test]
    fn build_skill_prompt_bundle_marks_existing_active_skills() {
        let resolved = resolve_skill_set(
            &[SkillRecord {
                name: "session-writer".to_string(),
                description: "desc".to_string(),
                location: "skills://session-writer".to_string(),
                body: "---\nallowedRuntimeModes: [wander]\nautoActivate: false\nactivationScope: session\nactivationHint: when writing\nhookMode: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "wander",
            Some(&serde_json::json!({
                "sessionSkillState": {
                    "requested": [{ "skillName": "session-writer", "requestedScope": "session" }],
                    "active": [{ "skillName": "session-writer", "requestedScope": "session" }]
                }
            })),
            &["workflow".to_string()],
        );
        let bundle = build_skill_prompt_bundle(&resolved);
        assert!(bundle
            .catalog_section
            .contains("Already selected in this session: session-writer"));
        assert!(bundle
            .catalog_section
            .contains("All visible skills for this runtime are already selected"));
    }
}
