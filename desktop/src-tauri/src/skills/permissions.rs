use crate::skills::LoadedSkillRecord;
use crate::tools::compat::canonical_tool_name;
use crate::tools::packs::{pack_by_name, tool_names_for_pack};

pub fn normalized_runtime_mode_name(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "default" | "chat" | "chatroom" => "team".to_string(),
        "image" | "image-gen" | "image_generate" => "image-generation".to_string(),
        "background" => "background-maintenance".to_string(),
        other => other.to_string(),
    }
}

fn normalized_set(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for item in values
        .iter()
        .map(|item| item.trim().to_ascii_lowercase())
        .filter(|item| !item.is_empty())
        .map(|item| canonical_tool_name(&item).to_string())
    {
        if !normalized.iter().any(|existing| existing == &item) {
            normalized.push(item);
        }
    }
    normalized
}

pub fn skill_allows_runtime_mode(skill: &LoadedSkillRecord, runtime_mode: &str) -> bool {
    if skill.disabled {
        return false;
    }
    if skill.metadata.allowed_runtime_modes.is_empty() {
        return true;
    }
    let normalized_mode = normalized_runtime_mode_name(runtime_mode);
    normalized_set(&skill.metadata.allowed_runtime_modes)
        .into_iter()
        .map(|item| normalized_runtime_mode_name(&item))
        .any(|item| item == normalized_mode || item == "all" || item == "*")
}

pub fn apply_skill_tool_permissions(
    base_tools: &[String],
    active_skills: &[LoadedSkillRecord],
) -> Vec<String> {
    let mut allowed = normalized_set(base_tools);
    for skill in active_skills {
        if let Some(pack_name) = skill.metadata.allowed_tool_pack.as_deref() {
            if let Some(pack) = pack_by_name(pack_name) {
                let pack_tools = tool_names_for_pack(pack)
                    .iter()
                    .map(|item| item.to_string())
                    .collect::<Vec<_>>();
                allowed.retain(|tool| pack_tools.iter().any(|candidate| candidate == tool));
            }
        }
        if !skill.metadata.allowed_tools.is_empty() {
            let allowed_tools = normalized_set(&skill.metadata.allowed_tools);
            allowed.retain(|tool| allowed_tools.iter().any(|candidate| candidate == tool));
        }
        if !skill.metadata.blocked_tools.is_empty() {
            let blocked_tools = normalized_set(&skill.metadata.blocked_tools);
            allowed.retain(|tool| !blocked_tools.iter().any(|candidate| candidate == tool));
        }
    }
    allowed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillMetadataRecord;

    fn test_skill() -> LoadedSkillRecord {
        LoadedSkillRecord {
            name: "skill".to_string(),
            description: "desc".to_string(),
            location: "skills://skill".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: true,
            disabled: false,
            metadata: SkillMetadataRecord {
                allowed_runtime_modes: vec!["redclaw".to_string()],
                allowed_tool_pack: Some("knowledge".to_string()),
                allowed_tools: vec!["query".to_string(), "resource".to_string()],
                blocked_tools: vec!["resource".to_string()],
                hook_mode: Some("inline".to_string()),
                auto_activate: true,
                activation_scope: None,
                prompt_prefix: None,
                prompt_suffix: None,
                context_note: None,
                activation_hint: None,
                max_prompt_chars: None,
            },
            body: "# Skill".to_string(),
            fingerprint: "fp".to_string(),
        }
    }

    #[test]
    fn apply_skill_tool_permissions_intersects_pack_and_tool_list() {
        let allowed = apply_skill_tool_permissions(
            &[
                "query".to_string(),
                "resource".to_string(),
                "mcp".to_string(),
            ],
            &[test_skill()],
        );
        assert_eq!(allowed, vec!["workflow".to_string()]);
    }

    #[test]
    fn skill_allows_runtime_mode_respects_explicit_modes() {
        assert!(skill_allows_runtime_mode(&test_skill(), "redclaw"));
        assert!(!skill_allows_runtime_mode(&test_skill(), "wander"));
    }

    #[test]
    fn skill_allows_runtime_mode_treats_default_as_team_alias() {
        let mut skill = test_skill();
        skill.metadata.allowed_runtime_modes = vec!["team".to_string()];
        assert!(skill_allows_runtime_mode(&skill, "default"));
        assert!(skill_allows_runtime_mode(&skill, "chat"));
        assert!(skill_allows_runtime_mode(&skill, "chatroom"));
    }

    #[test]
    fn skill_allows_runtime_mode_treats_image_alias_as_image_generation() {
        let mut skill = test_skill();
        skill.metadata.allowed_runtime_modes = vec!["image-generation".to_string()];
        assert!(skill_allows_runtime_mode(&skill, "image"));
        assert!(skill_allows_runtime_mode(&skill, "image-gen"));
    }
}
