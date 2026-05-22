use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::async_runtime::JoinHandle;

#[derive(Default)]
pub(super) struct RuntimeSlots {
    pub(super) image_submit_by_provider: HashMap<String, usize>,
    pub(super) video_submit_by_provider: HashMap<String, usize>,
    pub(super) audio_submit_by_provider: HashMap<String, usize>,
    pub(super) voice_clone_submit_by_provider: HashMap<String, usize>,
    pub(super) video_download_by_provider: HashMap<String, usize>,
    pub(super) active_video_polls: usize,
}

pub struct MediaGenerationRuntime {
    pub stop: Arc<AtomicBool>,
    pub dispatcher_join: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaJobRecord {
    pub(super) job_id: String,
    pub(super) kind: String,
    pub(super) source: String,
    pub(super) priority: String,
    pub(super) status: String,
    pub(super) provider_key: String,
    pub(super) provider_model: Option<String>,
    pub(super) request_json: Value,
    pub(super) result_json: Option<Value>,
    pub(super) project_id: Option<String>,
    pub(super) manuscript_path: Option<String>,
    pub(super) video_project_path: Option<String>,
    pub(super) owner_session_id: Option<String>,
    pub(super) current_attempt_no: i64,
    pub(super) cancel_reason: Option<String>,
    pub(super) archived_at: Option<String>,
    pub(super) archive_reason: Option<String>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaJobAttemptRecord {
    pub(super) attempt_id: String,
    pub(super) job_id: String,
    pub(super) attempt_no: i64,
    pub(super) status: String,
    pub(super) provider_task_id: Option<String>,
    pub(super) provider_status_url: Option<String>,
    pub(super) idempotency_key: String,
    pub(super) lease_owner: Option<String>,
    pub(super) lease_expires_at: Option<i64>,
    pub(super) next_poll_at: Option<i64>,
    pub(super) retry_not_before_at: Option<i64>,
    pub(super) last_error: Option<String>,
    pub(super) response_json: Option<Value>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaJobArtifactRecord {
    pub(super) artifact_id: String,
    pub(super) job_id: String,
    pub(super) kind: String,
    pub(super) relative_path: Option<String>,
    pub(super) absolute_path: Option<String>,
    pub(super) mime_type: Option<String>,
    pub(super) preview_url: Option<String>,
    pub(super) metadata_json: Option<Value>,
    pub(super) created_at: String,
}

#[derive(Debug, Clone)]
pub(super) struct LoadedJob {
    pub(super) job: MediaJobRecord,
    pub(super) attempt: MediaJobAttemptRecord,
}

#[derive(Debug, Clone)]
pub(super) enum VideoPollState {
    Pending {
        response: Value,
        next_poll_at: i64,
    },
    Ready {
        response: Value,
        inline_base64: Option<String>,
        download_url: Option<String>,
    },
    Failed {
        response: Value,
        message: String,
    },
}
