use crate::skills::{LoadedSkillRecord, SkillHookActionRecord};

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

fn execution_label(skill: &LoadedSkillRecord) -> &str {
    skill.metadata
        .execution_context
        .as_deref()
        .or(skill.metadata.hook_mode.as_deref())
        .unwrap_or("inline")
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
        let mut section_body = skill.body.trim().to_string();
        if let Some(when_to_use) = skill.metadata.when_to_use.as_deref() {
            if !when_to_use.trim().is_empty() {
                section_body = format!("[whenToUse]\n{}\n\n{}", when_to_use.trim(), section_body);
            }
        }
        let section_body = truncate_chars(
            &section_body,
            skill.metadata.max_prompt_chars.unwrap_or(3200),
        );
        if section_body.is_empty() {
            continue;
        }
        if !output.skills_section.is_empty() {
            output.skills_section.push_str("\n\n");
        }
        output.skills_section.push_str(&format!(
            "### {} [{}]\n{}\n",
            skill.name,
            execution_label(skill),
            section_body
        ));
    }
    output
}

pub fn build_skill_matcher_hooks_for_event(
    active_skills: &[LoadedSkillRecord],
    event: &str,
    runtime_mode: &str,
    message: &str,
) -> Vec<SkillHookActionRecord> {
    let normalized_event = event.trim();
    let normalized_runtime = runtime_mode.trim().to_ascii_lowercase();
    let normalized_message = message.trim().to_ascii_lowercase();
    let mut actions = Vec::<SkillHookActionRecord>::new();
    for skill in active_skills {
        let Some(matchers) = skill.metadata.hooks.get(normalized_event) else {
            continue;
        };
        for matcher in matchers {
            if matcher.enabled == Some(false) {
                continue;
            }
            let matcher_text = matcher
                .matcher
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let matches = matcher_text.is_empty()
                || matcher_text == "*"
                || normalized_runtime.contains(&matcher_text)
                || normalized_message.contains(&matcher_text)
                || skill.name.to_ascii_lowercase().contains(&matcher_text);
            if !matches {
                continue;
            }
            for hook in &matcher.hooks {
                if hook.enabled == Some(false) {
                    continue;
                }
                actions.push(hook.clone());
            }
        }
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{SkillHookMatcherRecord, SkillMetadataRecord};
    use serde_json::json;

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
                execution_context: Some("fork".to_string()),
                prompt_prefix: Some("prefix".to_string()),
                prompt_suffix: Some("suffix".to_string()),
                context_note: Some("note".to_string()),
                when_to_use: Some("when".to_string()),
                max_prompt_chars: Some(64),
                ..SkillMetadataRecord::default()
            },
            body: "# Skill\n\nUse structured output.".to_string(),
            fingerprint: "fp".to_string(),
            base_dir: None,
        }]);
        assert_eq!(output.prompt_prefix, "prefix");
        assert_eq!(output.prompt_suffix, "suffix");
        assert_eq!(output.context_note, "note");
        assert!(output.skills_section.contains("writer [fork]"));
        assert!(output.skills_section.contains("[whenToUse]"));
    }

    #[test]
    fn build_skill_matcher_hooks_for_event_filters_by_runtime_and_message() {
        let hooks = build_skill_matcher_hooks_for_event(
            &[LoadedSkillRecord {
                name: "writer".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/writer".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: true,
                disabled: false,
                metadata: SkillMetadataRecord {
                    hooks: [(
                        "turnStart".to_string(),
                        vec![SkillHookMatcherRecord {
                            matcher: Some("redclaw".to_string()),
                            enabled: Some(true),
                            hooks: vec![SkillHookActionRecord {
                                action_type: "checkpoint".to_string(),
                                summary: Some("start".to_string()),
                                message: None,
                                once: false,
                                enabled: Some(true),
                                payload: Some(json!({"scope": "writer"})),
                            }],
                        }],
                    )]
                    .into_iter()
                    .collect(),
                    ..SkillMetadataRecord::default()
                },
                body: "# Skill".to_string(),
                fingerprint: "fp".to_string(),
                base_dir: None,
            }],
            "turnStart",
            "redclaw",
            "draft the post",
        );
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].summary.as_deref(), Some("start"));
    }
}
