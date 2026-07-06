mod temp_upload;
mod video_retalk;

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
        "generation:submit-audio" => Some(media_runtime::submit_media_job(
            app, state, "audio", payload,
        )),
        "generation:submit-voice-clone" => Some(media_runtime::submit_media_job(
            app,
            state,
            "voice_clone",
            payload,
        )),
        "generation:upload-temp-file" => {
            Some(temp_upload::upload_official_temp_file(state, payload))
        }
        "generation:prepare-video-retalk-source" => {
            Some(video_retalk::prepare_source(app, state, payload))
        }
        "generation:list-job-summaries" => {
            Some(media_runtime::list_media_job_summaries(state, payload))
        }
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
        "generation:delete-job" => Some(
            payload_string(payload, "jobId")
                .ok_or_else(|| "generation:delete-job requires jobId".to_string())
                .and_then(|job_id| media_runtime::delete_media_job(app, state, &job_id)),
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
                        .unwrap_or_else(media_runtime::default_media_job_wait_timeout_ms);
                    media_runtime::await_media_job_completion(state, &job_id, timeout_ms)
                }),
        ),
        "generation:get-runtime-status" => Some((|| {
            let runtime_ready = media_runtime::ensure_media_runtime_ready(state).is_ok();
            let runtime_running = state
                .media_generation_runtime
                .lock()
                .map(|guard| {
                    guard
                        .as_ref()
                        .map(media_runtime::media_generation_runtime_is_active)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            let pressure = media_runtime::media_runtime_pressure_snapshot(state).ok();
            Ok(json!({
                "success": true,
                "runtimeReady": runtime_ready,
                "runtimeRunning": runtime_running,
                "pressure": pressure,
            }))
        })()),
        _ => None,
    }
}

pub(super) fn payload_string_any(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload_string(payload, key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::video_retalk::{
        target_video_retalk_dimensions, video_retalk_target_short_edge, VideoDimensions,
    };

    #[test]
    fn video_retalk_1080p_preparation_upscales_short_edge() {
        let target = target_video_retalk_dimensions(
            VideoDimensions {
                width: 544,
                height: 960,
            },
            video_retalk_target_short_edge(Some("1080p")),
        )
        .expect("target dimensions")
        .expect("resize target");

        assert_eq!(target.width, 1080);
        assert_eq!(target.height, 1906);
    }

    #[test]
    fn video_retalk_1080p_keeps_existing_high_resolution_source() {
        let target = target_video_retalk_dimensions(
            VideoDimensions {
                width: 1080,
                height: 1920,
            },
            video_retalk_target_short_edge(Some("1080p")),
        )
        .expect("target dimensions");

        assert!(target.is_none());
    }
}
