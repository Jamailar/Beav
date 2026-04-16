use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::skills::{skill_source_roots, LoadedSkillRecord};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillWatcherSnapshot {
    pub fingerprint: String,
    pub skill_count: usize,
    pub discovery_fingerprint: String,
}

#[allow(dead_code)]
pub fn build_skill_watcher_snapshot(skills: &[LoadedSkillRecord]) -> SkillWatcherSnapshot {
    build_skill_watcher_snapshot_with_discovery(skills, "")
}

pub fn build_skill_watcher_snapshot_with_discovery(
    skills: &[LoadedSkillRecord],
    discovery_fingerprint: &str,
) -> SkillWatcherSnapshot {
    let fingerprint = skills
        .iter()
        .map(|item| item.fingerprint.as_str())
        .collect::<Vec<_>>()
        .join(":");
    let composite = if discovery_fingerprint.trim().is_empty() {
        fingerprint
    } else {
        format!("{fingerprint}:{discovery_fingerprint}")
    };
    SkillWatcherSnapshot {
        fingerprint: composite,
        skill_count: skills.len(),
        discovery_fingerprint: discovery_fingerprint.to_string(),
    }
}

#[allow(dead_code)]
pub fn skill_catalog_changed(previous: &SkillWatcherSnapshot, next: &SkillWatcherSnapshot) -> bool {
    previous != next
}

fn skill_source_file_list(workspace_root: Option<&Path>) -> Vec<String> {
    let mut paths = Vec::<String>::new();
    for root in skill_source_roots(workspace_root) {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten().take(256) {
            let skill_dir = entry.path();
            if !skill_dir.is_dir() {
                continue;
            }
            let skill_file = skill_dir.join("SKILL.md");
            if skill_file.is_file() {
                paths.push(skill_file.display().to_string());
            }
            for folder_name in ["references", "scripts"] {
                let folder = skill_dir.join(folder_name);
                let Ok(items) = fs::read_dir(folder) else {
                    continue;
                };
                for item in items.flatten().take(256) {
                    let path = item.path();
                    if path.is_file() {
                        paths.push(path.display().to_string());
                    }
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

pub fn compute_skill_discovery_fingerprint(workspace_root: Option<&Path>) -> String {
    let mut hasher = DefaultHasher::new();
    for file_path in skill_source_file_list(workspace_root) {
        file_path.hash(&mut hasher);
        if let Ok(metadata) = fs::metadata(&file_path) {
            metadata.len().hash(&mut hasher);
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    duration.as_secs().hash(&mut hasher);
                    duration.subsec_nanos().hash(&mut hasher);
                }
            }
        }
    }
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillMetadataRecord;

    fn skill(name: &str, fingerprint: &str) -> LoadedSkillRecord {
        LoadedSkillRecord {
            name: name.to_string(),
            description: "desc".to_string(),
            location: format!("redbox://skills/{name}"),
            base_dir: None,
            source_scope: Some("builtin".to_string()),
            is_builtin: true,
            disabled: false,
            metadata: SkillMetadataRecord::default(),
            body: "# Skill".to_string(),
            fingerprint: fingerprint.to_string(),
        }
    }

    #[test]
    fn skill_catalog_changed_detects_fingerprint_updates() {
        let previous = build_skill_watcher_snapshot(&[skill("a", "1")]);
        let next = build_skill_watcher_snapshot(&[skill("a", "2")]);
        assert!(skill_catalog_changed(&previous, &next));
    }

    #[test]
    fn build_skill_watcher_snapshot_with_discovery_mixes_fingerprints() {
        let snapshot = build_skill_watcher_snapshot_with_discovery(&[skill("a", "1")], "ext");
        assert!(snapshot.fingerprint.contains("ext"));
        assert_eq!(snapshot.discovery_fingerprint, "ext");
    }
}
