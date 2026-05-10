use crate::runtime::SkillRecord;
use crate::skills::discover_builtin_skill_records;

pub fn builtin_skill_records() -> Vec<SkillRecord> {
    discover_builtin_skill_records()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_skill_records_are_loaded_from_builtin_skills_directory() {
        let skills = builtin_skill_records();
        let names = skills
            .iter()
            .map(|item| item.name.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            names,
            std::collections::BTreeSet::from([
                "cover-builder",
                "image-director",
                "image-prompt-optimizer",
                "member-skill-distiller",
                "remotion-best-practices",
                "skill-creator",
                "video-director",
                "wander-synthesis",
                "writing-style",
                "wwud",
                "xhs-title",
            ])
        );
        assert!(skills.iter().all(|item| item.is_builtin == Some(true)));
        assert!(skills
            .iter()
            .all(|item| item.source_scope.as_deref() == Some("builtin")));
    }
}
