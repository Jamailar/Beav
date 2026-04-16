use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use glob::Pattern;
use serde_json::{json, Value};

use crate::runtime::SkillRecord;
use crate::skills::{
    apply_skill_tool_permissions, build_skill_hook_output, build_skill_matcher_hooks_for_event,
    build_skill_watcher_snapshot_with_discovery, load_skill_bundle_sections_for_record,
    load_skill_catalog, resolve_skill_records, skill_allows_runtime_mode, LoadedSkillRecord,
    SkillHookMatcherRecord, SkillWatcherSnapshot,
};
use crate::tools::packs::tool_names_for_runtime_mode;

#[derive(Debug, Clone, Default)]
pub struct SkillRuntimeState {
    pub catalog: Vec<LoadedSkillRecord>,
    pub active_skills: Vec<LoadedSkillRecord>,
    pub allowed_tools: Vec<String>,
    pub available_skills_section: String,
    pub prompt_prefix: String,
    pub prompt_suffix: String,
    pub context_note: String,
    pub skills_section: String,
    pub model_override: Option<String>,
    pub effort_override: Option<String>,
    pub active_hooks: BTreeMap<String, Vec<SkillHookMatcherRecord>>,
}

#[derive(Debug, Clone, Default)]
pub struct SkillActivationContext {
    pub current_message: Option<String>,
    pub intent: Option<String>,
    pub touched_paths: Vec<String>,
    pub args: Option<String>,
}

fn normalized_value(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn metadata_string(metadata: Option<&Value>, field: &str) -> Option<String> {
    metadata
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
        .map(normalized_value)
        .filter(|value| !value.is_empty())
}

fn metadata_string_list(metadata: Option<&Value>, field: &str) -> Vec<String> {
    let mut items = Vec::<String>::new();
    if let Some(single) = metadata
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
    {
        let normalized = single.trim();
        if !normalized.is_empty() {
            items.push(normalized.to_string());
        }
    }
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
    let mut seen = BTreeSet::<String>::new();
    items
        .into_iter()
        .filter(|item| seen.insert(item.to_ascii_lowercase()))
        .collect()
}

fn current_activation_intent(
    metadata: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Option<String> {
    activation
        .and_then(|item| item.intent.as_deref())
        .map(normalized_value)
        .filter(|value| !value.is_empty())
        .or_else(|| metadata_string(metadata, "intent"))
}

fn current_activation_context_type(metadata: Option<&Value>) -> Option<String> {
    metadata_string(metadata, "contextType")
}

fn candidate_paths(metadata: Option<&Value>, activation: Option<&SkillActivationContext>) -> Vec<String> {
    let mut items = Vec::<String>::new();
    for field in [
        "associatedFilePath",
        "sourceManuscriptPath",
        "filePath",
        "path",
        "projectPath",
    ] {
        items.extend(metadata_string_list(metadata, field));
    }
    if let Some(activation) = activation {
        items.extend(
            activation
                .touched_paths
                .iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty()),
        );
    }
    let mut seen = BTreeSet::<String>::new();
    items
        .into_iter()
        .map(|item| item.replace('\\', "/"))
        .filter(|item| seen.insert(item.to_ascii_lowercase()))
        .collect()
}

fn is_manuscript_context(metadata: Option<&Value>, activation: Option<&SkillActivationContext>) -> bool {
    if matches!(
        current_activation_context_type(metadata).as_deref(),
        Some("manuscript") | Some("manuscripts")
    ) {
        return true;
    }
    candidate_paths(metadata, activation)
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .any(|value| value.contains("/manuscripts/") || value.ends_with(".md"))
}

fn looks_like_manuscript_request(message: Option<&str>) -> bool {
    let normalized = message
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if normalized.is_empty() {
        return false;
    }
    [
        "写一篇",
        "写个",
        "写篇",
        "改写",
        "扩写",
        "润色",
        "仿写",
        "续写",
        "重写",
        "文案",
        "文章",
        "稿子",
        "成稿",
        "提纲",
        "小红书",
        "rewrite",
        "polish",
        "draft",
        "article",
        "essay",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn activation_request_text(activation: Option<&SkillActivationContext>) -> Option<String> {
    let mut parts = Vec::<String>::new();
    if let Some(message) = activation
        .and_then(|item| item.current_message.as_deref())
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        parts.push(message.to_string());
    }
    if let Some(args) = activation
        .and_then(|item| item.args.as_deref())
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        parts.push(args.to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn path_matches_pattern(candidate: &str, pattern: &str) -> bool {
    let normalized_candidate = candidate.replace('\\', "/");
    let normalized_pattern = pattern.trim().replace('\\', "/");
    if normalized_pattern.is_empty() {
        return false;
    }
    let compiled = Pattern::new(&normalized_pattern);
    if compiled
        .as_ref()
        .map(|compiled| compiled.matches(&normalized_candidate))
        .unwrap_or_else(|_| normalized_candidate.contains(normalized_pattern.trim_matches('*')))
    {
        return true;
    }
    if let Ok(compiled) = compiled {
        let segments = normalized_candidate
            .split('/')
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        for index in 0..segments.len() {
            let suffix = segments[index..].join("/");
            if compiled.matches(&suffix) {
                return true;
            }
        }
    }
    Path::new(&normalized_candidate)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| {
            Pattern::new(&normalized_pattern)
                .map(|compiled| compiled.matches(value))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn matches_path_conditions(
    skill: &LoadedSkillRecord,
    metadata: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> bool {
    if skill.metadata.paths.is_empty() {
        return true;
    }
    let candidates = candidate_paths(metadata, activation);
    if candidates.is_empty() {
        return false;
    }
    candidates.iter().any(|candidate| {
        skill.metadata
            .paths
            .iter()
            .any(|pattern| path_matches_pattern(candidate, pattern))
    })
}

fn skill_matches_auto_activation(
    skill: &LoadedSkillRecord,
    metadata: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> bool {
    if !skill.metadata.auto_activate {
        return false;
    }
    let requested_intents = skill
        .metadata
        .auto_activate_when_intents
        .iter()
        .map(|item| normalized_value(item))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    let requested_context_types = skill
        .metadata
        .auto_activate_when_context_types
        .iter()
        .map(|item| normalized_value(item))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();

    let matches_intent = if requested_intents.is_empty() {
        true
    } else {
        let current_intent = current_activation_intent(metadata, activation);
        requested_intents
            .iter()
            .any(|item| current_intent.as_deref() == Some(item.as_str()))
            || (requested_intents.iter().any(|item| item == "manuscript_creation")
                && (is_manuscript_context(metadata, activation)
                    || looks_like_manuscript_request(
                        activation_request_text(activation).as_deref(),
                    )))
    };
    let matches_context_type = if requested_context_types.is_empty() {
        true
    } else {
        let current_context_type = current_activation_context_type(metadata);
        requested_context_types
            .iter()
            .any(|item| current_context_type.as_deref() == Some(item.as_str()))
    };
    matches_intent && matches_context_type && matches_path_conditions(skill, metadata, activation)
}

fn requested_skill_names(metadata: Option<&Value>) -> Vec<String> {
    let mut items = Vec::new();
    for field in ["activeSkills", "skillNames", "skills"] {
        items.extend(metadata_string_list(metadata, field));
    }
    let mut seen = BTreeSet::<String>::new();
    items
        .into_iter()
        .filter(|item| seen.insert(item.to_ascii_lowercase()))
        .collect()
}

fn resolve_active_skills(
    catalog: &[LoadedSkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Vec<LoadedSkillRecord> {
    let requested = requested_skill_names(metadata);
    let mut active = Vec::new();
    for skill in catalog {
        if !skill_allows_runtime_mode(skill, runtime_mode) {
            continue;
        }
        let requested_match = requested
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&skill.name))
            || skill
                .metadata
                .aliases
                .iter()
                .any(|alias| requested.iter().any(|item| item.eq_ignore_ascii_case(alias)));
        let path_match = matches_path_conditions(skill, metadata, activation);
        if requested_match {
            if path_match || skill.metadata.paths.is_empty() {
                active.push(skill.clone());
            }
            continue;
        }
        if skill_matches_auto_activation(skill, metadata, activation) {
            active.push(skill.clone());
        }
    }
    active
}

fn merge_hook_map(
    target: &mut BTreeMap<String, Vec<SkillHookMatcherRecord>>,
    source: &BTreeMap<String, Vec<SkillHookMatcherRecord>>,
) {
    for (event, items) in source {
        target
            .entry(event.clone())
            .or_default()
            .extend(items.iter().cloned());
    }
}

fn activation_mode_label(skill: &LoadedSkillRecord) -> &str {
    skill.metadata
        .execution_context
        .as_deref()
        .or(skill.metadata.hook_mode.as_deref())
        .unwrap_or("inline")
}

fn build_skills_section(active_skills: &[LoadedSkillRecord]) -> String {
    let mut parts = Vec::<String>::new();
    for skill in active_skills {
        let bundle = load_skill_bundle_sections_for_record(skill, None);
        let (_, main_body) = crate::skills::split_skill_body(&bundle.body);
        let mut section_body = String::new();
        if !main_body.trim().is_empty() {
            section_body.push_str(main_body.trim());
        }
        if !bundle.references.trim().is_empty() {
            if !section_body.is_empty() {
                section_body.push_str("\n\n");
            }
            section_body.push_str("[references]\n");
            section_body.push_str(bundle.references.trim());
        }
        if !bundle.rules.is_empty() {
            if !section_body.is_empty() {
                section_body.push_str("\n\n");
            }
            section_body.push_str("[rules]\n");
            for (name, content) in &bundle.rules {
                section_body.push_str(&format!("## {name}\n{}\n", content.trim()));
            }
        }
        if !bundle.scripts.trim().is_empty() {
            if !section_body.is_empty() {
                section_body.push_str("\n\n");
            }
            section_body.push_str("[scripts]\n");
            section_body.push_str(bundle.scripts.trim());
        }
        let truncated = section_body
            .chars()
            .take(skill.metadata.max_prompt_chars.unwrap_or(3200))
            .collect::<String>();
        if truncated.trim().is_empty() {
            continue;
        }
        parts.push(format!(
            "### {} [{}]\n{}",
            skill.name,
            activation_mode_label(skill),
            truncated.trim()
        ));
    }
    parts.join("\n\n")
}

fn build_available_skills_section(
    catalog: &[LoadedSkillRecord],
    runtime_mode: &str,
) -> String {
    catalog
        .iter()
        .filter(|skill| skill_allows_runtime_mode(skill, runtime_mode))
        .filter(|skill| !skill.metadata.disable_model_invocation)
        .map(|skill| {
            let mut parts = vec![skill.description.trim().to_string()];
            if let Some(when_to_use) = skill
                .metadata
                .when_to_use
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("when: {when_to_use}"));
            }
            if !skill.metadata.aliases.is_empty() {
                parts.push(format!("aliases: {}", skill.metadata.aliases.join(", ")));
            }
            if let Some(argument_hint) = skill
                .metadata
                .argument_hint
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("args: {argument_hint}"));
            } else if !skill.metadata.argument_names.is_empty() {
                parts.push(format!("args: {}", skill.metadata.argument_names.join(", ")));
            }
            if let Some(context) = skill
                .metadata
                .execution_context
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("context: {context}"));
            }
            format!("- {}: {}", skill.name, parts.join(" | "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn skill_runtime_state_from_catalog(
    catalog: Vec<LoadedSkillRecord>,
    runtime_mode: &str,
    metadata: Option<&Value>,
    base_tools: &[String],
    activation: Option<&SkillActivationContext>,
) -> SkillRuntimeState {
    let active_skills = resolve_active_skills(&catalog, runtime_mode, metadata, activation);
    let allowed_tools = apply_skill_tool_permissions(base_tools, &active_skills);
    let hooks = build_skill_hook_output(&active_skills);
    let mut active_hooks = BTreeMap::<String, Vec<SkillHookMatcherRecord>>::new();
    for skill in &active_skills {
        merge_hook_map(&mut active_hooks, &skill.metadata.hooks);
    }
    SkillRuntimeState {
        model_override: active_skills
            .iter()
            .rev()
            .find_map(|skill| skill.metadata.model.clone()),
        effort_override: active_skills
            .iter()
            .rev()
            .find_map(|skill| skill.metadata.effort.clone()),
        available_skills_section: build_available_skills_section(&catalog, runtime_mode),
        skills_section: build_skills_section(&active_skills),
        catalog,
        active_skills,
        allowed_tools,
        prompt_prefix: hooks.prompt_prefix,
        prompt_suffix: hooks.prompt_suffix,
        context_note: hooks.context_note,
        active_hooks,
    }
}

pub fn build_skill_runtime_state(
    skills: &[SkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
    base_tools: &[String],
    activation: Option<&SkillActivationContext>,
) -> SkillRuntimeState {
    let catalog = load_skill_catalog(skills);
    skill_runtime_state_from_catalog(catalog, runtime_mode, metadata, base_tools, activation)
}

pub fn build_resolved_skill_runtime_state(
    skills: &[SkillRecord],
    workspace_root: Option<&Path>,
    runtime_mode: &str,
    metadata: Option<&Value>,
    base_tools: &[String],
    activation: Option<&SkillActivationContext>,
) -> SkillRuntimeState {
    let records = resolve_skill_records(skills, workspace_root);
    let catalog = load_skill_catalog(&records);
    skill_runtime_state_from_catalog(catalog, runtime_mode, metadata, base_tools, activation)
}

pub fn active_skill_activation_items(
    skills: &[SkillRecord],
    runtime_mode: &str,
    metadata: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Vec<(String, String)> {
    let base_tools = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    build_skill_runtime_state(skills, runtime_mode, metadata, &base_tools, activation)
        .active_skills
        .into_iter()
        .map(|item| (item.name, item.description))
        .collect()
}

pub fn skills_catalog_list_value(
    skills: &[SkillRecord],
    discovery_fingerprint: Option<&str>,
) -> (Value, SkillWatcherSnapshot) {
    let state = build_skill_runtime_state(skills, "default", None, &[], None);
    let watcher = build_skill_watcher_snapshot_with_discovery(
        &state.catalog,
        discovery_fingerprint.unwrap_or_default(),
    );
    (
        json!(state
            .catalog
            .iter()
            .map(|skill| {
                json!({
                    "name": skill.name,
                    "description": skill.description,
                    "location": skill.location,
                    "body": skill.body,
                    "baseDir": skill.base_dir,
                    "aliases": skill.metadata.aliases,
                    "sourceScope": skill.source_scope,
                    "isBuiltin": skill.is_builtin,
                    "disabled": skill.disabled,
                    "metadata": skill.metadata,
                    "watchFingerprint": skill.fingerprint,
                    "catalogFingerprint": watcher.fingerprint,
                    "discoveryFingerprint": watcher.discovery_fingerprint,
                    "whenToUse": skill.metadata.when_to_use,
                    "userInvocable": skill.metadata.user_invocable,
                    "version": skill.metadata.version,
                    "argumentHint": skill.metadata.argument_hint,
                    "argumentNames": skill.metadata.argument_names,
                    "executionContext": skill.metadata.execution_context,
                    "modelOverride": skill.metadata.model,
                    "effortOverride": skill.metadata.effort,
                    "paths": skill.metadata.paths,
                })
            })
            .collect::<Vec<_>>()),
        watcher,
    )
}

pub fn build_skill_template_markdown(name: &str, forked: bool, note: &str) -> String {
    let context = if forked { "fork" } else { "inline" };
    format!(
        "---\nallowedRuntimeModes: []\nallowedTools: []\nblockedTools: []\nautoActivate: false\ncontext: {context}\nuserInvocable: true\nwhenToUse: \nargumentHint: \narguments: []\npaths: []\ncontextNote: {note}\n---\n# {name}\n\nDescribe this skill's execution contract, examples, constraints, and any reusable workflow steps here."
    )
}

fn substitute_skill_arguments(body: &str, skill: &LoadedSkillRecord, args: Option<&str>) -> String {
    let args_text = args.unwrap_or("").trim();
    let mut rendered = body
        .replace("$ARGUMENTS", args_text)
        .replace("{{ARGUMENTS}}", args_text);
    let positional = if args_text.contains(',') {
        args_text
            .split(',')
            .map(|item| item.trim().to_string())
            .collect::<Vec<_>>()
    } else {
        args_text
            .split_whitespace()
            .map(|item| item.trim().to_string())
            .collect::<Vec<_>>()
    };
    for (index, name) in skill.metadata.argument_names.iter().enumerate() {
        if let Some(value) = positional.get(index) {
            rendered = rendered.replace(&format!("{{{{{name}}}}}"), value);
            rendered = rendered.replace(&format!("${name}"), value);
        }
    }
    rendered
}

pub fn invoke_skill_value(
    skills: &[SkillRecord],
    workspace_root: Option<&Path>,
    name: &str,
    args: Option<&str>,
) -> Result<Value, String> {
    let resolved = resolve_skill_records(skills, workspace_root);
    let catalog = load_skill_catalog(&resolved);
    let Some(skill) = catalog.iter().find(|item| {
        item.name.eq_ignore_ascii_case(name)
            || item
                .metadata
                .aliases
                .iter()
                .any(|alias| alias.eq_ignore_ascii_case(name))
    }) else {
        return Err(format!("skill not found: {name}"));
    };
    let bundle = load_skill_bundle_sections_for_record(skill, workspace_root);
    let (_, body) = crate::skills::split_skill_body(&bundle.body);
    let rendered_body = substitute_skill_arguments(&body, skill, args);
    let mut invocation = String::new();
    invocation.push_str(&rendered_body);
    if !bundle.references.trim().is_empty() {
        invocation.push_str("\n\n[references]\n");
        invocation.push_str(bundle.references.trim());
    }
    if !bundle.rules.is_empty() {
        invocation.push_str("\n\n[rules]\n");
        for (rule_name, rule_body) in &bundle.rules {
            invocation.push_str(&format!("## {rule_name}\n{}\n", rule_body.trim()));
        }
    }
    if !bundle.scripts.trim().is_empty() {
        invocation.push_str("\n\n[scripts]\n");
        invocation.push_str(bundle.scripts.trim());
    }
    Ok(json!({
        "success": true,
        "skill": {
            "name": skill.name,
            "description": skill.description,
            "location": skill.location,
            "sourceScope": skill.source_scope,
            "isBuiltin": skill.is_builtin,
            "disabled": skill.disabled,
            "metadata": skill.metadata,
        },
        "invocation": {
            "args": args.unwrap_or_default(),
            "renderedPrompt": invocation.trim(),
            "executionContext": skill.metadata.execution_context.clone().unwrap_or_else(|| "inline".to_string()),
            "modelOverride": skill.metadata.model,
            "effortOverride": skill.metadata.effort,
            "agent": skill.metadata.agent,
            "allowedTools": skill.metadata.allowed_tools,
            "paths": skill.metadata.paths,
            "hooks": skill.metadata.hooks,
            "referencesIncluded": !bundle.references.trim().is_empty(),
            "scriptsIncluded": !bundle.scripts.trim().is_empty(),
            "ruleCount": bundle.rules.len(),
        }
    }))
}

pub fn preview_skill_activation_value(
    skills: &[SkillRecord],
    workspace_root: Option<&Path>,
    runtime_mode: &str,
    metadata: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Value {
    let base_tools = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    let state = build_resolved_skill_runtime_state(
        skills,
        workspace_root,
        runtime_mode,
        metadata,
        &base_tools,
        activation,
    );
    json!({
        "success": true,
        "runtimeMode": runtime_mode,
        "availableSkills": state.catalog.iter().filter(|item| skill_allows_runtime_mode(item, runtime_mode)).map(|item| json!({
            "name": item.name,
            "description": item.description,
            "whenToUse": item.metadata.when_to_use,
            "executionContext": item.metadata.execution_context,
            "aliases": item.metadata.aliases,
        })).collect::<Vec<_>>(),
        "activeSkills": state.active_skills.iter().map(|item| json!({
            "name": item.name,
            "description": item.description,
            "executionContext": item.metadata.execution_context,
            "modelOverride": item.metadata.model,
            "effortOverride": item.metadata.effort,
            "paths": item.metadata.paths,
            "whenToUse": item.metadata.when_to_use,
        })).collect::<Vec<_>>(),
        "allowedTools": state.allowed_tools,
        "modelOverride": state.model_override,
        "effortOverride": state.effort_override,
        "activeHookEvents": state.active_hooks.keys().cloned().collect::<Vec<_>>(),
        "activeHookCount": state
            .active_hooks
            .values()
            .map(|items| items.len())
            .sum::<usize>(),
    })
}

pub fn active_hooks_for_event(
    active_skills: &[LoadedSkillRecord],
    event: &str,
    runtime_mode: &str,
    message: &str,
) -> Vec<crate::skills::SkillHookActionRecord> {
    build_skill_matcher_hooks_for_event(active_skills, event, runtime_mode, message)
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
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [redbox_app_query, redbox_fs]\nautoActivate: true\ncontext: inline\n---\n# Skill\n\nBody".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "cover-builder".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/cover-builder".to_string(),
                body: "---\nallowedRuntimeModes: [redclaw]\nallowedTools: [redbox_mcp]\nautoActivate: false\ncontext: fork\narguments: [topic]\n---\n# Cover\n\nUse {{topic}}".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "remotion-best-practices".to_string(),
                description: "desc".to_string(),
                location: "redbox://skills/remotion-best-practices".to_string(),
                body: "---\nallowedRuntimeModes: [video-editor]\nallowedTools: [redbox_editor, redbox_fs, redbox_skill]\nautoActivate: true\ncontext: inline\n---\n# Remotion\n\nBody".to_string(),
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
            None,
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
            None,
        );
        assert_eq!(state.active_skills.len(), 2);
        assert_eq!(state.allowed_tools, Vec::<String>::new());
        assert!(state.skills_section.contains("cover-builder [fork]"));
    }

    #[test]
    fn build_skill_runtime_state_supports_request_scoped_intent_activation() {
        let skills = vec![SkillRecord {
            name: "writing-style".to_string(),
            description: "desc".to_string(),
            location: "redbox://skills/writing-style".to_string(),
            body: "---\nallowedRuntimeModes: []\nautoActivate: true\nautoActivateWhenIntents: [manuscript_creation]\ncontext: inline\n---\n# Writing Style\n\nBody".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        }];

        let idle_state = build_skill_runtime_state(
            &skills,
            "redclaw",
            None,
            &["redbox_fs".to_string()],
            None,
        );
        assert!(idle_state.active_skills.is_empty());

        let writing_state = build_skill_runtime_state(
            &skills,
            "redclaw",
            Some(&json!({ "intent": "manuscript_creation" })),
            &["redbox_fs".to_string()],
            None,
        );
        assert_eq!(writing_state.active_skills.len(), 1);
    }

    #[test]
    fn build_skill_runtime_state_exposes_runtime_available_skill_summary() {
        let state = build_skill_runtime_state(
            &skills(),
            "redclaw",
            None,
            &["redbox_fs".to_string()],
            None,
        );
        assert!(state.available_skills_section.contains("redclaw-project"));
        assert!(state.available_skills_section.contains("cover-builder"));
        assert!(!state.available_skills_section.contains("remotion-best-practices"));
    }

    #[test]
    fn build_skill_runtime_state_can_match_paths() {
        let skills = vec![SkillRecord {
            name: "manuscript-helper".to_string(),
            description: "desc".to_string(),
            location: "redbox://skills/manuscript-helper".to_string(),
            body: "---\nautoActivate: true\npaths: [manuscripts/**]\n---\n# Manuscript\n\nBody".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        }];

        let state = build_skill_runtime_state(
            &skills,
            "redclaw",
            Some(&json!({ "associatedFilePath": "/tmp/workspace/manuscripts/test.md" })),
            &["redbox_fs".to_string()],
            None,
        );
        assert_eq!(state.active_skills.len(), 1);
    }

    #[test]
    fn invoke_skill_value_substitutes_arguments() {
        let value = invoke_skill_value(&skills(), None, "cover-builder", Some("选题"))
            .expect("should invoke");
        let prompt = value
            .get("invocation")
            .and_then(|item| item.get("renderedPrompt"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(prompt.contains("选题"));
    }
}
