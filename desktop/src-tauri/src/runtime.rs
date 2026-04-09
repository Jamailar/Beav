use std::collections::HashMap;
use std::path::Path;
use std::sync::{atomic::AtomicBool, Arc};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpointRecord {
    pub id: String,
    pub session_id: String,
    pub checkpoint_type: String,
    pub summary: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionToolResultRecord {
    pub id: String,
    pub session_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTaskRecord {
    pub id: String,
    pub task_type: String,
    pub status: String,
    pub runtime_mode: String,
    pub owner_session_id: Option<String>,
    pub intent: Option<String>,
    pub role_id: Option<String>,
    pub goal: Option<String>,
    pub current_node: Option<String>,
    pub route: Option<Value>,
    pub graph: Vec<Value>,
    pub artifacts: Vec<Value>,
    pub checkpoints: Vec<Value>,
    pub metadata: Option<Value>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTaskTraceRecord {
    pub id: i64,
    pub task_id: String,
    pub node_id: Option<String>,
    pub event_type: String,
    pub payload: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRouteRecord {
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

impl RuntimeRouteRecord {
    pub fn from_value(route: &Value) -> Option<Self> {
        serde_json::from_value(route.clone()).ok()
    }

    pub fn into_value(self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGraphNodeRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub status: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RuntimeGraphNodeRecord {
    pub fn into_value(self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

#[derive(Debug, Clone)]
pub struct ChatExecutionResult {
    pub session_id: String,
    pub response: String,
    pub title_update: Option<(String, String)>,
}

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
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
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
    pub join: Option<JoinHandle<()>>,
}

pub const RUNTIME_INTENT_NAMES: &[&str] = &[
    "direct_answer",
    "file_operation",
    "manuscript_creation",
    "image_creation",
    "cover_generation",
    "knowledge_retrieval",
    "long_running_task",
    "discussion",
    "memory_maintenance",
    "automation",
    "advisor_persona",
];

pub const RUNTIME_ROLE_IDS: &[&str] = &[
    "planner",
    "researcher",
    "copywriter",
    "image-director",
    "reviewer",
    "ops-coordinator",
];

pub fn normalize_runtime_intent_name(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or("").trim();
    if RUNTIME_INTENT_NAMES.contains(&normalized) {
        Some(normalized.to_string())
    } else {
        None
    }
}

pub fn normalize_runtime_role_id(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or("").trim();
    if RUNTIME_ROLE_IDS.contains(&normalized) {
        Some(normalized.to_string())
    } else {
        None
    }
}

pub fn runtime_required_capabilities(intent: &str) -> Vec<String> {
    match intent {
        "manuscript_creation" => vec![
            "planning".to_string(),
            "writing".to_string(),
            "artifact-save".to_string(),
        ],
        "image_creation" | "cover_generation" => vec![
            "planning".to_string(),
            "image-generation".to_string(),
            "artifact-save".to_string(),
        ],
        "knowledge_retrieval" | "advisor_persona" => vec![
            "knowledge-retrieval".to_string(),
            "evidence-synthesis".to_string(),
        ],
        "automation" | "long_running_task" => vec![
            "task-graph".to_string(),
            "background-runner".to_string(),
            "artifact-save".to_string(),
        ],
        "memory_maintenance" => vec![
            "memory-read".to_string(),
            "memory-write".to_string(),
            "profile-doc".to_string(),
        ],
        "discussion" => vec!["multi-agent-discussion".to_string()],
        "file_operation" => vec!["file-read-write".to_string()],
        _ => vec!["direct-answer".to_string()],
    }
}

pub fn runtime_default_intent(runtime_mode: &str, metadata: Option<&Value>) -> String {
    if let Some(forced) = metadata
        .and_then(|value| payload_field(value, "intent"))
        .and_then(|value| value.as_str())
        .and_then(|value| normalize_runtime_intent_name(Some(value)))
    {
        return forced;
    }
    let metadata = metadata.and_then(Value::as_object);
    match runtime_mode {
        "background-maintenance" => "automation".to_string(),
        "knowledge" => "knowledge_retrieval".to_string(),
        "chatroom" | "advisor-discussion" => "discussion".to_string(),
        _ => {
            if metadata.and_then(|m| m.get("longCycleTaskId")).is_some()
                || metadata.and_then(|m| m.get("longCycleRound")).is_some()
                || metadata.and_then(|m| m.get("longCycleStep")).is_some()
            {
                "long_running_task".to_string()
            } else if metadata.and_then(|m| m.get("scheduledTaskId")).is_some()
                || metadata.and_then(|m| m.get("automationId")).is_some()
                || metadata.and_then(|m| m.get("runnerReason")).is_some()
            {
                "automation".to_string()
            } else {
                "manuscript_creation".to_string()
            }
        }
    }
}

pub fn runtime_default_role(runtime_mode: &str, intent: &str, metadata: Option<&Value>) -> String {
    if let Some(preferred) = metadata
        .and_then(|value| payload_field(value, "preferredRole"))
        .and_then(|value| value.as_str())
        .and_then(|value| normalize_runtime_role_id(Some(value)))
    {
        return preferred;
    }
    match runtime_mode {
        "knowledge" => "researcher".to_string(),
        "chatroom" => "ops-coordinator".to_string(),
        "advisor-discussion" => "researcher".to_string(),
        "background-maintenance" => "ops-coordinator".to_string(),
        _ => match intent {
            "knowledge_retrieval" | "advisor_persona" => "researcher".to_string(),
            "image_creation" | "cover_generation" => "image-director".to_string(),
            "automation" | "long_running_task" | "memory_maintenance" => {
                "ops-coordinator".to_string()
            }
            "discussion" | "direct_answer" | "file_operation" => "planner".to_string(),
            _ => "copywriter".to_string(),
        },
    }
}

pub fn runtime_direct_route(
    runtime_mode: &str,
    user_input: &str,
    metadata: Option<&Value>,
) -> Value {
    runtime_direct_route_record(runtime_mode, user_input, metadata).into_value()
}

pub fn runtime_direct_route_record(
    runtime_mode: &str,
    user_input: &str,
    metadata: Option<&Value>,
) -> RuntimeRouteRecord {
    let intent = runtime_default_intent(runtime_mode, metadata);
    let role = runtime_default_role(runtime_mode, &intent, metadata);
    let requires_multi_agent = metadata
        .and_then(|value| payload_field(value, "forceMultiAgent"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || metadata
            .and_then(|value| payload_field(value, "subagentRoles"))
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false)
        || intent == "advisor_persona";
    let requires_long_running = runtime_mode == "background-maintenance"
        || intent == "automation"
        || intent == "long_running_task"
        || metadata
            .and_then(|value| payload_field(value, "forceLongRunningTask"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    RuntimeRouteRecord {
        intent: intent.clone(),
        secondary_intents: Vec::new(),
        goal: if user_input.trim().is_empty() {
            "处理当前用户请求".to_string()
        } else {
            user_input.trim().to_string()
        },
        deliverables: Vec::new(),
        required_capabilities: runtime_required_capabilities(&intent),
        recommended_role: role.clone(),
        requires_long_running_task: requires_long_running,
        requires_multi_agent: requires_multi_agent,
        requires_human_approval: metadata
            .and_then(|value| payload_field(value, "requiresHumanApproval"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        confidence: if intent == "direct_answer" {
            0.55
        } else {
            0.92
        },
        reasoning: format!(
            "runtime-mode-default:{}; intent={}; role={}",
            runtime_mode, intent, role
        ),
        source: "rule".to_string(),
    }
}

pub fn runtime_graph_for_route(route: &Value) -> Vec<Value> {
    runtime_graph_for_route_record(route)
        .into_iter()
        .map(RuntimeGraphNodeRecord::into_value)
        .collect()
}

pub fn runtime_graph_for_route_record(route: &Value) -> Vec<RuntimeGraphNodeRecord> {
    let typed_route = RuntimeRouteRecord::from_value(route);
    let requires_multi_agent = typed_route
        .as_ref()
        .map(|item| item.requires_multi_agent)
        .unwrap_or_else(|| {
            route
                .get("requiresMultiAgent")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    let requires_long_running = if let Some(route) = typed_route.as_ref() {
        route.requires_long_running_task
    } else {
        route
            .get("requiresLongRunningTask")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let mut nodes = vec![
        RuntimeGraphNodeRecord {
            id: "plan".to_string(),
            node_type: "plan".to_string(),
            status: "pending".to_string(),
            title: "Plan".to_string(),
            summary: None,
            error: None,
        },
        RuntimeGraphNodeRecord {
            id: "retrieve".to_string(),
            node_type: "retrieve".to_string(),
            status: "pending".to_string(),
            title: "Retrieve".to_string(),
            summary: None,
            error: None,
        },
    ];
    if requires_multi_agent || requires_long_running {
        nodes.push(RuntimeGraphNodeRecord {
            id: "spawn_agents".to_string(),
            node_type: "spawn_agents".to_string(),
            status: "pending".to_string(),
            title: "Spawn Agents".to_string(),
            summary: None,
            error: None,
        });
        nodes.push(RuntimeGraphNodeRecord {
            id: "handoff".to_string(),
            node_type: "handoff".to_string(),
            status: "pending".to_string(),
            title: "Handoff".to_string(),
            summary: None,
            error: None,
        });
        nodes.push(RuntimeGraphNodeRecord {
            id: "review".to_string(),
            node_type: "review".to_string(),
            status: "pending".to_string(),
            title: "Review".to_string(),
            summary: None,
            error: None,
        });
    }
    nodes.push(RuntimeGraphNodeRecord {
        id: "execute_tools".to_string(),
        node_type: "execute_tools".to_string(),
        status: "pending".to_string(),
        title: "Execute".to_string(),
        summary: None,
        error: None,
    });
    nodes.push(RuntimeGraphNodeRecord {
        id: "save_artifact".to_string(),
        node_type: "save_artifact".to_string(),
        status: "pending".to_string(),
        title: "Save Artifact".to_string(),
        summary: None,
        error: None,
    });
    nodes
}

pub fn set_runtime_graph_node(
    graph: &mut [Value],
    node_id: &str,
    status: &str,
    summary: Option<String>,
    error: Option<String>,
) {
    if let Some(node) = graph
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(node_id))
    {
        if let Some(object) = node.as_object_mut() {
            object.insert("status".to_string(), json!(status));
            if let Some(summary) = summary {
                object.insert("summary".to_string(), json!(summary));
            }
            if let Some(error) = error {
                object.insert("error".to_string(), json!(error));
            }
        }
    }
}

pub fn role_sequence_for_route(route: &Value) -> Vec<String> {
    let intent = payload_string(route, "intent").unwrap_or_default();
    match intent.as_str() {
        "manuscript_creation" | "advisor_persona" => vec![
            "planner".to_string(),
            "researcher".to_string(),
            "copywriter".to_string(),
            "reviewer".to_string(),
        ],
        "cover_generation" | "image_creation" => vec![
            "planner".to_string(),
            "researcher".to_string(),
            "image-director".to_string(),
            "reviewer".to_string(),
        ],
        "knowledge_retrieval" => vec![
            "planner".to_string(),
            "researcher".to_string(),
            "reviewer".to_string(),
        ],
        "automation" | "long_running_task" | "memory_maintenance" => vec![
            "planner".to_string(),
            "ops-coordinator".to_string(),
            "reviewer".to_string(),
        ],
        _ => {
            vec![payload_string(route, "recommendedRole").unwrap_or_else(|| "planner".to_string())]
        }
    }
}

pub fn runtime_task_value(task: &RuntimeTaskRecord) -> Value {
    json!({
        "id": task.id,
        "taskType": task.task_type,
        "status": task.status,
        "runtimeMode": task.runtime_mode,
        "ownerSessionId": task.owner_session_id,
        "intent": task.intent,
        "roleId": task.role_id,
        "goal": task.goal,
        "currentNode": task.current_node,
        "route": task.route,
        "graph": task.graph,
        "artifacts": task.artifacts,
        "checkpoints": task.checkpoints,
        "metadata": task.metadata,
        "lastError": task.last_error,
        "createdAt": task.created_at,
        "updatedAt": task.updated_at,
        "startedAt": task.started_at,
        "completedAt": task.completed_at,
    })
}

pub fn runtime_warm_settings_fingerprint(settings: &Value, workspace_root: &Path) -> String {
    let mut parts = Vec::new();
    parts.push(workspace_root.display().to_string());
    for key in [
        "api_endpoint",
        "api_key",
        "model_name",
        "model_name_wander",
        "default_ai_source_id",
        "ai_sources_json",
        "redbox_auth_session_json",
    ] {
        parts.push(payload_string(settings, key).unwrap_or_default());
    }
    parts.join("::")
}

pub fn session_title_from_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "New Chat".to_string();
    }
    trimmed.chars().take(24).collect()
}

pub fn resolve_runtime_mode_from_context_type(value: Option<&str>) -> &'static str {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    match normalized.as_str() {
        "wander" => "wander",
        "redclaw" => "redclaw",
        "knowledge" | "note" | "video" | "youtube" | "document" | "link-article"
        | "wechat-article" => "knowledge",
        "advisor-discussion" => "advisor-discussion",
        "background-maintenance" => "background-maintenance",
        _ => "chatroom",
    }
}

pub fn infer_protocol(base_url: &str, preset_id: Option<&str>, explicit: Option<&str>) -> String {
    if let Some(protocol) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return protocol.to_string();
    }
    if let Some(preset) = preset_id.map(str::trim).filter(|value| !value.is_empty()) {
        if preset.contains("anthropic") {
            return "anthropic".to_string();
        }
        if preset.contains("gemini") {
            return "gemini".to_string();
        }
    }
    let lower = base_url.to_lowercase();
    if lower.contains("anthropic") {
        return "anthropic".to_string();
    }
    if lower.contains("gemini")
        || lower.contains("googleapis.com")
        || lower.contains("generativelanguage")
    {
        return "gemini".to_string();
    }
    "openai".to_string()
}

pub fn resolve_chat_config(
    settings: &Value,
    model_config: Option<&Value>,
) -> Option<ResolvedChatConfig> {
    let model_config = model_config.cloned().unwrap_or_else(|| json!({}));
    let base_url = model_config
        .get("baseURL")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "api_endpoint"))
        .unwrap_or_default();
    let model_name = model_config
        .get("modelName")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "model_name"))
        .unwrap_or_default();
    if base_url.trim().is_empty() || model_name.trim().is_empty() {
        return None;
    }
    let api_key = model_config
        .get("apiKey")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| payload_string(settings, "api_key"));
    let protocol = model_config
        .get("protocol")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| infer_protocol(&base_url, None, None));
    Some(ResolvedChatConfig {
        protocol,
        base_url,
        api_key,
        model_name,
    })
}

pub fn next_memory_maintenance_at_ms(response: &str, now_ms: i64) -> i64 {
    if response.chars().count() > 1200 {
        now_ms + 5 * 60 * 1000
    } else {
        now_ms + 20 * 60 * 1000
    }
}

pub fn runtime_subagent_role_spec(role_id: &str) -> RuntimeSubagentRoleSpec {
    match role_id {
        "planner" => RuntimeSubagentRoleSpec {
            role_id: "planner".to_string(),
            purpose: "负责拆解目标、确定阶段顺序、把任务转成明确执行步骤。".to_string(),
            handoff_contract: "把任务拆成可执行步骤，并给出下一角色所需最小输入。".to_string(),
            output_schema: "阶段计划、执行建议、关键依赖、保存策略".to_string(),
            system_prompt:
                "你是任务规划者，优先澄清目标、阶段、依赖和落盘动作，不要直接跳到模糊回答。"
                    .to_string(),
        },
        "researcher" => RuntimeSubagentRoleSpec {
            role_id: "researcher".to_string(),
            purpose: "负责检索知识、提取证据、整理素材、形成研究摘要。".to_string(),
            handoff_contract: "输出给写作者或评审时，必须包含证据、结论和不确定项。".to_string(),
            output_schema: "证据摘要、引用来源、结论边界、待验证点".to_string(),
            system_prompt:
                "你是研究代理，优先检索证据、阅读素材、提炼事实，不要在证据不足时强行下结论。"
                    .to_string(),
        },
        "copywriter" => RuntimeSubagentRoleSpec {
            role_id: "copywriter".to_string(),
            purpose: "负责产出标题、正文、发布话术、完整稿件和成品文案。".to_string(),
            handoff_contract: "完成正文后必须准备保存路径或项目归档信息。".to_string(),
            output_schema: "完整稿件、标题包、标签、发布建议".to_string(),
            system_prompt: "你是写作代理，目标是生成可直接交付和落盘的内容，而不是停留在聊天草稿。"
                .to_string(),
        },
        "image-director" => RuntimeSubagentRoleSpec {
            role_id: "image-director".to_string(),
            purpose: "负责封面、配图、海报、图片策略和视觉执行指令。".to_string(),
            handoff_contract: "给执行层的输出必须是可以直接生成或保存的结构化内容。".to_string(),
            output_schema: "封面策略、图片提示词、视觉结构、保存方案".to_string(),
            system_prompt:
                "你是图像策略代理，负责把目标转成可执行的配图/封面方案，并推动真实出图或落盘。"
                    .to_string(),
        },
        "reviewer" => RuntimeSubagentRoleSpec {
            role_id: "reviewer".to_string(),
            purpose: "负责校验结果是否符合需求、是否保存、是否存在幻觉或遗漏。".to_string(),
            handoff_contract: "如果结果不满足交付条件，明确指出缺口并阻止宣称成功。".to_string(),
            output_schema: "评审结论、问题列表、修正建议".to_string(),
            system_prompt:
                "你是质量评审代理，优先检查结果是否满足需求、是否真实落盘、是否存在伪成功。"
                    .to_string(),
        },
        _ => RuntimeSubagentRoleSpec {
            role_id: "ops-coordinator".to_string(),
            purpose: "负责后台任务、自动化、记忆维护和持续执行任务的推进。".to_string(),
            handoff_contract: "输出必须明确包含下一步执行条件与当前状态。".to_string(),
            output_schema: "调度动作、运行状态、恢复策略、维护结论".to_string(),
            system_prompt:
                "你是运行协调代理，负责长任务推进、自动化配置、状态检查、恢复和后台维护。"
                    .to_string(),
        },
    }
}

pub fn build_runtime_task_artifact_content(
    task_id: &str,
    route: &Value,
    goal: &str,
    orchestration: Option<&Value>,
) -> Result<String, String> {
    let intent = payload_string(route, "intent").unwrap_or_else(|| "direct_answer".to_string());
    let orchestration_outputs = orchestration_outputs(orchestration);
    let summary_lines = orchestration_summary_lines(&orchestration_outputs);
    let mut content = String::new();

    match intent.as_str() {
        "manuscript_creation" | "discussion" | "direct_answer" | "advisor_persona" => {
            content.push_str(&format!("# {}\n\n", goal.trim()));
            if !summary_lines.is_empty() {
                content.push_str("## Execution Summary\n\n");
                content.push_str(&summary_lines.join("\n"));
                content.push_str("\n\n");
            }
            for item in &orchestration_outputs {
                if let Some(role_id) = payload_string(item, "roleId") {
                    content.push_str(&format!("## {}\n\n", role_id));
                    if let Some(artifact) = payload_string(item, "artifact") {
                        if !artifact.trim().is_empty() {
                            content.push_str(&artifact);
                            content.push_str("\n\n");
                            continue;
                        }
                    }
                    content.push_str(&payload_string(item, "summary").unwrap_or_default());
                    content.push_str("\n\n");
                }
            }
        }
        "image_creation" | "cover_generation" => {
            content.push_str(&format!("# Visual Task {}\n\n", task_id));
            content.push_str(&format!("Goal: {}\n\n", goal));
            content.push_str("## Visual Plan\n\n");
            if summary_lines.is_empty() {
                content.push_str("- No visual plan generated.\n");
            } else {
                content.push_str(&summary_lines.join("\n"));
                content.push('\n');
            }
        }
        _ => {
            content.push_str(&format!("# Runtime Task {}\n\n", task_id));
            content.push_str(&format!("Intent: {}\n\n", intent));
            content.push_str(&format!("Goal: {}\n\n", goal));
            if !summary_lines.is_empty() {
                content.push_str("## Summary\n\n");
                content.push_str(&summary_lines.join("\n"));
                content.push_str("\n\n");
            }
        }
    }

    if let Some(orchestration) = orchestration {
        content.push_str("## Orchestration JSON\n\n```json\n");
        content.push_str(
            &serde_json::to_string_pretty(orchestration).map_err(|error| error.to_string())?,
        );
        content.push_str("\n```\n");
    }

    Ok(content)
}

fn payload_field<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload.as_object().and_then(|object| object.get(key))
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload_field(payload, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn orchestration_outputs(orchestration: Option<&Value>) -> Vec<Value> {
    orchestration
        .and_then(|value| value.get("outputs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn orchestration_summary_lines(outputs: &[Value]) -> Vec<String> {
    outputs
        .iter()
        .filter_map(|item| {
            Some(format!(
                "- {}: {}",
                payload_string(item, "roleId")?,
                payload_string(item, "summary").unwrap_or_default()
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redclaw_default_state_matches_existing_runner_defaults() {
        let state = RedclawStateRecord::default();
        assert!(!state.enabled);
        assert_eq!(state.lock_state, "owner");
        assert_eq!(state.interval_minutes, 20);
        assert_eq!(state.max_projects_per_tick, 1);
        assert_eq!(state.max_automation_per_tick, 2);
        assert_eq!(
            state
                .heartbeat
                .get("reportToMainSession")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn runtime_direct_route_marks_background_tasks_as_long_running() {
        let route = runtime_direct_route(
            "default",
            "run it",
            Some(&json!({
                "scheduledTaskId": "scheduled-1",
                "forceLongRunningTask": true
            })),
        );
        assert_eq!(
            route.get("intent").and_then(Value::as_str),
            Some("automation")
        );
        assert_eq!(
            route
                .get("requiresLongRunningTask")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn runtime_direct_route_promotes_advisor_persona_to_multi_agent() {
        let route = runtime_direct_route(
            "default",
            "generate persona",
            Some(&json!({
                "intent": "advisor_persona"
            })),
        );
        assert_eq!(
            route.get("requiresMultiAgent").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            route.get("recommendedRole").and_then(Value::as_str),
            Some("researcher")
        );
    }

    #[test]
    fn runtime_graph_for_route_adds_spawn_nodes_when_needed() {
        let graph = runtime_graph_for_route(&json!({
            "requiresMultiAgent": true,
            "requiresLongRunningTask": false
        }));
        let ids = graph
            .iter()
            .filter_map(|node| node.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(ids.contains(&"spawn_agents"));
        assert!(ids.contains(&"handoff"));
        assert!(ids.contains(&"review"));
    }

    #[test]
    fn role_sequence_for_route_uses_reviewer_for_automation() {
        let roles = role_sequence_for_route(&json!({
            "intent": "automation",
            "recommendedRole": "ops-coordinator"
        }));
        assert_eq!(roles, vec!["planner", "ops-coordinator", "reviewer"]);
    }

    #[test]
    fn set_runtime_graph_node_updates_summary_and_error() {
        let mut graph = runtime_graph_for_route(&json!({
            "requiresMultiAgent": false,
            "requiresLongRunningTask": false
        }));
        set_runtime_graph_node(
            &mut graph,
            "plan",
            "completed",
            Some("route resolved".to_string()),
            Some("none".to_string()),
        );
        let plan = graph
            .iter()
            .find(|node| node.get("id").and_then(Value::as_str) == Some("plan"))
            .unwrap();
        assert_eq!(
            plan.get("status").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            plan.get("summary").and_then(Value::as_str),
            Some("route resolved")
        );
        assert_eq!(plan.get("error").and_then(Value::as_str), Some("none"));
    }

    #[test]
    fn runtime_warm_settings_fingerprint_tracks_workspace_and_model_inputs() {
        let a = runtime_warm_settings_fingerprint(
            &json!({
                "api_endpoint": "https://example.com/v1",
                "api_key": "secret",
                "model_name": "gpt-main",
                "model_name_wander": "gpt-wander"
            }),
            Path::new("/tmp/workspace-a"),
        );
        let b = runtime_warm_settings_fingerprint(
            &json!({
                "api_endpoint": "https://example.com/v1",
                "api_key": "secret",
                "model_name": "gpt-main",
                "model_name_wander": "gpt-wander"
            }),
            Path::new("/tmp/workspace-b"),
        );
        assert_ne!(a, b);
    }

    #[test]
    fn runtime_route_record_round_trips_to_legacy_json_shape() {
        let route = runtime_direct_route_record("knowledge", "search it", None);
        let value = route.clone().into_value();
        let reparsed = RuntimeRouteRecord::from_value(&value).unwrap();
        assert_eq!(reparsed, route);
        assert_eq!(
            value.get("recommendedRole").and_then(Value::as_str),
            Some("researcher")
        );
    }

    #[test]
    fn runtime_graph_for_route_record_preserves_spawn_sequence() {
        let route = runtime_direct_route_record(
            "default",
            "handle automation",
            Some(&json!({
                "scheduledTaskId": "scheduled-1"
            })),
        );
        let graph = runtime_graph_for_route_record(&route.into_value());
        let ids = graph
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "plan",
                "retrieve",
                "spawn_agents",
                "handoff",
                "review",
                "execute_tools",
                "save_artifact"
            ]
        );
    }

    #[test]
    fn runtime_subagent_role_spec_returns_reviewer_contract() {
        let spec = runtime_subagent_role_spec("reviewer");
        assert_eq!(spec.role_id, "reviewer");
        assert!(spec.system_prompt.contains("质量评审"));
    }

    #[test]
    fn build_runtime_task_artifact_content_includes_execution_summary() {
        let content = build_runtime_task_artifact_content(
            "task-1",
            &json!({ "intent": "manuscript_creation" }),
            "写一篇稿子",
            Some(&json!({
                "outputs": [
                    {
                        "roleId": "planner",
                        "summary": "先列提纲",
                        "artifact": ""
                    },
                    {
                        "roleId": "copywriter",
                        "summary": "写完正文",
                        "artifact": "这里是正文"
                    }
                ]
            })),
        )
        .unwrap();

        assert!(content.contains("## Execution Summary"));
        assert!(content.contains("- planner: 先列提纲"));
        assert!(content.contains("## copywriter"));
        assert!(content.contains("这里是正文"));
    }

    #[test]
    fn build_runtime_task_artifact_content_for_visual_task_uses_visual_plan() {
        let content = build_runtime_task_artifact_content(
            "task-2",
            &json!({ "intent": "image_creation" }),
            "做一张图",
            Some(&json!({
                "outputs": [
                    {
                        "roleId": "image-director",
                        "summary": "高对比封面图"
                    }
                ]
            })),
        )
        .unwrap();

        assert!(content.contains("# Visual Task task-2"));
        assert!(content.contains("## Visual Plan"));
        assert!(content.contains("高对比封面图"));
    }

    #[test]
    fn session_title_from_message_trims_and_limits_length() {
        assert_eq!(session_title_from_message("   "), "New Chat");
        assert_eq!(
            session_title_from_message("abcdefghijklmnopqrstuvwxyz"),
            "abcdefghijklmnopqrstuvwx"
        );
    }

    #[test]
    fn resolve_runtime_mode_from_context_type_maps_known_contexts() {
        assert_eq!(resolve_runtime_mode_from_context_type(Some("wander")), "wander");
        assert_eq!(
            resolve_runtime_mode_from_context_type(Some("wechat-article")),
            "knowledge"
        );
        assert_eq!(resolve_runtime_mode_from_context_type(Some("unknown")), "chatroom");
    }

    #[test]
    fn infer_protocol_prefers_explicit_then_url() {
        assert_eq!(
            infer_protocol("https://foo.googleapis.com", None, Some("anthropic")),
            "anthropic"
        );
        assert_eq!(
            infer_protocol("https://foo.googleapis.com", None, None),
            "gemini"
        );
        assert_eq!(infer_protocol("https://api.openai.com/v1", None, None), "openai");
    }

    #[test]
    fn resolve_chat_config_prefers_model_override_and_infers_protocol() {
        let config = resolve_chat_config(
            &json!({
                "api_endpoint": "https://api.openai.com/v1",
                "api_key": "default-key",
                "model_name": "default-model"
            }),
            Some(&json!({
                "baseURL": "https://generativelanguage.googleapis.com/v1beta",
                "modelName": "gemini-2.5-pro"
            })),
        )
        .unwrap();

        assert_eq!(
            config,
            ResolvedChatConfig {
                protocol: "gemini".to_string(),
                base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
                api_key: Some("default-key".to_string()),
                model_name: "gemini-2.5-pro".to_string(),
            }
        );
    }

    #[test]
    fn next_memory_maintenance_at_ms_uses_shorter_delay_for_long_responses() {
        let short = next_memory_maintenance_at_ms("short", 1_000);
        let long = next_memory_maintenance_at_ms(&"a".repeat(1201), 1_000);
        assert_eq!(short, 1_000 + 20 * 60 * 1000);
        assert_eq!(long, 1_000 + 5 * 60 * 1000);
    }
}
