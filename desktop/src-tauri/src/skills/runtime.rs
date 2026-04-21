use serde_json::{json, Value};

use crate::runtime::SkillRecord;
use crate::skills::{
    build_skill_catalog_snapshot, build_skill_prompt_bundle,
    build_skill_watcher_snapshot_with_discovery, find_skill_catalog_entry_by_name,
    resolve_skill_set, LoadedSkillRecord, SkillWatcherSnapshot,
};
use crate::slug_from_relative_path;
use crate::tools::packs::tool_names_for_runtime_mode;

#[derive(Debug, Clone, Default)]
pub struct SkillRuntimeState {
    pub catalog: Vec<LoadedSkillRecord>,
    pub active_skills: Vec<LoadedSkillRecord>,
    pub allowed_tools: Vec<String>,
    #[allow(dead_code)]
    pub prompt_prefix: String,
    #[allow(dead_code)]
    pub prompt_suffix: String,
    #[allow(dead_code)]
    pub context_note: String,
    #[allow(dead_code)]
    pub skills_section: String,
}

pub fn find_catalog_skill_by_name(skills: &[SkillRecord], name: &str) -> Option<LoadedSkillRecord> {
    let snapshot = build_skill_catalog_snapshot(skills);
    find_skill_catalog_entry_by_name(&snapshot, name)
}

pub fn build_skill_runtime_state(
    skills: &[SkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
    base_tools: &[String],
) -> SkillRuntimeState {
    let resolved = resolve_skill_set(skills, runtime_mode, metadata, base_tools);
    let prompt_bundle = build_skill_prompt_bundle(&resolved);
    SkillRuntimeState {
        catalog: resolved.catalog,
        active_skills: resolved.active_skills,
        allowed_tools: resolved.allowed_tools,
        prompt_prefix: prompt_bundle.prompt_prefix,
        prompt_suffix: prompt_bundle.prompt_suffix,
        context_note: prompt_bundle.context_note,
        skills_section: prompt_bundle.skills_section,
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
    include_body: bool,
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
                let mut item = json!({
                    "name": skill.name,
                    "description": skill.description,
                    "location": skill.location,
                    "sourceScope": skill.source_scope,
                    "isBuiltin": skill.is_builtin,
                    "disabled": skill.disabled,
                    "metadata": skill.metadata,
                    "watchFingerprint": skill.fingerprint,
                    "catalogFingerprint": watcher.fingerprint,
                    "discoveryFingerprint": watcher.discovery_fingerprint,
                });
                if include_body {
                    item["body"] = json!(record.body);
                }
                item
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
            "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nhookMode: inline\nautoActivate: false\nactivationScope: session\ncontextNote: \n---\n# {name}\n\nDescribe this skill's runtime rules, prompt patches, and execution contract here."
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
            "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nhookMode: forked\nautoActivate: false\nactivationScope: session\ncontextNote: Installed from market.\n---\n# {slug}\n\nThis skill was registered from the RedBox market installer.\n\nReplace this body with the upstream skill contract or add runtime modifiers here."
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
                name: "redclaw-guide".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/redclaw-guide".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [bash, app_cli]\nautoActivate: true\nhookMode: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "cover-builder".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/cover-builder".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [app_cli]\nautoActivate: false\nhookMode: forked\n---\n# Cover\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "remotion-best-practices".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/remotion-best-practices".to_string(),
                body: "---\nallowedRuntimeModes: [video-editor]\nallowedTools: [bash, app_cli, redbox_editor]\nautoActivate: true\nhookMode: inline\n---\n# Remotion\n\nBody".to_string(),
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
            &["bash".to_string(), "app_cli".to_string()],
        );
        assert_eq!(state.active_skills.len(), 1);
        assert_eq!(
            state.allowed_tools,
            vec!["bash".to_string(), "app_cli".to_string()]
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
                "redbox_skill".to_string(),
            ],
        );
        assert_eq!(state.active_skills.len(), 2);
        assert_eq!(state.allowed_tools, vec!["app_cli".to_string()]);
        assert!(state
            .skills_section
            .contains("call `app_cli(command=\"skills invoke --name skill-name\")`"));
        assert!(state.skills_section.contains("cover-builder [forked]"));
    }

    #[test]
    fn build_skill_runtime_state_auto_activates_video_editor_remotion_skill_only_in_video_mode() {
        let video_state = build_skill_runtime_state(
            &skills(),
            "video-editor",
            None,
            &[
                "redbox_editor".to_string(),
                "redbox_fs".to_string(),
                "redbox_skill".to_string(),
            ],
        );
        assert_eq!(video_state.active_skills.len(), 1);
        assert_eq!(
            video_state.active_skills[0].name,
            "remotion-best-practices".to_string()
        );

        let default_state = build_skill_runtime_state(
            &skills(),
            "default",
            None,
            &[
                "redbox_editor".to_string(),
                "redbox_fs".to_string(),
                "redbox_skill".to_string(),
            ],
        );
        assert!(default_state.active_skills.is_empty());
    }

    #[test]
    fn skills_catalog_list_value_can_omit_large_bodies() {
        let (list, _) = skills_catalog_list_value(&skills(), None, false);
        let items = list.as_array().expect("skills list should be an array");
        assert_eq!(items.len(), 3);
        assert!(items.iter().all(|item| item.get("body").is_none()));
    }

    #[test]
    fn build_skill_runtime_state_includes_catalog_for_matching_runtime_mode() {
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
        assert!(state.skills_section.contains("redclaw-guide: desc"));
        assert!(state.skills_section.contains("cover-builder: desc"));
        assert!(!state
            .skills_section
            .contains("remotion-best-practices: desc"));
    }

    #[test]
    fn build_skill_runtime_state_avoids_manual_invoke_copy_when_skill_tool_is_unavailable() {
        let state = build_skill_runtime_state(
            &[SkillRecord {
                name: "writing-style".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/writing-style".to_string(),
                body: "---\nallowedRuntimeModes: [wander]\nautoActivate: true\nhookMode: inline\n---\n# Writing Style\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "wander",
            None,
            &["redbox_fs".to_string()],
        );
        assert!(!state
            .skills_section
            .contains("call `app_cli(command=\"skills invoke --name skill-name\")`"));
        assert!(state.skills_section.contains("writing-style [inline]"));
    }

    #[test]
    fn build_skill_runtime_state_ignores_turn_scoped_session_skill_persistence() {
        let state = build_skill_runtime_state(
            &[SkillRecord {
                name: "writing-style".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/writing-style".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nautoActivate: false\nactivationScope: turn\nhookMode: forked\n---\n# Writing Style\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "redclaw",
            Some(&json!({ "activeSkills": ["writing-style"] })),
            &["redbox_fs".to_string()],
        );
        assert!(state.active_skills.is_empty());
        assert!(!state.skills_section.contains("writing-style [forked]"));
    }

    #[test]
    fn build_skill_runtime_state_lists_turn_scoped_image_skill_in_chatroom_and_redclaw_catalog() {
        let state = build_skill_runtime_state(
            &[SkillRecord {
                name: "image-prompt-optimizer".to_string(),
                description: "image desc".to_string(),
                location: "redbox://skills/image-prompt-optimizer".to_string(),
                body: "---\nallowedRuntimeModes: [chatroom, redclaw, image-generation]\nautoActivate: false\nactivationScope: turn\nhookMode: inline\n---\n# Image Prompt Optimizer\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "chatroom",
            None,
            &["app_cli".to_string()],
        );
        assert!(state.active_skills.is_empty());
        assert!(state
            .skills_section
            .contains("image-prompt-optimizer: image desc"));
        assert!(state
            .skills_section
            .contains("Before any `app_cli(command=\"image generate ...\")`"));
        assert!(state
            .skills_section
            .contains("call `app_cli(command=\"skills invoke --name skill-name\")`"));

        let redclaw_state = build_skill_runtime_state(
            &[SkillRecord {
                name: "image-prompt-optimizer".to_string(),
                description: "image desc".to_string(),
                location: "redbox://skills/image-prompt-optimizer".to_string(),
                body: "---\nallowedRuntimeModes: [chatroom, redclaw, image-generation]\nautoActivate: false\nactivationScope: turn\nhookMode: inline\n---\n# Image Prompt Optimizer\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "redclaw",
            None,
            &["app_cli".to_string()],
        );
        assert!(redclaw_state.active_skills.is_empty());
        assert!(redclaw_state
            .skills_section
            .contains("image-prompt-optimizer: image desc"));
        assert!(redclaw_state
            .skills_section
            .contains("Before any `app_cli(command=\"image generate ...\")`"));
    }
}
