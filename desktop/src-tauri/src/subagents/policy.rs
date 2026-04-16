use serde_json::{json, Value};

use crate::runtime::{role_sequence_for_route, RuntimeRouteRecord};
use crate::subagents::{ForkOverrides, SubAgentConfig};
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
    settings
        .get("experimental")
        .and_then(|item| item.get("realSubagentsEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
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
            SubAgentConfig {
                role_id,
                runtime_mode: runtime_mode.to_string(),
                parent_task_id: parent_task_id.to_string(),
                parent_session_id: parent_session_id.map(ToString::to_string),
                parallel_group,
                model_config: Some(merged_model_config),
                fork_overrides: overrides.clone(),
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
    }
}
