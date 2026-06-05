use crate::logging::event::LogLevel;
use crate::logging::log_renderer_event;
use crate::{payload_field, payload_string};
use serde_json::{json, Value};

fn renderer_log_level(value: &str) -> LogLevel {
    match value.to_ascii_lowercase().as_str() {
        "trace" => LogLevel::Trace,
        "debug" => LogLevel::Debug,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    }
}

pub(super) fn append_renderer_log(payload: &Value) -> Result<Value, String> {
    let level = payload_string(payload, "level").unwrap_or_else(|| "error".to_string());
    let category =
        payload_string(payload, "category").unwrap_or_else(|| "plugin.bridge".to_string());
    let event = payload_string(payload, "event").unwrap_or_else(|| "renderer.log".to_string());
    let message = payload_string(payload, "message").unwrap_or_else(|| "renderer log".to_string());
    log_renderer_event(
        renderer_log_level(&level),
        &category,
        &event,
        &message,
        payload_field(payload, "fields")
            .cloned()
            .unwrap_or(Value::Null),
    );
    Ok(json!({ "success": true }))
}

#[cfg(test)]
mod tests {
    use super::renderer_log_level;

    fn level_name(value: &str) -> String {
        serde_json::to_value(renderer_log_level(value))
            .expect("serialize log level")
            .as_str()
            .expect("level string")
            .to_string()
    }

    #[test]
    fn renderer_log_level_defaults_to_info_for_unknown_values() {
        assert_eq!(level_name("error"), "error");
        assert_eq!(level_name("warn"), "warn");
        assert_eq!(level_name("verbose"), "info");
    }
}
