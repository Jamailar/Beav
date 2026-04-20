#[path = "runtime/agent_engine.rs"]
mod agent_engine;
#[path = "runtime/config_runtime.rs"]
mod config_runtime;
#[path = "runtime/events.rs"]
mod events;
#[path = "runtime/interactive_loop.rs"]
mod interactive_loop;
#[path = "runtime/orchestration_runtime.rs"]
mod orchestration_runtime;
#[path = "runtime/session_runtime.rs"]
mod session_runtime;
#[path = "runtime/task_runtime.rs"]
mod task_runtime;
#[path = "runtime/types.rs"]
mod types;

pub use agent_engine::*;
pub use config_runtime::*;
pub use events::*;
pub use interactive_loop::*;
pub use orchestration_runtime::*;
pub use session_runtime::*;
pub use task_runtime::*;
pub use types::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::path::Path;

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
        let route = runtime_direct_route_record(
            "default",
            "run it",
            Some(&json!({
                "scheduledTaskId": "scheduled-1",
                "forceLongRunningTask": true
            })),
        )
        .into_value();
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
        let route = runtime_direct_route_record(
            "default",
            "generate persona",
            Some(&json!({
                "intent": "advisor_persona"
            })),
        )
        .into_value();
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
            .map(|node| node.id.as_str())
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
        let plan = graph.iter().find(|node| node.id == "plan").unwrap();
        assert_eq!(plan.status, "completed");
        assert_eq!(plan.summary.as_deref(), Some("route resolved"));
        assert_eq!(plan.error.as_deref(), Some("none"));
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
    fn runtime_task_value_preserves_frontend_shape_for_typed_runtime_task() {
        let route = runtime_direct_route_record("knowledge", "search it", None);
        let task = RuntimeTaskRecord {
            id: "task-1".to_string(),
            runtime_id: None,
            parent_runtime_id: None,
            parent_task_id: None,
            root_task_id: None,
            child_task_ids: Vec::new(),
            aggregation_status: None,
            task_type: "manual".to_string(),
            status: "pending".to_string(),
            runtime_mode: "knowledge".to_string(),
            owner_session_id: Some("session-1".to_string()),
            intent: Some(route.intent.clone()),
            role_id: Some(route.recommended_role.clone()),
            goal: Some("search it".to_string()),
            current_node: Some("plan".to_string()),
            route: Some(route),
            graph: runtime_graph_for_route(&json!({
                "requiresMultiAgent": false,
                "requiresLongRunningTask": false
            })),
            artifacts: vec![RuntimeArtifact::new(
                "saved-artifact",
                "Saved Artifact",
                Some("/tmp/task-1.md".to_string()),
                Some(json!({ "origin": "test" })),
                None,
            )],
            checkpoints: vec![RuntimeCheckpointRecord::new(
                "route",
                "plan",
                "route resolved",
                Some(json!({ "intent": "knowledge_retrieval" })),
            )],
            metadata: Some(json!({ "contextType": "knowledge" })),
            last_error: None,
            created_at: 1,
            updated_at: 2,
            started_at: Some(3),
            completed_at: Some(4),
        };
        let value = runtime_task_value(&task);

        assert_eq!(
            value.get("taskType").and_then(Value::as_str),
            Some("manual")
        );
        assert_eq!(
            value
                .get("route")
                .and_then(|item| item.get("recommendedRole"))
                .and_then(Value::as_str),
            Some("researcher")
        );
        assert_eq!(
            value
                .get("graph")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("startedAt")),
            Some(&Value::Null)
        );
        assert_eq!(
            value
                .get("artifacts")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("label"))
                .and_then(Value::as_str),
            Some("Saved Artifact")
        );
        assert_eq!(
            value
                .get("checkpoints")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("nodeId"))
                .and_then(Value::as_str),
            Some("plan")
        );
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
        assert_eq!(
            resolve_runtime_mode_from_context_type(Some("wander")),
            "wander"
        );
        assert_eq!(
            resolve_runtime_mode_from_context_type(Some("wechat-article")),
            "knowledge"
        );
        assert_eq!(
            resolve_runtime_mode_from_context_type(Some("unknown")),
            "chatroom"
        );
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
        assert_eq!(
            infer_protocol("https://api.openai.com/v1", None, None),
            "openai"
        );
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
