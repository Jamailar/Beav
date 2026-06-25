use serde_json::{json, Value};

use crate::mcp::{McpToolInfo, McpToolInventorySnapshot};
use crate::tools::action_aliases::canonical_app_cli_action_for_policy;
use crate::tools::catalog::{
    descriptor_by_name, schema_for_tool_for_runtime_mode, schema_for_tool_from_action_descriptors,
    tool_action_family_summary, tool_action_family_summary_for_descriptors, ToolDescriptor,
};
use crate::tools::packs::{tool_names_for_runtime_mode, visible_tool_names_for_runtime_mode};
use crate::tools::plan::{
    base_tool_names_for_metadata, build_tool_registry_plan_for_session,
    build_tool_registry_plan_for_session_with_mcp, ToolRegistryPlan,
};
use crate::AppStore;

fn kind_text(kind: crate::tools::catalog::ToolKind) -> &'static str {
    match kind {
        crate::tools::catalog::ToolKind::AppCli => "workflow",
        crate::tools::catalog::ToolKind::Bash => "bash",
        crate::tools::catalog::ToolKind::Shell => "shell",
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

fn string_value(metadata: Option<&Value>, field: &str) -> Option<String> {
    metadata
        .and_then(|item| item.get(field))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn is_artifact_authoring_manuscript(metadata: Option<&Value>) -> bool {
    string_value(metadata, "executionProfile").as_deref() == Some("artifact-authoring")
        && string_value(metadata, "artifactType").as_deref() == Some("manuscript")
}

pub fn normalized_allowed_app_cli_actions(metadata: Option<&Value>) -> Vec<String> {
    let mut operate_actions = canonical_action_list(string_list(metadata, "allowedOperateActions"));
    if is_artifact_authoring_manuscript(metadata) && !operate_actions.is_empty() {
        for action in ["manuscripts.readCurrent"] {
            if !operate_actions.iter().any(|item| item == action) {
                operate_actions.push(action.to_string());
            }
        }
    }
    if !operate_actions.is_empty() {
        return operate_actions;
    }
    let mut actions = canonical_action_list(string_list(metadata, "allowedAppCliActions"));
    if is_artifact_authoring_manuscript(metadata) {
        actions.retain(|item| item != "manuscripts.writeCurrent");
        if !actions.is_empty() && !actions.iter().any(|item| item == "manuscripts.readCurrent") {
            actions.push("manuscripts.readCurrent".to_string());
        }
    }
    let looks_like_legacy_authoring_whitelist = actions.iter().any(|item| {
        matches!(
            item.as_str(),
            "manuscripts.createProject" | "manuscripts.writeCurrent"
        )
    });
    if looks_like_legacy_authoring_whitelist
        && !is_artifact_authoring_manuscript(metadata)
        && !actions.iter().any(|item| item == "image.generate")
    {
        actions.push("image.generate".to_string());
    }
    actions
}

fn canonical_action_list(actions: Vec<String>) -> Vec<String> {
    let mut canonical = Vec::<String>::new();
    for action in actions {
        let normalized = canonical_app_cli_action_for_policy(&action).to_string();
        if !canonical.iter().any(|item| item == &normalized) {
            canonical.push(normalized);
        }
    }
    canonical
}

pub fn base_tool_names_for_session_metadata(
    runtime_mode: &str,
    metadata: Option<&Value>,
) -> Vec<String> {
    base_tool_names_for_metadata(runtime_mode, metadata)
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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
            if tool.name == "Operate" && !plan.direct_app_cli_actions.is_empty() {
                schema_for_tool_from_action_descriptors("Operate", &plan.direct_app_cli_actions)
            } else {
                schema_for_tool_for_runtime_mode(tool.name, Some(&plan.runtime_mode))
            }
        })
        .collect::<Vec<_>>();
    json!(schemas)
}

pub fn openai_schemas_for_session_with_mcp(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    mcp_inventory: Option<&McpToolInventorySnapshot>,
) -> Value {
    let plan = build_tool_registry_plan_for_session_with_mcp(
        store,
        runtime_mode,
        session_id,
        mcp_inventory,
    );
    let mut schemas = plan
        .visible_tools
        .iter()
        .filter_map(|tool| {
            if tool.name == "Operate" && !plan.direct_app_cli_actions.is_empty() {
                schema_for_tool_from_action_descriptors("Operate", &plan.direct_app_cli_actions)
            } else {
                schema_for_tool_for_runtime_mode(tool.name, Some(&plan.runtime_mode))
            }
        })
        .collect::<Vec<_>>();
    if !plan.mcp_tool_namespaces.is_empty() {
        schemas.extend(mcp_resource_openai_schemas());
    }
    schemas.extend(plan.direct_mcp_tools.iter().map(mcp_openai_schema));
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
            "mcp": {
                "inventoryFingerprint": plan.mcp_inventory_fingerprint,
                "exposureMode": plan.mcp_exposure_mode,
                "namespaces": plan.mcp_tool_namespaces,
                "resourceTools": !plan.mcp_tool_namespaces.is_empty(),
                "directTools": plan
                .direct_mcp_tools
                .iter()
                .map(|tool| tool.callable_name.clone())
                .collect::<Vec<_>>(),
            "deferredToolCount": plan.deferred_mcp_tools.len(),
        }
    })
}

pub fn tool_plan_snapshot_for_session_with_mcp(
    store: &AppStore,
    runtime_mode: &str,
    session_id: Option<&str>,
    mcp_inventory: Option<&McpToolInventorySnapshot>,
) -> Value {
    let plan = build_tool_registry_plan_for_session_with_mcp(
        store,
        runtime_mode,
        session_id,
        mcp_inventory,
    );
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
        "mcp": {
            "inventoryFingerprint": plan.mcp_inventory_fingerprint,
            "exposureMode": plan.mcp_exposure_mode,
            "namespaces": plan.mcp_tool_namespaces,
            "resourceTools": !plan.mcp_tool_namespaces.is_empty(),
            "directTools": plan
                .direct_mcp_tools
                .iter()
                .map(|tool| tool.callable_name.clone())
                .collect::<Vec<_>>(),
            "deferredToolCount": plan.deferred_mcp_tools.len(),
        }
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
    if tool_name == "Operate" && !plan.direct_app_cli_actions.is_empty() {
        let mut summary = tool_action_family_summary_for_descriptors(&plan.direct_app_cli_actions)?;
        if !plan.deferred_action_namespaces.is_empty() {
            summary.push_str(" | deferred=");
            summary.push_str(&plan.deferred_action_namespaces.join(","));
            summary.push_str(" | discover=tool_search");
        }
        return Some(summary);
    }
    tool_action_family_summary(tool_name, Some(&plan.runtime_mode))
}

fn mcp_openai_schema(tool: &McpToolInfo) -> Value {
    let description = tool
        .description
        .as_deref()
        .or(tool.title.as_deref())
        .unwrap_or("MCP tool provided by an enabled external server.");
    json!({
        "type": "function",
        "function": {
            "name": tool.callable_name,
            "description": format!("{} (MCP server: {})", description, tool.server_name),
            "parameters": normalize_mcp_input_schema(&tool.input_schema),
        }
    })
}

fn mcp_resource_openai_schemas() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "list_mcp_resources",
                "description": "List MCP resources exposed by enabled external MCP servers. Optionally pass serverId to narrow the listing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "serverId": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_mcp_resource_templates",
                "description": "List MCP resource templates exposed by enabled external MCP servers. Optionally pass serverId to narrow the listing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "serverId": { "type": "string" }
                    },
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "read_mcp_resource",
                "description": "Read a concrete MCP resource by serverId and uri.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "serverId": { "type": "string" },
                        "uri": { "type": "string" }
                    },
                    "required": ["serverId", "uri"],
                    "additionalProperties": false
                }
            }
        }),
    ]
}

fn normalize_mcp_input_schema(schema: &Value) -> Value {
    let mut schema = schema.clone();
    if !schema.is_object() {
        return json!({ "type": "object", "additionalProperties": true });
    }
    if schema.get("type").is_none() {
        schema["type"] = json!("object");
    }
    if schema.get("properties").is_none() {
        schema["properties"] = json!({});
    }
    schema
}

pub fn diagnostics_tool_items() -> Vec<Value> {
    ["shell", "resource", "workflow", "editor"]
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
    use crate::mcp::tool_inventory::{McpToolInfo, McpToolInventorySnapshot};
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
                "allowedTools": ["resource", "runtime_control", "not_real"]
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
        });

        let names = tool_names_for_session(&store, "team", Some("session-1"));
        assert_eq!(names, vec!["resource".to_string(), "workflow".to_string()]);
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
                "allowedTools": ["resource", "workflow"],
                "allowedAppCliActions": [
                    "manuscripts.createProject",
                    "manuscripts.writeCurrent"
                ]
            })),
            starred: false,
            archived: false,
            archived_at: None,
            deleted_at: None,
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
        assert!(names.contains(&"Operate".to_string()));
        assert!(!names.contains(&"workflow".to_string()));
        assert!(!names.contains(&"resource".to_string()));
        let redbox = schemas
            .as_array()
            .expect("schemas")
            .iter()
            .find(|item| item.pointer("/function/name").and_then(Value::as_str) == Some("Operate"))
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
    }

    #[test]
    fn redclaw_session_schema_exposes_cli_runtime_and_web_resources() {
        let store = crate::AppStore::default();
        let schemas = openai_schemas_for_session(&store, "redclaw", None);
        let redbox = schemas
            .as_array()
            .expect("schemas")
            .iter()
            .find(|item| item.pointer("/function/name").and_then(Value::as_str) == Some("Operate"))
            .expect("redbox schema");
        let resources = redbox
            .pointer("/function/parameters/properties/resource/enum")
            .and_then(Value::as_array)
            .expect("redbox resource enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let operations = redbox
            .pointer("/function/parameters/properties/operation/enum")
            .and_then(Value::as_array)
            .expect("redbox operation enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        assert!(resources.contains(&"web"));
        assert!(resources.contains(&"cli_runtime"));
        assert!(resources.contains(&"media"));
        assert!(operations.contains(&"get"));
        assert!(operations.contains(&"run"));
        assert!(operations.contains(&"transcribe"));
        assert!(operations.contains(&"verify"));
        assert!(operations.contains(&"search"));
    }

    #[test]
    fn openai_schemas_for_session_with_mcp_exposes_direct_mcp_tools() {
        let store = crate::AppStore::default();
        let inventory = McpToolInventorySnapshot {
            tools: vec![McpToolInfo {
                server_id: "demo".to_string(),
                server_name: "Demo".to_string(),
                raw_tool_name: "read".to_string(),
                callable_name: "mcp__demo__read".to_string(),
                description: Some("Read demo resource".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": { "uri": { "type": "string" } },
                    "required": ["uri"]
                }),
                ..McpToolInfo::default()
            }],
            fingerprint: "mcp-a".to_string(),
        };

        let schemas = openai_schemas_for_session_with_mcp(&store, "team", None, Some(&inventory));
        let names = schemas
            .as_array()
            .expect("schemas")
            .iter()
            .filter_map(|item| item.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(names.contains(&"mcp__demo__read"));
        assert!(names.contains(&"tool_search"));
        assert!(names.contains(&"list_mcp_resources"));
        assert!(names.contains(&"list_mcp_resource_templates"));
        assert!(names.contains(&"read_mcp_resource"));
    }
}
