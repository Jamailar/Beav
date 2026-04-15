use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MEMORY_TYPE_USER_PROFILE: &str = "user_profile";
pub const MEMORY_TYPE_WORKSPACE_FACT: &str = "workspace_fact";
pub const MEMORY_TYPE_TASK_LEARNING: &str = "task_learning";

pub fn normalize_memory_type(raw: Option<&str>) -> String {
    let normalized = raw.unwrap_or_default().trim().to_lowercase();
    match normalized.as_str() {
        MEMORY_TYPE_USER_PROFILE | "preference" | "user" | "profile" => {
            MEMORY_TYPE_USER_PROFILE.to_string()
        }
        MEMORY_TYPE_TASK_LEARNING | "learning" | "lesson" | "workflow" => {
            MEMORY_TYPE_TASK_LEARNING.to_string()
        }
        MEMORY_TYPE_WORKSPACE_FACT | "fact" | "general" | "" => {
            MEMORY_TYPE_WORKSPACE_FACT.to_string()
        }
        other => other.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionLineageSummary {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub root_session_id: Option<String>,
    pub runtime_id: Option<String>,
    pub parent_runtime_id: Option<String>,
    pub source_task_id: Option<String>,
    pub forked_from_checkpoint_id: Option<String>,
    pub resumed_from_checkpoint_id: Option<String>,
    pub compacted_checkpoint_id: Option<String>,
    pub compact_rounds: i64,
    pub compacted_message_count: i64,
    pub last_compacted_at: Option<String>,
    pub lineage_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MemoryRecallRequest {
    pub query: String,
    pub session_id: Option<String>,
    pub runtime_id: Option<String>,
    pub sources: Vec<String>,
    pub memory_types: Vec<String>,
    pub include_archived: bool,
    pub include_child_sessions: bool,
    pub limit: usize,
    pub max_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MemoryRecallHit {
    pub id: String,
    pub source_kind: String,
    pub source_label: String,
    pub title: Option<String>,
    pub summary: String,
    pub excerpt: Option<String>,
    pub score: f64,
    pub match_reasons: Vec<String>,
    pub session_id: Option<String>,
    pub runtime_id: Option<String>,
    pub source_task_id: Option<String>,
    pub memory_type: Option<String>,
    pub created_at: Value,
    pub updated_at: Option<Value>,
    pub lineage: Option<SessionLineageSummary>,
    pub payload: Option<Value>,
}
