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
        assert!(skills.iter().any(|item| item.name == "cover-builder"));
        assert!(skills.iter().any(|item| item.name == "writing-style"));
        assert!(skills.iter().all(|item| item.is_builtin == Some(true)));
        assert!(skills
            .iter()
            .all(|item| item.source_scope.as_deref() == Some("builtin")));
    }
}
