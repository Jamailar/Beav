use serde_json::Value;

use crate::runtime::{runtime_direct_route_record, RuntimeRouteRecord};

pub fn route_runtime_intent_with_settings(
    _settings: &Value,
    runtime_mode: &str,
    user_input: &str,
    metadata: Option<&Value>,
) -> RuntimeRouteRecord {
    runtime_direct_route_record(runtime_mode, user_input, metadata)
}
