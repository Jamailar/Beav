use serde_json::Value;

use crate::runtime::{PreparedExecution, RuntimeRouteRecord};
use crate::payload_string;

pub fn prepare_runtime_query_execution(
    route: RuntimeRouteRecord,
    orchestration: Option<Value>,
    message: &str,
) -> PreparedExecution {
    let effective_message = orchestration
        .as_ref()
        .and_then(|value| value.get("outputs"))
        .and_then(|value| value.as_array())
        .filter(|items| !items.is_empty())
        .map(|items| {
            let summaries = items
                .iter()
                .filter_map(|item| {
                    Some(format!(
                        "- {}: {}",
                        payload_string(item, "roleId")?,
                        payload_string(item, "summary").unwrap_or_default()
                    ))
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{message}\n\nSubagent orchestration summary:\n{summaries}")
        })
        .unwrap_or_else(|| message.to_string());
    PreparedExecution {
        route,
        orchestration,
        effective_message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::runtime_direct_route_record;
    use serde_json::json;

    #[test]
    fn prepare_runtime_query_execution_includes_orchestration_summary_when_present() {
        let route = runtime_direct_route_record("default", "draft", None);
        let prepared = prepare_runtime_query_execution(
            route,
            Some(json!({
                "outputs": [
                    { "roleId": "planner", "summary": "break into steps" },
                    { "roleId": "reviewer", "summary": "verify saved artifact" }
                ]
            })),
            "help me",
        );

        assert!(prepared.effective_message.contains("Subagent orchestration summary"));
        assert!(prepared.effective_message.contains("- planner: break into steps"));
        assert!(prepared.effective_message.contains("- reviewer: verify saved artifact"));
    }

    #[test]
    fn prepare_runtime_query_execution_keeps_original_message_without_outputs() {
        let route = runtime_direct_route_record("default", "draft", None);
        let prepared =
            prepare_runtime_query_execution(route, Some(json!({ "outputs": [] })), "help me");
        assert_eq!(prepared.effective_message, "help me");
    }
}
