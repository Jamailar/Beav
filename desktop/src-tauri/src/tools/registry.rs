use serde_json::{json, Value};

use crate::skills::build_skill_runtime_state;
use crate::tools::catalog::{descriptor_by_name, schema_for_tool, ToolDescriptor};
use crate::tools::compat::canonical_tool_name;
use crate::tools::packs::tool_names_for_runtime_mode;
use crate::AppStore;

fn kind_text(kind: crate::tools::catalog::ToolKind) -> &'static str {
    match kind {
        crate::tools::catalog::ToolKind::AppCli => "app_cli",
        crate::tools::catalog::ToolKind::Bash => "bash",
        crate::tools::catalog::ToolKind::AppQuery => "app_query",
        crate::tools::catalog::ToolKind::FileSystem => "file_system",
        crate::tools::catalog::ToolKind::ProfileDoc => "profile_doc",
        crate::tools::catalog::ToolKind::Mcp => "mcp",
        crate::tools::catalog::ToolKind::Skill => "skill",
        crate::tools::catalog::ToolKind::RuntimeControl => "runtime_control",
        crate::tools::catalog::ToolKind::Editor => "editor",
    }
}

fn normalize_requested_tool_name(name: &str) -> &str {
    canonical_tool_name(name)
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
            let mut normalized = Vec::new();
            for item in items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(normalize_requested_tool_name)
                .map(ToString::to_string)
            {
                if !normalized.iter().any(|existing| existing == &item) {
                    normalized.push(item);
                }
            }
            normalized
        })
        .unwrap_or_default();
    if requested.is_empty() {
        return base;
    }
    let filtered = requested
        .into_iter()
        .filter(|item| base.iter().any(|allowed| allowed == item))
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        return base;
    }
    filtered
}

pub fn tool_names_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Vec<String> {
    let metadata = session_id.and_then(|id| {
        store
            .chat_sessions
            .iter()
            .find(|item| item.id == id)
            .and_then(|item| item.metadata.as_ref())
    });
    let base = base_tool_names_for_session_metadata(runtime_mode, metadata);
    let skill_state = build_skill_runtime_state(&store.skills, runtime_mode, metadata, &base);
    skill_state.allowed_tools
}

pub fn descriptors_for_runtime_mode(runtime_mode: &str) -> Vec<ToolDescriptor> {
    tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .filter_map(|name| descriptor_by_name(name))
        .collect()
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
    let schemas = tool_names_for_session(store, runtime_mode, session_id)
        .iter()
        .filter_map(|name| schema_for_tool(name))
        .collect::<Vec<_>>();
    json!(schemas)
}

pub fn prompt_tool_lines_for_runtime_mode(runtime_mode: &str) -> String {
    descriptors_for_runtime_mode(runtime_mode)
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

pub fn prompt_tool_lines_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> String {
    let tool_names = tool_names_for_session(store, runtime_mode, session_id);
    prompt_tool_lines_for_tool_names(&tool_names)
}

pub fn diagnostics_tool_items() -> Vec<Value> {
    ["bash", "redbox_fs", "app_cli", "redbox_editor"]
        .iter()
        .filter_map(|name| descriptor_by_name(name))
        .map(|tool| {
            json!({
                "name": tool.name,
                "displayName": format!("Runtime · {}", tool.name),
                "description": tool.description,
                "kind": kind_text(tool.kind),
                "requiresApproval": tool.requires_approval,
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
        assert_eq!(names, vec!["redbox_fs".to_string(), "app_cli".to_string()]);
    }
}
