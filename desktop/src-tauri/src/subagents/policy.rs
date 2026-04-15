use serde_json::{json, Value};

use crate::runtime::{role_sequence_for_route, runtime_subagent_role_spec, RuntimeRouteRecord};
use crate::subagents::{
    ForkOverrides, SubAgentBudget, SubAgentConfig, SubAgentContextPolicy, SubAgentMemoryPolicy,
    SubAgentResultContract,
};
use crate::tools::catalog::ApprovalLevel;
use crate::tools::packs::{pack_for_runtime_mode, tool_names_for_pack};
use crate::{payload_field, payload_string};

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub fn real_subagents_enabled(settings: &Value, metadata: Option<&Value>) -> bool {
    if let Some(value) = metadata
        .and_then(|item| payload_field(item, "useRealSubagents"))
        .and_then(Value::as_bool)
    {
        return value;
    }
    if let Some(value) = settings
        .get("feature_flags")
        .and_then(|item| item.get("runtimeSubagentRuntimeV2"))
        .and_then(Value::as_bool)
    {
        return value;
    }
    settings
        .get("experimental")
        .and_then(|item| item.get("realSubagentsEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn role_default_tools(role_id: &str, runtime_mode: &str) -> Vec<String> {
    let mut tools = match role_id {
        "researcher" => vec![
            "redbox_app_query".to_string(),
            "redbox_fs".to_string(),
            "redbox_runtime_control".to_string(),
        ],
        "reviewer" => vec![
            "redbox_app_query".to_string(),
            "redbox_fs".to_string(),
            "redbox_runtime_control".to_string(),
        ],
        "copywriter" | "image-director" => {
            vec!["redbox_app_query".to_string(), "redbox_fs".to_string()]
        }
        "animation-director" => vec![
            "redbox_editor".to_string(),
            "redbox_fs".to_string(),
            "redbox_runtime_control".to_string(),
        ],
        _ => vec![
            "redbox_app_query".to_string(),
            "redbox_fs".to_string(),
            "redbox_runtime_control".to_string(),
        ],
    };
    if matches!(runtime_mode, "video-editor" | "audio-editor")
        && !tools.iter().any(|item| item == "redbox_editor")
    {
        tools.push("redbox_editor".to_string());
    }
    tools.sort();
    tools.dedup();
    tools
}

fn context_policy_for_role(role_id: &str, runtime_mode: &str) -> SubAgentContextPolicy {
    let inherits_editor =
        matches!(runtime_mode, "video-editor" | "audio-editor") || role_id == "animation-director";
    SubAgentContextPolicy {
        inherit_workspace_context: true,
        inherit_editor_binding: inherits_editor,
        inherit_profile_docs: false,
        include_parent_goal: true,
        include_prior_outputs: true,
        include_recent_transcript: false,
        max_recent_messages: 0,
        max_prior_output_chars: if role_id == "reviewer" { 2_400 } else { 4_000 },
    }
}

fn memory_policy_for_role(role_id: &str) -> SubAgentMemoryPolicy {
    let read_scopes = match role_id {
        "researcher" | "reviewer" => {
            vec!["workspace_fact".to_string(), "task_learning".to_string()]
        }
        _ => vec![],
    };
    SubAgentMemoryPolicy {
        read_scopes,
        write_enabled: false,
    }
}

fn approval_policy_for_role(role_id: &str) -> ApprovalLevel {
    match role_id {
        "reviewer" => ApprovalLevel::Light,
        "researcher" => ApprovalLevel::Light,
        _ => ApprovalLevel::Explicit,
    }
}

fn budget_for_role(role_id: &str) -> SubAgentBudget {
    match role_id {
        "reviewer" => SubAgentBudget {
            max_prompt_chars: 7_000,
            max_response_chars: 5_000,
            max_prior_outputs: 4,
        },
        "animation-director" => SubAgentBudget {
            max_prompt_chars: 9_000,
            max_response_chars: 10_000,
            max_prior_outputs: 3,
        },
        "researcher" => SubAgentBudget {
            max_prompt_chars: 8_500,
            max_response_chars: 6_000,
            max_prior_outputs: 4,
        },
        _ => SubAgentBudget {
            max_prompt_chars: 8_000,
            max_response_chars: 7_000,
            max_prior_outputs: 4,
        },
    }
}

fn result_contract_for_role(role_id: &str) -> SubAgentResultContract {
    SubAgentResultContract {
        require_summary: true,
        require_artifact_refs: !matches!(role_id, "reviewer"),
        require_findings: matches!(role_id, "researcher" | "reviewer"),
        require_risks: true,
        require_handoff: true,
        require_approvals_requested: true,
    }
}

fn merge_budget_override(default: SubAgentBudget, metadata: Option<&Value>) -> SubAgentBudget {
    let override_budget = metadata.and_then(|item| payload_field(item, "subagentBudget"));
    let max_prompt_chars = override_budget
        .and_then(|value| value.get("maxPromptChars"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default.max_prompt_chars)
        .clamp(2_000, 20_000);
    let max_response_chars = override_budget
        .and_then(|value| value.get("maxResponseChars"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default.max_response_chars)
        .clamp(1_000, 16_000);
    let max_prior_outputs = override_budget
        .and_then(|value| value.get("maxPriorOutputs"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default.max_prior_outputs)
        .clamp(0, 8);
    SubAgentBudget {
        max_prompt_chars,
        max_response_chars,
        max_prior_outputs,
    }
}

pub fn fork_overrides_from_metadata(runtime_mode: &str, metadata: Option<&Value>) -> ForkOverrides {
    let pack_tools = tool_names_for_pack(pack_for_runtime_mode(runtime_mode))
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    let requested = string_list(metadata.and_then(|item| payload_field(item, "allowedTools")));
    let allowed_tools = if requested.is_empty() {
        pack_tools
    } else {
        requested
            .into_iter()
            .filter(|item| pack_tools.iter().any(|allowed| allowed == item))
            .collect()
    };
    ForkOverrides {
        allowed_tools,
        model_override: metadata
            .and_then(|item| payload_string(item, "subagentModel"))
            .or_else(|| metadata.and_then(|item| payload_string(item, "modelOverride"))),
        reasoning_effort_override: metadata
            .and_then(|item| payload_string(item, "reasoningEffort"))
            .or_else(|| metadata.and_then(|item| payload_string(item, "reasoningEffortOverride"))),
        system_prompt_patch: metadata.and_then(|item| payload_string(item, "systemPromptPatch")),
        metadata: metadata
            .and_then(|item| payload_field(item, "subagentMetadata"))
            .cloned(),
    }
}

fn role_sequence(route: &RuntimeRouteRecord, metadata: Option<&Value>) -> Vec<String> {
    let explicit = string_list(metadata.and_then(|item| payload_field(item, "subagentRoles")));
    if !explicit.is_empty() {
        return explicit;
    }
    role_sequence_for_route(&route.clone().into_value())
}

fn parallel_group_for_role(role_id: &str, middle_index: usize) -> usize {
    match role_id {
        "planner" => 0,
        "reviewer" => usize::MAX,
        _ => 1 + (middle_index / 4),
    }
}

fn merge_allowed_tools(runtime_mode: &str, role_id: &str, metadata: Option<&Value>) -> Vec<String> {
    let pack_tools = tool_names_for_pack(pack_for_runtime_mode(runtime_mode))
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    let defaults = role_default_tools(role_id, runtime_mode);
    let requested = string_list(metadata.and_then(|item| payload_field(item, "allowedTools")));
    let seed = if requested.is_empty() {
        defaults
    } else {
        requested
    };
    let mut allowed = seed
        .into_iter()
        .filter(|item| pack_tools.iter().any(|allowed| allowed == item))
        .collect::<Vec<_>>();
    allowed.sort();
    allowed.dedup();
    allowed
}

pub fn build_subagent_configs(
    route: &RuntimeRouteRecord,
    runtime_mode: &str,
    parent_task_id: &str,
    parent_session_id: Option<&str>,
    metadata: Option<&Value>,
    model_config: Option<&Value>,
) -> Vec<SubAgentConfig> {
    let overrides = fork_overrides_from_metadata(runtime_mode, metadata);
    let roles = role_sequence(route, metadata);
    let mut middle_index = 0usize;
    roles
        .into_iter()
        .map(|role_id| {
            let role_spec = runtime_subagent_role_spec(&role_id);
            let parallel_group = if role_id == "reviewer" {
                usize::MAX
            } else {
                let group = parallel_group_for_role(&role_id, middle_index);
                if role_id != "planner" {
                    middle_index += 1;
                }
                group
            };
            let mut merged_model_config = model_config.cloned().unwrap_or_else(|| json!({}));
            if let Some(model_override) = overrides.model_override.as_ref() {
                if let Some(object) = merged_model_config.as_object_mut() {
                    object.insert("modelName".to_string(), json!(model_override));
                }
            }
            if let Some(reasoning_override) = overrides.reasoning_effort_override.as_ref() {
                if let Some(object) = merged_model_config.as_object_mut() {
                    object.insert("reasoningEffort".to_string(), json!(reasoning_override));
                }
            }
            let mut fork_overrides = overrides.clone();
            fork_overrides.allowed_tools = merge_allowed_tools(runtime_mode, &role_id, metadata);
            SubAgentConfig {
                role_id,
                child_runtime_type: role_spec.child_runtime_type,
                runtime_mode: runtime_mode.to_string(),
                parent_task_id: parent_task_id.to_string(),
                parent_session_id: parent_session_id.map(ToString::to_string),
                parallel_group,
                model_config: Some(merged_model_config),
                context_policy: context_policy_for_role(&role_spec.role_id, runtime_mode),
                memory_policy: memory_policy_for_role(&role_spec.role_id),
                approval_policy: approval_policy_for_role(&role_spec.role_id),
                budget: merge_budget_override(budget_for_role(&role_spec.role_id), metadata),
                result_contract: result_contract_for_role(&role_spec.role_id),
                fork_overrides,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::runtime_direct_route_record;

    #[test]
    fn subagent_policy_builds_waves_and_tool_bounds() {
        let route = runtime_direct_route_record(
            "default",
            "draft something",
            Some(&json!({
                "intent": "advisor_persona"
            })),
        );
        let configs = build_subagent_configs(
            &route,
            "chatroom",
            "task-parent",
            Some("session-parent"),
            Some(&json!({
                "allowedTools": ["redbox_fs", "redbox_runtime_control"],
                "reasoningEffort": "high"
            })),
            Some(&json!({"modelName": "gpt-main"})),
        );

        assert_eq!(
            configs.first().map(|item| item.role_id.as_str()),
            Some("planner")
        );
        assert!(configs.iter().any(|item| item.role_id == "reviewer"));
        assert!(configs.iter().all(|item| {
            item.fork_overrides
                .allowed_tools
                .iter()
                .all(|tool| tool == "redbox_fs" || tool == "redbox_runtime_control")
        }));
        assert!(configs.iter().all(|item| item.model_config.is_some()));
        assert!(configs.iter().all(|item| !item.memory_policy.write_enabled));
        assert!(configs
            .iter()
            .all(|item| item.budget.max_prompt_chars >= 2_000));
    }

    #[test]
    fn subagent_policy_assigns_runtime_types_and_restrictive_defaults() {
        let route = runtime_direct_route_record("default", "review", None);
        let configs = build_subagent_configs(
            &route,
            "video-editor",
            "task-parent",
            Some("session-parent"),
            Some(&json!({
                "subagentRoles": ["animation-director", "reviewer"]
            })),
            None,
        );
        assert_eq!(configs[0].child_runtime_type, "editor-planner".to_string());
        assert!(configs[0].context_policy.inherit_editor_binding);
        assert!(configs[0]
            .fork_overrides
            .allowed_tools
            .iter()
            .any(|item| item == "redbox_editor"));
        assert_eq!(configs[1].child_runtime_type, "reviewer".to_string());
        assert_eq!(configs[1].approval_policy, ApprovalLevel::Light);
    }
}
