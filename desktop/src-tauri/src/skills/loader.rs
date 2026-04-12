use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    pub prompt_prefix: Option<String>,
    pub prompt_suffix: Option<String>,
    pub context_note: Option<String>,
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
            "maxpromptchars" | "max_prompt_chars" | "max-prompt-chars" => {
                metadata.max_prompt_chars = value.parse::<usize>().ok();
            }
            _ => {}
        }
    }
    metadata
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
    metadata.prompt_prefix.hash(&mut hasher);
    metadata.prompt_suffix.hash(&mut hasher);
    metadata.context_note.hash(&mut hasher);
    metadata.max_prompt_chars.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

pub fn load_skill_record(record: &SkillRecord) -> LoadedSkillRecord {
    let (metadata, body) = split_skill_body(&record.body);
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

pub fn load_skill_bundle_sections_from_sources(
    skill_name: &str,
    workspace_root: Option<&Path>,
) -> SkillBundleSections {
    for root in skill_source_roots(workspace_root) {
        let skill_root = root.join(skill_name);
        let skill_file = skill_root.join("SKILL.md");
        if !skill_file.exists() || !skill_file.is_file() {
            continue;
        }
        let body = fs::read_to_string(&skill_file).unwrap_or_default();
        let references = load_section_folder(&skill_root.join("references"));
        let scripts = load_section_folder(&skill_root.join("scripts"));
        return SkillBundleSections {
            skill_name: skill_name.to_string(),
            body,
            references,
            scripts,
        };
    }
    SkillBundleSections {
        skill_name: skill_name.to_string(),
        body: String::new(),
        references: String::new(),
        scripts: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_skill_body_extracts_frontmatter_metadata() {
        let (metadata, body) = split_skill_body(
            "---\nallowedRuntimeModes: [redclaw, knowledge]\nallowedTools: [redbox_fs, redbox_mcp]\nautoActivate: true\nhookMode: forked\nmaxPromptChars: 1200\n---\n# Skill\n\nBody",
        );
        assert_eq!(metadata.allowed_runtime_modes, vec!["redclaw", "knowledge"]);
        assert_eq!(metadata.allowed_tools, vec!["redbox_fs", "redbox_mcp"]);
        assert!(metadata.auto_activate);
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
}
