use serde_json::{json, Value};

use crate::tools::catalog::{descriptor_by_name, schema_for_tool, ToolDescriptor};
use crate::tools::packs::tool_names_for_runtime_mode;

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

pub fn descriptors_for_runtime_mode(runtime_mode: &str) -> Vec<ToolDescriptor> {
    tool_names_for_runtime_mode(runtime_mode)
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

pub fn openai_schemas_for_runtime_mode(runtime_mode: &str) -> Value {
    let schemas = tool_names_for_runtime_mode(runtime_mode)
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
