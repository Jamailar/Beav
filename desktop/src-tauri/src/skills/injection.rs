use std::path::Path;

use serde_json::{json, Value};

use crate::runtime::SkillRecord;
use crate::skills::{resolve_skill_file_path, LoadedSkillRecord};

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub struct SkillInstructionInjection {
    pub name: String,
    pub path: String,
    pub fingerprint: String,
    pub source_scope: Option<String>,
    pub content: String,
}

#[allow(dead_code)]
fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[allow(dead_code)]
pub fn render_skill_instruction_content(name: &str, path: &str, body: &str) -> String {
    format!(
        "<skill>\n<name>{}</name>\n<path>{}</path>\n{}\n</skill>",
        escape_xml_text(name.trim()),
        escape_xml_text(path.trim()),
        body.trim()
    )
}

#[allow(dead_code)]
pub fn build_skill_instruction_injection(
    record: &SkillRecord,
    loaded: &LoadedSkillRecord,
    workspace_root: Option<&Path>,
) -> SkillInstructionInjection {
    let path = resolve_skill_file_path(record, workspace_root)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| record.location.clone());
    let content = render_skill_instruction_content(&record.name, &path, &record.body);
    SkillInstructionInjection {
        name: record.name.clone(),
        path,
        fingerprint: loaded.fingerprint.clone(),
        source_scope: record.source_scope.clone(),
        content,
    }
}

#[allow(dead_code)]
pub fn skill_instruction_message(injection: &SkillInstructionInjection) -> Value {
    json!({
        "role": "user",
        "content": injection.content,
        "metadata": {
            "redboxContextType": "skillInstructions",
            "skillName": injection.name,
            "skillPath": injection.path,
            "skillFingerprint": injection.fingerprint,
            "sourceScope": injection.source_scope,
        }
    })
}

pub fn is_skill_instruction_content(content: &str) -> bool {
    let text = content.trim();
    text.starts_with("<skill>\n") && text.contains("</skill>")
}

pub fn is_available_skills_instruction_content(content: &str) -> bool {
    let text = content.trim();
    text.starts_with("<skills_instructions>\n") && text.contains("</skills_instructions>")
}

pub fn is_skill_instruction_message(message: &Value) -> bool {
    message
        .get("metadata")
        .and_then(|value| value.get("redboxContextType"))
        .and_then(Value::as_str)
        .map(|value| value == "skillInstructions" || value == "availableSkillsInstructions")
        .unwrap_or(false)
        || message
            .get("content")
            .and_then(Value::as_str)
            .map(|content| {
                is_skill_instruction_content(content)
                    || is_available_skills_instruction_content(content)
            })
            .unwrap_or(false)
}

#[allow(dead_code)]
pub fn message_contains_skill_instruction(
    message: &Value,
    injection: &SkillInstructionInjection,
) -> bool {
    message
        .get("content")
        .and_then(Value::as_str)
        .map(|content| content == injection.content)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillMetadataRecord;

    #[test]
    fn render_skill_instruction_content_uses_codex_shape() {
        let rendered = render_skill_instruction_content(
            "demo",
            "/tmp/demo/SKILL.md",
            "---\nname: demo\n---\n# Demo\n\nFollow this.",
        );

        assert!(rendered.starts_with("<skill>\n<name>demo</name>"));
        assert!(rendered.contains("<path>/tmp/demo/SKILL.md</path>"));
        assert!(rendered.contains("# Demo\n\nFollow this."));
        assert!(rendered.ends_with("</skill>"));
    }

    #[test]
    fn skill_instruction_message_keeps_metadata_outside_provider_content() {
        let record = SkillRecord {
            name: "demo".to_string(),
            description: "desc".to_string(),
            location: "skills://demo".to_string(),
            body: "# Demo".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        };
        let loaded = LoadedSkillRecord {
            name: "demo".to_string(),
            description: "desc".to_string(),
            location: "skills://demo".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: true,
            disabled: false,
            metadata: SkillMetadataRecord::default(),
            body: "# Demo".to_string(),
            fingerprint: "fp".to_string(),
        };

        let injection = build_skill_instruction_injection(&record, &loaded, None);
        let message = skill_instruction_message(&injection);

        assert_eq!(message.get("role").and_then(Value::as_str), Some("user"));
        assert!(message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("<skill>"));
        assert_eq!(
            message
                .get("metadata")
                .and_then(|value| value.get("redboxContextType"))
                .and_then(Value::as_str),
            Some("skillInstructions")
        );
        assert!(is_skill_instruction_message(&message));
    }
}
