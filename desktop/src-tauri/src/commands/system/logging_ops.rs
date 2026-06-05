use crate::logging::{
    create_report_from_trigger, dismiss_pending_report, export_bundle_for_report,
    list_pending_reports_value, recent_value, status_value as logging_status_value,
    update_upload_consent, upload_pending_report,
};
use crate::{payload_field, payload_string, store_root, AppState};
use serde_json::{json, Value};
use tauri::State;

fn log_limit(payload: &Value) -> usize {
    payload_field(payload, "limit")
        .and_then(|value| value.as_i64())
        .unwrap_or(50)
        .clamp(1, 200) as usize
}

pub(super) fn status(state: &State<'_, AppState>) -> Result<Value, String> {
    logging_status_value(state)
}

pub(super) fn recent(payload: &Value) -> Result<Value, String> {
    Ok(recent_value(log_limit(payload)))
}

pub(super) fn open_dir(state: &State<'_, AppState>) -> Result<Value, String> {
    let path = store_root(state)?.join("logs");
    open::that(&path).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": path.display().to_string() }))
}

pub(super) fn list_pending_reports() -> Result<Value, String> {
    list_pending_reports_value()
}

pub(super) fn export_bundle(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let report_id = if let Some(report_id) = payload_string(payload, "reportId") {
        report_id
    } else {
        create_report_from_trigger(
            state,
            "manual-export",
            "用户手动导出诊断包",
            payload
                .get("includeAdvancedContext")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            json!({
                "source": "settings",
            }),
        )?
        .id
    };
    let path = export_bundle_for_report(state, &report_id)?;
    Ok(json!({
        "success": true,
        "reportId": report_id,
        "path": path.display().to_string()
    }))
}

pub(super) fn upload_report(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let report_id =
        payload_string(payload, "reportId").ok_or_else(|| "reportId is required".to_string())?;
    upload_pending_report(state, &report_id)
}

pub(super) fn dismiss_report(payload: &Value) -> Result<Value, String> {
    let report_id =
        payload_string(payload, "reportId").ok_or_else(|| "reportId is required".to_string())?;
    dismiss_pending_report(&report_id)
}

pub(super) fn set_upload_consent(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let consent = payload_string(payload, "consent").unwrap_or_else(|| "none".to_string());
    let auto_send_same_crash = payload
        .get("autoSendSameCrash")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    update_upload_consent(state, &consent, auto_send_same_crash)
}

#[cfg(test)]
mod tests {
    use super::log_limit;
    use serde_json::json;

    #[test]
    fn log_limit_defaults_and_clamps() {
        assert_eq!(log_limit(&json!({})), 50);
        assert_eq!(log_limit(&json!({ "limit": -5 })), 1);
        assert_eq!(log_limit(&json!({ "limit": 500 })), 200);
    }
}
