use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ForkOverrides {
    pub allowed_tools: Vec<String>,
    pub model_override: Option<String>,
    pub reasoning_effort_override: Option<String>,
    pub system_prompt_patch: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentConfig {
    pub role_id: String,
    pub runtime_mode: String,
    pub parent_task_id: String,
    pub parent_session_id: Option<String>,
    pub parallel_group: usize,
    pub model_config: Option<Value>,
    pub fork_overrides: ForkOverrides,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentSpawnResult {
    pub child_task_id: String,
    pub child_session_id: String,
    pub child_runtime_id: String,
    pub role_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentOutput {
    pub role_id: String,
    pub summary: String,
    pub artifact: Option<String>,
    pub handoff: Option<String>,
    pub risks: Vec<Value>,
    pub issues: Vec<Value>,
    pub approved: bool,
    pub child_task_id: Option<String>,
    pub child_session_id: Option<String>,
    pub status: String,
}
