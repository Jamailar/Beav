use crate::logging::event::LogLevel;
use crate::logging::{create_auto_report_from_trigger, log_renderer_event};
use crate::{payload_field, payload_string};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

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

pub(super) fn create_auto_report(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    append_renderer_log(payload)?;
    let event = payload_string(payload, "event").unwrap_or_else(|| "renderer.error".to_string());
    let message =
        payload_string(payload, "message").unwrap_or_else(|| "renderer error".to_string());
    let trigger =
        payload_string(payload, "trigger").unwrap_or_else(|| "renderer_error".to_string());
    let metadata = json!({
        "kind": "renderer_auto_report",
        "event": event,
        "category": payload_string(payload, "category").unwrap_or_else(|| "renderer".to_string()),
        "error": message,
        "fields": payload_field(payload, "fields").cloned().unwrap_or(Value::Null),
        "createdAt": crate::now_iso(),
    });
    let (report, upload) = create_auto_report_from_trigger(
        state,
        &trigger,
        &format!("Renderer issue: {message}"),
        metadata,
    )?;
    if upload.is_none() {
        let _ = app.emit("diagnostics:report-pending", json!(report));
    }
    Ok(json!({
        "success": true,
        "report": report,
        "uploaded": upload.is_some(),
        "upload": upload,
    }))
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
