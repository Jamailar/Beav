use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{make_id, now_i64};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub oauth: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHookRecord {
    pub id: String,
    pub event: String,
    pub r#type: String,
    pub matcher: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub name: String,
    pub description: String,
    pub location: String,
    pub body: String,
    pub source_scope: Option<String>,
    pub is_builtin: Option<bool>,
    pub disabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptRecord {
    pub id: String,
    pub session_id: String,
    pub record_type: String,
    pub role: String,
    pub content: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawScheduledTaskRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub mode: String,
    pub prompt: String,
    pub project_id: Option<String>,
    pub interval_minutes: Option<i64>,
    pub time: Option<String>,
    pub weekdays: Option<Vec<i64>>,
    pub run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
    pub next_run_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawLongCycleTaskRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub status: String,
    pub objective: String,
    pub step_prompt: String,
    pub project_id: Option<String>,
    pub interval_minutes: i64,
    pub total_rounds: i64,
    pub completed_rounds: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
    pub next_run_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawProjectRecord {
    pub id: String,
    pub goal: String,
    pub platform: Option<String>,
    pub task_type: Option<String>,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RedclawJobDefinitionRecord {
    pub id: String,
    pub source_kind: Option<String>,
    pub source_task_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub enabled: bool,
    pub owner_context_id: Option<String>,
    pub runtime_mode: String,
    pub trigger_kind: String,
    pub progression_kind: String,
    pub payload: Value,
    pub next_due_at: Option<String>,
    pub last_enqueued_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RedclawJobExecutionRecord {
    pub id: String,
    pub definition_id: String,
    pub status: String,
    pub attempt_count: i64,
    pub worker_id: Option<String>,
    pub worker_mode: String,
    pub session_id: Option<String>,
    pub runtime_task_id: Option<String>,
    pub started_at: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub heartbeat_timeout_ms: Option<i64>,
    pub completed_at: Option<String>,
    pub last_error: Option<String>,
    pub input_snapshot: Option<Value>,
    pub output_summary: Option<String>,
    pub artifacts: Vec<Value>,
    pub checkpoints: Vec<Value>,
    pub retry_not_before_at: Option<String>,
    pub cancel_requested_at: Option<String>,
    pub cancel_reason: Option<String>,
    pub dead_lettered_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedclawStateRecord {
    pub enabled: bool,
    pub lock_state: String,
    pub blocked_by: Option<String>,
    pub interval_minutes: i64,
    pub keep_alive_when_no_window: bool,
    pub max_projects_per_tick: i64,
    pub max_automation_per_tick: i64,
    pub is_ticking: bool,
    pub current_project_id: Option<String>,
    pub current_automation_task_id: Option<String>,
    pub next_automation_fire_at: Option<String>,
    pub in_flight_task_ids: Vec<String>,
    pub in_flight_long_cycle_task_ids: Vec<String>,
    pub heartbeat_in_flight: bool,
    pub last_tick_at: Option<String>,
    pub next_tick_at: Option<String>,
    pub next_maintenance_at: Option<String>,
    pub last_error: Option<String>,
    pub heartbeat: Value,
    pub scheduled_tasks: Vec<RedclawScheduledTaskRecord>,
    pub long_cycle_tasks: Vec<RedclawLongCycleTaskRecord>,
    pub projects: Vec<RedclawProjectRecord>,
}

impl Default for RedclawStateRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            lock_state: "owner".to_string(),
            blocked_by: None,
            interval_minutes: 20,
            keep_alive_when_no_window: true,
            max_projects_per_tick: 1,
            max_automation_per_tick: 2,
            is_ticking: false,
            current_project_id: None,
            current_automation_task_id: None,
            next_automation_fire_at: None,
            in_flight_task_ids: Vec::new(),
            in_flight_long_cycle_task_ids: Vec::new(),
            heartbeat_in_flight: false,
            last_tick_at: None,
            next_tick_at: None,
            next_maintenance_at: None,
            last_error: Some("RedClaw runner is idle.".to_string()),
            heartbeat: json!({
                "enabled": true,
                "intervalMinutes": 30,
                "suppressEmptyReport": true,
                "reportToMainSession": true
            }),
            scheduled_tasks: Vec::new(),
            long_cycle_tasks: Vec::new(),
            projects: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionCheckpointRecord {
    pub id: String,
    pub session_id: String,
    pub runtime_id: Option<String>,
    pub parent_runtime_id: Option<String>,
    pub source_task_id: Option<String>,
    pub checkpoint_type: String,
    pub summary: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionToolResultRecord {
    pub id: String,
    pub session_id: String,
    pub runtime_id: Option<String>,
    pub parent_runtime_id: Option<String>,
    pub source_task_id: Option<String>,
    pub call_id: String,
    pub tool_name: String,
    pub command: Option<String>,
    pub success: bool,
    pub result_text: Option<String>,
    pub summary_text: Option<String>,
    pub prompt_text: Option<String>,
    pub original_chars: Option<i64>,
    pub prompt_chars: Option<i64>,
    pub truncated: bool,
    pub payload: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct IntentRoute {
    pub intent: String,
    pub secondary_intents: Vec<String>,
    pub goal: String,
    pub deliverables: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub recommended_role: String,
    pub requires_long_running_task: bool,
    pub requires_multi_agent: bool,
    pub requires_human_approval: bool,
    pub confidence: f64,
    pub reasoning: String,
    pub source: String,
}

impl IntentRoute {
    pub fn from_value(route: &Value) -> Option<Self> {
        serde_json::from_value(route.clone()).ok()
    }

    pub fn into_value(self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

pub type RuntimeRouteRecord = IntentRoute;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub status: String,
    pub title: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub summary: Option<String>,
    pub error: Option<String>,
}

pub type RuntimeGraphNodeRecord = RuntimeNode;
pub type RuntimeGraph = Vec<RuntimeNode>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeCheckpoint {
    pub id: String,
    #[serde(rename = "type", alias = "checkpointType")]
    pub checkpoint_type: String,
    pub node_id: String,
    pub summary: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}

impl RuntimeCheckpoint {
    pub fn new(
        checkpoint_type: impl Into<String>,
        node_id: impl Into<String>,
        summary: impl Into<String>,
        payload: Option<Value>,
    ) -> Self {
        Self {
            id: make_id("task-checkpoint"),
            checkpoint_type: checkpoint_type.into(),
            node_id: node_id.into(),
            summary: summary.into(),
            payload,
            created_at: now_i64(),
        }
    }
}

pub type RuntimeCheckpointRecord = RuntimeCheckpoint;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeArtifact {
    pub id: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub label: String,
    pub path: Option<String>,
    pub metadata: Option<Value>,
    pub payload: Option<Value>,
    pub created_at: i64,
}

impl RuntimeArtifact {
    pub fn new(
        artifact_type: impl Into<String>,
        label: impl Into<String>,
        path: Option<String>,
        metadata: Option<Value>,
        payload: Option<Value>,
    ) -> Self {
        Self {
            id: make_id("artifact"),
            artifact_type: artifact_type.into(),
            label: label.into(),
            path,
            metadata,
            payload,
            created_at: now_i64(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeTask {
    pub id: String,
    pub runtime_id: Option<String>,
    pub parent_runtime_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub root_task_id: Option<String>,
    pub child_task_ids: Vec<String>,
    pub aggregation_status: Option<String>,
    pub task_type: String,
    pub status: String,
    pub runtime_mode: String,
    pub owner_session_id: Option<String>,
    pub intent: Option<String>,
    pub role_id: Option<String>,
    pub goal: Option<String>,
    pub current_node: Option<String>,
    pub route: Option<IntentRoute>,
    pub graph: RuntimeGraph,
    pub artifacts: Vec<RuntimeArtifact>,
    pub checkpoints: Vec<RuntimeCheckpoint>,
    pub metadata: Option<Value>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

pub type RuntimeTaskRecord = RuntimeTask;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeTrace {
    pub id: i64,
    pub task_id: String,
    pub runtime_id: Option<String>,
    pub parent_runtime_id: Option<String>,
    pub source_task_id: Option<String>,
    pub node_id: Option<String>,
    pub event_type: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}

impl RuntimeTrace {
    pub fn new(
        task_id: &str,
        runtime_id: Option<String>,
        parent_runtime_id: Option<String>,
        source_task_id: Option<String>,
        node_id: Option<String>,
        event_type: &str,
        payload: Option<Value>,
    ) -> Self {
        let created_at = now_i64();
        Self {
            id: created_at,
            task_id: task_id.to_string(),
            runtime_id,
            parent_runtime_id,
            source_task_id,
            node_id,
            event_type: event_type.to_string(),
            payload,
            created_at,
        }
    }
}

pub type RuntimeTaskTraceRecord = RuntimeTrace;

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedChatConfig {
    pub protocol: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_name: String,
}

#[derive(Debug, Clone)]
pub struct InteractiveToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeSubagentRoleSpec {
    pub role_id: String,
    pub purpose: String,
    pub handoff_contract: String,
    pub output_schema: String,
    pub system_prompt: String,
}

#[derive(Clone, Default)]
pub struct RuntimeWarmEntry {
    pub mode: String,
    pub system_prompt: String,
    pub model_config: Option<Value>,
    pub long_term_context: Option<String>,
    pub warmed_at: i64,
}

#[derive(Default)]
pub struct RuntimeWarmState {
    pub entries: HashMap<String, RuntimeWarmEntry>,
    pub settings_fingerprint: String,
    pub last_warmed_at: i64,
}

pub struct RedclawRuntime {
    pub stop: Arc<AtomicBool>,
    pub scheduler_join: Option<JoinHandle<()>>,
    pub runner_join: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub struct PreparedTaskResumeExecution {
    pub route: IntentRoute,
    pub route_value: Value,
    pub orchestration: Option<Value>,
    pub repair_plan: Option<Value>,
    pub repair_orchestration: Option<Value>,
    pub reviewer_blocked: bool,
    pub repair_pass_failed: bool,
}

#[derive(Debug)]
pub struct AppliedTaskResumeExecution {
    pub response: Value,
    pub runtime_node_events: Vec<(String, String, Option<String>, Option<String>)>,
    pub runtime_checkpoint_events: Vec<(String, String, Option<Value>)>,
}
