use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::events::emit_runtime_subagent_spawned;
use crate::runtime::{
    build_runtime_task_artifact_content, runtime_subagent_role_spec, RuntimeArtifact,
    RuntimeRouteRecord,
};
use crate::subagents::{real_subagents_enabled, run_real_subagent_orchestration_for_task};
use crate::{
    generate_structured_response_with_settings, load_redbox_prompt, parse_json_value_from_text,
    payload_string, render_redbox_prompt, role_sequence_for_route, slug_from_relative_path,
    workspace_root, write_text_file, AppState,
};

fn run_prompt_subagent_orchestration_for_task(
    app: Option<&AppHandle>,
    settings: &Value,
    runtime_mode: &str,
    task_id: &str,
    session_id: Option<&str>,
    route: &RuntimeRouteRecord,
    user_input: &str,
) -> Result<Value, String> {
    let Some(template) = load_redbox_prompt("runtime/ai/subagent_orchestrator.txt") else {
        return Ok(json!({
            "outputs": [],
            "promptSection": "subagent prompt unavailable"
        }));
    };
    let route_value = route.clone().into_value();
    let role_sequence = role_sequence_for_route(&route_value);
    let mut outputs = Vec::<Value>::new();
    for role_id in role_sequence {
        if let Some(handle) = app {
            emit_runtime_subagent_spawned(
                handle,
                Some(task_id),
                session_id,
                &role_id,
                runtime_mode,
                None,
                None,
                None,
                None,
            );
        }
        let role_spec = runtime_subagent_role_spec(&role_id);
        let system_prompt = render_redbox_prompt(
            &template,
            &[
                ("role_id", role_spec.role_id.clone()),
                ("role_purpose", role_spec.purpose.clone()),
                ("role_handoff", role_spec.handoff_contract.clone()),
                ("role_output_schema", role_spec.output_schema.clone()),
                ("role_directive", role_spec.system_prompt.clone()),
                ("runtime_mode", runtime_mode.to_string()),
                ("task_id", task_id.to_string()),
                ("intent", route.intent.clone()),
                ("goal", route.goal.clone()),
                (
                    "required_capabilities",
                    serde_json::to_string(&route.required_capabilities)
                        .unwrap_or_else(|_| "[]".to_string()),
                ),
                ("previous_outputs_json", json!(outputs).to_string()),
            ],
        );
        let user_prompt = format!("用户请求：{}\n任务目标：{}", user_input, route.goal);
        let raw = generate_structured_response_with_settings(
            settings,
            None,
            &system_prompt,
            &user_prompt,
            true,
        )?;
        let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
            json!({
                "summary": raw,
                "artifact": "",
                "handoff": "",
                "risks": []
            })
        });
        outputs.push(json!({
            "roleId": role_spec.role_id,
            "summary": payload_string(&parsed, "summary").unwrap_or_else(|| raw.clone()),
            "artifact": payload_string(&parsed, "artifact"),
            "handoff": payload_string(&parsed, "handoff"),
            "risks": parsed.get("risks").cloned().unwrap_or_else(|| json!([])),
            "issues": parsed.get("issues").cloned().unwrap_or_else(|| json!([])),
            "approved": parsed.get("approved").cloned().unwrap_or_else(|| json!(true)),
        }));
    }
    Ok(json!({
        "outputs": outputs,
        "promptSection": "subagent orchestration completed"
    }))
}

pub fn run_subagent_orchestration_for_task(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    settings: &Value,
    runtime_mode: &str,
    task_id: &str,
    session_id: Option<&str>,
    route: &RuntimeRouteRecord,
    user_input: &str,
    metadata: Option<&Value>,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    if let Some(handle) = app {
        if real_subagents_enabled(settings, metadata) {
            return run_real_subagent_orchestration_for_task(
                handle,
                state,
                settings,
                runtime_mode,
                task_id,
                session_id,
                route,
                user_input,
                metadata,
                model_config,
            );
        }
    }
    run_prompt_subagent_orchestration_for_task(
        app,
        settings,
        runtime_mode,
        task_id,
        session_id,
        route,
        user_input,
    )
}

pub fn save_runtime_task_artifact(
    state: &State<'_, AppState>,
    task_id: &str,
    route: &RuntimeRouteRecord,
    goal: &str,
    orchestration: Option<&Value>,
) -> Result<RuntimeArtifact, String> {
    let intent = route.intent.clone();
    let root = workspace_root(state)?;
    let (dir, extension) = match intent.as_str() {
        "manuscript_creation" | "advisor_persona" | "discussion" | "direct_answer" => {
            (root.join("manuscripts").join("runtime-tasks"), "md")
        }
        "image_creation" | "cover_generation" => (root.join("cover").join("runtime-tasks"), "md"),
        _ => (root.join("redclaw").join("runtime-artifacts"), "md"),
    };
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!(
        "{}-artifact.{}",
        slug_from_relative_path(task_id),
        extension
    ));
    let route_value = route.clone().into_value();
    let content = build_runtime_task_artifact_content(task_id, &route_value, goal, orchestration)?;
    write_text_file(&path, &content)?;
    Ok(RuntimeArtifact::new(
        "saved-artifact",
        "Saved Artifact",
        Some(path.display().to_string()),
        Some(json!({ "intent": intent })),
        None,
    ))
}

pub fn run_reviewer_repair_for_task(
    settings: &Value,
    task_id: &str,
    route: &RuntimeRouteRecord,
    goal: &str,
    orchestration: &Value,
) -> Result<Value, String> {
    let reviewer = orchestration
        .get("outputs")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("roleId").and_then(|value| value.as_str()) == Some("reviewer")
            })
        })
        .cloned()
        .unwrap_or_else(|| json!({}));
    let issues = reviewer
        .get("issues")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let prompt = format!(
        "Task ID: {}\nGoal: {}\nRoute: {}\nReviewer issues: {}\n\nReturn strict JSON with fields summary, artifact, handoff, risks. Focus on concrete repair steps needed before the task can be considered complete.",
        task_id,
        goal,
        route.clone().into_value(),
        issues
    );
    let raw = generate_structured_response_with_settings(
        settings,
        None,
        "You are a runtime repair planner for RedBox. Output strict JSON only.",
        &prompt,
        true,
    )?;
    Ok(parse_json_value_from_text(&raw).unwrap_or_else(|| {
        json!({
            "summary": raw,
            "artifact": "",
            "handoff": "",
            "risks": []
        })
    }))
}
