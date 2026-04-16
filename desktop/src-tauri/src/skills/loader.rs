use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::lexbox_project_root;
use crate::runtime::SkillRecord;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillHookActionRecord {
    #[serde(rename = "type", alias = "action")]
    pub action_type: String,
    pub summary: Option<String>,
    pub message: Option<String>,
    pub once: bool,
    pub enabled: Option<bool>,
    pub payload: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillHookMatcherRecord {
    pub matcher: Option<String>,
    pub enabled: Option<bool>,
    pub hooks: Vec<SkillHookActionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillMetadataRecord {
    pub allowed_runtime_modes: Vec<String>,
    pub allowed_tool_pack: Option<String>,
    pub allowed_tools: Vec<String>,
    pub blocked_tools: Vec<String>,
    pub auto_activate_when_intents: Vec<String>,
    pub auto_activate_when_context_types: Vec<String>,
    pub hook_mode: Option<String>,
    pub auto_activate: bool,
    pub prompt_prefix: Option<String>,
    pub prompt_suffix: Option<String>,
    pub context_note: Option<String>,
    pub max_prompt_chars: Option<usize>,
    pub description: Option<String>,
    pub when_to_use: Option<String>,
    pub version: Option<String>,
    pub aliases: Vec<String>,
    pub argument_hint: Option<String>,
    pub argument_names: Vec<String>,
    pub user_invocable: bool,
    pub disable_model_invocation: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub execution_context: Option<String>,
    pub agent: Option<String>,
    pub paths: Vec<String>,
    pub hooks: BTreeMap<String, Vec<SkillHookMatcherRecord>>,
    pub shell: Option<String>,
    pub disabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LoadedSkillRecord {
    pub name: String,
    pub description: String,
    pub location: String,
    pub source_scope: Option<String>,
    pub is_builtin: bool,
    pub disabled: bool,
    pub metadata: SkillMetadataRecord,
    pub body: String,
    pub fingerprint: String,
    pub base_dir: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SkillBundleSections {
    pub skill_name: String,
    pub body: String,
    pub references: String,
    pub scripts: String,
    pub rules: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(untagged)]
enum StringOrVec {
    #[default]
    Empty,
    Single(String),
    Many(Vec<String>),
}

impl StringOrVec {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::Empty => Vec::new(),
            Self::Single(value) => split_frontmatter_list(&value),
            Self::Many(values) => values
                .into_iter()
                .flat_map(|item| split_frontmatter_list(&item))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct SkillFrontmatterRecord {
    #[serde(alias = "allowedRuntimeModes", alias = "runtime_modes", alias = "runtime-modes")]
    allowed_runtime_modes: StringOrVec,
    #[serde(alias = "allowedToolPack", alias = "tool_pack", alias = "tool-pack")]
    allowed_tool_pack: Option<String>,
    #[serde(alias = "allowedTools", alias = "allowed_tools", alias = "allowed-tools")]
    allowed_tools: StringOrVec,
    #[serde(alias = "blockedTools", alias = "blocked_tools", alias = "blocked-tools")]
    blocked_tools: StringOrVec,
    #[serde(
        alias = "autoActivateWhenIntents",
        alias = "auto_activate_when_intents",
        alias = "auto-activate-when-intents"
    )]
    auto_activate_when_intents: StringOrVec,
    #[serde(
        alias = "autoActivateWhenContextTypes",
        alias = "auto_activate_when_context_types",
        alias = "auto-activate-when-context-types"
    )]
    auto_activate_when_context_types: StringOrVec,
    #[serde(alias = "hookMode", alias = "hook_mode", alias = "hook-mode")]
    hook_mode: Option<String>,
    #[serde(alias = "autoActivate", alias = "auto_activate", alias = "auto-activate")]
    auto_activate: Option<bool>,
    #[serde(alias = "promptPrefix", alias = "prompt_prefix", alias = "prompt-prefix")]
    prompt_prefix: Option<String>,
    #[serde(alias = "promptSuffix", alias = "prompt_suffix", alias = "prompt-suffix")]
    prompt_suffix: Option<String>,
    #[serde(alias = "contextNote", alias = "context_note", alias = "context-note")]
    context_note: Option<String>,
    #[serde(alias = "maxPromptChars", alias = "max_prompt_chars", alias = "max-prompt-chars")]
    max_prompt_chars: Option<usize>,
    #[serde(alias = "whenToUse", alias = "when_to_use", alias = "when-to-use")]
    when_to_use: Option<String>,
    version: Option<String>,
    description: Option<String>,
    aliases: StringOrVec,
    #[serde(alias = "argumentHint", alias = "argument_hint", alias = "argument-hint")]
    argument_hint: Option<String>,
    arguments: StringOrVec,
    #[serde(alias = "userInvocable", alias = "user_invocable", alias = "user-invocable")]
    user_invocable: Option<bool>,
    #[serde(
        alias = "disableModelInvocation",
        alias = "disable_model_invocation",
        alias = "disable-model-invocation"
    )]
    disable_model_invocation: Option<bool>,
    model: Option<String>,
    effort: Option<String>,
    #[serde(alias = "context")]
    execution_context: Option<String>,
    agent: Option<String>,
    paths: StringOrVec,
    hooks: BTreeMap<String, Vec<SkillHookMatcherRecord>>,
    shell: Option<String>,
    disabled: Option<bool>,
}

fn normalize_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|item| !item.is_empty())
}

fn split_frontmatter_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|item| item.strip_suffix(']'))
        .unwrap_or(trimmed);
    inner
        .split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn normalized_list(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::<String>::new();
    values
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .filter(|item| seen.insert(item.to_ascii_lowercase()))
        .collect()
}

fn parse_frontmatter_metadata(frontmatter: &str) -> SkillMetadataRecord {
    let parsed = serde_yaml::from_str::<SkillFrontmatterRecord>(frontmatter).unwrap_or_default();
    SkillMetadataRecord {
        allowed_runtime_modes: normalized_list(parsed.allowed_runtime_modes.into_vec()),
        allowed_tool_pack: normalize_string(parsed.allowed_tool_pack),
        allowed_tools: normalized_list(parsed.allowed_tools.into_vec()),
        blocked_tools: normalized_list(parsed.blocked_tools.into_vec()),
        auto_activate_when_intents: normalized_list(parsed.auto_activate_when_intents.into_vec()),
        auto_activate_when_context_types: normalized_list(
            parsed.auto_activate_when_context_types.into_vec(),
        ),
        hook_mode: normalize_string(parsed.hook_mode),
        auto_activate: parsed.auto_activate.unwrap_or(false),
        prompt_prefix: normalize_string(parsed.prompt_prefix),
        prompt_suffix: normalize_string(parsed.prompt_suffix),
        context_note: normalize_string(parsed.context_note),
        max_prompt_chars: parsed.max_prompt_chars,
        description: normalize_string(parsed.description),
        when_to_use: normalize_string(parsed.when_to_use),
        version: normalize_string(parsed.version),
        aliases: normalized_list(parsed.aliases.into_vec()),
        argument_hint: normalize_string(parsed.argument_hint),
        argument_names: normalized_list(parsed.arguments.into_vec()),
        user_invocable: parsed.user_invocable.unwrap_or(true),
        disable_model_invocation: parsed.disable_model_invocation.unwrap_or(false),
        model: normalize_string(parsed.model),
        effort: normalize_string(parsed.effort),
        execution_context: normalize_string(parsed.execution_context),
        agent: normalize_string(parsed.agent),
        paths: normalized_list(parsed.paths.into_vec()),
        hooks: parsed.hooks,
        shell: normalize_string(parsed.shell),
        disabled: parsed.disabled,
    }
}

fn body_heading_description(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.to_string())
}

pub fn split_skill_body(body: &str) -> (SkillMetadataRecord, String) {
    let trimmed = body.trim_start();
    let Some(rest) = trimmed.strip_prefix("---\n") else {
        return (SkillMetadataRecord::default(), body.trim().to_string());
    };
    let Some((frontmatter, content)) = rest.split_once("\n---\n") else {
        return (SkillMetadataRecord::default(), body.trim().to_string());
    };
    (
        parse_frontmatter_metadata(frontmatter),
        content.trim().to_string(),
    )
}

fn fingerprint_for_loaded_skill(
    record: &SkillRecord,
    metadata: &SkillMetadataRecord,
    body: &str,
    base_dir: Option<&str>,
) -> String {
    let mut hasher = DefaultHasher::new();
    record.name.hash(&mut hasher);
    record.description.hash(&mut hasher);
    record.location.hash(&mut hasher);
    record.source_scope.hash(&mut hasher);
    record.is_builtin.hash(&mut hasher);
    record.disabled.hash(&mut hasher);
    body.hash(&mut hasher);
    base_dir.hash(&mut hasher);
    metadata.allowed_runtime_modes.hash(&mut hasher);
    metadata.allowed_tool_pack.hash(&mut hasher);
    metadata.allowed_tools.hash(&mut hasher);
    metadata.blocked_tools.hash(&mut hasher);
    metadata.auto_activate_when_intents.hash(&mut hasher);
    metadata.auto_activate_when_context_types.hash(&mut hasher);
    metadata.hook_mode.hash(&mut hasher);
    metadata.auto_activate.hash(&mut hasher);
    metadata.prompt_prefix.hash(&mut hasher);
    metadata.prompt_suffix.hash(&mut hasher);
    metadata.context_note.hash(&mut hasher);
    metadata.max_prompt_chars.hash(&mut hasher);
    metadata.description.hash(&mut hasher);
    metadata.when_to_use.hash(&mut hasher);
    metadata.version.hash(&mut hasher);
    metadata.aliases.hash(&mut hasher);
    metadata.argument_hint.hash(&mut hasher);
    metadata.argument_names.hash(&mut hasher);
    metadata.user_invocable.hash(&mut hasher);
    metadata.disable_model_invocation.hash(&mut hasher);
    metadata.model.hash(&mut hasher);
    metadata.effort.hash(&mut hasher);
    metadata.execution_context.hash(&mut hasher);
    metadata.agent.hash(&mut hasher);
    metadata.paths.hash(&mut hasher);
    serde_json::to_string(&metadata.hooks)
        .unwrap_or_default()
        .hash(&mut hasher);
    metadata.shell.hash(&mut hasher);
    metadata.disabled.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn base_dir_for_location(location: &str) -> Option<String> {
    let path = PathBuf::from(location);
    path.parent()
        .filter(|parent| parent.exists() || location.starts_with('/'))
        .map(|parent| parent.display().to_string())
}

pub fn load_skill_record(record: &SkillRecord) -> LoadedSkillRecord {
    let (metadata, body) = split_skill_body(&record.body);
    let base_dir = base_dir_for_location(&record.location);
    let fingerprint =
        fingerprint_for_loaded_skill(record, &metadata, &body, base_dir.as_deref());
    LoadedSkillRecord {
        name: record.name.clone(),
        description: metadata
            .description
            .clone()
            .or_else(|| (!record.description.trim().is_empty()).then(|| record.description.clone()))
            .or_else(|| body_heading_description(&body))
            .unwrap_or_else(|| format!("{} skill", record.name)),
        location: record.location.clone(),
        source_scope: record.source_scope.clone(),
        is_builtin: record.is_builtin.unwrap_or(false),
        disabled: metadata.disabled.or(record.disabled).unwrap_or(false),
        metadata,
        body,
        fingerprint,
        base_dir,
    }
}

pub fn load_skill_catalog(skills: &[SkillRecord]) -> Vec<LoadedSkillRecord> {
    skills.iter().map(load_skill_record).collect()
}

fn project_skill_root() -> PathBuf {
    lexbox_project_root().join("skills")
}

pub fn skill_source_roots(workspace_root: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::<PathBuf>::new();
    if let Some(root) = workspace_root {
        roots.push(root.join("skills"));
    }
    roots.push(project_skill_root());
    let mut seen = BTreeSet::<String>::new();
    roots
        .into_iter()
        .filter(|path| path.exists() && path.is_dir())
        .filter(|path| {
            let normalized = path
                .canonicalize()
                .unwrap_or_else(|_| path.to_path_buf())
                .display()
                .to_string()
                .to_ascii_lowercase();
            seen.insert(normalized)
        })
        .collect()
}

fn scope_for_root(root: &Path, workspace_root: Option<&Path>) -> String {
    if workspace_root
        .map(|workspace| root.starts_with(workspace))
        .unwrap_or(false)
    {
        return "workspace".to_string();
    }
    if root.starts_with(project_skill_root()) {
        "project".to_string()
    } else {
        "external".to_string()
    }
}

fn discovered_skill_records_for_root(
    root: &Path,
    workspace_root: Option<&Path>,
) -> Vec<SkillRecord> {
    let mut records = Vec::<SkillRecord>::new();
    let Ok(entries) = fs::read_dir(root) else {
        return records;
    };
    for entry in entries.flatten().take(256) {
        let skill_dir = entry.path();
        if !skill_dir.is_dir() {
            continue;
        }
        let skill_file = skill_dir.join("SKILL.md");
        if !skill_file.is_file() {
            continue;
        }
        let body = fs::read_to_string(&skill_file).unwrap_or_default();
        if body.trim().is_empty() {
            continue;
        }
        let name = skill_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill")
            .to_string();
        let (metadata, content) = split_skill_body(&body);
        let description = metadata
            .description
            .clone()
            .or_else(|| body_heading_description(&content))
            .unwrap_or_else(|| format!("{name} skill"));
        records.push(SkillRecord {
            name,
            description,
            location: skill_file
                .canonicalize()
                .unwrap_or(skill_file)
                .display()
                .to_string(),
            body,
            source_scope: Some(scope_for_root(root, workspace_root)),
            is_builtin: Some(false),
            disabled: metadata.disabled,
        });
    }
    records
}

pub fn resolve_skill_records(
    persisted_skills: &[SkillRecord],
    workspace_root: Option<&Path>,
) -> Vec<SkillRecord> {
    let mut merged = BTreeMap::<String, SkillRecord>::new();
    for record in persisted_skills {
        merged.insert(record.name.to_ascii_lowercase(), record.clone());
    }
    let mut discovered = Vec::<SkillRecord>::new();
    for root in skill_source_roots(workspace_root) {
        discovered.extend(discovered_skill_records_for_root(&root, workspace_root));
    }
    discovered.sort_by(|left, right| {
        left.source_scope
            .as_deref()
            .unwrap_or_default()
            .cmp(right.source_scope.as_deref().unwrap_or_default())
            .then_with(|| left.name.cmp(&right.name))
    });
    for record in discovered {
        merged.insert(record.name.to_ascii_lowercase(), record);
    }
    merged.into_values().collect()
}

fn load_section_folder(folder: &Path) -> String {
    if !folder.exists() || !folder.is_dir() {
        return String::new();
    }
    let mut parts = Vec::<String>::new();
    if let Ok(entries) = fs::read_dir(folder) {
        for entry in entries.flatten().take(8) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file");
            parts.push(format!("## {name}\n{content}"));
        }
    }
    parts.join("\n\n")
}

fn load_named_markdown_folder(folder: &Path) -> BTreeMap<String, String> {
    let mut parts = BTreeMap::<String, String>::new();
    if !folder.exists() || !folder.is_dir() {
        return parts;
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return parts;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        parts.insert(name.to_string(), content);
    }
    parts
}

fn builtin_skill_root(skill_name: &str) -> PathBuf {
    lexbox_project_root().join("builtin-skills").join(skill_name)
}

fn skill_root_for_record(skill: &LoadedSkillRecord, workspace_root: Option<&Path>) -> Option<PathBuf> {
    if skill.is_builtin {
        return Some(builtin_skill_root(&skill.name));
    }
    let location_path = PathBuf::from(&skill.location);
    if location_path.is_file() {
        return location_path.parent().map(Path::to_path_buf);
    }
    if let Some(base_dir) = skill.base_dir.as_ref() {
        let path = PathBuf::from(base_dir);
        if path.exists() {
            return Some(path);
        }
    }
    for root in skill_source_roots(workspace_root) {
        let candidate = root.join(&skill.name);
        if candidate.join("SKILL.md").is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn load_skill_bundle_sections_for_record(
    skill: &LoadedSkillRecord,
    workspace_root: Option<&Path>,
) -> SkillBundleSections {
    let Some(skill_root) = skill_root_for_record(skill, workspace_root) else {
        return SkillBundleSections {
            skill_name: skill.name.clone(),
            body: format!("---\n---\n{}", skill.body),
            references: String::new(),
            scripts: String::new(),
            rules: BTreeMap::new(),
        };
    };
    let skill_file = skill_root.join("SKILL.md");
    let body = fs::read_to_string(&skill_file).unwrap_or_else(|_| skill.body.clone());
    SkillBundleSections {
        skill_name: skill.name.clone(),
        body,
        references: load_section_folder(&skill_root.join("references")),
        scripts: load_section_folder(&skill_root.join("scripts")),
        rules: load_named_markdown_folder(&skill_root.join("rules")),
    }
}

pub fn load_skill_bundle_sections_from_sources(
    skill_name: &str,
    workspace_root: Option<&Path>,
) -> SkillBundleSections {
    let builtin_root = builtin_skill_root(skill_name);
    let builtin_skill_file = builtin_root.join("SKILL.md");
    if builtin_skill_file.exists() && builtin_skill_file.is_file() {
        return SkillBundleSections {
            skill_name: skill_name.to_string(),
            body: fs::read_to_string(&builtin_skill_file).unwrap_or_default(),
            references: load_section_folder(&builtin_root.join("references")),
            scripts: load_section_folder(&builtin_root.join("scripts")),
            rules: load_named_markdown_folder(&builtin_root.join("rules")),
        };
    }
    for root in skill_source_roots(workspace_root) {
        let skill_root = root.join(skill_name);
        let skill_file = skill_root.join("SKILL.md");
        if !skill_file.exists() || !skill_file.is_file() {
            continue;
        }
        return SkillBundleSections {
            skill_name: skill_name.to_string(),
            body: fs::read_to_string(&skill_file).unwrap_or_default(),
            references: load_section_folder(&skill_root.join("references")),
            scripts: load_section_folder(&skill_root.join("scripts")),
            rules: load_named_markdown_folder(&skill_root.join("rules")),
        };
    }
    SkillBundleSections {
        skill_name: skill_name.to_string(),
        body: String::new(),
        references: String::new(),
        scripts: String::new(),
        rules: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_skill_body_extracts_rich_frontmatter_metadata() {
        let (metadata, body) = split_skill_body(
            "---\nallowedRuntimeModes: [redclaw, knowledge]\nallowedTools: [redbox_fs, redbox_mcp]\nautoActivate: true\ncontext: fork\nmodel: gpt-5\npaths: [manuscripts/**, drafts/*.md]\nargumentHint: topic\narguments: [topic, tone]\nuserInvocable: false\nhooks:\n  turnStart:\n    - matcher: redclaw\n      hooks:\n        - type: checkpoint\n          summary: start\n---\n# Skill\n\nBody",
        );
        assert_eq!(metadata.allowed_runtime_modes, vec!["redclaw", "knowledge"]);
        assert_eq!(metadata.allowed_tools, vec!["redbox_fs", "redbox_mcp"]);
        assert!(metadata.auto_activate);
        assert_eq!(metadata.execution_context.as_deref(), Some("fork"));
        assert_eq!(metadata.model.as_deref(), Some("gpt-5"));
        assert_eq!(metadata.paths, vec!["manuscripts/**", "drafts/*.md"]);
        assert_eq!(metadata.argument_hint.as_deref(), Some("topic"));
        assert_eq!(metadata.argument_names, vec!["topic", "tone"]);
        assert!(!metadata.user_invocable);
        assert!(metadata.hooks.contains_key("turnStart"));
        assert_eq!(body, "# Skill\n\nBody");
    }

    #[test]
    fn load_skill_record_prefers_frontmatter_description_and_disabled_flag() {
        let loaded = load_skill_record(&SkillRecord {
            name: "writer".to_string(),
            description: "Legacy".to_string(),
            location: "/tmp/writer/SKILL.md".to_string(),
            body: "---\ndescription: Better description\ndisabled: true\n---\n# Writer\n\nBody".to_string(),
            source_scope: Some("workspace".to_string()),
            is_builtin: Some(false),
            disabled: Some(false),
        });
        assert_eq!(loaded.description, "Better description");
        assert!(loaded.disabled);
        assert_eq!(loaded.base_dir.as_deref(), Some("/tmp/writer"));
    }

    #[test]
    fn load_skill_bundle_sections_prefers_builtin_skill_root() {
        let loaded = load_skill_bundle_sections_from_sources("remotion-best-practices", None);
        assert!(!loaded.body.trim().is_empty());
        assert!(loaded.rules.contains_key("calculate-metadata.md"));
        assert!(loaded.rules.contains_key("compositions.md"));
        assert!(loaded.rules.contains_key("timing.md"));
    }

    #[test]
    fn skill_source_roots_stay_inside_lexbox_and_workspace() {
        let roots = skill_source_roots(None);
        let project_root = lexbox_project_root().join("skills");
        assert!(roots.iter().any(|root| root == &project_root));
        assert!(!roots.iter().any(|root| root.ends_with(".codex/skills")));
        assert!(!roots.iter().any(|root| root.ends_with(".agents/skills")));
    }
}
