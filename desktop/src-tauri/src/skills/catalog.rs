use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::runtime::SkillRecord;
use crate::skills::{load_skill_catalog, LoadedSkillRecord};

pub type SkillCatalogEntry = LoadedSkillRecord;

#[derive(Debug, Clone, Default)]
pub struct SkillCatalogSnapshot {
    pub entries: Vec<SkillCatalogEntry>,
    #[allow(dead_code)]
    pub fingerprint: String,
}

pub fn build_skill_catalog_snapshot(skills: &[SkillRecord]) -> SkillCatalogSnapshot {
    let entries = load_skill_catalog(skills);
    let mut hasher = DefaultHasher::new();
    for entry in &entries {
        entry.name.hash(&mut hasher);
        entry.location.hash(&mut hasher);
        entry.fingerprint.hash(&mut hasher);
        entry.disabled.hash(&mut hasher);
    }
    SkillCatalogSnapshot {
        entries,
        fingerprint: format!("{:x}", hasher.finish()),
    }
}

pub fn find_skill_catalog_entry_by_name(
    snapshot: &SkillCatalogSnapshot,
    name: &str,
) -> Option<SkillCatalogEntry> {
    let lookup = name.trim();
    if lookup.is_empty() {
        return None;
    }
    snapshot
        .entries
        .iter()
        .find(|skill| skill.name.eq_ignore_ascii_case(lookup))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, description: &str, body: &str) -> SkillRecord {
        SkillRecord {
            name: name.to_string(),
            description: description.to_string(),
            location: format!("redbox://skills/{name}"),
            body: body.to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        }
    }

    #[test]
    fn catalog_snapshot_fingerprint_changes_with_skill_content() {
        let first = build_skill_catalog_snapshot(&[skill(
            "writing-style",
            "desc",
            "---\nallowedRuntimeModes: [wander]\n---\n# Writing Style\n\nBody A",
        )]);
        let second = build_skill_catalog_snapshot(&[skill(
            "writing-style",
            "desc",
            "---\nallowedRuntimeModes: [wander]\n---\n# Writing Style\n\nBody B",
        )]);
        assert_ne!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn find_skill_catalog_entry_by_name_is_case_insensitive() {
        let snapshot = build_skill_catalog_snapshot(&[skill(
            "writing-style",
            "desc",
            "---\nallowedRuntimeModes: [wander]\n---\n# Writing Style\n\nBody",
        )]);
        let found = find_skill_catalog_entry_by_name(&snapshot, "Writing-Style");
        assert_eq!(
            found.as_ref().map(|item| item.name.as_str()),
            Some("writing-style")
        );
    }
}
