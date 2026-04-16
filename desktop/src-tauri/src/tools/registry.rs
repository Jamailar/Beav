use serde_json::{json, Value};

use crate::skills::{build_skill_runtime_state, SkillActivationContext};
use crate::tools::catalog::{descriptor_by_name, schema_for_tool, ToolDescriptor};
use crate::tools::packs::tool_names_for_runtime_mode;
use crate::{AppStore, SkillRecord};

fn kind_text(kind: crate::tools::catalog::ToolKind) -> &'static str {
    match kind {
        crate::tools::catalog::ToolKind::AppQuery => "app_query",
        crate::tools::catalog::ToolKind::FileSystem => "file_system",
        crate::tools::catalog::ToolKind::ProfileDoc => "profile_doc",
        crate::tools::catalog::ToolKind::Mcp => "mcp",
        crate::tools::catalog::ToolKind::Skill => "skill",
        crate::tools::catalog::ToolKind::RuntimeControl => "runtime_control",
        crate::tools::catalog::ToolKind::Editor => "editor",
    }
}

pub fn base_tool_names_for_session_metadata(
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<String> {
    let base = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    let requested = metadata
        .and_then(|item| item.get("allowedTools"))
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
        .unwrap_or_default();
    if requested.is_empty() {
        return base;
    }
    requested
        .into_iter()
        .filter(|item| base.iter().any(|allowed| allowed == item))
        .collect()
}

pub fn tool_names_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Vec<String> {
    tool_names_for_request(store, runtime_mode, session_id, None, None)
}

fn merge_metadata(base: Option<Value>, overlay: Option<Value>) -> Option<Value> {
    match (base, overlay) {
        (Some(Value::Object(mut base_map)), Some(Value::Object(overlay_map))) => {
            for (key, value) in overlay_map {
                base_map.insert(key, value);
            }
            Some(Value::Object(base_map))
        }
        (_, Some(overlay)) => Some(overlay),
        (Some(base), None) => Some(base),
        (None, None) => None,
    }
}

pub fn tool_names_for_request(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    metadata_override: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Vec<String> {
    let metadata = session_id.and_then(|id| {
        store
            .chat_sessions
            .iter()
            .find(|item| item.id == id)
            .and_then(|item| item.metadata.clone())
    });
    let merged_metadata = merge_metadata(metadata, metadata_override.cloned());
    let base = base_tool_names_for_session_metadata(runtime_mode, merged_metadata.as_ref());
    let skill_state = build_skill_runtime_state(
        &store.skills,
        runtime_mode,
        merged_metadata.as_ref(),
        &base,
        activation,
    );
    skill_state.allowed_tools
}

pub fn tool_names_for_skill_records(
    skills: &[SkillRecord],
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    metadata_override: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Vec<String> {
    let metadata = session_id.and_then(|id| {
        store
            .chat_sessions
            .iter()
            .find(|item| item.id == id)
            .and_then(|item| item.metadata.clone())
    });
    let merged_metadata = merge_metadata(metadata, metadata_override.cloned());
    let base = base_tool_names_for_session_metadata(runtime_mode, merged_metadata.as_ref());
    build_skill_runtime_state(skills, runtime_mode, merged_metadata.as_ref(), &base, activation)
        .allowed_tools
}

pub fn descriptors_for_tool_names(tool_names: &[String]) -> Vec<ToolDescriptor> {
    tool_names
        .iter()
        .filter_map(|name| descriptor_by_name(name))
        .collect()
}

pub fn descriptor_by_name_for_runtime_mode(
    runtime_mode: &str,
    tool_name: &str,
) -> Option<ToolDescriptor> {
    if !tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .any(|name| *name == tool_name)
    {
        return None;
    }
    descriptor_by_name(tool_name)
}

pub fn descriptor_by_name_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    tool_name: &str,
) -> Option<ToolDescriptor> {
    if !tool_names_for_session(store, runtime_mode, session_id)
        .iter()
        .any(|name| name == tool_name)
    {
        return None;
    }
    descriptor_by_name(tool_name)
}

pub fn openai_schemas_for_runtime_mode(runtime_mode: &str) -> Value {
    let schemas = tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .filter_map(|name| schema_for_tool(name))
        .collect::<Vec<_>>();
    json!(schemas)
}

pub fn openai_schemas_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Value {
    openai_schemas_for_request(store, runtime_mode, session_id, None, None)
}

pub fn openai_schemas_for_request(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    metadata_override: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Value {
    let schemas = tool_names_for_request(store, runtime_mode, session_id, metadata_override, activation)
        .iter()
        .filter_map(|name| schema_for_tool(name))
        .collect::<Vec<_>>();
    json!(schemas)
}

pub fn openai_schemas_for_skill_records(
    skills: &[SkillRecord],
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    metadata_override: Option<&Value>,
    activation: Option<&SkillActivationContext>,
) -> Value {
    let schemas = tool_names_for_skill_records(
        skills,
        store,
        runtime_mode,
        session_id,
        metadata_override,
        activation,
    )
    .iter()
    .filter_map(|name| schema_for_tool(name))
    .collect::<Vec<_>>();
    json!(schemas)
}

pub fn prompt_tool_lines_for_tool_names(tool_names: &[String]) -> String {
    descriptors_for_tool_names(tool_names)
        .iter()
        .map(|item| {
            format!(
                "- {} | kind={} | requiresApproval={} | concurrencySafe={} | outputBudget={} chars",
                item.name,
                kind_text(item.kind),
                item.requires_approval,
                item.concurrency_safe,
                item.output_budget_chars
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn diagnostics_tool_items() -> Vec<Value> {
    [
        "redbox_app_query",
        "redbox_fs",
        "redbox_profile_doc",
        "redbox_mcp",
        "redbox_skill",
        "redbox_runtime_control",
        "redbox_editor",
    ]
    .iter()
    .filter_map(|name| descriptor_by_name(name))
    .map(|tool| {
        json!({
            "name": tool.name,
            "displayName": format!("Runtime · {}", tool.name),
            "description": tool.description,
            "kind": kind_text(tool.kind),
            "requiresApproval": tool.requires_approval,
            "defaultApproval": tool.default_approval,
            "riskLevel": tool.risk_level,
            "concurrencySafe": tool.concurrency_safe,
            "outputBudgetChars": tool.output_budget_chars,
            "visibility": "developer",
            "contexts": ["desktop"],
            "availabilityStatus": "available",
            "availabilityReason": "Registered in Rust Tool Registry"
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_names_for_session_respects_allowed_tools_intersection() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(crate::ChatSessionRecord {
            id: "session-1".to_string(),
            title: "Child".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "allowedTools": ["redbox_fs", "redbox_runtime_control", "not_real"]
            })),
        });

        let names = tool_names_for_session(&store, "chatroom", Some("session-1"));
        assert_eq!(
            names,
            vec![
                "redbox_fs".to_string(),
                "redbox_runtime_control".to_string()
            ]
        );
    }
}
