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

    let list = resolved
        .visible_skills
        .iter()
        .map(|skill| {
            let mut item = format!("- {}: {}", skill.name, skill.description);
            if skill.metadata.auto_activate {
                item.push_str(" [auto]");
            }
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
    let available_names = resolved
        .visible_skills
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>();
    let mut preflight_rules = Vec::<&str>::new();
    if available_names
        .iter()
        .any(|name| name.eq_ignore_ascii_case("image-prompt-optimizer"))
    {
        preflight_rules.push(
            "Before any `app_cli(command=\"image generate ...\")`, you must first call `app_cli(command=\"skills invoke --name image-prompt-optimizer\")` in the same turn, then use that skill's instructions to prepare the final image prompt.",
        );
    }
    if available_names
        .iter()
        .any(|name| name.eq_ignore_ascii_case("redbox-video-director"))
    {
        preflight_rules.push(
            "Before any `app_cli(command=\"video generate ...\")`, you must first call `app_cli(command=\"skills invoke --name redbox-video-director\")` in the same turn, then follow its script-confirmation workflow before generating video.",
        );
    }

    if resolved.can_invoke_skill {
        let mut sections = vec![
            "You have access to specialized skills in this runtime.".to_string(),
            "Keep full skill bodies out of context until they are actually needed.".to_string(),
            "Visible skills below are not active by default unless marked `[auto]`.".to_string(),
            "When a task clearly matches one of the skills below, call `app_cli(command=\"skills invoke --name skill-name\")` to load the full instructions, references, scripts, and rules into the current session.".to_string(),
            "If the user explicitly names a skill, invoke it before proceeding.".to_string(),
        ];
        if !preflight_rules.is_empty() {
            sections.push("Mandatory preflight rules:".to_string());
            sections.extend(preflight_rules.into_iter().map(ToString::to_string));
        }
        sections.push(String::new());
        sections.push("Available skills:".to_string());
        sections.push(list);
        return sections.join("\n");
    }

    [
        "You have access to specialized skills in this runtime.",
        "Manual skill invocation is unavailable here, so rely on the auto-activated skills and the instructions already injected into this session.",
        "",
        "Available skills:",
        &list,
    ]
    .join("\n")
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
                name: "writing-style".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/writing-style".to_string(),
                body: "---\nallowedRuntimeModes: [wander]\nautoActivate: false\nactivationHint: when writing\nhookMode: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "wander",
            None,
            &["app_cli".to_string()],
        );
        let bundle = build_skill_prompt_bundle(&resolved);
        assert!(bundle
            .catalog_section
            .contains("call `app_cli(command=\"skills invoke --name skill-name\")`"));
        assert!(bundle
            .catalog_section
            .contains("Visible skills below are not active by default"));
        assert!(bundle
            .catalog_section
            .contains("Activate when: when writing"));
    }
}
