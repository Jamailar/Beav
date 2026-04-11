use std::path::Path;
use serde_json::{json, Value};

#[path = "runtime/agent_engine.rs"]
mod agent_engine;
#[path = "runtime/events.rs"]
mod events;
#[path = "runtime/session_runtime.rs"]
mod session_runtime;
#[path = "runtime/task_runtime.rs"]
mod task_runtime;
#[path = "runtime/types.rs"]
mod types;

pub use agent_engine::*;
pub use events::*;
pub use session_runtime::*;
pub use task_runtime::*;
pub use types::*;

pub fn set_runtime_graph_node(
    graph: &mut [RuntimeGraphNodeRecord],
    node_id: &str,
    status: &str,
    summary: Option<String>,
    error: Option<String>,
) {
    if let Some(node) = graph.iter_mut().find(|item| item.id == node_id) {
        node.status = status.to_string();
        if status == "running" && node.started_at.is_none() {
            node.started_at = Some(crate::now_i64());
        }
        if matches!(status, "completed" | "failed" | "skipped") {
            node.completed_at = Some(crate::now_i64());
        }
        if let Some(summary) = summary {
            node.summary = Some(summary);
        }
        if let Some(error) = error {
            node.error = Some(error);
        }
    }
}

pub fn runtime_task_value(task: &RuntimeTaskRecord) -> Value {
    json!(task)
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
        "video-editor" | "video_editor" | "video-draft" | "redvideo" => "video-editor",
        "audio-editor" | "audio_editor" | "audio-draft" | "redaudio" => "audio-editor",
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
        let ids = graph.iter().map(|node| node.id.as_str()).collect::<Vec<_>>();
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

        assert_eq!(value.get("taskType").and_then(Value::as_str), Some("manual"));
        assert_eq!(
            value.get("route")
                .and_then(|item| item.get("recommendedRole"))
                .and_then(Value::as_str),
            Some("researcher")
        );
        assert_eq!(
            value.get("graph")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("startedAt")),
            Some(&Value::Null)
        );
        assert_eq!(
            value.get("artifacts")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("label"))
                .and_then(Value::as_str),
            Some("Saved Artifact")
        );
        assert_eq!(
            value.get("checkpoints")
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
