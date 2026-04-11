use serde_json::Value;

use crate::runtime::{RuntimeRouteRecord, RuntimeTaskRecord};
use crate::payload_field;

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
        confidence: if intent == "direct_answer" { 0.55 } else { 0.92 },
        reasoning: format!(
            "runtime-mode-default:{}; intent={}; role={}",
            runtime_mode, intent, role
        ),
        source: "rule".to_string(),
    }
}

pub fn runtime_route_from_llm_parsed(
    fallback: &RuntimeRouteRecord,
    parsed: &Value,
    user_input: &str,
) -> Option<RuntimeRouteRecord> {
    let intent = normalize_runtime_intent_name(
        parsed
            .get("primary_intent")
            .or_else(|| parsed.get("intent"))
            .and_then(|value| value.as_str()),
    )?;
    let recommended_role = normalize_runtime_role_id(
        parsed
            .get("recommended_role")
            .or_else(|| parsed.get("role_id"))
            .and_then(|value| value.as_str()),
    )?;
    let secondary_intents = parsed
        .get("secondary_intents")
        .or_else(|| parsed.get("secondaryIntents"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(|item| normalize_runtime_intent_name(Some(item)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let deliverables = parsed
        .get("deliverables")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let required_capabilities = parsed
        .get("required_capabilities")
        .or_else(|| parsed.get("requiredCapabilities"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| runtime_required_capabilities(&intent));
    Some(RuntimeRouteRecord {
        intent,
        secondary_intents,
        goal: parsed
            .get("goal")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(user_input)
            .to_string(),
        deliverables,
        required_capabilities,
        recommended_role,
        requires_long_running_task: parsed
            .get("requires_long_running_task")
            .or_else(|| parsed.get("requiresLongRunningTask"))
            .and_then(Value::as_bool)
            .unwrap_or(fallback.requires_long_running_task),
        requires_multi_agent: parsed
            .get("requires_multi_agent")
            .or_else(|| parsed.get("requiresMultiAgent"))
            .and_then(Value::as_bool)
            .unwrap_or(fallback.requires_multi_agent),
        requires_human_approval: parsed
            .get("requires_human_approval")
            .or_else(|| parsed.get("requiresHumanApproval"))
            .and_then(Value::as_bool)
            .unwrap_or(fallback.requires_human_approval),
        confidence: parsed
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(fallback.confidence),
        reasoning: parsed
            .get("reasoning")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("llm-route")
            .to_string(),
        source: parsed
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("llm")
            .to_string(),
    })
}

pub fn route_for_task_snapshot(task: &RuntimeTaskRecord) -> Option<RuntimeRouteRecord> {
    task.route.clone()
}
