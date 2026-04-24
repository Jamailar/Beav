use crate::media_runtime;
use crate::*;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn handle_media_jobs_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "generation:submit-image" => Some(media_runtime::submit_media_job(
            app, state, "image", payload,
        )),
        "generation:submit-video" => Some(media_runtime::submit_media_job(
            app, state, "video", payload,
        )),
        "generation:list-jobs" => Some(media_runtime::list_media_jobs(state, payload)),
        "generation:get-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:get-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::get_media_job_projection(state, &job_id)),
        ),
        "generation:get-job-artifacts" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:get-job-artifacts requires jobId".to_string())
                .and_then(|job_id| media_runtime::get_media_job_artifacts(state, &job_id)),
        ),
        "generation:cancel-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:cancel-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::cancel_media_job(app, state, &job_id)),
        ),
        "generation:retry-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:retry-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::retry_media_job(app, state, &job_id)),
        ),
        "generation:await-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:await-job requires jobId".to_string())
                .and_then(|job_id| {
                    let timeout_ms = payload_field(payload, "timeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(15 * 60 * 1000);
                    media_runtime::await_media_job_completion(state, &job_id, timeout_ms)
                }),
        ),
        "generation:get-runtime-status" => Some(Ok(json!({
            "success": true,
            "runtimeReady": media_runtime::ensure_media_runtime_ready(state).is_ok(),
            "runtimeRunning": state
                .media_generation_runtime
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false),
        }))),
        _ => None,
    }
}
