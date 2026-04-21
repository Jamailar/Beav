use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use normalized_line_endings::Normalized;
use serde::{Deserialize, Serialize};

use crate::{redbox_project_root, slug_from_relative_path};
use crate::runtime::SkillRecord;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillMetadataRecord {
    pub allowed_runtime_modes: Vec<String>,
    pub allowed_tool_pack: Option<String>,
    pub allowed_tools: Vec<String>,
    pub blocked_tools: Vec<String>,
    pub hook_mode: Option<String>,
    pub auto_activate: bool,
    pub activation_scope: Option<String>,
    pub prompt_prefix: Option<String>,
    pub prompt_suffix: Option<String>,
    pub context_note: Option<String>,
    pub activation_hint: Option<String>,
    pub max_prompt_chars: Option<usize>,
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
}

#[derive(Debug, Clone, Default)]
pub struct SkillBundleSections {
    pub skill_name: String,
    pub body: String,
    pub references: String,
    pub scripts: String,
    pub rules: BTreeMap<String, String>,
}

fn normalize_string(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

fn parse_string_list(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    let inner = trimmed
        .strip_prefix('[')
        .and_then(|item| item.strip_suffix(']'))
        .unwrap_or(trimmed);
    inner
        .split(',')
        .map(normalize_string)
        .filter(|item| !item.is_empty())
        .collect()
}

fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn normalize_skill_text(value: &str) -> String {
    value.chars().normalized().collect()
}

pub fn normalize_skill_logical_path(value: &str) -> String {
    value.trim().replace('\\', "/")
}

fn parse_frontmatter_metadata(frontmatter: &str) -> SkillMetadataRecord {
    let mut metadata = SkillMetadataRecord::default();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = raw_value.trim();
        match key.as_str() {
            "allowedruntimemodes" | "runtime_modes" | "runtime-modes" => {
                metadata.allowed_runtime_modes = parse_string_list(value);
            }
            "allowedtoolpack" | "tool_pack" | "tool-pack" => {
                let normalized = normalize_string(value);
                metadata.allowed_tool_pack = (!normalized.is_empty()).then_some(normalized);
            }
            "allowedtools" | "allowed_tools" | "allowed-tools" => {
                metadata.allowed_tools = parse_string_list(value);
            }
            "blockedtools" | "blocked_tools" | "blocked-tools" => {
                metadata.blocked_tools = parse_string_list(value);
            }
            "hookmode" | "hook_mode" | "hook-mode" => {
                let normalized = normalize_string(value);
                metadata.hook_mode = (!normalized.is_empty()).then_some(normalized);
            }
            "autoactivate" | "auto_activate" | "auto-activate" => {
                metadata.auto_activate = parse_bool(value);
            }
            "activationscope" | "activation_scope" | "activation-scope" => {
                let normalized = normalize_string(value).to_ascii_lowercase();
                metadata.activation_scope = (!normalized.is_empty()).then_some(normalized);
            }
            "promptprefix" | "prompt_prefix" | "prompt-prefix" => {
                let normalized = normalize_string(value);
                metadata.prompt_prefix = (!normalized.is_empty()).then_some(normalized);
            }
            "promptsuffix" | "prompt_suffix" | "prompt-suffix" => {
                let normalized = normalize_string(value);
                metadata.prompt_suffix = (!normalized.is_empty()).then_some(normalized);
            }
            "contextnote" | "context_note" | "context-note" => {
                let normalized = normalize_string(value);
                metadata.context_note = (!normalized.is_empty()).then_some(normalized);
            }
            "activationhint" | "activation_hint" | "activation-hint" => {
                let normalized = normalize_string(value);
                metadata.activation_hint = (!normalized.is_empty()).then_some(normalized);
            }
            "maxpromptchars" | "max_prompt_chars" | "max-prompt-chars" => {
                metadata.max_prompt_chars = value.parse::<usize>().ok();
            }
            _ => {}
        }
    }
    metadata
}

fn legacy_default_activation_scope(skill_name: &str) -> Option<&'static str> {
    match skill_name.trim().to_ascii_lowercase().as_str() {
        "writing-style" | "writing-style-creator" => Some("turn"),
        _ => None,
    }
}

pub fn normalized_activation_scope(value: Option<&str>) -> &'static str {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("session")
        .to_ascii_lowercase()
        .as_str()
    {
        "turn" | "single-turn" | "single_turn" | "ephemeral" => "turn",
        _ => "session",
    }
}

pub fn split_skill_body(body: &str) -> (SkillMetadataRecord, String) {
    let normalized = normalize_skill_text(body);
    let trimmed = normalized.trim_start();
    let Some(rest) = trimmed.strip_prefix("---\n") else {
        return (
            SkillMetadataRecord::default(),
            normalized.trim().to_string(),
        );
    };
    let Some((frontmatter, content)) = rest.split_once("\n---\n") else {
        return (
            SkillMetadataRecord::default(),
            normalized.trim().to_string(),
        );
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
) -> String {
    let mut hasher = DefaultHasher::new();
    record.name.hash(&mut hasher);
    record.description.hash(&mut hasher);
    record.location.hash(&mut hasher);
    record.source_scope.hash(&mut hasher);
    record.is_builtin.hash(&mut hasher);
    record.disabled.hash(&mut hasher);
    body.hash(&mut hasher);
    metadata.allowed_runtime_modes.hash(&mut hasher);
    metadata.allowed_tool_pack.hash(&mut hasher);
    metadata.allowed_tools.hash(&mut hasher);
    metadata.blocked_tools.hash(&mut hasher);
    metadata.hook_mode.hash(&mut hasher);
    metadata.auto_activate.hash(&mut hasher);
    metadata.activation_scope.hash(&mut hasher);
    metadata.prompt_prefix.hash(&mut hasher);
    metadata.prompt_suffix.hash(&mut hasher);
    metadata.context_note.hash(&mut hasher);
    metadata.activation_hint.hash(&mut hasher);
    metadata.max_prompt_chars.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

pub fn load_skill_record(record: &SkillRecord) -> LoadedSkillRecord {
    let (mut metadata, body) = split_skill_body(&record.body);
    if metadata.activation_scope.is_none() {
        metadata.activation_scope =
            legacy_default_activation_scope(&record.name).map(ToString::to_string);
    }
    let fingerprint = fingerprint_for_loaded_skill(record, &metadata, &body);
    LoadedSkillRecord {
        name: record.name.clone(),
        description: record.description.clone(),
        location: record.location.clone(),
        source_scope: record.source_scope.clone(),
        is_builtin: record.is_builtin.unwrap_or(false),
        disabled: record.disabled.unwrap_or(false),
        metadata,
        body,
        fingerprint,
    }
}

pub fn load_skill_catalog(skills: &[SkillRecord]) -> Vec<LoadedSkillRecord> {
    skills.iter().map(load_skill_record).collect()
}

fn parse_frontmatter_string(raw_body: &str, accepted_keys: &[&str]) -> Option<String> {
    let normalized = normalize_skill_text(raw_body);
    let trimmed = normalized.trim_start();
    let rest = trimmed.strip_prefix("---\n")?;
    let (frontmatter, _) = rest.split_once("\n---\n")?;
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        if accepted_keys
            .iter()
            .any(|accepted| key == accepted.trim().to_ascii_lowercase())
        {
            let value = normalize_string(raw_value);
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn derive_skill_description_from_content(content: &str) -> String {
    let mut paragraph = Vec::<String>::new();
    let mut skipped_heading = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if !skipped_heading && trimmed.starts_with('#') {
            skipped_heading = true;
            continue;
        }
        paragraph.push(trimmed.to_string());
    }
    let description = paragraph.join(" ");
    if description.is_empty() {
        "Skill".to_string()
    } else {
        description
    }
}

pub fn discover_skill_records_from_root(
    root: &Path,
    source_scope: &str,
    is_builtin: bool,
) -> Vec<SkillRecord> {
    if !root.exists() || !root.is_dir() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut records = Vec::<SkillRecord>::new();
    for entry in entries.flatten() {
        let skill_root = entry.path();
        if !skill_root.is_dir() {
            continue;
        }
        let skill_file = skill_root.join("SKILL.md");
        if !skill_file.is_file() {
            continue;
        }
        let Ok(raw_body) = fs::read_to_string(&skill_file).map(|value| normalize_skill_text(&value))
        else {
            continue;
        };
        let directory_name = entry.file_name().to_string_lossy().trim().to_string();
        if directory_name.is_empty() {
            continue;
        }
        let name = parse_frontmatter_string(&raw_body, &["name"]).unwrap_or(directory_name);
        let (_, content) = split_skill_body(&raw_body);
        let description = parse_frontmatter_string(
            &raw_body,
            &["description", "short-description", "short_description"],
        )
        .unwrap_or_else(|| derive_skill_description_from_content(&content));
        records.push(SkillRecord {
            name: name.clone(),
            description,
            location: format!("redbox://skills/{}", slug_from_relative_path(&name)),
            body: raw_body,
            source_scope: Some(source_scope.to_string()),
            is_builtin: Some(is_builtin),
            disabled: Some(false),
        });
    }
    records.sort_by_key(|item| item.name.to_ascii_lowercase());
    records
}

pub fn discover_builtin_skill_records() -> Vec<SkillRecord> {
    discover_skill_records_from_root(&redbox_project_root().join("builtin-skills"), "builtin", true)
}

pub fn skill_source_roots(workspace_root: Option<&Path>) -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut roots = Vec::<PathBuf>::new();
    if let Some(root) = workspace_root {
        roots.push(root.join("skills"));
    }
    roots.push(home.join(".codex").join("skills"));
    roots.push(home.join(".agents").join("skills"));
    roots
        .into_iter()
        .filter(|path| path.exists() && path.is_dir())
        .collect()
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
            let content = fs::read_to_string(&path)
                .map(|value| normalize_skill_text(&value))
                .unwrap_or_default();
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
        let content = fs::read_to_string(&path)
            .map(|value| normalize_skill_text(&value))
            .unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        parts.insert(name.to_string(), content);
    }
    parts
}

fn builtin_skill_root(skill_name: &str) -> PathBuf {
    redbox_project_root()
        .join("builtin-skills")
        .join(skill_name)
}

pub fn load_skill_bundle_sections_from_root(
    skill_name: &str,
    skill_root: &Path,
) -> SkillBundleSections {
    let skill_file = skill_root.join("SKILL.md");
    if !skill_file.exists() || !skill_file.is_file() {
        return SkillBundleSections {
            skill_name: skill_name.to_string(),
            body: String::new(),
            references: String::new(),
            scripts: String::new(),
            rules: BTreeMap::new(),
        };
    }
    let body = fs::read_to_string(&skill_file)
        .map(|value| normalize_skill_text(&value))
        .unwrap_or_default();
    let references = load_section_folder(&skill_root.join("references"));
    let scripts = load_section_folder(&skill_root.join("scripts"));
    let rules = load_named_markdown_folder(&skill_root.join("rules"));
    SkillBundleSections {
        skill_name: skill_name.to_string(),
        body,
        references,
        scripts,
        rules,
    }
}

pub fn load_skill_bundle_sections_from_sources(
    skill_name: &str,
    workspace_root: Option<&Path>,
) -> SkillBundleSections {
    let builtin_root = builtin_skill_root(skill_name);
    let builtin_bundle = load_skill_bundle_sections_from_root(skill_name, &builtin_root);
    if !builtin_bundle.body.trim().is_empty() {
        return builtin_bundle;
    }
    for root in skill_source_roots(workspace_root) {
        let skill_root = root.join(skill_name);
        let bundle = load_skill_bundle_sections_from_root(skill_name, &skill_root);
        if !bundle.body.trim().is_empty() {
            return bundle;
        }
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
    fn split_skill_body_extracts_frontmatter_metadata() {
        let (metadata, body) = split_skill_body(
            "---\nallowedRuntimeModes: [redclaw, knowledge]\nallowedTools: [redbox_fs, redbox_mcp]\nautoActivate: true\nactivationScope: turn\nhookMode: forked\nmaxPromptChars: 1200\n---\n# Skill\n\nBody",
        );
        assert_eq!(metadata.allowed_runtime_modes, vec!["redclaw", "knowledge"]);
        assert_eq!(metadata.allowed_tools, vec!["redbox_fs", "redbox_mcp"]);
        assert!(metadata.auto_activate);
        assert_eq!(metadata.activation_scope.as_deref(), Some("turn"));
        assert_eq!(metadata.hook_mode.as_deref(), Some("forked"));
        assert_eq!(metadata.max_prompt_chars, Some(1200));
        assert_eq!(body, "# Skill\n\nBody");
    }

    #[test]
    fn load_skill_record_keeps_legacy_body_without_frontmatter() {
        let loaded = load_skill_record(&SkillRecord {
            name: "legacy".to_string(),
            description: "Legacy".to_string(),
            location: "redbox://skills/legacy".to_string(),
            body: "# Legacy\n\nBody".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        });
        assert_eq!(loaded.body, "# Legacy\n\nBody");
        assert!(loaded.metadata.allowed_runtime_modes.is_empty());
        assert!(!loaded.fingerprint.is_empty());
    }

    #[test]
    fn load_skill_record_applies_legacy_turn_scope_for_writing_style() {
        let loaded = load_skill_record(&SkillRecord {
            name: "writing-style".to_string(),
            description: "Writing style".to_string(),
            location: "redbox://skills/writing-style".to_string(),
            body: "# Writing Style\n\nBody".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        });
        assert_eq!(
            normalized_activation_scope(loaded.metadata.activation_scope.as_deref()),
            "turn"
        );
    }

    #[test]
    fn split_skill_body_normalizes_crlf_frontmatter() {
        let (metadata, body) = split_skill_body(
            "---\r\nallowedRuntimeModes: [wander]\r\nhookMode: inline\r\n---\r\n# Skill\r\n\r\nBody",
        );
        assert_eq!(metadata.allowed_runtime_modes, vec!["wander"]);
        assert_eq!(metadata.hook_mode.as_deref(), Some("inline"));
        assert_eq!(body, "# Skill\n\nBody");
    }

    #[test]
    fn normalize_skill_logical_path_converts_backslashes() {
        assert_eq!(
            normalize_skill_logical_path(r"builtin-skills\writing-style\SKILL.md"),
            "builtin-skills/writing-style/SKILL.md"
        );
    }

    #[test]
    fn discover_skill_records_from_root_reads_directory_skills() {
        let root = std::env::temp_dir().join(format!("redbox-skill-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("demo-skill")).expect("root should be created");
        fs::write(
            root.join("demo-skill").join("SKILL.md"),
            "---\ndescription: Demo description\n---\n# Demo Skill\n\nBody",
        )
        .expect("skill file should be written");

        let discovered = discover_skill_records_from_root(&root, "user", false);
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].name, "demo-skill");
        assert_eq!(discovered[0].description, "Demo description");
        assert_eq!(discovered[0].source_scope.as_deref(), Some("user"));
        assert_eq!(discovered[0].is_builtin, Some(false));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn load_skill_bundle_sections_prefers_builtin_skill_root() {
        let loaded = load_skill_bundle_sections_from_sources("remotion-best-practices", None);
        assert!(!loaded.body.trim().is_empty());
        assert!(loaded.rules.contains_key("calculate-metadata.md"));
        assert!(loaded.rules.contains_key("compositions.md"));
        assert!(loaded.rules.contains_key("timing.md"));
    }
}
