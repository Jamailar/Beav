use crate::skills::LoadedSkillRecord;

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>()
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SkillHookOutput {
    pub prompt_prefix: String,
    pub prompt_suffix: String,
    pub context_note: String,
    pub skills_section: String,
    pub active_skill_names: Vec<String>,
}

pub fn build_skill_hook_output(active_skills: &[LoadedSkillRecord]) -> SkillHookOutput {
    let mut output = SkillHookOutput::default();
    for skill in active_skills {
        output.active_skill_names.push(skill.name.clone());
        if let Some(prefix) = skill.metadata.prompt_prefix.as_deref() {
            if !prefix.trim().is_empty() {
                if !output.prompt_prefix.is_empty() {
                    output.prompt_prefix.push('\n');
                }
                output.prompt_prefix.push_str(prefix.trim());
            }
        }
        if let Some(suffix) = skill.metadata.prompt_suffix.as_deref() {
            if !suffix.trim().is_empty() {
                if !output.prompt_suffix.is_empty() {
                    output.prompt_suffix.push('\n');
                }
                output.prompt_suffix.push_str(suffix.trim());
            }
        }
        if let Some(note) = skill.metadata.context_note.as_deref() {
            if !note.trim().is_empty() {
                if !output.context_note.is_empty() {
                    output.context_note.push('\n');
                }
                output.context_note.push_str(note.trim());
            }
        }
        let section_body = truncate_chars(
            skill.body.trim(),
            skill.metadata.max_prompt_chars.unwrap_or(3200),
        );
        if section_body.is_empty() {
            continue;
        }
        let hook_mode = skill.metadata.hook_mode.as_deref().unwrap_or("inline");
        if !output.skills_section.is_empty() {
            output.skills_section.push_str("\n\n");
        }
        output.skills_section.push_str(&format!(
            "### {} [{}]\n{}\n",
            skill.name, hook_mode, section_body
        ));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillMetadataRecord;

    #[test]
    fn build_skill_hook_output_includes_prompt_and_context_modifiers() {
        let output = build_skill_hook_output(&[LoadedSkillRecord {
            name: "writer".to_string(),
            description: "desc".to_string(),
            location: "redbox://skills/writer".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: true,
            disabled: false,
            metadata: SkillMetadataRecord {
                hook_mode: Some("forked".to_string()),
                prompt_prefix: Some("prefix".to_string()),
                prompt_suffix: Some("suffix".to_string()),
                context_note: Some("note".to_string()),
                max_prompt_chars: Some(32),
                ..SkillMetadataRecord::default()
            },
            body: "# Skill\n\nUse structured output.".to_string(),
            fingerprint: "fp".to_string(),
        }]);
        assert_eq!(output.prompt_prefix, "prefix");
        assert_eq!(output.prompt_suffix, "suffix");
        assert_eq!(output.context_note, "note");
        assert!(output.skills_section.contains("writer [forked]"));
    }
}
