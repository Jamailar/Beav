use serde_json::{Value, json};
use std::path::Path;

use crate::runtime::SkillRecord;
use crate::skills::{
    LoadedSkillRecord, SkillWatcherSnapshot, apply_skill_tool_permissions, build_skill_hook_output,
    build_skill_watcher_snapshot_with_discovery, load_skill_bundle_sections_from_sources,
    load_skill_catalog, normalized_activation_scope, skill_allows_runtime_mode, split_skill_body,
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
        let session_scoped =
            normalized_activation_scope(skill.metadata.activation_scope.as_deref()) == "session";
        if (requested_match && session_scoped) || skill.metadata.auto_activate {
            active.push(skill.clone());
        }
    }
    active
}

fn compatible_catalog(catalog: &[LoadedSkillRecord], runtime_mode: &str) -> Vec<LoadedSkillRecord> {
    catalog
        .iter()
        .filter(|skill| skill_allows_runtime_mode(skill, runtime_mode))
        .cloned()
        .collect()
}

fn build_skill_catalog_prompt_section(
    catalog: &[LoadedSkillRecord],
    runtime_mode: &str,
    can_invoke_skill: bool,
) -> String {
    let available = compatible_catalog(catalog, runtime_mode);
    if available.is_empty() {
        return "No specialized skills are currently available in this runtime.".to_string();
    }

    let list = available
        .iter()
        .map(|skill| {
            let mut item = format!("- {}: {}", skill.name, skill.description);
            if skill.metadata.auto_activate {
                item.push_str(" [auto]");
            }
            item
        })
        .collect::<Vec<_>>()
        .join("\n");
    let available_names = available
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

    if can_invoke_skill {
        let mut sections = vec![
            "You have access to specialized skills in this runtime.".to_string(),
            "Keep full skill bodies out of context until they are actually needed.".to_string(),
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

fn format_optional_list(label: &str, values: &[String]) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    Some(format!("<{}>{}</{}>", label, values.join(", "), label))
}

pub fn find_catalog_skill_by_name(skills: &[SkillRecord], name: &str) -> Option<LoadedSkillRecord> {
    let lookup = name.trim();
    if lookup.is_empty() {
        return None;
    }
    load_skill_catalog(skills)
        .into_iter()
        .find(|skill| skill.name.eq_ignore_ascii_case(lookup))
}

pub fn render_invoked_skill_bundle(
    skill: &LoadedSkillRecord,
    workspace_root: Option<&Path>,
) -> String {
    let bundle = load_skill_bundle_sections_from_sources(&skill.name, workspace_root);
    let source_body = if bundle.body.trim().is_empty() {
        skill.body.as_str()
    } else {
        bundle.body.as_str()
    };
    let (_, instructions) = split_skill_body(source_body);
    let rules = bundle
        .rules
        .iter()
        .filter_map(|(name, body)| {
            let (_, content) = split_skill_body(body);
            if content.trim().is_empty() {
                None
            } else {
                Some(format!("## {name}\n{content}"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let metadata_lines = [
        Some(format!("<name>{}</name>", skill.name)),
        Some(format!("<description>{}</description>", skill.description)),
        skill
            .metadata
            .hook_mode
            .as_ref()
            .map(|value| format!("<hook_mode>{value}</hook_mode>")),
        Some(format!(
            "<activation_scope>{}</activation_scope>",
            normalized_activation_scope(skill.metadata.activation_scope.as_deref())
        )),
        skill
            .source_scope
            .as_ref()
            .map(|value| format!("<source_scope>{value}</source_scope>")),
        Some(format!("<is_builtin>{}</is_builtin>", skill.is_builtin)),
        Some(format!("<disabled>{}</disabled>", skill.disabled)),
        format_optional_list(
            "allowed_runtime_modes",
            &skill.metadata.allowed_runtime_modes,
        ),
        skill
            .metadata
            .allowed_tool_pack
            .as_ref()
            .map(|value| format!("<allowed_tool_pack>{value}</allowed_tool_pack>")),
        format_optional_list("allowed_tools", &skill.metadata.allowed_tools),
        format_optional_list("blocked_tools", &skill.metadata.blocked_tools),
        skill
            .metadata
            .context_note
            .as_ref()
            .map(|value| format!("<context_note>{value}</context_note>")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");

    let mut parts = vec![
        format!("<activated_skill name=\"{}\">", skill.name),
        "<metadata>".to_string(),
        metadata_lines,
        "</metadata>".to_string(),
        "<instructions>".to_string(),
        instructions,
        "</instructions>".to_string(),
    ];

    if !bundle.references.trim().is_empty() {
        parts.push("<references>".to_string());
        parts.push(bundle.references.trim().to_string());
        parts.push("</references>".to_string());
    }
    if !bundle.scripts.trim().is_empty() {
        parts.push("<scripts>".to_string());
        parts.push(bundle.scripts.trim().to_string());
        parts.push("</scripts>".to_string());
    }
    if !rules.trim().is_empty() {
        parts.push("<rules>".to_string());
        parts.push(rules);
        parts.push("</rules>".to_string());
    }
    parts.push("</activated_skill>".to_string());
    parts.join("\n")
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
    let can_invoke_skill = base_tools
        .iter()
        .any(|item| item == "redbox_skill" || item == "app_cli");
    let catalog_section =
        build_skill_catalog_prompt_section(&catalog, runtime_mode, can_invoke_skill);
    SkillRuntimeState {
        catalog,
        active_skills,
        allowed_tools,
        prompt_prefix: hooks.prompt_prefix,
        prompt_suffix: hooks.prompt_suffix,
        context_note: hooks.context_note,
        skills_section: combine_skills_section(&catalog_section, &hooks.skills_section),
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
        json!(
            skills
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
                .collect::<Vec<_>>()
        ),
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
        assert!(
            state
                .skills_section
                .contains("call `app_cli(command=\"skills invoke --name skill-name\")`")
        );
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
        assert!(
            !state
                .skills_section
                .contains("remotion-best-practices: desc")
        );
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
        assert!(
            !state
                .skills_section
                .contains("call `app_cli(command=\"skills invoke --name skill-name\")`")
        );
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
        assert!(
            state
                .skills_section
                .contains("image-prompt-optimizer: image desc")
        );
        assert!(
            state
                .skills_section
                .contains("Before any `app_cli(command=\"image generate ...\")`")
        );
        assert!(
            state
                .skills_section
                .contains("call `app_cli(command=\"skills invoke --name skill-name\")`")
        );

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
        assert!(
            redclaw_state
                .skills_section
                .contains("image-prompt-optimizer: image desc")
        );
        assert!(
            redclaw_state
                .skills_section
                .contains("Before any `app_cli(command=\"image generate ...\")`")
        );
    }
}
