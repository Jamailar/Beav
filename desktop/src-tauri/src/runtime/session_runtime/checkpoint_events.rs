use super::*;

pub fn persist_runtime_query_checkpoints(
    store: &mut AppStore,
    session_id: &str,
    route_reasoning: &str,
    route_value: Value,
    orchestration: Option<Value>,
) {
    append_session_checkpoint(
        store,
        session_id,
        "runtime.route",
        if route_reasoning.trim().is_empty() {
            "runtime route".to_string()
        } else {
            route_reasoning.to_string()
        },
        Some(route_value),
    );
    if let Some(orchestration_value) = orchestration {
        append_session_checkpoint(
            store,
            session_id,
            "runtime.orchestration",
            "subagent orchestration completed".to_string(),
            Some(orchestration_value),
        );
    }
}

pub fn runtime_query_checkpoint_events(
    route_reasoning: &str,
    route_value: Value,
    orchestration: Option<Value>,
) -> Vec<(String, String, Option<Value>)> {
    let mut events = vec![(
        "runtime.route".to_string(),
        if route_reasoning.trim().is_empty() {
            "runtime route".to_string()
        } else {
            route_reasoning.to_string()
        },
        Some(route_value),
    )];
    if let Some(orchestration_value) = orchestration {
        events.push((
            "runtime.orchestration".to_string(),
            "subagent orchestration completed".to_string(),
            Some(orchestration_value),
        ));
    }
    events
}
