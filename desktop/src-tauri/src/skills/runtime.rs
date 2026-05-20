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
            .filter(|(_, skill)| !skill.metadata.hidden)
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
        location: format!("skills://{}", slug_from_relative_path(name)),
        body: format!(
            "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nhookMode: inline\nautoActivate: false\nactivationScope: turn\ncontextNote: \n---\n# {name}\n\nDescribe this skill's runtime rules, prompt patches, and execution contract here."
        ),
        source_scope: Some("user".to_string()),
        is_builtin: Some(false),
        disabled: Some(false),
    }
}

pub fn build_market_skill_record(slug: &str) -> SkillRecord {
    SkillRecord {
        name: slug.to_string(),
        description: format!("Market placeholder skill: {slug}"),
        location: format!("skills://market/{slug}"),
        body: format!(
            "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nhookMode: forked\nautoActivate: false\nactivationScope: turn\ncontextNote: Registered as a market placeholder. This does not provision CLI tools or external runtimes.\n---\n# {slug}\n\nThis skill entry was registered from the market installer as a placeholder only.\n\nIt does not install upstream toolchains, npm packages, binaries, or other external runtimes.\nUse the CLI runtime control plane to provision required tools, then replace this body with the upstream skill contract or runtime modifiers."
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
                location: "skills://redclaw-guide".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [bash, workflow]\nautoActivate: true\nhookMode: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "xhs-title".to_string(),
                description: "desc".to_string(),
                location: "skills://xhs-title".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [workflow]\nautoActivate: false\nactivationScope: session\nhookMode: forked\n---\n# Title\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
        ]
    }

    #[test]
    fn build_skill_runtime_state_keeps_skills_inactive_without_request() {
        let state = build_skill_runtime_state(
            &skills(),
            "redclaw",
            None,
            &["bash".to_string(), "workflow".to_string()],
        );
        assert!(state.active_skills.is_empty());
        assert_eq!(
            state.allowed_tools,
            vec!["bash".to_string(), "workflow".to_string()]
        );
    }

    #[test]
    fn build_skill_runtime_state_respects_explicit_requested_skill_names() {
        let state = build_skill_runtime_state(
            &skills(),
            "redclaw",
            Some(&json!({ "activeSkills": ["xhs-title"] })),
            &[
                "query".to_string(),
                "resource".to_string(),
                "mcp".to_string(),
                "skill".to_string(),
            ],
        );
        assert_eq!(state.active_skills.len(), 1);
        assert_eq!(state.allowed_tools, vec!["workflow".to_string()]);
        assert!(state.skills_section.contains(
            "call `Operate(resource=\"skills\", operation=\"invoke\", input={ \"name\": \"skill-name\" })`"
        ));
        assert!(state.skills_section.contains("xhs-title [forked]"));
    }

    #[test]
    fn build_skill_runtime_state_keeps_video_skill_inactive_until_requested() {
        let video_state = build_skill_runtime_state(
            &skills(),
            "video-editor",
            None,
            &[
                "editor".to_string(),
                "resource".to_string(),
                "skill".to_string(),
            ],
        );
        assert!(video_state.active_skills.is_empty());

        let default_state = build_skill_runtime_state(
            &skills(),
            "default",
            None,
            &[
                "editor".to_string(),
                "resource".to_string(),
                "skill".to_string(),
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
                "query".to_string(),
                "resource".to_string(),
                "mcp".to_string(),
            ],
        );
        assert!(state.skills_section.contains("redclaw-guide: desc"));
        assert!(state.skills_section.contains("xhs-title: desc"));
        assert!(!state.skills_section.contains("video-editor"));
    }

    #[test]
    fn build_skill_runtime_state_avoids_manual_invoke_copy_when_skill_tool_is_unavailable() {
        let state = build_skill_runtime_state(
            &[SkillRecord {
                name: "writing-style".to_string(),
                description: "desc".to_string(),
                location: "skills://writing-style".to_string(),
                body: "---\nallowedRuntimeModes: [wander]\nautoActivate: true\nhookMode: inline\n---\n# Writing Style\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "wander",
            None,
            &["resource".to_string()],
        );
        assert!(!state.skills_section.contains(
            "call `Operate(resource=\"skills\", operation=\"invoke\", input={ \"name\": \"skill-name\" })`"
        ));
        assert!(state.skills_section.contains("- writing-style: desc"));
    }

    #[test]
    fn build_skill_runtime_state_ignores_turn_scoped_session_skill_persistence() {
        let state = build_skill_runtime_state(
            &[SkillRecord {
                name: "writing-style".to_string(),
                description: "desc".to_string(),
                location: "skills://writing-style".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nautoActivate: false\nactivationScope: turn\nhookMode: forked\n---\n# Writing Style\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "redclaw",
            Some(&json!({ "activeSkills": ["writing-style"] })),
            &["resource".to_string()],
        );
        assert!(state.active_skills.is_empty());
        assert!(!state.skills_section.contains("writing-style [forked]"));
    }

    #[test]
    fn build_skill_runtime_state_lists_multi_image_director_in_image_generation_catalog() {
        let state = build_skill_runtime_state(
            &[SkillRecord {
                name: "image-director".to_string(),
                description: "image desc".to_string(),
                location: "skills://image-director".to_string(),
                body: "---\nallowedRuntimeModes: [team, redclaw, image-generation]\nautoActivate: false\nactivationScope: session\nhookMode: inline\n---\n# Image Director\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "image-generation",
            None,
            &["workflow".to_string()],
        );
        assert!(state.active_skills.is_empty());
        assert!(state.skills_section.contains("image-director: image desc"));
        assert!(state.skills_section.contains(
            "call `Operate(resource=\"skills\", operation=\"invoke\", input={ \"name\": \"skill-name\" })`"
        ));

        let redclaw_state = build_skill_runtime_state(
            &[SkillRecord {
                name: "image-director".to_string(),
                description: "image desc".to_string(),
                location: "skills://image-director".to_string(),
                body: "---\nallowedRuntimeModes: [team, redclaw, image-generation]\nautoActivate: false\nactivationScope: session\nhookMode: inline\n---\n# Image Director\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            }],
            "redclaw",
            None,
            &["workflow".to_string()],
        );
        assert!(redclaw_state.active_skills.is_empty());
        assert!(redclaw_state
            .skills_section
            .contains("image-director: image desc"));
    }

    #[test]
    fn build_skill_runtime_state_lists_tts_director_in_generation_audio_modes() {
        let skill = SkillRecord {
            name: "tts-director".to_string(),
            description: "tts desc".to_string(),
            location: "skills://tts-director".to_string(),
            body: "---\nallowedRuntimeModes: [chatroom, redclaw, image-generation, audio-editor]\nautoActivate: false\nactivationScope: turn\nhookMode: inline\n---\n# TTS Director\n\nBody".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        };

        let generation_state = build_skill_runtime_state(
            &[skill.clone()],
            "image-generation",
            None,
            &["workflow".to_string()],
        );
        assert!(generation_state
            .skills_section
            .contains("tts-director: tts desc"));

        let audio_editor_state =
            build_skill_runtime_state(&[skill], "audio-editor", None, &["workflow".to_string()]);
        assert!(audio_editor_state
            .skills_section
            .contains("tts-director: tts desc"));
    }
}
