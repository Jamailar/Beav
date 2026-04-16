use serde_json::Value;

use crate::payload_field;
use crate::runtime::{RuntimeRouteRecord, RuntimeTaskRecord};

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
    "animation-director",
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

pub fn route_for_task_snapshot(task: &RuntimeTaskRecord) -> Option<RuntimeRouteRecord> {
    task.route.clone()
}
