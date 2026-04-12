use serde_json::Value;

use crate::agent::ChatExchangeRequest;
use crate::payload_string;
use crate::runtime::RuntimeRouteRecord;

pub struct PreparedRuntimeQueryExecution {
    pub route: RuntimeRouteRecord,
    pub orchestration: Option<Value>,
    pub effective_message: String,
}

pub struct PreparedRuntimeQueryTurn<'a> {
    pub route: RuntimeRouteRecord,
    pub route_value: Value,
    pub orchestration: Option<Value>,
    pub request: ChatExchangeRequest<'a>,
}

pub struct RuntimeQueryCheckpointBundle {
    pub route_reasoning: String,
    pub route_value: Value,
    pub orchestration: Option<Value>,
}

pub fn prepare_runtime_query_execution(
    route: RuntimeRouteRecord,
    orchestration: Option<Value>,
    message: &str,
) -> PreparedRuntimeQueryExecution {
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
    PreparedRuntimeQueryExecution {
        route,
        orchestration,
        effective_message,
    }
}

pub fn build_runtime_query_turn<'a>(
    session_id: Option<String>,
    route: RuntimeRouteRecord,
    orchestration: Option<Value>,
    display_content: &str,
    model_config: Option<&'a Value>,
) -> PreparedRuntimeQueryTurn<'a> {
    let prepared = prepare_runtime_query_execution(route, orchestration, display_content);
    let route_value = prepared.route.clone().into_value();
    let request = ChatExchangeRequest::runtime_query(
        session_id,
        prepared.effective_message,
        display_content.to_string(),
        model_config,
    );
    PreparedRuntimeQueryTurn {
        route: prepared.route,
        route_value,
        orchestration: prepared.orchestration,
        request,
    }
}

pub fn build_runtime_query_checkpoint_bundle(
    turn: &PreparedRuntimeQueryTurn<'_>,
) -> RuntimeQueryCheckpointBundle {
    RuntimeQueryCheckpointBundle {
        route_reasoning: turn.route.reasoning.clone(),
        route_value: turn.route_value.clone(),
        orchestration: turn.orchestration.clone(),
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

        assert!(prepared
            .effective_message
            .contains("Subagent orchestration summary"));
        assert!(prepared
            .effective_message
            .contains("- planner: break into steps"));
        assert!(prepared
            .effective_message
            .contains("- reviewer: verify saved artifact"));
    }

    #[test]
    fn prepare_runtime_query_execution_keeps_original_message_without_outputs() {
        let route = runtime_direct_route_record("default", "draft", None);
        let prepared =
            prepare_runtime_query_execution(route, Some(json!({ "outputs": [] })), "help me");
        assert_eq!(prepared.effective_message, "help me");
    }

    #[test]
    fn build_runtime_query_turn_carries_request_and_route_value() {
        let route = runtime_direct_route_record("default", "draft", None);
        let turn = build_runtime_query_turn(
            Some("session-1".to_string()),
            route,
            Some(json!({
                "outputs": [{ "roleId": "planner", "summary": "break into steps" }]
            })),
            "help me",
            None,
        );

        assert_eq!(turn.request.session_id.as_deref(), Some("session-1"));
        assert_eq!(turn.request.display_content, "help me");
        assert_eq!(
            turn.request.turn_kind,
            crate::agent::SessionAgentTurnKind::RuntimeQuery
        );
        assert_eq!(
            turn.route_value.get("intent").and_then(Value::as_str),
            Some(turn.route.intent.as_str())
        );
        assert!(turn
            .request
            .message
            .contains("Subagent orchestration summary"));
    }

    #[test]
    fn build_runtime_query_checkpoint_bundle_preserves_reasoning_route_and_orchestration() {
        let route = runtime_direct_route_record("default", "draft", None);
        let turn = build_runtime_query_turn(
            Some("session-1".to_string()),
            route,
            Some(json!({
                "outputs": [{ "roleId": "planner", "summary": "break into steps" }]
            })),
            "help me",
            None,
        );
        let bundle = build_runtime_query_checkpoint_bundle(&turn);

        assert!(!bundle.route_reasoning.is_empty());
        assert_eq!(
            bundle.route_value.get("intent").and_then(Value::as_str),
            turn.route_value.get("intent").and_then(Value::as_str)
        );
        assert!(bundle.orchestration.is_some());
    }
}
