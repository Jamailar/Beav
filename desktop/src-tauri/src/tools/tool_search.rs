use serde_json::{json, Value};

use crate::mcp::tool_inventory::search_mcp_tools;
use crate::tools::action_search::{search_actions, ActionSearchParams};
use crate::tools::plan::ToolRegistryPlan;
use crate::{payload_field, payload_string};

pub fn tool_search_payload(plan: &ToolRegistryPlan, payload: &Value) -> Value {
    let query = payload_string(payload, "query")
        .or_else(|| payload_string(payload, "q"))
        .unwrap_or_default();
    let namespace = payload_string(payload, "namespace")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let limit = payload_field(payload, "limit")
        .and_then(Value::as_u64)
        .unwrap_or(12)
        .clamp(1, 50) as usize;
    let include_direct = payload_field(payload, "includeDirect")
        .or_else(|| payload_field(payload, "include_direct"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let action_results = search_actions(
        &plan.direct_app_cli_actions,
        &plan.deferred_app_cli_actions,
        ActionSearchParams {
            query: &query,
            namespace: namespace.as_deref(),
            limit,
            include_direct,
        },
    );
    let mcp_results = search_mcp_tools(
        &plan.direct_mcp_tools,
        &plan.deferred_mcp_tools,
        &query,
        limit,
        include_direct,
    )
    .into_iter()
    .map(|entry| serde_json::to_value(entry).unwrap_or_else(|_| json!({})))
    .collect::<Vec<_>>();
    let (direct_actions, deferred_actions): (Vec<_>, Vec<_>) = action_results
        .into_iter()
        .map(|entry| serde_json::to_value(entry).unwrap_or_else(|_| json!({})))
        .partition(|entry| {
            entry
                .get("availableThisTurn")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });

    json!({
        "success": true,
        "runtimeMode": plan.runtime_mode,
        "query": query,
        "namespace": namespace,
        "limit": limit,
        "deferredNamespaces": plan.deferred_action_namespaces,
        "deferredActions": deferred_actions,
        "directActions": direct_actions,
        "mcpTools": mcp_results,
        "deferredMcpNamespaces": plan.mcp_tool_namespaces,
        "routerPlan": plan.fingerprint,
    })
}
