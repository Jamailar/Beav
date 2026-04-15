use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::agent::{ContextScanWarning, ContextTruncationStrategy};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSection {
    pub id: String,
    pub title: String,
    pub source: String,
    pub priority: i64,
    pub max_chars: usize,
    pub truncation_strategy: ContextTruncationStrategy,
    pub raw_chars: usize,
    pub final_chars: usize,
    pub truncated: bool,
    pub scan_warnings: Vec<ContextScanWarning>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundle {
    pub session_id: Option<String>,
    pub runtime_mode: String,
    pub generated_at: String,
    pub sections: Vec<ContextSection>,
}

impl ContextBundle {
    pub fn total_raw_chars(&self) -> usize {
        self.sections.iter().map(|item| item.raw_chars).sum()
    }

    pub fn total_final_chars(&self) -> usize {
        self.sections.iter().map(|item| item.final_chars).sum()
    }

    pub fn truncated_section_ids(&self) -> Vec<String> {
        self.sections
            .iter()
            .filter(|item| item.truncated)
            .map(|item| item.id.clone())
            .collect()
    }

    pub fn scan_warnings(&self) -> Vec<ContextScanWarning> {
        self.sections
            .iter()
            .flat_map(|item| item.scan_warnings.clone())
            .collect()
    }

    pub fn fingerprint(&self) -> String {
        let mut hasher = DefaultHasher::new();
        self.runtime_mode.hash(&mut hasher);
        self.session_id.hash(&mut hasher);
        for section in &self.sections {
            section.id.hash(&mut hasher);
            section.final_chars.hash(&mut hasher);
            section.content.hash(&mut hasher);
        }
        format!("{:x}", hasher.finish())
    }

    pub fn render_prompt(&self) -> String {
        let mut lines = vec![format!(
            "# Runtime Context Bundle\nmode: {}\nsession: {}",
            self.runtime_mode,
            self.session_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("none")
        )];
        for section in &self.sections {
            if section.content.trim().is_empty() {
                continue;
            }
            lines.push(String::new());
            lines.push(format!("## {}", section.title));
            lines.push(section.content.trim().to_string());
        }
        lines.join("\n")
    }

    pub fn summary_payload(&self) -> Value {
        let rendered_prompt = self.render_prompt();
        json!({
            "fingerprint": self.fingerprint(),
            "sessionId": self.session_id,
            "runtimeMode": self.runtime_mode,
            "generatedAt": self.generated_at,
            "totalRawChars": self.total_raw_chars(),
            "totalFinalChars": self.total_final_chars(),
            "renderedPromptChars": rendered_prompt.chars().count(),
            "truncatedSections": self.truncated_section_ids(),
            "scanWarnings": self.scan_warnings(),
            "sections": self.sections.iter().map(|section| {
                json!({
                    "id": section.id,
                    "title": section.title,
                    "source": section.source,
                    "priority": section.priority,
                    "maxChars": section.max_chars,
                    "rawChars": section.raw_chars,
                    "finalChars": section.final_chars,
                    "truncated": section.truncated,
                    "scanWarnings": section.scan_warnings,
                    "contentPreview": section.content.chars().take(500).collect::<String>(),
                })
            }).collect::<Vec<_>>(),
        })
    }
}
