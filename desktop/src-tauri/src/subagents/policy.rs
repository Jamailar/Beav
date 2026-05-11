use serde_json::{Value, json};

use crate::runtime::{RuntimeRouteRecord, role_sequence_for_route};
use crate::subagents::{ForkOverrides, SubAgentConfig};
use crate::tools::compat::canonical_tool_name;
use crate::tools::packs::{pack_for_runtime_mode, tool_names_for_pack};
use crate::{payload_field, payload_string};

fn string_list(value: Option<&Value>) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(items) = value.and_then(Value::as_array) {
        for item in items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| canonical_tool_name(item).to_string())
        {
            if !values.iter().any(|existing| existing == &item) {
                values.push(item);
            }
        }
    }
    values
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

fn node_for_role(graph: &Value, role_id: &str) -> Option<Value> {
    graph
        .get("nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes
                .iter()
                .find(|node| payload_string(node, "agentId").as_deref() == Some(role_id))
        })
        .cloned()
}

fn edge_node_ids(graph: &Value, node_id: &str, edge_key: &str) -> Vec<String> {
    graph
        .get("edges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|edge| {
            let from = payload_string(edge, "from")?;
            let to = payload_string(edge, "to")?;
            match edge_key {
                "upstream" if to == node_id => Some(from),
                "downstream" if from == node_id => Some(to),
                _ => None,
            }
        })
        .collect()
}

fn node_skill_ids(node: Option<&Value>) -> Vec<String> {
    node.and_then(|item| payload_field(item, "skillIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn selected_skill_profiles(metadata: Option<&Value>, skill_ids: &[String]) -> Vec<Value> {
    metadata
        .and_then(|item| payload_field(item, "redclawSkillProfiles"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|profile| {
            payload_string(profile, "id")
                .map(|id| skill_ids.iter().any(|skill_id| skill_id == &id))
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

fn subagent_task_context(
    role_id: &str,
    runtime_mode: &str,
    parent_task_id: &str,
    metadata: Option<&Value>,
) -> Option<Value> {
    let graph = metadata.and_then(|item| payload_field(item, "redclawTaskGraph"))?;
    let node = node_for_role(graph, role_id);
    if runtime_mode != "redclaw" && node.is_none() {
        return None;
    }
    let node_id = node
        .as_ref()
        .and_then(|item| payload_string(item, "id"))
        .unwrap_or_else(|| role_id.to_string());
    let skill_ids = node_skill_ids(node.as_ref());
    let skill_profiles = selected_skill_profiles(metadata, &skill_ids);
    Some(json!({
        "source": "redclaw-orchestrator",
        "parentTaskId": parent_task_id,
        "runId": metadata.and_then(|item| payload_string(item, "runId")),
        "projectId": metadata.and_then(|item| payload_string(item, "projectId")),
        "graphId": metadata.and_then(|item| payload_string(item, "graphId")),
        "platform": graph.get("platform").cloned().unwrap_or(Value::Null),
        "contentFormat": graph.get("contentFormat").cloned().unwrap_or(Value::Null),
        "node": node.unwrap_or_else(|| json!({ "id": node_id, "agentId": role_id })),
        "skillProfiles": skill_profiles,
        "upstreamNodeIds": edge_node_ids(graph, &node_id, "upstream"),
        "downstreamNodeIds": edge_node_ids(graph, &node_id, "downstream"),
        "graph": graph,
    }))
}

fn parallel_group_for_role(role_id: &str, middle_index: usize) -> usize {
    match role_id {
        "planner" | "research_agent" => 0,
        "insight_agent" => 1,
        "script_agent" => 2,
        "storyboard_agent" => 3,
        "media_agent" => 4,
        "editor_agent" => 5,
        "publish_agent" => 6,
        "reviewer" | "review_agent" => usize::MAX,
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
        .enumerate()
        .map(|(role_index, role_id)| {
            let parallel_group = if role_id == "reviewer" || role_id == "review_agent" {
                usize::MAX
            } else if runtime_mode == "redclaw" {
                role_index
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
            let task_context =
                subagent_task_context(&role_id, runtime_mode, parent_task_id, metadata);
            SubAgentConfig {
                role_id,
                runtime_mode: runtime_mode.to_string(),
                parent_task_id: parent_task_id.to_string(),
                parent_session_id: parent_session_id.map(ToString::to_string),
                collab_session_id: metadata
                    .and_then(|item| payload_string(item, "collabSessionId")),
                parallel_group,
                model_config: Some(merged_model_config),
                fork_overrides: overrides.clone(),
                task_context,
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
            "team",
            "task-parent",
            Some("session-parent"),
            Some(&json!({
                "allowedTools": ["resource", "runtime_control"],
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
                .all(|tool| tool == "resource" || tool == "workflow")
        }));
        assert!(configs.iter().all(|item| item.model_config.is_some()));
    }

    #[test]
    fn redclaw_roles_follow_creative_pipeline_order() {
        let route = runtime_direct_route_record(
            "redclaw",
            "make a short video package",
            Some(&json!({
                "forceMultiAgent": true,
                "subagentRoles": [
                    "research_agent",
                    "insight_agent",
                    "script_agent",
                    "storyboard_agent",
                    "media_agent",
                    "editor_agent",
                    "publish_agent",
                    "review_agent"
                ]
            })),
        );
        let configs = build_subagent_configs(
            &route,
            "redclaw",
            "task-redclaw",
            Some("session-redclaw"),
            Some(&json!({
                "allowedTools": ["workflow", "resource"],
                "subagentRoles": [
                    "research_agent",
                    "insight_agent",
                    "script_agent",
                    "storyboard_agent",
                    "media_agent",
                    "editor_agent",
                    "publish_agent",
                    "review_agent"
                ]
            })),
            Some(&json!({"modelName": "gpt-main"})),
        );

        let groups = configs
            .iter()
            .map(|config| (config.role_id.as_str(), config.parallel_group))
            .collect::<Vec<_>>();
        assert_eq!(
            groups,
            vec![
                ("research_agent", 0),
                ("insight_agent", 1),
                ("script_agent", 2),
                ("storyboard_agent", 3),
                ("media_agent", 4),
                ("editor_agent", 5),
                ("publish_agent", 6),
                ("review_agent", usize::MAX),
            ]
        );
    }

    #[test]
    fn redclaw_config_includes_node_task_context() {
        let route = runtime_direct_route_record(
            "redclaw",
            "make a short video package",
            Some(&json!({
                "forceMultiAgent": true,
                "subagentRoles": ["script_agent"]
            })),
        );
        let configs = build_subagent_configs(
            &route,
            "redclaw",
            "task-redclaw",
            Some("session-redclaw"),
            Some(&json!({
                "runId": "run-1",
                "projectId": "project-1",
                "graphId": "graph-1",
                "subagentRoles": ["script_agent"],
                "redclawSkillProfiles": [
                    {
                        "id": "script.short_video_script",
                        "domain": "script",
                        "version": "0.1.0",
                        "inputSchema": "CreativeBrief",
                        "outputSchema": "ScriptDocument",
                        "instruction": "write script",
                        "inputContract": { "type": "object" },
                        "outputContract": { "type": "object" },
                        "evaluationDimensions": ["relevance"]
                    }
                ],
                "redclawTaskGraph": {
                    "platform": "xiaohongshu",
                    "contentFormat": "short_video",
                    "nodes": [
                        {
                            "id": "insight",
                            "agentId": "insight_agent",
                            "skillIds": ["insight.brief_from_references"],
                            "requiredArtifacts": ["CreativeBrief"],
                            "outputSchema": "CreativeBrief"
                        },
                        {
                            "id": "script",
                            "agentId": "script_agent",
                            "skillIds": ["script.short_video_script"],
                            "requiredArtifacts": ["ScriptDocument"],
                            "outputSchema": "ScriptDocument"
                        }
                    ],
                    "edges": [
                        { "from": "insight", "to": "script", "dependencyType": "requires_output" }
                    ]
                }
            })),
            Some(&json!({"modelName": "gpt-main"})),
        );

        let context = configs
            .first()
            .and_then(|config| config.task_context.as_ref())
            .expect("missing RedClaw task context");
        assert_eq!(
            context
                .get("node")
                .and_then(|node| node.get("outputSchema"))
                .and_then(Value::as_str),
            Some("ScriptDocument")
        );
        assert_eq!(
            context
                .get("upstreamNodeIds")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("insight")
        );
        assert_eq!(
            context
                .get("skillProfiles")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|profile| profile.get("id"))
                .and_then(Value::as_str),
            Some("script.short_video_script")
        );
    }

    #[test]
    fn redclaw_xhs_roles_run_in_graph_order() {
        let roles = vec![
            "research_agent",
            "topic_agent",
            "note_architect_agent",
            "copy_agent",
            "visual_director_agent",
            "image_agent",
            "layout_agent",
            "editor_agent",
            "publish_agent",
            "compliance_agent",
            "review_agent",
        ];
        let route = runtime_direct_route_record(
            "redclaw",
            "make a rednote carousel",
            Some(&json!({
                "forceMultiAgent": true,
                "subagentRoles": roles
            })),
        );
        let configs = build_subagent_configs(
            &route,
            "redclaw",
            "task-redclaw",
            Some("session-redclaw"),
            Some(&json!({
                "subagentRoles": roles
            })),
            Some(&json!({"modelName": "gpt-main"})),
        );
        let groups = configs
            .iter()
            .map(|config| (config.role_id.as_str(), config.parallel_group))
            .collect::<Vec<_>>();

        assert_eq!(
            groups,
            vec![
                ("research_agent", 0),
                ("topic_agent", 1),
                ("note_architect_agent", 2),
                ("copy_agent", 3),
                ("visual_director_agent", 4),
                ("image_agent", 5),
                ("layout_agent", 6),
                ("editor_agent", 7),
                ("publish_agent", 8),
                ("compliance_agent", 9),
                ("review_agent", usize::MAX),
            ]
        );
    }
}
