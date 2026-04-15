use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::chat_state::resolve_runtime_mode_for_session;
use crate::persistence::{with_store, with_store_mut};
use crate::runtime::{
    append_runtime_task_trace_scoped, append_session_checkpoint_scoped, RuntimeArtifact,
};
use crate::script_runtime::{
    default_limits_for_runtime_mode, execute_script_with_bridge, merge_limits,
    script_runtime_enabled_for_mode, RealScriptToolBridge, ScriptExecutionRequest, ScriptProgram,
    SCRIPT_RUNTIME_ELIGIBLE_MODES,
};
use crate::{payload_field, payload_string, AppState};

fn parse_program(payload: &Value) -> Result<ScriptProgram, String> {
    let Some(program) = payload_field(payload, "program") else {
        return Err("program is required for runtime:execute-script".to_string());
    };
    if let Some(text) = program.as_str() {
        serde_json::from_str::<ScriptProgram>(text).map_err(|error| error.to_string())
    } else {
        serde_json::from_value::<ScriptProgram>(program.clone()).map_err(|error| error.to_string())
    }
}

fn resolve_script_runtime_mode(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<String, String> {
    if let Some(runtime_mode) = payload_string(payload, "runtimeMode") {
        return Ok(runtime_mode);
    }
    if let Some(session_id) = payload_string(payload, "sessionId") {
        return with_store(state, |store| {
            Ok(resolve_runtime_mode_for_session(&store, &session_id))
        });
    }
    Err("runtimeMode is required when sessionId is not provided".to_string())
}

pub fn runtime_execute_script_value(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let runtime_mode = resolve_script_runtime_mode(state, payload)?;
    let settings_snapshot =
        crate::persistence::with_store(state, |store| Ok(store.settings.clone()))?;
    if !script_runtime_enabled_for_mode(&settings_snapshot, &runtime_mode) {
        return Err(format!(
            "script runtime is disabled for `{runtime_mode}`. eligible modes: {}",
            SCRIPT_RUNTIME_ELIGIBLE_MODES.join(", ")
        ));
    }

    let request = ScriptExecutionRequest {
        session_id: payload_string(payload, "sessionId"),
        task_id: payload_string(payload, "taskId"),
        runtime_mode: runtime_mode.clone(),
        inputs: payload_field(payload, "inputs")
            .cloned()
            .unwrap_or_else(|| json!({})),
        program: parse_program(payload)?,
        limits: payload_field(payload, "limits")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| error.to_string())?,
        reason: payload_string(payload, "reason"),
    };

    let limits = merge_limits(
        default_limits_for_runtime_mode(&request.runtime_mode),
        request.limits.as_ref(),
    );
    let mut bridge = RealScriptToolBridge::new(
        app,
        state,
        &request.runtime_mode,
        request.session_id.as_deref(),
        &limits,
    );
    let result = execute_script_with_bridge(&mut bridge, &request, limits.clone())?;

    with_store_mut(state, |store| {
        let runtime_scope = request
            .session_id
            .as_deref()
            .map(|session_id| crate::runtime::session_lineage_fields(store, session_id));
        let runtime_id = runtime_scope.as_ref().and_then(|item| item.0.clone());
        let parent_runtime_id = runtime_scope.as_ref().and_then(|item| item.1.clone());
        let source_task_id = request
            .task_id
            .clone()
            .or_else(|| runtime_scope.as_ref().and_then(|item| item.2.clone()));

        if let Some(session_id) = request.session_id.as_deref() {
            append_session_checkpoint_scoped(
                store,
                session_id,
                runtime_id.clone(),
                parent_runtime_id.clone(),
                source_task_id.clone(),
                "runtime.script_execution",
                if result.success {
                    format!(
                        "script runtime completed: {} tools, {} artifacts",
                        result.tool_call_count,
                        result.artifact_paths.len()
                    )
                } else {
                    format!(
                        "script runtime failed: {}",
                        result
                            .error_summary
                            .clone()
                            .unwrap_or_else(|| "unknown error".to_string())
                    )
                },
                Some(json!({
                    "executionId": result.execution_id,
                    "runtimeMode": result.runtime_mode,
                    "success": result.success,
                    "stdoutPreview": crate::truncate_chars(&result.stdout, 800),
                    "stdoutChars": result.stdout.chars().count(),
                    "stdoutTruncated": result.stdout_truncated,
                    "artifactPaths": result.artifact_paths,
                    "toolCallCount": result.tool_call_count,
                    "stepCount": result.step_count,
                    "errorSummary": result.error_summary,
                    "estimatedPromptReductionChars": result.estimated_prompt_reduction_chars,
                    "executedTools": result.executed_tools,
                    "stepSummaries": result.step_summaries,
                    "tempWorkspace": result.temp_workspace,
                    "limitSummary": result.limit_summary,
                    "reason": request.reason,
                })),
            );
        }

        if let Some(task_id) = request.task_id.as_deref() {
            append_runtime_task_trace_scoped(
                store,
                task_id,
                runtime_id.clone(),
                parent_runtime_id.clone(),
                source_task_id.clone(),
                Some("execute_tools".to_string()),
                "scripted_execution",
                Some(json!({
                    "executionId": result.execution_id,
                    "runtimeMode": result.runtime_mode,
                    "success": result.success,
                    "toolCallCount": result.tool_call_count,
                    "artifactCount": result.artifact_paths.len(),
                    "errorSummary": result.error_summary,
                    "estimatedPromptReductionChars": result.estimated_prompt_reduction_chars,
                })),
            );
            if let Some(task) = store
                .runtime_tasks
                .iter_mut()
                .find(|item| item.id == task_id)
            {
                for path in &result.artifact_paths {
                    task.artifacts.push(RuntimeArtifact::new(
                        "script-runtime-artifact",
                        "Script Runtime Artifact",
                        Some(path.clone()),
                        Some(json!({
                            "executionId": result.execution_id,
                            "runtimeMode": result.runtime_mode,
                        })),
                        None,
                    ));
                }
            }
        }
        Ok(())
    })?;

    Ok(json!(result))
}
