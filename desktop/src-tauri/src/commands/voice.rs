use serde_json::Value;
use tauri::{AppHandle, State};

use crate::persistence::with_store;
use crate::{media_runtime, payload_field, payload_string, voice_service, AppState};

pub fn handle_voice_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "voice:list" => voice_service::list_voices(state, payload),
        "voice:get" => voice_service::get_voice(state, payload),
        "voice:clone" => {
            if payload_field(payload, "runtimeBypass")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                voice_service::clone_voice(Some(app), state, payload)
            } else {
                (|| {
                    let submitted =
                        media_runtime::submit_media_job(app, state, "voice_clone", payload)?;
                    if let (Some(subject_id), Some(job_id)) = (
                        payload_string(payload, "ownerAssetId")
                            .or_else(|| payload_string(payload, "assetId"))
                            .or_else(|| payload_string(payload, "subjectId")),
                        submitted.get("jobId").and_then(Value::as_str),
                    ) {
                        let _ = voice_service::patch_subject_voice_queued(
                            state,
                            &subject_id,
                            job_id,
                            payload,
                        );
                    }
                    if payload_field(payload, "waitForCompletion")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        let timeout_ms = payload_field(payload, "timeoutMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(30 * 60 * 1000);
                        let job_id = submitted
                            .get("jobId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "voice clone job did not return jobId".to_string())?;
                        media_runtime::await_media_job_completion(state, job_id, timeout_ms)
                    } else {
                        Ok(submitted)
                    }
                })()
            }
        }
        "voice:bind-asset" | "assets:bind-voice" => {
            voice_service::bind_subject_voice(state, payload)
        }
        "voice:speech" => {
            if let Err(error) = with_store(state, |store| {
                crate::media_task_context::validate_voice_speech_payload(&store, payload)
                    .map_err(|error| error.to_string())
            }) {
                return Some(Err(error));
            }
            if payload_field(payload, "runtimeBypass")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                voice_service::synthesize_speech(state, payload)
            } else {
                (|| {
                    let submitted = media_runtime::submit_media_job(app, state, "audio", payload)?;
                    if payload_field(payload, "waitForCompletion")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        let timeout_ms = payload_field(payload, "timeoutMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(30 * 60 * 1000);
                        let job_id = submitted
                            .get("jobId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "audio job did not return jobId".to_string())?;
                        media_runtime::await_media_job_completion(state, job_id, timeout_ms)
                    } else {
                        Ok(submitted)
                    }
                })()
            }
        }
        "voice:delete" => voice_service::delete_voice(state, payload),
        _ => return None,
    };
    Some(result)
}
