use serde_json::Value;
use tauri::State;

use crate::persistence::with_store;
use crate::tools::capabilities::{
    append_capability_audit_record, approval_blocks_automated_entry, approval_level_for_tool,
    build_audit_record, resolve_capability_set, summarize_tool_arguments, CapabilityGuardDecision,
};
use crate::tools::catalog::{approval_level_max, descriptor_by_name, ApprovalLevel};
use crate::tools::registry::{descriptor_by_name_for_runtime_mode, descriptor_by_name_for_session};
use crate::{payload_field, payload_string, AppState};

fn action_from_arguments(tool_name: &str, arguments: &Value) -> Option<String> {
    match tool_name {
        "redbox_fs"
        | "redbox_profile_doc"
        | "redbox_mcp"
        | "redbox_skill"
        | "redbox_runtime_control"
        | "redbox_editor" => payload_string(arguments, "action"),
        "redbox_app_query" => payload_string(arguments, "operation"),
        _ => None,
    }
}

fn mutating_editor_action(action: &str) -> bool {
    matches!(
        action,
        "script_update"
            | "script-update"
            | "script_confirm"
            | "script-confirm"
            | "ffmpeg_edit"
            | "ffmpeg-edit"
            | "remotion_generate"
            | "remotion-generate"
            | "remotion_save"
            | "remotion-save"
            | "export"
            | "track_add"
            | "track-add"
            | "track_reorder"
            | "track-reorder"
            | "track_delete"
            | "track-delete"
            | "clip_add"
            | "clip-add"
            | "clip_insert_at_playhead"
            | "clip-insert-at-playhead"
            | "subtitle_add"
            | "subtitle-add"
            | "text_add"
            | "text-add"
            | "clip_update"
            | "clip-update"
            | "clip_move"
            | "clip-move"
            | "clip_toggle_enabled"
            | "clip-toggle-enabled"
            | "clip_delete"
            | "clip-delete"
            | "clip_split"
            | "clip-split"
            | "clip_duplicate"
            | "clip-duplicate"
            | "clip_replace_asset"
            | "clip-replace-asset"
            | "marker_add"
            | "marker-add"
            | "marker_update"
            | "marker-update"
            | "marker_delete"
            | "marker-delete"
            | "undo"
            | "redo"
    )
}

fn approval_level_for_action(
    decision: &CapabilityGuardDecision,
    arguments: &Value,
) -> ApprovalLevel {
    let action = action_from_arguments(decision.descriptor.name, arguments).unwrap_or_default();
    let mut level = decision.approval_level;
    match decision.descriptor.name {
        "redbox_profile_doc" if action == "update" => {
            level = approval_level_max(level, ApprovalLevel::Explicit);
        }
        "redbox_mcp" => {
            let action_level = match action.as_str() {
                "disconnect_all" => ApprovalLevel::AlwaysHold,
                "save" | "disconnect" | "discover_local" | "import_local" | "call" => {
                    ApprovalLevel::Explicit
                }
                "test" => ApprovalLevel::Light,
                _ => ApprovalLevel::None,
            };
            level = approval_level_max(level, action_level);
        }
        "redbox_skill" => {
            let action_level = match action.as_str() {
                "create" | "save" | "enable" | "disable" | "market_install" => {
                    ApprovalLevel::Explicit
                }
                "test_connection" | "fetch_models" => ApprovalLevel::Explicit,
                "detect_protocol" => ApprovalLevel::Light,
                _ => ApprovalLevel::None,
            };
            level = approval_level_max(level, action_level);
        }
        "redbox_runtime_control" => {
            let action_level = match action.as_str() {
                "runtime_query"
                | "runtime_resume"
                | "runtime_fork_session"
                | "runtime_execute_script"
                | "tasks_create"
                | "tasks_resume"
                | "tasks_cancel"
                | "background_tasks_cancel" => ApprovalLevel::Explicit,
                _ => ApprovalLevel::None,
            };
            level = approval_level_max(level, action_level);
        }
        "redbox_editor" if mutating_editor_action(&action) => {
            level = approval_level_max(level, ApprovalLevel::Light);
        }
        _ => {}
    }
    level
}

fn validate_relative_tool_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        return Err("path must stay relative to currentSpaceRoot".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized
        .split('/')
        .any(|segment| segment.trim().is_empty() || segment == "..")
    {
        return Err("path may not escape currentSpaceRoot".to_string());
    }
    Ok(())
}

fn ensure_known_server_id_or_name(
    decision: &CapabilityGuardDecision,
    arguments: &Value,
) -> Result<(), String> {
    let server = payload_field(arguments, "server").unwrap_or(arguments);
    let server_id = payload_string(server, "id")
        .or_else(|| payload_string(arguments, "serverId"))
        .unwrap_or_default();
    let server_name = payload_string(server, "name")
        .or_else(|| payload_string(arguments, "serverName"))
        .unwrap_or_default();
    if server_id.trim().is_empty() && server_name.trim().is_empty() {
        return Err("server.id or server.name is required".to_string());
    }
    let id_allowed = !server_id.trim().is_empty()
        && decision
            .capability_set
            .mcp_scope
            .allowed_server_ids
            .iter()
            .any(|item| item == &server_id);
    let name_allowed = !server_name.trim().is_empty()
        && decision
            .capability_set
            .mcp_scope
            .allowed_server_names
            .iter()
            .any(|item| item == &server_name);
    if id_allowed || name_allowed {
        return Ok(());
    }
    Err("server is not in capability allowlist".to_string())
}

fn validate_tool_arguments(
    decision: &CapabilityGuardDecision,
    arguments: &Value,
) -> Result<(), String> {
    let action = action_from_arguments(decision.descriptor.name, arguments).unwrap_or_default();
    match decision.descriptor.name {
        "redbox_fs" => {
            if !matches!(action.as_str(), "list" | "read") {
                return Err(format!("unsupported fs action: {action}"));
            }
            let path = payload_string(arguments, "path").unwrap_or_default();
            validate_relative_tool_path(&path)?;
        }
        "redbox_profile_doc" => {
            if !matches!(action.as_str(), "bundle" | "read" | "update") {
                return Err(format!("unsupported profile_doc action: {action}"));
            }
            if action == "read" || action == "update" {
                let doc_type = payload_string(arguments, "docType").unwrap_or_default();
                if !matches!(
                    doc_type.as_str(),
                    "agent" | "soul" | "user" | "creator_profile"
                ) {
                    return Err(format!("unsupported profile doc type: {doc_type}"));
                }
            }
            if action == "update" {
                if !matches!(
                    decision.capability_set.runtime_mode.as_str(),
                    "redclaw" | "diagnostics"
                ) {
                    return Err(
                        "profile doc update is only allowed in redclaw or diagnostics runtime"
                            .to_string(),
                    );
                }
                if !matches!(
                    decision.capability_set.entry_kind,
                    crate::tools::capabilities::CapabilityEntryKind::Interactive
                        | crate::tools::capabilities::CapabilityEntryKind::Diagnostics
                ) {
                    return Err(
                        "profile doc update is blocked for subagent and background entries"
                            .to_string(),
                    );
                }
                if payload_string(arguments, "markdown")
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err("markdown is required for profile doc update".to_string());
                }
            }
        }
        "redbox_mcp" => {
            if !decision
                .capability_set
                .mcp_scope
                .allowed_actions
                .iter()
                .any(|item| item == &action)
            {
                return Err(format!(
                    "mcp action `{action}` is blocked by capability scope"
                ));
            }
            if [
                "call",
                "list_tools",
                "list_resources",
                "list_resource_templates",
                "disconnect",
            ]
            .contains(&action.as_str())
            {
                ensure_known_server_id_or_name(decision, arguments)?;
            }
            if action == "oauth_status" {
                let server_id = payload_string(arguments, "serverId").unwrap_or_default();
                if server_id.trim().is_empty() {
                    return Err("serverId is required for oauth_status".to_string());
                }
                if !decision
                    .capability_set
                    .mcp_scope
                    .allowed_server_ids
                    .iter()
                    .any(|item| item == &server_id)
                {
                    return Err("serverId is not in capability allowlist".to_string());
                }
            }
        }
        "redbox_skill" => {
            if action.trim().is_empty() {
                return Err("skill action is required".to_string());
            }
            match action.as_str() {
                "create" => {
                    if payload_string(arguments, "name")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        return Err("name is required for skill create".to_string());
                    }
                }
                "save" => {
                    if payload_string(arguments, "location")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        return Err("location is required for skill save".to_string());
                    }
                    if payload_string(arguments, "content")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        return Err("content is required for skill save".to_string());
                    }
                }
                "enable" | "disable" => {
                    if payload_string(arguments, "name")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        return Err("name is required for skill toggle".to_string());
                    }
                }
                "market_install" => {
                    if payload_string(arguments, "slug")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        return Err("slug is required for market_install".to_string());
                    }
                }
                "invoke" => {
                    if payload_string(arguments, "name")
                        .map(|value| value.trim().is_empty())
                        .unwrap_or(true)
                    {
                        return Err("name is required for skill invoke".to_string());
                    }
                }
                "preview_activation" => {}
                "detect_protocol" | "test_connection" | "fetch_models" => {
                    let has_endpoint = payload_string(arguments, "baseURL")
                        .map(|value| !value.trim().is_empty())
                        .unwrap_or(false)
                        || payload_string(arguments, "presetId")
                            .map(|value| !value.trim().is_empty())
                            .unwrap_or(false);
                    if !has_endpoint {
                        return Err("baseURL or presetId is required for model endpoint actions"
                            .to_string());
                    }
                }
                "list" | "ai_roles_list" => {}
                _ => return Err(format!("unsupported redbox_skill action: {action}")),
            }
        }
        "redbox_runtime_control" => match action.as_str() {
            "runtime_query" => {
                if payload_string(arguments, "message")
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err("message is required for runtime_query".to_string());
                }
            }
            "runtime_resume"
            | "runtime_fork_session"
            | "runtime_get_trace"
            | "runtime_get_checkpoints"
            | "runtime_get_tool_results" => {
                if payload_string(arguments, "sessionId")
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err("sessionId is required for runtime session actions".to_string());
                }
            }
            "tasks_get"
            | "tasks_resume"
            | "tasks_cancel"
            | "background_tasks_get"
            | "background_tasks_cancel" => {
                if payload_string(arguments, "taskId")
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err("taskId is required for task control actions".to_string());
                }
            }
            "runtime_execute_script" => {
                let runtime_mode = payload_string(arguments, "runtimeMode").unwrap_or_default();
                if !matches!(
                    runtime_mode.as_str(),
                    "knowledge" | "diagnostics" | "video-editor"
                ) {
                    return Err("runtime_execute_script only supports knowledge, diagnostics, and video-editor runtime modes".to_string());
                }
                if payload_field(arguments, "program").is_none() {
                    return Err("program is required for runtime_execute_script".to_string());
                }
            }
            "runtime_recall"
            | "tasks_create"
            | "tasks_list"
            | "background_tasks_list"
            | "session_bridge_status"
            | "session_bridge_list_sessions"
            | "session_bridge_get_session" => {}
            _ => {
                return Err(format!(
                    "unsupported redbox_runtime_control action: {action}"
                ))
            }
        },
        _ => {}
    }
    Ok(())
}

fn block_with_audit(
    state: &State<'_, AppState>,
    decision: &CapabilityGuardDecision,
    session_id: Option<&str>,
    reason: &str,
) -> Result<CapabilityGuardDecision, String> {
    let _ = append_capability_audit_record(
        state,
        build_audit_record(decision, session_id, "blocked", reason),
    );
    Err(reason.to_string())
}

pub fn preflight_tool_call(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    tool_name: &str,
    arguments: &Value,
) -> Result<CapabilityGuardDecision, String> {
    let session_descriptor = with_store(state, |store| {
        Ok(descriptor_by_name_for_session(
            &store,
            runtime_mode,
            session_id,
            tool_name,
        ))
    })?;
    let Some(descriptor) = session_descriptor.or_else(|| descriptor_by_name(tool_name)) else {
        return Err(format!("unsupported interactive tool: {tool_name}"));
    };
    let capability_set = resolve_capability_set(state, runtime_mode, session_id)?;
    let arguments_summary = summarize_tool_arguments(tool_name, arguments);
    let mut decision = CapabilityGuardDecision {
        tool_action: action_from_arguments(tool_name, arguments),
        approval_level: approval_level_for_tool(&capability_set, &descriptor),
        capability_set,
        descriptor,
        arguments_summary,
    };
    decision.approval_level = approval_level_for_action(&decision, arguments);

    if !decision
        .capability_set
        .allowed_tools
        .iter()
        .any(|item| item == tool_name)
    {
        return block_with_audit(
            state,
            &decision,
            session_id,
            &format!(
                "tool `{tool_name}` is not allowed for runtime `{}` entry `{}`",
                decision.capability_set.runtime_mode,
                serde_json::to_string(&decision.capability_set.entry_kind)
                    .unwrap_or_else(|_| "\"unknown\"".to_string())
            ),
        );
    }

    if let Err(error) = validate_tool_arguments(&decision, arguments) {
        return block_with_audit(state, &decision, session_id, &error);
    }

    if approval_blocks_automated_entry(&decision.capability_set.entry_kind, decision.approval_level)
    {
        let action = decision
            .tool_action
            .clone()
            .unwrap_or_else(|| decision.descriptor.name.to_string());
        return block_with_audit(
            state,
            &decision,
            session_id,
            &format!(
                "capability policy blocked `{}` for automated entry {:?} at approval {:?}",
                action, decision.capability_set.entry_kind, decision.approval_level
            ),
        );
    }

    Ok(decision)
}

pub fn record_tool_execution_outcome(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    decision: &CapabilityGuardDecision,
    result: &Result<Value, String>,
) {
    let (outcome, reason) = match result {
        Ok(value) => (
            "allowed",
            if decision.approval_level == ApprovalLevel::None {
                "tool executed within capability bounds".to_string()
            } else {
                format!(
                    "tool executed with {:?} approval policy; result keys={}",
                    decision.approval_level,
                    value.as_object().map(|object| object.len()).unwrap_or(0)
                )
            },
        ),
        Err(error) => ("failed", error.clone()),
    };
    let _ = append_capability_audit_record(
        state,
        build_audit_record(decision, session_id, outcome, &reason),
    );
}

pub fn output_budget_for_tool(runtime_mode: &str, tool_name: &str) -> usize {
    descriptor_by_name_for_runtime_mode(runtime_mode, tool_name)
        .map(|item| item.output_budget_chars)
        .unwrap_or(8_000)
}

pub fn apply_output_budget(runtime_mode: &str, tool_name: &str, content: &str) -> (String, bool) {
    let budget = output_budget_for_tool(runtime_mode, tool_name);
    let count = content.chars().count();
    if count <= budget {
        return (content.to_string(), false);
    }
    let mut truncated = content.chars().take(budget).collect::<String>();
    truncated.push_str("\n\n[truncated by ToolResultBudget]");
    (truncated, true)
}
