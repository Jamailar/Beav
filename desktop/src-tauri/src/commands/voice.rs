use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::persistence::with_store;
use crate::{media_runtime, payload_field, payload_string, voice_service, AppState};

fn voice_completion_with_final_audio(value: Value) -> Value {
    let final_audio = value
        .get("artifacts")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .rev()
                .find(|item| item.get("kind").and_then(Value::as_str) == Some("audio"))
        })
        .map(|artifact| {
            let metadata = artifact.get("metadata").unwrap_or(&Value::Null);
            let asset = metadata.get("asset").unwrap_or(metadata);
            json!({
                "artifactId": artifact.get("artifactId").cloned().unwrap_or(Value::Null),
                "asset": asset,
                "path": artifact
                    .get("absolutePath")
                    .cloned()
                    .or_else(|| asset.get("absolutePath").cloned())
                    .unwrap_or(Value::Null),
                "relativePath": artifact
                    .get("relativePath")
                    .cloned()
                    .or_else(|| asset.get("relativePath").cloned())
                    .unwrap_or(Value::Null),
                "previewUrl": artifact
                    .get("previewUrl")
                    .cloned()
                    .or_else(|| asset.get("previewUrl").cloned())
                    .unwrap_or(Value::Null),
                "mimeType": artifact
                    .get("mimeType")
                    .cloned()
                    .or_else(|| asset.get("mimeType").cloned())
                    .unwrap_or(Value::Null),
            })
        });
    let Some(final_audio) = final_audio else {
        return value;
    };
    let segment_count = value
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("kind").and_then(Value::as_str) == Some("audio_segment"))
                .count()
        })
        .unwrap_or(0);
    json!({
        "success": true,
        "jobId": value.get("jobId").cloned().unwrap_or(Value::Null),
        "status": value.get("status").cloned().unwrap_or(Value::Null),
        "finalAudio": final_audio,
        "segmentCount": segment_count,
        "message": "Speech synthesis completed. Use finalAudio.previewUrl or finalAudio.path for playback; do not present segment files as the final output.",
    })
}

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
                            .unwrap_or_else(media_runtime::default_media_job_wait_timeout_ms);
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
                    let job_kind = if voice_service::is_speech_sequence_payload(payload) {
                        "audio_sequence"
                    } else {
                        "audio"
                    };
                    let submitted = media_runtime::submit_media_job(app, state, job_kind, payload)?;
                    if payload_field(payload, "waitForCompletion")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        let timeout_ms = payload_field(payload, "timeoutMs")
                            .and_then(Value::as_u64)
                            .unwrap_or_else(media_runtime::default_media_job_wait_timeout_ms);
                        let job_id = submitted
                            .get("jobId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| "audio job did not return jobId".to_string())?;
                        media_runtime::await_media_job_completion(state, job_id, timeout_ms)
                            .map(voice_completion_with_final_audio)
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
