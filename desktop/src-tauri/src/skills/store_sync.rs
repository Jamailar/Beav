use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::persistence::{with_store, with_store_mut};
use crate::runtime::SkillRecord;
use crate::skills::{
    build_market_skill_record, build_user_skill_record, discover_builtin_skill_records,
    discover_skill_records_from_root,
};
use crate::{redbox_project_root, slug_from_relative_path, workspace_root, AppState};

pub fn preferred_user_skill_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("skills")
}

fn additional_user_skill_roots() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    vec![home.join(".agents").join("skills")]
}

fn discover_external_skill_records(workspace_root: Option<&Path>) -> Vec<SkillRecord> {
    let mut discovered = Vec::<SkillRecord>::new();
    let mut seen = HashSet::<String>::new();
    let mut push_records = |root: PathBuf, source_scope: &str| {
        for record in discover_skill_records_from_root(&root, source_scope, false) {
            let key = record.name.to_ascii_lowercase();
            if seen.insert(key) {
                discovered.push(record);
            }
        }
    };
    if let Some(root) = workspace_root {
        push_records(root.join("skills"), "workspace");
    }
    push_records(preferred_user_skill_root(), "user");
    for root in additional_user_skill_roots() {
        push_records(root, "user");
    }
    discovered
}

pub fn discover_all_skill_records(workspace_root: Option<&Path>) -> Vec<SkillRecord> {
    let mut records = Vec::<SkillRecord>::new();
    let mut seen = HashSet::<String>::new();
    for record in discover_external_skill_records(workspace_root) {
        let key = record.name.to_ascii_lowercase();
        if seen.insert(key) {
            records.push(record);
        }
    }
    for record in discover_builtin_skill_records() {
        let key = record.name.to_ascii_lowercase();
        if seen.insert(key) {
            records.push(record);
        }
    }
    records.sort_by_key(|item| item.name.to_ascii_lowercase());
    records
}

fn merge_discovered_with_existing(
    existing: &[SkillRecord],
    discovered: Vec<SkillRecord>,
) -> Vec<SkillRecord> {
    let mut merged = discovered;
    for record in merged.iter_mut() {
        if let Some(existing_record) = existing
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(&record.name))
        {
            record.disabled = existing_record.disabled.or(record.disabled);
        }
    }
    for record in existing {
        if merged
            .iter()
            .any(|item| item.name.eq_ignore_ascii_case(&record.name))
        {
            continue;
        }
        let is_builtin =
            record.is_builtin.unwrap_or(false) || record.source_scope.as_deref() == Some("builtin");
        if is_builtin {
            continue;
        }
        merged.push(record.clone());
    }
    merged.sort_by_key(|item| item.name.to_ascii_lowercase());
    merged
}

pub fn refresh_skill_store_catalog(state: &State<'_, AppState>) -> Result<bool, String> {
    let existing = with_store(state, |store| Ok(store.skills.clone()))?;
    let workspace = workspace_root(state).ok();
    let merged = merge_discovered_with_existing(&existing, discover_all_skill_records(workspace.as_deref()));
    if existing == merged {
        return Ok(false);
    }
    with_store_mut(state, |store| {
        store.skills = merged;
        Ok(())
    })?;
    Ok(true)
}

fn skill_file_path_for_root(root: &Path, skill_name: &str) -> PathBuf {
    root.join(slug_from_relative_path(skill_name)).join("SKILL.md")
}

pub fn resolve_skill_file_path(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
) -> Option<PathBuf> {
    match record.source_scope.as_deref() {
        Some("builtin") => Some(skill_file_path_for_root(
            &redbox_project_root().join("builtin-skills"),
            &record.name,
        )),
        Some("workspace") => workspace_root.map(|root| skill_file_path_for_root(&root.join("skills"), &record.name)),
        Some("user") | Some("market") | None => {
            let preferred = skill_file_path_for_root(&preferred_user_skill_root(), &record.name);
            if preferred.is_file() {
                return Some(preferred);
            }
            for root in additional_user_skill_roots() {
                let candidate = skill_file_path_for_root(&root, &record.name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            Some(preferred)
        }
        Some(_) => Some(skill_file_path_for_root(&preferred_user_skill_root(), &record.name)),
    }
}

pub fn write_skill_record_to_path(record: &SkillRecord, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, &record.body).map_err(|error| error.to_string())
}

pub fn build_workspace_skill_record(name: &str) -> SkillRecord {
    let mut record = build_user_skill_record(name);
    record.source_scope = Some("workspace".to_string());
    record
}

pub fn build_market_file_skill_record(slug: &str) -> SkillRecord {
    let mut record = build_market_skill_record(slug);
    record.source_scope = Some("market".to_string());
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, scope: &str, disabled: bool) -> SkillRecord {
        SkillRecord {
            name: name.to_string(),
            description: format!("{name} desc"),
            location: format!("redbox://skills/{name}"),
            body: format!("# {name}"),
            source_scope: Some(scope.to_string()),
            is_builtin: Some(scope == "builtin"),
            disabled: Some(disabled),
        }
    }

    #[test]
    fn merge_discovered_with_existing_preserves_disabled_state() {
        let existing = vec![skill("writer", "workspace", true)];
        let merged = merge_discovered_with_existing(&existing, vec![skill("writer", "workspace", false)]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].disabled, Some(true));
    }

    #[test]
    fn merge_discovered_with_existing_drops_removed_builtin_records() {
        let existing = vec![skill("old-builtin", "builtin", false)];
        let merged = merge_discovered_with_existing(&existing, Vec::new());
        assert!(merged.is_empty());
    }
}
