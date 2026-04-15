use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ScriptExecutionRequest {
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub runtime_mode: String,
    pub inputs: Value,
    pub program: ScriptProgram,
    pub limits: Option<ScriptExecutionLimitOverrides>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ScriptProgram {
    pub version: String,
    pub steps: Vec<ScriptStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ScriptStep {
    Tool {
        #[serde(default)]
        id: Option<String>,
        tool: String,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        save_as: Option<String>,
    },
    ForEach {
        #[serde(default)]
        id: Option<String>,
        items: String,
        #[serde(default)]
        item_as: Option<String>,
        #[serde(default)]
        max_items: Option<usize>,
        steps: Vec<ScriptStep>,
    },
    StdoutWrite {
        #[serde(default)]
        id: Option<String>,
        text: String,
    },
    ArtifactWrite {
        #[serde(default)]
        id: Option<String>,
        path: String,
        content: String,
        #[serde(default)]
        save_as: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ScriptExecutionLimitOverrides {
    pub timeout_ms: Option<u64>,
    pub max_stdout_chars: Option<usize>,
    pub max_tool_calls: Option<usize>,
    pub max_artifacts: Option<usize>,
    pub max_artifact_chars: Option<usize>,
    pub max_steps: Option<usize>,
    pub max_loop_items: Option<usize>,
    pub max_fs_read_chars: Option<usize>,
    pub max_fs_list_entries: Option<usize>,
    pub max_recall_chars: Option<usize>,
    pub max_recall_hits: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ScriptStepSummary {
    pub id: Option<String>,
    pub op: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ScriptExecutionResult {
    pub success: bool,
    pub execution_id: String,
    pub runtime_mode: String,
    pub stdout: String,
    pub stdout_truncated: bool,
    pub artifact_paths: Vec<String>,
    pub tool_call_count: usize,
    pub step_count: usize,
    pub temp_workspace: String,
    pub error_summary: Option<String>,
    pub estimated_prompt_reduction_chars: usize,
    pub executed_tools: Vec<String>,
    pub step_summaries: Vec<ScriptStepSummary>,
    pub limit_summary: Value,
}
