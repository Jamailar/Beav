use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRecallItem {
    pub id: String,
    pub memory_type: String,
    pub content_preview: String,
    pub score: f64,
    pub match_reasons: Vec<String>,
    pub tags: Vec<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRecallSummary {
    pub query: String,
    pub total_active: usize,
    pub matched_count: usize,
    pub items: Vec<MemoryRecallItem>,
    pub rendered_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryPromptSection {
    pub title: String,
    pub summary: String,
    pub total_active: usize,
    pub matched_count: usize,
    pub rendered_chars: usize,
}
