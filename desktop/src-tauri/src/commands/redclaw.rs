#[path = "redclaw/export_content.rs"]
mod redclaw_export_content;
#[path = "redclaw/export_files.rs"]
mod redclaw_export_files;
#[path = "redclaw/export_markdown.rs"]
mod redclaw_export_markdown;
#[path = "redclaw/media_export.rs"]
mod redclaw_media_export;
#[path = "redclaw/profile_channels.rs"]
mod redclaw_profile_channels;
#[path = "redclaw/runner_lifecycle.rs"]
mod redclaw_runner_lifecycle;
#[path = "redclaw/runner_tasks.rs"]
mod redclaw_runner_tasks;
#[path = "redclaw_task_control.rs"]
pub(crate) mod redclaw_task_control;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::memory::append_memory_record;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    add_collab_member, collab_session_snapshot, create_collab_session, create_collab_task,
    plan_redclaw_orchestration, redclaw_orchestration_registry_value, runtime_direct_route_record,
    CollabSessionSnapshot, RedclawAgentId, RedclawOrchestrationPlan,
};
use crate::store::{
    redclaw as redclaw_store, runtime_tasks as runtime_tasks_store, spaces as spaces_store,
};
use crate::{
    ffmpeg_executable, now_i64, now_iso, parse_json_value_from_text, payload_string, AppState,
    UserMemoryRecord,
};
use redclaw_export_files::{
    export_redclaw_publish_package, export_redclaw_review_report, export_redclaw_xhs_package,
};
use redclaw_media_export::{export_redclaw_media_plan, render_redclaw_rough_cut};
use redclaw_profile_channels::handle_redclaw_profile_channel;
pub use redclaw_runner_lifecycle::ensure_redclaw_runtime_running;
use redclaw_runner_lifecycle::handle_redclaw_runner_lifecycle_channel;
pub(crate) use redclaw_runner_lifecycle::redclaw_runner_status_value;
use redclaw_runner_tasks::handle_redclaw_runner_task_channel;
use redclaw_task_control::{
    handle_task_cancel, handle_task_confirm, handle_task_create, handle_task_list,
    handle_task_preview, handle_task_stats, handle_task_update,
};

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn require_confirmed_redclaw_team_plan(payload: &Value) -> Result<(), String> {
    if payload_bool(payload, "userConfirmedTeamPlan")
        || payload
            .get("metadata")
            .map(|metadata| payload_bool(metadata, "userConfirmedTeamPlan"))
            .unwrap_or(false)
    {
        return Ok(());
    }
    Err("创建 team 前必须先向用户列出团队成员和分工，并等待用户明确确认。确认后再传入 userConfirmedTeamPlan=true。".to_string())
}

#[tauri::command]
pub async fn redclaw_runner_status(state: State<'_, AppState>) -> Result<Value, String> {
    redclaw_runner_status_value(&state)
}

pub fn handle_redclaw_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result: Result<Value, String> = match channel {
        "redclaw:list-projects" => with_store(state, |store| {
            let projects = redclaw_store::list_projects_sorted(&store);
            Ok(json!({ "success": true, "items": projects, "count": projects.len() }))
        }),
        "redclaw:orchestration-plan" => plan_redclaw_orchestration(payload).map(|plan| json!(plan)),
        "redclaw:orchestration-registry" => Ok(redclaw_orchestration_registry_value()),
        "redclaw:orchestration-create-run" => create_redclaw_orchestration_run(state, payload),
        "redclaw:learning-candidate-update" => update_redclaw_learning_candidate(state, payload),
        "redclaw:project-section-update" => update_redclaw_project_section(state, payload),
        "redclaw:media-plan-export" => export_redclaw_media_plan(state, payload),
        "redclaw:media-plan-render" => render_redclaw_rough_cut(app, state, payload),
        "redclaw:publish-package-export" => export_redclaw_publish_package(state, payload),
        "redclaw:review-report-export" => export_redclaw_review_report(state, payload),
        "redclaw:xhs-package-export" => export_redclaw_xhs_package(state, payload),
        "redclaw:profile:get-bundle"
        | "redclaw:profile:update-doc"
        | "redclaw:profile:onboarding-status"
        | "redclaw:profile:onboarding-turn"
        | "redclaw:profile:save-initialization-progress"
        | "redclaw:profile:complete-initialization"
        | "redclaw:profile:start-style-definition"
        | "redclaw:profile:complete-style-definition" => {
            handle_redclaw_profile_channel(app, state, channel, payload)?
        }
        "redclaw:task-preview" => handle_task_preview(app, state, payload),
        "redclaw:task-create" => handle_task_create(app, state, payload),
        "redclaw:task-confirm" => handle_task_confirm(app, state, payload),
        "redclaw:task-update" => handle_task_update(app, state, payload),
        "redclaw:task-cancel" => handle_task_cancel(app, state, payload),
        "redclaw:task-list" => handle_task_list(state, payload),
        "redclaw:task-stats" => handle_task_stats(state),
        _ => {
            return handle_redclaw_runner_lifecycle_channel(app, state, channel, payload)
                .or_else(|| handle_redclaw_runner_task_channel(app, state, channel, payload));
        }
    };
    Some(result)
}

fn update_redclaw_learning_candidate(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let candidate_id = payload_string(payload, "candidateId")
        .ok_or_else(|| "candidateId is required".to_string())?;
    let status = payload_string(payload, "status").unwrap_or_else(|| "accepted".to_string());
    if !matches!(status.as_str(), "accepted" | "rejected" | "pending") {
        return Err("status must be accepted, rejected, or pending".to_string());
    }
    let now = now_iso();
    with_store_mut(state, |store| {
        let active_space_id = spaces_store::active_space_id(store);
        let (project, candidate_snapshot) = redclaw_store::update_learning_candidate_status(
            store,
            &project_id,
            &candidate_id,
            &status,
            &now,
        )?;
        if status == "accepted" {
            append_memory_record(
                store,
                redclaw_learning_memory_record(
                    &candidate_snapshot,
                    active_space_id,
                    &project_id,
                    &candidate_id,
                ),
            );
        }
        Ok(json!({
            "success": true,
            "project": project,
            "candidate": candidate_snapshot
        }))
    })
}

fn redclaw_learning_memory_record(
    candidate_snapshot: &Value,
    active_space_id: String,
    project_id: &str,
    candidate_id: &str,
) -> UserMemoryRecord {
    let statement = candidate_snapshot
        .get("statement")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("RedClaw learning candidate accepted")
        .to_string();
    UserMemoryRecord {
        id: crate::make_id("memory"),
        content: statement,
        r#type: "redclaw_learning".to_string(),
        tags: vec!["redclaw".to_string(), "learning".to_string()],
        entities: Vec::new(),
        scope: Some(
            candidate_snapshot
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("project")
                .to_string(),
        ),
        space_id: Some(active_space_id),
        project_id: Some(project_id.to_string()),
        session_id: None,
        source: Some(json!({
            "kind": "redclaw_learning_candidate",
            "projectId": project_id,
            "candidateId": candidate_id,
            "candidate": candidate_snapshot,
        })),
        confidence: candidate_snapshot.get("confidence").and_then(Value::as_f64),
        created_at: now_i64(),
        updated_at: None,
        last_accessed: None,
        status: Some("active".to_string()),
        archived_at: None,
        archive_reason: None,
        origin_id: None,
        canonical_key: None,
        revision: Some(1),
        last_conflict_at: None,
    }
}

fn update_redclaw_project_section(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let project_id =
        payload_string(payload, "projectId").ok_or_else(|| "projectId is required".to_string())?;
    let section_id =
        payload_string(payload, "sectionId").ok_or_else(|| "sectionId is required".to_string())?;
    let content =
        payload_string(payload, "content").ok_or_else(|| "content is required".to_string())?;
    let allowed = [
        "brief",
        "script",
        "storyboard",
        "media",
        "publish",
        "review",
        "research",
    ];
    if !allowed.iter().any(|item| item == &section_id.as_str()) {
        return Err("sectionId is not supported".to_string());
    }
    let now = now_iso();
    with_store_mut(state, |store| {
        let project = redclaw_store::update_project_section_draft(
            store,
            &project_id,
            &section_id,
            content,
            &now,
        )?;
        Ok(json!({
            "success": true,
            "project": project,
            "sectionId": section_id
        }))
    })
}

fn redclaw_agent_role_id(agent_id: &RedclawAgentId) -> &'static str {
    match agent_id {
        RedclawAgentId::ResearchAgent => "research_agent",
        RedclawAgentId::InsightAgent => "insight_agent",
        RedclawAgentId::TopicAgent => "topic_agent",
        RedclawAgentId::NoteArchitectAgent => "note_architect_agent",
        RedclawAgentId::ScriptAgent => "script_agent",
        RedclawAgentId::CopyAgent => "copy_agent",
        RedclawAgentId::StoryboardAgent => "storyboard_agent",
        RedclawAgentId::VisualDirectorAgent => "visual_director_agent",
        RedclawAgentId::MediaAgent => "media_agent",
        RedclawAgentId::ImageAgent => "image_agent",
        RedclawAgentId::LayoutAgent => "layout_agent",
        RedclawAgentId::EditorAgent => "editor_agent",
        RedclawAgentId::PublishAgent => "publish_agent",
        RedclawAgentId::ComplianceAgent => "compliance_agent",
        RedclawAgentId::ReviewAgent => "review_agent",
    }
}

fn redclaw_agent_display_name(agent_id: &RedclawAgentId) -> &'static str {
    match agent_id {
        RedclawAgentId::ResearchAgent => "Research Agent",
        RedclawAgentId::InsightAgent => "Insight Agent",
        RedclawAgentId::TopicAgent => "Topic Agent",
        RedclawAgentId::NoteArchitectAgent => "Note Architect Agent",
        RedclawAgentId::ScriptAgent => "Script Agent",
        RedclawAgentId::CopyAgent => "Copy Agent",
        RedclawAgentId::StoryboardAgent => "Storyboard Agent",
        RedclawAgentId::VisualDirectorAgent => "Visual Director Agent",
        RedclawAgentId::MediaAgent => "Media Agent",
        RedclawAgentId::ImageAgent => "Image Agent",
        RedclawAgentId::LayoutAgent => "Layout Agent",
        RedclawAgentId::EditorAgent => "Editor Agent",
        RedclawAgentId::PublishAgent => "Publish Agent",
        RedclawAgentId::ComplianceAgent => "Compliance Agent",
        RedclawAgentId::ReviewAgent => "Review Agent",
    }
}

fn redclaw_plan_role_ids(plan: &RedclawOrchestrationPlan) -> Vec<String> {
    let mut roles = Vec::new();
    for node in &plan.graph.nodes {
        let role_id = redclaw_agent_role_id(&node.agent_id).to_string();
        if !roles.iter().any(|existing| existing == &role_id) {
            roles.push(role_id);
        }
    }
    roles
}

fn create_redclaw_team_records(
    store: &mut crate::AppStore,
    plan: &RedclawOrchestrationPlan,
    source_task_id: Option<&str>,
) -> Result<(String, CollabSessionSnapshot), String> {
    let session = create_collab_session(
        store,
        &json!({
            "title": "RedClaw 临时创作团队",
            "objective": plan.graph.goal,
            "runtimeMode": "redclaw",
            "source": "redclaw-orchestrator",
            "metadata": {
                "runId": plan.run_id,
                "graphId": plan.graph.id,
                "sourceTaskId": source_task_id,
                "temporaryTeam": true,
                "releasePolicy": plan.release_policy
            }
        }),
    )?;

    let mut member_by_role = std::collections::HashMap::<String, String>::new();
    let selected_agent_ids = plan
        .graph
        .nodes
        .iter()
        .map(|node| node.agent_id.clone())
        .collect::<Vec<_>>();
    for spec in plan.agent_specs.iter().filter(|spec| {
        selected_agent_ids
            .iter()
            .any(|agent_id| agent_id == &spec.id)
    }) {
        let role_id = redclaw_agent_role_id(&spec.id).to_string();
        if member_by_role.contains_key(&role_id) {
            continue;
        }
        let member = add_collab_member(
            store,
            &json!({
                "sessionId": session.id,
                "displayName": redclaw_agent_display_name(&spec.id),
                "roleId": role_id,
                "sourceKind": "ephemeral_subagent_spec",
                "backend": "redclaw-orchestrator",
                "adapterKind": "internal",
                "status": "idle",
                "capabilities": &spec.allowed_skills,
                "allowedTools": &spec.allowed_tools,
                "metadata": {
                    "temporary": true,
                    "memoryScopes": &spec.readable_memory_scopes,
                    "outputSchema": &spec.output_schema
                }
            }),
        )?;
        member_by_role.insert(role_id, member.id);
    }

    let mut task_by_node = std::collections::HashMap::<String, String>::new();
    for node in &plan.graph.nodes {
        let role_id = redclaw_agent_role_id(&node.agent_id);
        let member_id = member_by_role
            .get(role_id)
            .ok_or_else(|| format!("missing member for role {role_id}"))?;
        let depends_on_task_ids = plan
            .graph
            .edges
            .iter()
            .filter(|edge| edge.to == node.id)
            .filter_map(|edge| task_by_node.get(&edge.from).cloned())
            .collect::<Vec<_>>();
        let task = create_collab_task(
            store,
            &json!({
                "sessionId": session.id,
                "memberId": member_id,
                "title": node.title,
                "objective": format!("{}：{}", node.title, plan.graph.goal),
                "description": format!("使用 {} 输出 {}", node.skill_ids.join(", "), node.output_schema),
                "status": "todo",
                "priority": if role_id == "review_agent" { 1 } else { 0 },
                "taskType": "redclaw_orchestration_node",
                "dependsOnTaskIds": depends_on_task_ids,
                "runtimeTaskId": source_task_id,
                "metadata": {
                    "runId": plan.run_id,
                    "graphId": plan.graph.id,
                    "nodeId": node.id,
                    "agentId": role_id,
                    "skillIds": &node.skill_ids,
                    "requiredArtifacts": &node.required_artifacts,
                    "outputSchema": &node.output_schema,
                    "temporaryTeam": true
                }
            }),
        )?;
        task_by_node.insert(node.id.clone(), task.id);
    }

    let snapshot = collab_session_snapshot(store, &session.id, Some(100), Some(100))
        .ok_or_else(|| "created RedClaw team session could not be reloaded".to_string())?;
    Ok((session.id, snapshot))
}

fn create_redclaw_orchestration_run(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    require_confirmed_redclaw_team_plan(payload)?;
    let plan = plan_redclaw_orchestration(payload)?;
    let owner_session_id = payload_string(payload, "sessionId");
    let project_id = payload_string(payload, "projectId")
        .unwrap_or_else(|| format!("redclaw-project:{}", plan.run_id));
    with_store_mut(state, |store| {
        let metadata = json!({
            "source": "redclaw-orchestrator",
            "intent": "redclaw_orchestration",
            "preferredRole": "ops-coordinator",
            "runId": plan.run_id,
            "graphId": plan.graph.id,
            "projectId": project_id,
            "redclawTaskGraph": &plan.graph,
            "redclawAgentSpecs": &plan.agent_specs,
            "redclawSkillProfiles": &plan.skill_profiles,
            "subagentRoles": redclaw_plan_role_ids(&plan),
            "forceMultiAgent": true,
            "useRealSubagents": true,
            "temporaryTeam": true,
            "releasePolicy": plan.release_policy
        });
        let route = runtime_direct_route_record("redclaw", &plan.graph.goal, Some(&metadata));
        let task = runtime_tasks_store::store_task(
            store,
            "redclaw_orchestration",
            "pending",
            "redclaw".to_string(),
            owner_session_id,
            Some(plan.graph.goal.clone()),
            route,
            Some(metadata),
        );
        let (session_id, snapshot) = create_redclaw_team_records(store, &plan, Some(&task.id))?;
        Ok(json!({
            "success": true,
            "runId": plan.run_id,
            "runtimeTaskId": task.id,
            "sessionId": session_id,
            "graph": plan.graph,
            "snapshot": snapshot,
            "task": task
        }))
    })
}
