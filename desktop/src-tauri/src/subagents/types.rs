use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::tools::catalog::ApprovalLevel;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentContextPolicy {
    pub inherit_workspace_context: bool,
    pub inherit_editor_binding: bool,
    pub inherit_profile_docs: bool,
    pub include_parent_goal: bool,
    pub include_prior_outputs: bool,
    pub include_recent_transcript: bool,
    pub max_recent_messages: usize,
    pub max_prior_output_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentMemoryPolicy {
    pub read_scopes: Vec<String>,
    pub write_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentBudget {
    pub max_prompt_chars: usize,
    pub max_response_chars: usize,
    pub max_prior_outputs: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentResultContract {
    pub require_summary: bool,
    pub require_artifact_refs: bool,
    pub require_findings: bool,
    pub require_risks: bool,
    pub require_handoff: bool,
    pub require_approvals_requested: bool,
}

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
    pub child_runtime_type: String,
    pub runtime_mode: String,
    pub parent_task_id: String,
    pub parent_session_id: Option<String>,
    pub parallel_group: usize,
    pub model_config: Option<Value>,
    pub context_policy: SubAgentContextPolicy,
    pub memory_policy: SubAgentMemoryPolicy,
    pub approval_policy: ApprovalLevel,
    pub budget: SubAgentBudget,
    pub result_contract: SubAgentResultContract,
    pub fork_overrides: ForkOverrides,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentSpawnResult {
    pub child_task_id: String,
    pub child_session_id: String,
    pub child_runtime_id: String,
    pub role_id: String,
    pub child_runtime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SubAgentOutput {
    pub role_id: String,
    pub child_runtime_type: String,
    pub summary: String,
    pub artifact: Option<String>,
    pub artifact_refs: Vec<Value>,
    pub findings: Vec<Value>,
    pub handoff: Option<String>,
    pub risks: Vec<Value>,
    pub issues: Vec<Value>,
    pub approvals_requested: Vec<Value>,
    pub approved: bool,
    pub child_task_id: Option<String>,
    pub child_session_id: Option<String>,
    pub child_runtime_id: Option<String>,
    pub status: String,
}
