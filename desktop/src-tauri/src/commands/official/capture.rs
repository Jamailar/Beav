use super::*;
use crate::store::settings as settings_store;

fn capture_response_payload(response: &crate::HttpJsonResponse, context: &str) -> Value {
    if (200..300).contains(&response.status) {
        return official_unwrap_response_payload(&response.body);
    }
    let details = crate::http_error_details_from_value(response.status, &response.body);
    json!({
        "success": false,
        "status": "unavailable",
        "httpStatus": response.status,
        "error": crate::format_http_error_message(context, &details),
        "raw": response.body,
    })
}

pub(super) fn handle_capture_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
    request_generation: Option<u64>,
) -> Option<Result<Value, String>> {
    match channel {
        "capture:create-server-job" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let response = run_authenticated_official_request_response(
                app,
                state,
                &mut settings,
                "POST",
                "/capture/jobs",
                Some(payload.clone()),
                request_generation,
            )?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-capture-create-job",
                None,
                request_generation,
            )?;
            Ok(capture_response_payload(&response, "Capture job create"))
        })()),
        "capture:get-server-job" => Some((|| -> Result<Value, String> {
            let job_id = payload_string(payload, "jobId")
                .or_else(|| payload_string(payload, "id"))
                .ok_or_else(|| "jobId is required".to_string())?;
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let response = run_authenticated_official_request_response(
                app,
                state,
                &mut settings,
                "GET",
                &format!("/capture/jobs/{job_id}"),
                None,
                request_generation,
            )?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-capture-get-job",
                None,
                request_generation,
            )?;
            Ok(capture_response_payload(&response, "Capture job status"))
        })()),
        "capture:list-server-jobs" => Some((|| -> Result<Value, String> {
            let limit = payload
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(20)
                .clamp(1, 50);
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let response = run_authenticated_official_request_response(
                app,
                state,
                &mut settings,
                "GET",
                &format!("/capture/jobs?limit={limit}"),
                None,
                request_generation,
            )?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-capture-list-jobs",
                None,
                request_generation,
            )?;
            Ok(capture_response_payload(&response, "Capture jobs list"))
        })()),
        _ => None,
    }
}
