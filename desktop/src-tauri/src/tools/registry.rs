use serde_json::{json, Value};

use crate::tools::catalog::{
    descriptor_by_name, schema_for_tool_for_runtime_mode, schema_for_tool_from_action_descriptors,
    tool_action_family_summary, tool_action_family_summary_for_descriptors, ToolDescriptor,
};
use crate::tools::packs::{tool_names_for_runtime_mode, visible_tool_names_for_runtime_mode};
use crate::tools::plan::{
    base_tool_names_for_metadata, build_tool_registry_plan_for_session, ToolRegistryPlan,
};
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

fn string_list(metadata: Option<&Value>, field: &str) -> Vec<String> {
    metadata
        .and_then(|item| item.get(field))
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
        .unwrap_or_default()
}

pub fn normalized_allowed_app_cli_actions(metadata: Option<&Value>) -> Vec<String> {
    let mut actions = string_list(metadata, "allowedAppCliActions");
    let looks_like_legacy_authoring_whitelist = actions.iter().any(|item| {
        matches!(
            item.as_str(),
            "manuscripts.createProject" | "manuscripts.writeCurrent"
        )
    });
    if looks_like_legacy_authoring_whitelist && !actions.iter().any(|item| item == "image.generate")
    {
        actions.push("image.generate".to_string());
    }
    actions
}

pub fn base_tool_names_for_session_metadata(
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<String> {
    base_tool_names_for_metadata(runtime_mode, metadata)
}

pub fn tool_names_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Vec<String> {
    build_tool_registry_plan_for_session(store, runtime_mode, session_id).internal_tool_names
}

pub fn descriptors_for_runtime_mode(runtime_mode: &str) -> Vec<ToolDescriptor> {
    visible_tool_names_for_runtime_mode(runtime_mode)
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
        && !visible_tool_names_for_runtime_mode(runtime_mode)
            .iter()
            .any(|name| *name == tool_name)
    {
        return None;
    }
    descriptor_by_name(tool_name)
}

#[allow(dead_code)]
pub fn descriptor_by_name_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    tool_name: &str,
) -> Option<ToolDescriptor> {
    let plan = build_tool_registry_plan_for_session(store, runtime_mode, session_id);
    if !plan
        .internal_tool_names
        .iter()
        .any(|name| name == tool_name)
        && !plan
            .visible_tools
            .iter()
            .any(|descriptor| descriptor.name == tool_name)
    {
        return None;
    }
    descriptor_by_name(tool_name)
}

pub fn openai_schemas_for_runtime_mode(runtime_mode: &str) -> Value {
    let schemas = visible_tool_names_for_runtime_mode(runtime_mode)
        .iter()
        .filter_map(|name| schema_for_tool_for_runtime_mode(name, Some(runtime_mode)))
        .collect::<Vec<_>>();
    json!(schemas)
}

pub fn openai_schemas_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Value {
    let plan = build_tool_registry_plan_for_session(store, runtime_mode, session_id);
    let schemas = plan
        .visible_tools
        .iter()
        .filter_map(|tool| {
            if tool.name == "Redbox" && !plan.direct_app_cli_actions.is_empty() {
                schema_for_tool_from_action_descriptors("Redbox", &plan.direct_app_cli_actions)
            } else {
                schema_for_tool_for_runtime_mode(tool.name, Some(&plan.runtime_mode))
            }
        })
        .collect::<Vec<_>>();
    json!(schemas)
}

pub fn tool_plan_snapshot_for_session(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Value {
    let plan = build_tool_registry_plan_for_session(store, runtime_mode, session_id);
    json!({
        "runtimeMode": plan.runtime_mode,
        "sessionId": session_id,
        "fingerprint": plan.fingerprint,
        "internalTools": plan.internal_tool_names,
        "visibleTools": plan
            .visible_tools
            .iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>(),
        "directAppCliActions": plan
            .direct_app_cli_actions
            .iter()
            .map(|descriptor| descriptor.action)
            .collect::<Vec<_>>(),
        "deferredActionNamespaces": plan.deferred_action_namespaces,
        "deferredActionCount": plan.deferred_app_cli_actions.len(),
    })
}

pub fn prompt_tool_lines_for_runtime_mode(runtime_mode: &str) -> String {
    descriptors_for_runtime_mode(runtime_mode)
        .iter()
        .map(|item| {
            let capability_summary = tool_action_family_summary(item.name, Some(runtime_mode))
                .map(|summary| format!(" | capabilities={summary}"))
                .unwrap_or_default();
            format!(
                "- {} | kind={} | requiresApproval={} | concurrencySafe={} | outputBudget={} chars{}",
                item.name,
                kind_text(item.kind),
                item.requires_approval,
                item.concurrency_safe,
                item.output_budget_chars,
                capability_summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(dead_code)]
pub fn prompt_tool_lines_for_tool_names(
    tool_names: &[String],
    runtime_mode: Option<&str>,
) -> String {
    descriptors_for_tool_names(tool_names)
        .iter()
        .map(|item| {
            let capability_summary = tool_action_family_summary(item.name, runtime_mode)
                .map(|summary| format!(" | capabilities={summary}"))
                .unwrap_or_default();
            format!(
                "- {} | kind={} | requiresApproval={} | concurrencySafe={} | outputBudget={} chars{}",
                item.name,
                kind_text(item.kind),
                item.requires_approval,
                item.concurrency_safe,
                item.output_budget_chars,
                capability_summary
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
    let plan = build_tool_registry_plan_for_session(store, runtime_mode, session_id);
    plan.visible_tools
        .iter()
        .map(|item| {
            let capability_summary = capability_summary_for_plan_tool(item.name, &plan)
                .map(|summary| format!(" | capabilities={summary}"))
                .unwrap_or_default();
            format!(
                "- {} | kind={} | requiresApproval={} | concurrencySafe={} | outputBudget={} chars{}",
                item.name,
                kind_text(item.kind),
                item.requires_approval,
                item.concurrency_safe,
                item.output_budget_chars,
                capability_summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn capability_summary_for_plan_tool(tool_name: &str, plan: &ToolRegistryPlan) -> Option<String> {
    if tool_name == "Redbox" && !plan.direct_app_cli_actions.is_empty() {
        let mut summary = tool_action_family_summary_for_descriptors(&plan.direct_app_cli_actions)?;
        if !plan.deferred_action_namespaces.is_empty() {
            summary.push_str(" | deferred=");
            summary.push_str(&plan.deferred_action_namespaces.join(","));
            summary.push_str(" | discover=Redbox(resource=tools, operation=search)");
        }
        return Some(summary);
    }
    tool_action_family_summary(tool_name, Some(&plan.runtime_mode))
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

    #[test]
    fn openai_schemas_for_session_exposes_universal_tools() {
        let mut store = crate::AppStore::default();
        store.chat_sessions.push(crate::ChatSessionRecord {
            id: "session-1".to_string(),
            title: "Authoring".to_string(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
            metadata: Some(json!({
                "allowedTools": ["redbox_fs", "app_cli"],
                "allowedAppCliActions": [
                    "manuscripts.createProject",
                    "manuscripts.writeCurrent"
                ]
            })),
        });

        let schemas = openai_schemas_for_session(&store, "redclaw", Some("session-1"));
        let names = schemas
            .as_array()
            .expect("schemas")
            .iter()
            .filter_map(|item| item.pointer("/function/name").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(names.contains(&"Read".to_string()));
        assert!(names.contains(&"Write".to_string()));
        assert!(names.contains(&"Redbox".to_string()));
        assert!(!names.contains(&"app_cli".to_string()));
        assert!(!names.contains(&"redbox_fs".to_string()));
        let redbox = schemas
            .as_array()
            .expect("schemas")
            .iter()
            .find(|item| item.pointer("/function/name").and_then(Value::as_str) == Some("Redbox"))
            .expect("redbox schema");
        let resources = redbox
            .pointer("/function/parameters/properties/resource/enum")
            .and_then(Value::as_array)
            .expect("redbox resource enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(resources, vec!["image", "manuscript"]);
        let snapshot = tool_plan_snapshot_for_session(&store, "redclaw", Some("session-1"));
        assert_eq!(
            snapshot
                .get("fingerprint")
                .and_then(Value::as_str)
                .is_some(),
            true
        );
        assert_eq!(
            snapshot
                .get("deferredActionCount")
                .and_then(Value::as_u64)
                .unwrap_or_default()
                > 0,
            true
        );
    }
}
