use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::runtime::SkillRecord;
use crate::skills::resolve_skill_file_path;

pub const DEFAULT_SKILL_RESOURCE_MAX_CHARS: usize = 20_000;

const MAX_SKILL_RESOURCE_BYTES: u64 = 1_000_000;
const RESOURCE_ROOTS: &[&str] = &["references", "scripts", "assets", "rules"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillResourceUri {
    pub skill_name: String,
    pub path: String,
}

pub fn parse_skill_resource_uri(raw: &str) -> Option<ParsedSkillResourceUri> {
    let rest = raw.trim().strip_prefix("skill://")?;
    let (skill_name, path) = rest.split_once('/')?;
    let skill_name = skill_name.trim();
    let path = path.trim_start_matches('/');
    if skill_name.is_empty() || path.is_empty() {
        return None;
    }
    Some(ParsedSkillResourceUri {
        skill_name: skill_name.to_string(),
        path: path.to_string(),
    })
}

pub fn looks_like_skill_bundle_relative_path(raw: &str) -> bool {
    let normalized = raw.trim().trim_start_matches('/').replace('\\', "/");
    RESOURCE_ROOTS
        .iter()
        .any(|root| normalized == *root || normalized.starts_with(&format!("{root}/")))
}

pub fn active_skill_resource_access_note(skill_name: &str) -> String {
    format!(
        "Bundled skill files under references/, scripts/, assets/, or rules/ are not workspace files. Read them with Read(path=\"skill://{skill_name}/<relative-path>\") or workflow action skills.readResource."
    )
}

pub fn list_skill_resources_value(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
) -> Result<Value, String> {
    let root = skill_root_for_record(record, workspace_root)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("failed to resolve skill root: {error}"))?;
    let mut resources = Vec::<Value>::new();
    for resource_root in RESOURCE_ROOTS {
        let dir = canonical_root.join(resource_root);
        if !dir.is_dir() {
            continue;
        }
        collect_resource_entries(&canonical_root, &dir, &mut resources)?;
    }
    resources.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    Ok(json!({
        "success": true,
        "name": record.name,
        "uri": format!("skill://{}", record.name),
        "rootKinds": RESOURCE_ROOTS,
        "resources": resources
    }))
}

pub fn read_skill_resource_value(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
    raw_path: &str,
    max_chars: usize,
    resolved_from: Option<&str>,
) -> Result<Value, String> {
    let (path, normalized_path) = resolve_skill_resource_file(record, workspace_root, raw_path)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_SKILL_RESOURCE_BYTES {
        return Err(format!(
            "skill resource is too large to read safely: {} bytes",
            metadata.len()
        ));
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        format!(
            "skill resource is not UTF-8 text: skill://{}/{}",
            record.name, normalized_path
        )
    })?;
    let truncated_content = truncate_chars(&content, max_chars);
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    let mut response = json!({
        "success": true,
        "name": record.name,
        "path": normalized_path,
        "uri": format!("skill://{}/{}", record.name, normalized_path),
        "kind": resource_kind(&normalized_path),
        "byteSize": metadata.len(),
        "sha256": format!("{:x}", Sha256::digest(&bytes)),
        "truncated": truncated_content.chars().count() < content.chars().count(),
        "content": truncated_content
    });
    if let Some(modified_at) = modified_at {
        response["modifiedAt"] = json!(modified_at);
    }
    if let Some(resolved_from) = resolved_from {
        response["resolvedFrom"] = json!(resolved_from);
    }
    Ok(response)
}

pub fn read_unique_active_skill_resource_value(
    records: &[SkillRecord],
    workspace_root: Option<&Path>,
    raw_path: &str,
    max_chars: usize,
) -> Option<Result<Value, String>> {
    if !looks_like_skill_bundle_relative_path(raw_path) {
        return None;
    }
    let matches = records
        .iter()
        .filter(|record| skill_resource_exists(record, workspace_root, raw_path))
        .cloned()
        .collect::<Vec<_>>();
    match matches.len() {
        0 => None,
        1 => Some(read_skill_resource_value(
            &matches[0],
            workspace_root,
            raw_path,
            max_chars,
            Some("activeSkillResourceFallback"),
        )),
        _ => Some(Err(format!(
            "multiple active skills contain resource path {raw_path}; use skill://<skill>/{raw_path}"
        ))),
    }
}

pub fn skill_resource_exists(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
    raw_path: &str,
) -> bool {
    resolve_skill_resource_file(record, workspace_root, raw_path).is_ok()
}

fn skill_root_for_record(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, String> {
    resolve_skill_file_path(record, workspace_root)
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .ok_or_else(|| format!("无法解析技能目录: {}", record.name))
}

fn resolve_skill_resource_file(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
    raw_path: &str,
) -> Result<(PathBuf, String), String> {
    let normalized_path = normalize_skill_resource_path(raw_path)?;
    if !looks_like_skill_bundle_relative_path(&normalized_path) {
        return Err(format!(
            "unsupported skill resource path: {normalized_path}. Use references/, scripts/, assets/, or rules/."
        ));
    }
    let root = skill_root_for_record(record, workspace_root)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("failed to resolve skill root: {error}"))?;
    let candidate = canonical_root.join(&normalized_path);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("skill resource not found: {normalized_path}: {error}"))?;
    if !resolved.starts_with(&canonical_root) {
        return Err("skill resource path escapes the skill directory".to_string());
    }
    if !resolved.is_file() {
        return Err(format!("skill resource is not a file: {normalized_path}"));
    }
    Ok((resolved, normalized_path))
}

fn normalize_skill_resource_path(raw_path: &str) -> Result<String, String> {
    let path = parse_skill_resource_uri(raw_path)
        .map(|parsed| parsed.path)
        .unwrap_or_else(|| raw_path.trim().trim_start_matches('/').to_string())
        .replace('\\', "/");
    if path.is_empty() {
        return Err("skill resource path is required".to_string());
    }
    if path.starts_with('/') || path.starts_with('~') {
        return Err("skill resource path must be relative".to_string());
    }
    let mut components = Vec::<String>::new();
    for component in Path::new(&path).components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_string_lossy();
                if value.is_empty() {
                    continue;
                }
                components.push(value.to_string());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("skill resource path cannot contain parent traversal".to_string());
            }
        }
    }
    if components.is_empty() {
        return Err("skill resource path is required".to_string());
    }
    Ok(components.join("/"))
}

fn collect_resource_entries(
    root: &Path,
    dir: &Path,
    resources: &mut Vec<Value>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_resource_entries(root, &path, resources)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        resources.push(json!({
            "path": relative,
            "kind": resource_kind(&relative),
            "byteSize": metadata.len()
        }));
    }
    Ok(())
}

fn resource_kind(path: &str) -> &str {
    path.split('/').next().unwrap_or("resource")
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_workspace() -> PathBuf {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let unique = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "redbox-skill-resource-test-{}-{id}-{unique}",
            std::process::id(),
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn workspace_skill(temp: &Path) -> SkillRecord {
        let skill_root = temp.join("skills").join("writer");
        fs::create_dir_all(skill_root.join("references")).expect("skill references dir");
        fs::write(skill_root.join("SKILL.md"), "# writer").expect("skill file");
        fs::write(skill_root.join("references").join("guide.md"), "hello").expect("reference");
        SkillRecord {
            name: "writer".to_string(),
            description: "desc".to_string(),
            location: "skills://writer".to_string(),
            body: "# writer".to_string(),
            source_scope: Some("workspace".to_string()),
            is_builtin: Some(false),
            disabled: Some(false),
        }
    }

    #[test]
    fn reads_skill_resource_from_workspace_skill() {
        let temp = temp_workspace();
        let record = workspace_skill(&temp);
        let value =
            read_skill_resource_value(&record, Some(&temp), "references/guide.md", 100, None)
                .expect("read resource");
        assert_eq!(value["content"], "hello");
        assert_eq!(value["uri"], "skill://writer/references/guide.md");
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn lists_skill_resources() {
        let temp = temp_workspace();
        let record = workspace_skill(&temp);
        let value = list_skill_resources_value(&record, Some(&temp)).expect("list");
        assert_eq!(value["resources"][0]["path"], "references/guide.md");
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn rejects_parent_traversal() {
        let temp = temp_workspace();
        let record = workspace_skill(&temp);
        let error = read_skill_resource_value(&record, Some(&temp), "../SKILL.md", 100, None)
            .expect_err("parent traversal rejected");
        assert!(error.contains("parent traversal"));
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn parses_skill_uri() {
        let parsed =
            parse_skill_resource_uri("skill://writer/references/guide.md").expect("parsed");
        assert_eq!(parsed.skill_name, "writer");
        assert_eq!(parsed.path, "references/guide.md");
    }
}
