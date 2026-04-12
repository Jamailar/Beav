use serde_json::{json, Value};

use crate::runtime::SkillRecord;
use crate::skills::{
    apply_skill_tool_permissions, build_skill_hook_output,
    build_skill_watcher_snapshot_with_discovery, load_skill_catalog, skill_allows_runtime_mode,
    LoadedSkillRecord, SkillWatcherSnapshot,
};
use crate::slug_from_relative_path;
use crate::tools::packs::tool_names_for_runtime_mode;

#[derive(Debug, Clone, Default)]
pub struct SkillRuntimeState {
    pub catalog: Vec<LoadedSkillRecord>,
    pub active_skills: Vec<LoadedSkillRecord>,
    pub allowed_tools: Vec<String>,
    pub prompt_prefix: String,
    pub prompt_suffix: String,
    pub context_note: String,
    pub skills_section: String,
}

fn requested_skill_names(metadata: Option<&Value>) -> Vec<String> {
    let mut items = Vec::new();
    for field in ["activeSkills", "skillNames", "skills"] {
        if let Some(array) = metadata
            .and_then(|value| value.get(field))
            .and_then(Value::as_array)
        {
            for value in array.iter().filter_map(Value::as_str) {
                let normalized = value.trim();
                if !normalized.is_empty() {
                    items.push(normalized.to_string());
                }
            }
        }
        if let Some(single) = metadata
            .and_then(|value| value.get(field))
            .and_then(Value::as_str)
        {
            let normalized = single.trim();
            if !normalized.is_empty() {
                items.push(normalized.to_string());
            }
        }
    }
    items.sort();
    items.dedup();
    items
}

fn resolve_active_skills(
    catalog: &[LoadedSkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<LoadedSkillRecord> {
    let requested = requested_skill_names(metadata);
    let mut active = Vec::new();
    for skill in catalog {
        if !skill_allows_runtime_mode(skill, runtime_mode) {
            continue;
        }
        let requested_match = requested.iter().any(|item| item == &skill.name);
        if requested_match || skill.metadata.auto_activate {
            active.push(skill.clone());
        }
    }
    active
}

pub fn build_skill_runtime_state(
    skills: &[SkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
    base_tools: &[String],
) -> SkillRuntimeState {
    let catalog = load_skill_catalog(skills);
    let active_skills = resolve_active_skills(&catalog, runtime_mode, metadata);
    let allowed_tools = apply_skill_tool_permissions(base_tools, &active_skills);
    let hooks = build_skill_hook_output(&active_skills);
    SkillRuntimeState {
        catalog,
        active_skills,
        allowed_tools,
        prompt_prefix: hooks.prompt_prefix,
        prompt_suffix: hooks.prompt_suffix,
        context_note: hooks.context_note,
        skills_section: hooks.skills_section,
    }
}

pub fn active_skill_activation_items(
    skills: &[SkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<(String, String)> {
    let base_tools = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    build_skill_runtime_state(skills, runtime_mode, metadata, &base_tools)
        .active_skills
        .into_iter()
        .map(|item| (item.name, item.description))
        .collect()
}

pub fn skills_catalog_list_value(
    skills: &[SkillRecord],
    discovery_fingerprint: Option<&str>,
) -> (Value, SkillWatcherSnapshot) {
    let state = build_skill_runtime_state(skills, "default", None, &[]);
    let watcher = build_skill_watcher_snapshot_with_discovery(
        &state.catalog,
        discovery_fingerprint.unwrap_or_default(),
    );
    (
        json!(skills
            .iter()
            .zip(state.catalog.iter())
            .map(|(record, skill)| {
                json!({
                    "name": skill.name,
                    "description": skill.description,
                    "location": skill.location,
                    "body": record.body,
                    "sourceScope": skill.source_scope,
                    "isBuiltin": skill.is_builtin,
                    "disabled": skill.disabled,
                    "metadata": skill.metadata,
                    "watchFingerprint": skill.fingerprint,
                    "catalogFingerprint": watcher.fingerprint,
                    "discoveryFingerprint": watcher.discovery_fingerprint,
                })
            })
            .collect::<Vec<_>>()),
        watcher,
    )
}

pub fn build_user_skill_record(name: &str) -> SkillRecord {
    SkillRecord {
        name: name.to_string(),
        description: format!("{name} skill"),
        location: format!("redbox://skills/{}", slug_from_relative_path(name)),
        body: format!(
            "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nhookMode: inline\nautoActivate: false\ncontextNote: \n---\n# {name}\n\nDescribe this skill's runtime rules, prompt patches, and execution contract here."
        ),
        source_scope: Some("user".to_string()),
        is_builtin: Some(false),
        disabled: Some(false),
    }
}

pub fn build_market_skill_record(slug: &str) -> SkillRecord {
    SkillRecord {
        name: slug.to_string(),
        description: format!("Installed from market: {slug}"),
        location: format!("redbox://skills/market/{slug}"),
        body: format!(
            "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nhookMode: forked\nautoActivate: false\ncontextNote: Installed from market.\n---\n# {slug}\n\nThis skill was registered from the RedBox market installer.\n\nReplace this body with the upstream skill contract or add runtime modifiers here."
        ),
        source_scope: Some("user".to_string()),
        is_builtin: Some(false),
        disabled: Some(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skills() -> Vec<SkillRecord> {
        vec![
            SkillRecord {
                name: "redclaw-project".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/redclaw-project".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [redbox_app_query, redbox_fs]\nautoActivate: true\nhookMode: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "cover-builder".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/cover-builder".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [redbox_mcp]\nautoActivate: false\nhookMode: forked\n---\n# Cover\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
        ]
    }

    #[test]
    fn build_skill_runtime_state_auto_activates_and_restricts_tools() {
        let state = build_skill_runtime_state(
            &skills(),
            "redclaw",
            None,
            &[
                "redbox_app_query".to_string(),
                "redbox_fs".to_string(),
                "redbox_mcp".to_string(),
            ],
        );
        assert_eq!(state.active_skills.len(), 1);
        assert_eq!(
            state.allowed_tools,
            vec!["redbox_app_query".to_string(), "redbox_fs".to_string()]
        );
    }

    #[test]
    fn build_skill_runtime_state_respects_explicit_requested_skill_names() {
        let state = build_skill_runtime_state(
            &skills(),
            "redclaw",
            Some(&json!({ "activeSkills": ["cover-builder"] })),
            &[
                "redbox_app_query".to_string(),
                "redbox_fs".to_string(),
                "redbox_mcp".to_string(),
            ],
        );
        assert_eq!(state.active_skills.len(), 2);
        assert_eq!(state.allowed_tools, Vec::<String>::new());
        assert!(state.skills_section.contains("cover-builder [forked]"));
    }
}
