#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_shared;
mod assistant_core;
mod chat_helpers;
mod commands;
mod desktop_io;
mod events;
mod helpers;
mod http_utils;
mod interactive_runtime_shared;
mod legacy_import;
mod manuscript_package;
mod mcp_runtime;
mod media_generation;
mod memory_maintenance;
mod official_support;
mod persistence;
mod redclaw_profile;
mod runtime;
mod scheduler;
mod tools;
mod workspace_loaders;

use commands::chat_state::{
    ensure_chat_session, is_chat_runtime_cancel_requested, latest_session_id,
    resolve_runtime_mode_for_session,
};
use commands::redclaw_runtime::execute_redclaw_run;
use events::{
    emit_runtime_stream_start, emit_runtime_task_checkpoint_saved, emit_runtime_text_delta,
    emit_runtime_tool_partial, emit_runtime_tool_request, emit_runtime_tool_result,
    split_stream_chunks,
};
use persistence::{
    build_store_path, ensure_store_hydrated_for_advisors, ensure_store_hydrated_for_knowledge,
    ensure_store_hydrated_for_work, hydrate_store_from_workspace_files, load_store, persist_store,
    with_store, with_store_mut,
};
use runtime::{
    append_runtime_task_trace, append_session_checkpoint, infer_protocol,
    next_memory_maintenance_at_ms, resolve_chat_config, resolve_runtime_mode_from_context_type,
    role_sequence_for_route, runtime_direct_route, runtime_graph_for_route,
    runtime_warm_settings_fingerprint, session_title_from_message, set_runtime_graph_node,
    InteractiveToolCall, McpServerRecord, RedclawJobDefinitionRecord, RedclawJobExecutionRecord,
    RedclawLongCycleTaskRecord, RedclawProjectRecord, RedclawRuntime, RedclawScheduledTaskRecord,
    RedclawStateRecord, ResolvedChatConfig, RuntimeHookRecord, RuntimeTaskRecord,
    RuntimeTaskTraceRecord, RuntimeWarmEntry, RuntimeWarmState, SessionCheckpointRecord,
    SessionToolResultRecord, SessionTranscriptRecord, SkillRecord,
};
use scheduler::{
    next_long_cycle_timestamp, next_scheduled_timestamp, parse_millis_string,
    sync_redclaw_job_definitions,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use app_shared::*;
pub(crate) use assistant_core::*;
pub(crate) use helpers::*;
pub(crate) use http_utils::*;
pub(crate) use legacy_import::*;
pub(crate) use manuscript_package::*;
pub(crate) use media_generation::*;
pub(crate) use memory_maintenance::*;
pub(crate) use official_support::*;
pub(crate) use redclaw_profile::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceRecord {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubjectAttribute {
    key: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectCategory {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectRecord {
    id: String,
    name: String,
    category_id: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
    attributes: Vec<SubjectAttribute>,
    image_paths: Vec<String>,
    voice_path: Option<String>,
    voice_script: Option<String>,
    created_at: String,
    updated_at: String,
    absolute_image_paths: Vec<String>,
    preview_urls: Vec<String>,
    primary_preview_url: Option<String>,
    absolute_voice_path: Option<String>,
    voice_preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSessionRecord {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessageRecord {
    id: String,
    session_id: String,
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment: Option<Value>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdvisorRecord {
    id: String,
    name: String,
    avatar: String,
    personality: String,
    system_prompt: String,
    knowledge_language: Option<String>,
    knowledge_files: Vec<String>,
    youtube_channel: Option<Value>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdvisorVideoRecord {
    id: String,
    advisor_id: String,
    title: String,
    published_at: String,
    status: String,
    retry_count: i64,
    error_message: Option<String>,
    subtitle_file: Option<String>,
    video_url: Option<String>,
    channel_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRoomRecord {
    id: String,
    name: String,
    advisor_ids: Vec<String>,
    created_at: String,
    is_system: Option<bool>,
    system_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRoomMessageRecord {
    id: String,
    room_id: String,
    role: String,
    advisor_id: Option<String>,
    advisor_name: Option<String>,
    advisor_avatar: Option<String>,
    content: String,
    timestamp: String,
    is_streaming: Option<bool>,
    phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WechatOfficialBindingRecord {
    id: String,
    name: String,
    app_id: String,
    secret: Option<String>,
    created_at: String,
    updated_at: String,
    verified_at: Option<String>,
    is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingCacheRecord {
    file_path: String,
    content_hash: String,
    embedding: Vec<f64>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimilarityCacheRecord {
    manuscript_id: String,
    content_hash: String,
    knowledge_version: String,
    sorted_ids: Vec<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WanderHistoryRecord {
    id: String,
    items: String,
    result: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeVideoRecord {
    id: String,
    video_id: String,
    video_url: String,
    title: String,
    original_title: Option<String>,
    description: String,
    summary: Option<String>,
    thumbnail_url: String,
    has_subtitle: bool,
    subtitle_content: Option<String>,
    status: Option<String>,
    created_at: String,
    folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AppStore {
    settings: Value,
    spaces: Vec<SpaceRecord>,
    active_space_id: String,
    subjects: Vec<SubjectRecord>,
    categories: Vec<SubjectCategory>,
    advisors: Vec<AdvisorRecord>,
    advisor_videos: Vec<AdvisorVideoRecord>,
    chat_rooms: Vec<ChatRoomRecord>,
    chatroom_messages: Vec<ChatRoomMessageRecord>,
    wechat_official_bindings: Vec<WechatOfficialBindingRecord>,
    embedding_cache: Vec<EmbeddingCacheRecord>,
    similarity_cache: Vec<SimilarityCacheRecord>,
    wander_history: Vec<WanderHistoryRecord>,
    chat_sessions: Vec<ChatSessionRecord>,
    chat_messages: Vec<ChatMessageRecord>,
    youtube_videos: Vec<YoutubeVideoRecord>,
    knowledge_notes: Vec<KnowledgeNoteRecord>,
    document_sources: Vec<DocumentKnowledgeSourceRecord>,
    session_transcript_records: Vec<SessionTranscriptRecord>,
    session_checkpoints: Vec<SessionCheckpointRecord>,
    session_tool_results: Vec<SessionToolResultRecord>,
    runtime_tasks: Vec<RuntimeTaskRecord>,
    runtime_task_traces: Vec<RuntimeTaskTraceRecord>,
    debug_logs: Vec<String>,
    archive_profiles: Vec<ArchiveProfileRecord>,
    archive_samples: Vec<ArchiveSampleRecord>,
    memories: Vec<UserMemoryRecord>,
    memory_history: Vec<MemoryHistoryRecord>,
    mcp_servers: Vec<McpServerRecord>,
    runtime_hooks: Vec<RuntimeHookRecord>,
    skills: Vec<SkillRecord>,
    assistant_state: AssistantStateRecord,
    redclaw_state: RedclawStateRecord,
    redclaw_job_definitions: Vec<RedclawJobDefinitionRecord>,
    redclaw_job_executions: Vec<RedclawJobExecutionRecord>,
    media_assets: Vec<MediaAssetRecord>,
    cover_assets: Vec<CoverAssetRecord>,
    work_items: Vec<WorkItemRecord>,
    legacy_imported_at: Option<String>,
    legacy_import_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssistantStateRecord {
    enabled: bool,
    auto_start: bool,
    keep_alive_when_no_window: bool,
    host: String,
    port: i64,
    listening: bool,
    lock_state: String,
    blocked_by: Option<String>,
    last_error: Option<String>,
    active_task_count: i64,
    queued_peer_count: i64,
    in_flight_keys: Vec<String>,
    feishu: Value,
    relay: Value,
    weixin: Value,
}

impl Default for AssistantStateRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_start: true,
            keep_alive_when_no_window: true,
            host: "127.0.0.1".to_string(),
            port: 31937,
            listening: false,
            lock_state: "passive".to_string(),
            blocked_by: None,
            last_error: Some("RedClaw assistant daemon is idle.".to_string()),
            active_task_count: 0,
            queued_peer_count: 0,
            in_flight_keys: Vec::new(),
            feishu: json!({
                "enabled": false,
                "receiveMode": "webhook",
                "endpointPath": "/hooks/feishu/events",
                "replyUsingChatId": true,
                "webhookUrl": "",
                "websocketRunning": false
            }),
            relay: json!({
                "enabled": true,
                "endpointPath": "/hooks/channel/relay",
                "authToken": "",
                "webhookUrl": ""
            }),
            weixin: json!({
                "enabled": false,
                "endpointPath": "/hooks/weixin/relay",
                "authToken": "",
                "accountId": "",
                "autoStartSidecar": false,
                "cursorFile": "",
                "sidecarCommand": "",
                "sidecarArgs": [],
                "sidecarCwd": "",
                "sidecarEnv": {},
                "webhookUrl": "",
                "sidecarRunning": false,
                "connected": false,
                "stateDir": "",
                "availableAccountIds": []
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveProfileRecord {
    id: String,
    name: String,
    platform: Option<String>,
    goal: Option<String>,
    domain: Option<String>,
    audience: Option<String>,
    tone_tags: Vec<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSampleRecord {
    id: String,
    profile_id: String,
    title: Option<String>,
    content: Option<String>,
    excerpt: Option<String>,
    tags: Vec<String>,
    images: Vec<String>,
    platform: Option<String>,
    source_url: Option<String>,
    sample_date: Option<String>,
    is_featured: i64,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserMemoryRecord {
    id: String,
    content: String,
    r#type: String,
    tags: Vec<String>,
    created_at: i64,
    updated_at: Option<i64>,
    last_accessed: Option<i64>,
    status: Option<String>,
    archived_at: Option<i64>,
    archive_reason: Option<String>,
    origin_id: Option<String>,
    canonical_key: Option<String>,
    revision: Option<i64>,
    last_conflict_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryHistoryRecord {
    id: String,
    memory_id: String,
    origin_id: String,
    action: String,
    reason: Option<String>,
    timestamp: i64,
    before: Option<Value>,
    after: Option<Value>,
    archived_memory_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeNoteStatsRecord {
    likes: i64,
    collects: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeNoteRecord {
    id: String,
    r#type: Option<String>,
    source_url: Option<String>,
    title: String,
    author: String,
    content: String,
    excerpt: Option<String>,
    site_name: Option<String>,
    capture_kind: Option<String>,
    html_file: Option<String>,
    html_file_url: Option<String>,
    images: Vec<String>,
    tags: Option<Vec<String>>,
    cover: Option<String>,
    video: Option<String>,
    video_url: Option<String>,
    transcript: Option<String>,
    transcription_status: Option<String>,
    stats: KnowledgeNoteStatsRecord,
    created_at: String,
    folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentKnowledgeSourceRecord {
    id: String,
    kind: String,
    name: String,
    root_path: String,
    locked: bool,
    indexing: bool,
    index_error: Option<String>,
    file_count: i64,
    sample_files: Vec<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaAssetRecord {
    id: String,
    source: String,
    project_id: Option<String>,
    title: Option<String>,
    prompt: Option<String>,
    provider: Option<String>,
    provider_template: Option<String>,
    model: Option<String>,
    aspect_ratio: Option<String>,
    size: Option<String>,
    quality: Option<String>,
    mime_type: Option<String>,
    relative_path: Option<String>,
    bound_manuscript_path: Option<String>,
    created_at: String,
    updated_at: String,
    absolute_path: Option<String>,
    preview_url: Option<String>,
    exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverAssetRecord {
    id: String,
    title: Option<String>,
    template_name: Option<String>,
    prompt: Option<String>,
    provider: Option<String>,
    provider_template: Option<String>,
    model: Option<String>,
    aspect_ratio: Option<String>,
    size: Option<String>,
    quality: Option<String>,
    relative_path: Option<String>,
    preview_url: Option<String>,
    exists: bool,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkRefsRecord {
    project_ids: Vec<String>,
    session_ids: Vec<String>,
    task_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkScheduleRecord {
    mode: String,
    interval_minutes: Option<i64>,
    time: Option<String>,
    weekdays: Option<Vec<i64>>,
    run_at: Option<String>,
    next_run_at: Option<String>,
    completed_rounds: Option<i64>,
    total_rounds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkItemRecord {
    id: String,
    title: String,
    description: Option<String>,
    summary: Option<String>,
    status: String,
    effective_status: String,
    priority: i64,
    r#type: String,
    blocked_by: Vec<String>,
    refs: WorkRefsRecord,
    metadata: Option<Value>,
    schedule: WorkScheduleRecord,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRuntimeStateRecord {
    session_id: String,
    is_processing: bool,
    partial_response: String,
    updated_at: u128,
    error: Option<String>,
    cancel_requested: bool,
}

struct AppState {
    store_path: PathBuf,
    store: Mutex<AppStore>,
    chat_runtime_states: Mutex<std::collections::HashMap<String, ChatRuntimeStateRecord>>,
    active_chat_requests: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    assistant_runtime: Mutex<Option<AssistantRuntime>>,
    assistant_sidecar: Mutex<Option<AssistantSidecarRuntime>>,
    redclaw_runtime: Mutex<Option<RedclawRuntime>>,
    runtime_warm: Mutex<RuntimeWarmState>,
}

struct AssistantRuntime {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    host: String,
    port: i64,
}

struct AssistantSidecarRuntime {
    child: std::process::Child,
    pid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectMediaInput {
    relative_path: Option<String>,
    data_url: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectVoiceInput {
    relative_path: Option<String>,
    data_url: Option<String>,
    name: Option<String>,
    script_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectMutationInput {
    id: Option<String>,
    name: String,
    category_id: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
    attributes: Option<Vec<SubjectAttribute>>,
    images: Option<Vec<SubjectMediaInput>>,
    voice: Option<SubjectVoiceInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectCategoryMutationInput {
    id: Option<String>,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeSavePayload {
    video_id: String,
    video_url: String,
    title: String,
    description: Option<String>,
    thumbnail_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso() -> String {
    now_ms().to_string()
}

fn make_id(prefix: &str) -> String {
    format!("{prefix}-{}", now_ms())
}

fn refresh_runtime_warm_state(state: &State<'_, AppState>, modes: &[&str]) -> Result<(), String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let workspace_root_value = workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let fingerprint = runtime_warm_settings_fingerprint(&settings_snapshot, &workspace_root_value);
    let mut warmed_entries = Vec::new();
    for mode in modes {
        let entry = RuntimeWarmEntry {
            mode: (*mode).to_string(),
            system_prompt: interactive_runtime_system_prompt(state, mode),
            model_config: if *mode == "wander" {
                Some(resolve_wander_model_config(&settings_snapshot))
            } else {
                None
            },
            long_term_context: if *mode == "wander" {
                Some(build_wander_long_term_context(state))
            } else {
                None
            },
            warmed_at: now_i64(),
        };
        warmed_entries.push(entry);
    }
    let mut runtime_warm = state
        .runtime_warm
        .lock()
        .map_err(|error| error.to_string())?;
    runtime_warm.settings_fingerprint = fingerprint;
    runtime_warm.last_warmed_at = now_i64();
    for entry in warmed_entries {
        runtime_warm.entries.insert(entry.mode.clone(), entry);
    }
    Ok(())
}

fn ensure_runtime_warm_entry(
    state: &State<'_, AppState>,
    mode: &str,
) -> Result<RuntimeWarmEntry, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let workspace_root_value = workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let fingerprint = runtime_warm_settings_fingerprint(&settings_snapshot, &workspace_root_value);
    let cached = {
        let runtime_warm = state
            .runtime_warm
            .lock()
            .map_err(|error| error.to_string())?;
        if runtime_warm.settings_fingerprint == fingerprint {
            runtime_warm.entries.get(mode).cloned()
        } else {
            None
        }
    };
    if let Some(entry) = cached {
        return Ok(entry);
    }
    refresh_runtime_warm_state(state, &[mode])?;
    let runtime_warm = state
        .runtime_warm
        .lock()
        .map_err(|error| error.to_string())?;
    runtime_warm
        .entries
        .get(mode)
        .cloned()
        .ok_or_else(|| format!("未找到预热的 runtime: {mode}"))
}

fn normalize_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str().map(|item| item.trim().to_string()))
        .filter(|item| !item.is_empty())
}

fn payload_field<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload.as_object().and_then(|object| object.get(key))
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    normalize_string(payload_field(payload, key))
}

fn payload_value_as_string(payload: &Value) -> Option<String> {
    if let Some(text) = payload.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn store_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = state
        .store_path
        .parent()
        .ok_or_else(|| "RedBox store root is unavailable".to_string())?
        .to_path_buf();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn preferred_workspace_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join(".redbox")
}

fn legacy_workspace_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".redconvert"))
}

fn managed_workspace_dir_candidates(store_path: &Path) -> Vec<PathBuf> {
    let mut items = Vec::new();
    if let Some(root) = store_path.parent() {
        items.push(root.join("spaces").join("default"));
    }
    items
}

fn is_same_path(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().replace('\\', "/");
    let right = right.to_string_lossy().replace('\\', "/");
    left == right
}

fn configured_workspace_dir(settings: &Value) -> Option<PathBuf> {
    settings
        .get("workspace_dir")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn should_force_preferred_workspace_dir(configured: Option<&Path>, store_path: &Path) -> bool {
    let Some(configured) = configured else {
        return true;
    };
    if legacy_workspace_dir()
        .as_ref()
        .is_some_and(|legacy| is_same_path(configured, legacy))
    {
        return true;
    }
    if managed_workspace_dir_candidates(store_path)
        .iter()
        .any(|candidate| is_same_path(configured, candidate))
    {
        return true;
    }
    false
}

fn active_space_workspace_root_from_store(
    store: &AppStore,
    active_space_id: &str,
    store_path: &Path,
) -> Result<PathBuf, String> {
    let base = if should_force_preferred_workspace_dir(
        configured_workspace_dir(&store.settings).as_deref(),
        store_path,
    ) {
        preferred_workspace_dir()
    } else {
        configured_workspace_dir(&store.settings).unwrap_or_else(preferred_workspace_dir)
    };
    let root = if active_space_id == "default" {
        base
    } else {
        base.join("spaces").join(active_space_id)
    };
    ensure_workspace_dirs(&root)?;
    Ok(root)
}

fn workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    with_store(state, |store| {
        active_space_workspace_root_from_store(&store, &store.active_space_id, &state.store_path)
    })
}

fn ensure_workspace_dirs(root: &Path) -> Result<(), String> {
    for dir in [
        root.join("manuscripts"),
        root.join("knowledge"),
        root.join("media"),
        root.join("cover"),
        root.join("redclaw"),
        root.join("redclaw").join("profile"),
        root.join("memory"),
        root.join("subjects"),
        root.join("chatrooms"),
    ] {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn manuscripts_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("manuscripts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn collect_text_files_recursive(root: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    if max_depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if ["node_modules", ".git", "dist", "dist-electron"].contains(&name.as_str()) {
                continue;
            }
            collect_text_files_recursive(&path, max_depth - 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ["md", "txt", "json"].contains(&ext.as_str()) {
            out.push(path);
        }
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        let mut out = value
            .chars()
            .take(max_chars.saturating_sub(1))
            .collect::<String>();
        out.push('…');
        out
    }
}

fn build_excerpt_around(content: &str, max_chars: usize) -> String {
    let normalized = content.replace('\0', "").replace("\r\n", "\n");
    truncate_chars(normalized.trim(), max_chars)
}

fn load_advisor_existing_context(store: &AppStore, advisor_id: &str) -> String {
    let Some(advisor) = store.advisors.iter().find(|item| item.id == advisor_id) else {
        return "(无已有智囊团成员档案)".to_string();
    };
    format!(
        "Advisor ID: {}\nName: {}\nPersonality: {}\nExisting System Prompt:\n{}",
        advisor.id,
        advisor.name,
        advisor.personality,
        truncate_chars(&advisor.system_prompt, 6000)
    )
}

fn render_named_corpus(label: &str, items: &[(String, String)], empty_text: &str) -> String {
    if items.is_empty() {
        return empty_text.to_string();
    }
    items
        .iter()
        .enumerate()
        .map(|(index, (file, excerpt))| {
            format!(
                "{label} {}\nFile: {}\nExcerpt:\n{}",
                index + 1,
                file,
                excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn collect_advisor_knowledge_evidence(
    state: &State<'_, AppState>,
    advisor_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let knowledge_dir = advisor_knowledge_dir(state, advisor_id)?;
    let mut files = Vec::new();
    collect_text_files_recursive(&knowledge_dir, 3, &mut files);
    files.sort();
    let mut items = Vec::new();
    for file_path in files.into_iter().take(12) {
        let content = fs::read_to_string(&file_path).unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let relative = file_path
            .strip_prefix(&knowledge_dir)
            .unwrap_or(&file_path)
            .display()
            .to_string();
        items.push((relative, build_excerpt_around(&content, 3200)));
    }
    Ok(items)
}

fn collect_related_manuscript_evidence(
    state: &State<'_, AppState>,
    subject_names: &[String],
) -> Result<Vec<(String, String)>, String> {
    let root = manuscripts_root(state)?;
    let mut files = Vec::new();
    collect_text_files_recursive(&root, 6, &mut files);
    files.sort();
    let lowered_needles = subject_names
        .iter()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    let mut items = Vec::<(String, String, usize)>::new();
    for file_path in files {
        let content = fs::read_to_string(&file_path).unwrap_or_default();
        let lowered = content.to_lowercase();
        let score = lowered_needles
            .iter()
            .filter(|needle| lowered.contains(needle.as_str()))
            .count();
        if score == 0 {
            continue;
        }
        let relative = file_path
            .strip_prefix(&root)
            .unwrap_or(&file_path)
            .display()
            .to_string();
        items.push((relative, build_excerpt_around(&content, 2200), score));
    }
    items.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    Ok(items
        .into_iter()
        .take(8)
        .map(|(file, excerpt, _)| (file, excerpt))
        .collect())
}

fn load_skill_bundle_sections(skill_name: &str) -> (String, String, String, String) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let candidates = [
        home.join(".codex").join("skills").join(skill_name),
        home.join(".agents").join("skills").join(skill_name),
    ];
    for root in candidates {
        let skill_path = root.join("SKILL.md");
        if !skill_path.exists() {
            continue;
        }
        let body = fs::read_to_string(&skill_path).unwrap_or_default();
        let references = root.join("references");
        let scripts = root.join("scripts");
        let mut refs_parts = Vec::new();
        let mut script_parts = Vec::new();
        if let Ok(entries) = fs::read_dir(&references) {
            for entry in entries.flatten().take(8) {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let content = fs::read_to_string(&path).unwrap_or_default();
                let name = path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("reference");
                refs_parts.push(format!("## {}\n{}", name, content));
            }
        }
        if let Ok(entries) = fs::read_dir(&scripts) {
            for entry in entries.flatten().take(8) {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let content = fs::read_to_string(&path).unwrap_or_default();
                let name = path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("script");
                script_parts.push(format!("## {}\n{}", name, content));
            }
        }
        return (
            skill_name.to_string(),
            body,
            refs_parts.join("\n\n"),
            script_parts.join("\n\n"),
        );
    }
    (
        skill_name.to_string(),
        String::new(),
        String::new(),
        String::new(),
    )
}

fn media_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("media");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn cover_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("cover");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn redclaw_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("redclaw");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn knowledge_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("knowledge");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn default_work_schedule() -> WorkScheduleRecord {
    WorkScheduleRecord {
        mode: "none".to_string(),
        interval_minutes: None,
        time: None,
        weekdays: None,
        run_at: None,
        next_run_at: None,
        completed_rounds: None,
        total_rounds: None,
    }
}

fn default_work_refs() -> WorkRefsRecord {
    WorkRefsRecord {
        project_ids: Vec::new(),
        session_ids: Vec::new(),
        task_ids: Vec::new(),
    }
}

fn create_work_item(
    item_type: &str,
    title: String,
    summary: Option<String>,
    description: Option<String>,
    metadata: Option<Value>,
    priority: i64,
) -> WorkItemRecord {
    let timestamp = now_iso();
    WorkItemRecord {
        id: make_id("work"),
        title,
        description,
        summary,
        status: "done".to_string(),
        effective_status: "done".to_string(),
        priority,
        r#type: item_type.to_string(),
        blocked_by: Vec::new(),
        refs: default_work_refs(),
        metadata,
        schedule: default_work_schedule(),
        created_at: timestamp.clone(),
        updated_at: timestamp.clone(),
        completed_at: Some(timestamp),
    }
}

fn collect_sample_files(root: &Path, limit: usize) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_file() {
            files.push(entry.file_name().to_string_lossy().to_string());
        } else if path.is_dir() {
            let nested = entry.file_name().to_string_lossy().to_string();
            files.push(format!("{nested}/"));
        }
        if files.len() >= limit {
            break;
        }
    }
    Ok(files)
}

fn count_files_in_dir(root: &Path) -> Result<i64, String> {
    if !root.exists() {
        return Ok(0);
    }
    let mut count = 0_i64;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_file() {
            count += 1;
        } else if path.is_dir() {
            count += count_files_in_dir(&path)?;
        }
    }
    Ok(count)
}

fn guess_mime_and_kind(path: &Path) -> (String, String, bool) {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" => (
            format!("image/{}", if ext == "jpg" { "jpeg" } else { ext.as_str() }),
            "image".to_string(),
            true,
        ),
        "mp3" | "wav" | "m4a" | "aac" | "ogg" => ("audio/*".to_string(), "audio".to_string(), true),
        "mp4" | "mov" | "mkv" | "avi" | "webm" => {
            ("video/*".to_string(), "video".to_string(), false)
        }
        "md" | "txt" | "json" | "csv" | "ts" | "tsx" | "js" | "jsx" | "html" | "css" => {
            ("text/plain".to_string(), "text".to_string(), true)
        }
        _ => (
            "application/octet-stream".to_string(),
            "binary".to_string(),
            false,
        ),
    }
}

fn run_osascript_json(script: &str) -> Result<Value, String> {
    let output = std::process::Command::new("osascript")
        .arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "osascript execution failed".to_string()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!([]));
    }
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid osascript JSON: {error}"))
}

#[cfg(target_os = "windows")]
fn run_powershell_json(script: &str) -> Result<Value, String> {
    let output = std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "powershell execution failed".to_string()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!([]));
    }
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid powershell JSON: {error}"))
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn pick_files_native(
    prompt: &str,
    folders_only: bool,
    multiple: bool,
) -> Result<Vec<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let base_call = if folders_only {
            "chooseFolder"
        } else {
            "chooseFile"
        };
        let picker_call = format!(
            "var app=Application.currentApplication(); app.includeStandardAdditions=true; var picked=app.{base_call}({{withPrompt:{prompt:?}, multipleSelectionsAllowed:{multiple}}}); var list=Array.isArray(picked)?picked:[picked]; JSON.stringify(list.map(String));"
        );
        let value = run_osascript_json(&picker_call)?;
        let items = value
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(PathBuf::from))
            .collect::<Vec<_>>();
        return Ok(items);
    }

    #[cfg(target_os = "windows")]
    {
        let prompt = escape_powershell_single_quoted(prompt);
        let script = if folders_only {
            format!(
                r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '{prompt}'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  @($dialog.SelectedPath) | ConvertTo-Json -Compress
}} else {{
  '[]'
}}
"#
            )
        } else {
            format!(
                r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '{prompt}'
$dialog.Multiselect = ${multiple}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  @($dialog.FileNames) | ConvertTo-Json -Compress
}} else {{
  '[]'
}}
"#
            )
        };
        let value = run_powershell_json(&script)?;
        let items = value
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.as_str().map(PathBuf::from))
            .collect::<Vec<_>>();
        return Ok(items);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = prompt;
        let _ = folders_only;
        let _ = multiple;
        Err("RedBox picker currently supports macOS and Windows".to_string())
    }
}

fn copy_file_into_dir(source: &Path, target_dir: &Path) -> Result<(String, PathBuf), String> {
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("imported-{}", now_ms()));
    let relative_name = format!("{}-{}", now_ms(), file_name);
    let target = target_dir.join(&relative_name);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, &target).map_err(|error| error.to_string())?;
    Ok((relative_name, target))
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("目录不存在: {}", source.display()));
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let next = target.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &next)?;
        } else if path.is_file() {
            if let Some(parent) = next.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&path, &next).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn load_subject_categories_from_fs(subjects_root: &Path) -> Vec<SubjectCategory> {
    workspace_loaders::load_subject_categories_from_fs(subjects_root)
}

fn load_subjects_from_fs(subjects_root: &Path) -> Vec<SubjectRecord> {
    workspace_loaders::load_subjects_from_fs(subjects_root)
}

fn load_advisors_from_fs(advisors_root: &Path) -> Vec<AdvisorRecord> {
    workspace_loaders::load_advisors_from_fs(advisors_root)
}

fn load_media_assets_from_fs(media_root: &Path) -> Vec<MediaAssetRecord> {
    workspace_loaders::load_media_assets_from_fs(media_root)
}

fn load_cover_assets_from_fs(cover_root: &Path) -> Vec<CoverAssetRecord> {
    workspace_loaders::load_cover_assets_from_fs(cover_root)
}

fn load_knowledge_notes_from_fs(knowledge_root: &Path) -> Vec<KnowledgeNoteRecord> {
    workspace_loaders::load_knowledge_notes_from_fs(knowledge_root)
}

fn load_youtube_videos_from_fs(knowledge_root: &Path) -> Vec<YoutubeVideoRecord> {
    workspace_loaders::load_youtube_videos_from_fs(knowledge_root)
}

fn load_document_sources_from_fs(knowledge_root: &Path) -> Vec<DocumentKnowledgeSourceRecord> {
    workspace_loaders::load_document_sources_from_fs(knowledge_root)
}

fn load_redclaw_state_from_fs(redclaw_root: &Path) -> RedclawStateRecord {
    workspace_loaders::load_redclaw_state_from_fs(redclaw_root)
}

fn load_work_items_from_fs(redclaw_root: &Path) -> Vec<WorkItemRecord> {
    workspace_loaders::load_work_items_from_fs(redclaw_root)
}

fn browser_plugin_bundled_root() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Plugin")
}

fn browser_plugin_export_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = store_root(state)?.join("browser-plugin");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn advisors_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("advisors");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn advisor_dir(state: &State<'_, AppState>, advisor_id: &str) -> Result<PathBuf, String> {
    let root = advisors_root(state)?.join(slug_from_relative_path(advisor_id));
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn advisor_knowledge_dir(state: &State<'_, AppState>, advisor_id: &str) -> Result<PathBuf, String> {
    let root = advisor_dir(state, advisor_id)?.join("knowledge");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn advisor_avatar_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = advisors_root(state)?.join("avatars");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn wechat_drafts_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?
        .join("wechat-official")
        .join("drafts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn write_base64_payload_to_file(encoded: &str, output_path: &Path) -> Result<(), String> {
    desktop_io::write_base64_payload_to_file(encoded, output_path)
}

fn run_curl_transcription(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    desktop_io::run_curl_transcription(endpoint, api_key, model_name, file_path, mime_type)
}

fn resolve_transcription_settings(settings: &Value) -> Option<(String, Option<String>, String)> {
    desktop_io::resolve_transcription_settings(settings)
}

fn detect_ytdlp() -> Option<(String, String)> {
    desktop_io::detect_ytdlp()
}

fn ensure_ytdlp_installed(update: bool) -> Result<(String, String), String> {
    desktop_io::ensure_ytdlp_installed(update)
}

fn fetch_ytdlp_channel_info(channel_url: &str, limit: i64) -> Result<Value, String> {
    desktop_io::fetch_ytdlp_channel_info(channel_url, limit)
}

fn parse_ytdlp_videos(
    advisor_id: &str,
    channel_id: Option<&str>,
    value: &Value,
) -> Vec<AdvisorVideoRecord> {
    desktop_io::parse_ytdlp_videos(advisor_id, channel_id, value)
}

fn download_ytdlp_subtitle(
    video_url: &str,
    target_dir: &Path,
    file_prefix: &str,
) -> Result<PathBuf, String> {
    desktop_io::download_ytdlp_subtitle(video_url, target_dir, file_prefix)
}

fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    desktop_io::copy_image_to_clipboard(path)
}

fn now_i64() -> i64 {
    now_ms() as i64
}

fn discover_local_mcp_configs() -> Vec<(String, Vec<McpServerRecord>)> {
    mcp_runtime::discover_local_mcp_configs()
}

fn invoke_mcp_server(
    server: &McpServerRecord,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    mcp_runtime::invoke_mcp_server(server, method, params)
}

fn test_mcp_server(server: &McpServerRecord) -> Result<(String, String), String> {
    mcp_runtime::test_mcp_server(server)
}

fn append_session_transcript(
    store: &mut AppStore,
    session_id: &str,
    record_type: &str,
    role: &str,
    content: String,
    payload: Option<Value>,
) {
    store
        .session_transcript_records
        .push(SessionTranscriptRecord {
            id: make_id("transcript"),
            session_id: session_id.to_string(),
            record_type: record_type.to_string(),
            role: role.to_string(),
            content,
            payload,
            created_at: now_i64(),
        });
}

fn append_debug_log(store: &mut AppStore, line: String) {
    store.debug_logs.insert(0, line);
    if store.debug_logs.len() > 200 {
        store.debug_logs.truncate(200);
    }
}

fn append_debug_log_state(state: &State<'_, AppState>, line: impl Into<String>) {
    let line = format!("{} | {}", now_iso(), line.into());
    let _ = with_store_mut(state, |store| {
        append_debug_log(store, line);
        Ok(())
    });
}

fn log_timing_event(
    state: &State<'_, AppState>,
    scope: &str,
    request_id: &str,
    stage: &str,
    started_at_ms: u128,
    extra: Option<String>,
) {
    let elapsed = now_ms().saturating_sub(started_at_ms);
    let mut line = format!(
        "[timing][{}][{}] {} elapsed={}ms",
        scope, request_id, stage, elapsed
    );
    if let Some(extra_text) = extra.filter(|value| !value.trim().is_empty()) {
        line.push_str(" | ");
        line.push_str(&extra_text);
    }
    eprintln!("{}", line);
    append_debug_log_state(state, line);
}

fn redclaw_state_value(state: &RedclawStateRecord) -> Value {
    let scheduled_tasks = state
        .scheduled_tasks
        .iter()
        .map(|item| (item.id.clone(), json!(item)))
        .collect::<serde_json::Map<String, Value>>();
    let long_cycle_tasks = state
        .long_cycle_tasks
        .iter()
        .map(|item| (item.id.clone(), json!(item)))
        .collect::<serde_json::Map<String, Value>>();
    json!({
        "enabled": state.enabled,
        "lockState": state.lock_state,
        "blockedBy": state.blocked_by,
        "intervalMinutes": state.interval_minutes,
        "keepAliveWhenNoWindow": state.keep_alive_when_no_window,
        "maxProjectsPerTick": state.max_projects_per_tick,
        "maxAutomationPerTick": state.max_automation_per_tick,
        "isTicking": state.is_ticking,
        "currentProjectId": state.current_project_id,
        "currentAutomationTaskId": state.current_automation_task_id,
        "nextAutomationFireAt": state.next_automation_fire_at,
        "inFlightTaskIds": state.in_flight_task_ids,
        "inFlightLongCycleTaskIds": state.in_flight_long_cycle_task_ids,
        "heartbeatInFlight": state.heartbeat_in_flight,
        "lastTickAt": state.last_tick_at,
        "nextTickAt": state.next_tick_at,
        "nextMaintenanceAt": state.next_maintenance_at,
        "lastError": state.last_error,
        "heartbeat": state.heartbeat,
        "scheduledTasks": scheduled_tasks,
        "longCycleTasks": long_cycle_tasks,
    })
}

fn knowledge_version(store: &AppStore) -> String {
    format!(
        "{}:{}:{}",
        store.knowledge_notes.len(),
        store.youtube_videos.len(),
        store.document_sources.len()
    )
}

fn knowledge_source_texts(store: &AppStore) -> Vec<(String, String, Value)> {
    let mut items = Vec::new();
    for note in &store.knowledge_notes {
        items.push((
            note.id.clone(),
            format!("{}\n{}\n{}", note.title, note.content, note.transcript.clone().unwrap_or_default()),
            json!({ "kind": note.capture_kind.clone().unwrap_or_else(|| "note".to_string()), "title": note.title }),
        ));
    }
    for video in &store.youtube_videos {
        items.push((
            video.id.clone(),
            format!(
                "{}\n{}\n{}\n{}",
                video.title,
                video.description,
                video.summary.clone().unwrap_or_default(),
                video.subtitle_content.clone().unwrap_or_default()
            ),
            json!({ "kind": "youtube", "title": video.title }),
        ));
    }
    for source in &store.document_sources {
        items.push((
            source.id.clone(),
            format!(
                "{}\n{}\n{}",
                source.name,
                source.root_path,
                source.sample_files.join("\n")
            ),
            json!({ "kind": source.kind, "title": source.name, "rootPath": source.root_path }),
        ));
    }
    items
}

fn wander_item_from_note(note: &KnowledgeNoteRecord) -> Value {
    json!({
        "id": note.id,
        "type": if note.video.is_some() || note.video_url.is_some() { "video" } else { "note" },
        "title": note.title,
        "content": note.excerpt.clone().unwrap_or_else(|| note.content.chars().take(500).collect::<String>()),
        "cover": note.cover,
        "meta": {
            "sourceType": note.capture_kind,
            "folderPath": note.folder_path,
            "sourceUrl": note.source_url
        }
    })
}

fn wander_item_from_youtube(video: &YoutubeVideoRecord) -> Value {
    json!({
        "id": video.id,
        "type": "video",
        "title": video.title,
        "content": video.summary.clone().or(video.subtitle_content.clone()).unwrap_or_else(|| video.description.clone()),
        "cover": video.thumbnail_url,
        "meta": {
            "sourceType": "youtube",
            "videoId": video.video_id,
            "folderPath": video.folder_path,
            "sourceUrl": video.video_url
        }
    })
}

fn wander_item_from_doc(source: &DocumentKnowledgeSourceRecord) -> Value {
    json!({
        "id": source.id,
        "type": "note",
        "title": source.name,
        "content": format!("文档源：{}\n样例文件：{}", source.root_path, source.sample_files.join(", ")),
        "cover": Value::Null,
        "meta": {
            "sourceType": "document",
            "sourceName": source.name,
            "sourceKind": source.kind,
            "filePath": source.root_path,
            "relativePath": source.sample_files.first().cloned().unwrap_or_default()
        }
    })
}

fn build_wander_items_text(items: &[Value]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "Item {}:\nTitle: {}\nType: {}\nContent Summary: {}...",
                index + 1,
                item.get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Untitled"),
                item.get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("note"),
                item.get("content")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(500)
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_wander_long_term_context(state: &State<'_, AppState>) -> String {
    let _ = ensure_redclaw_profile_files(state);
    let root = workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let profile_root = root.join("redclaw").join("profile");
    let paths = [
        ("Agent.md", profile_root.join("Agent.md"), 2200usize),
        ("user.md", profile_root.join("user.md"), 1800usize),
        (
            "CreatorProfile.md",
            profile_root.join("CreatorProfile.md"),
            2200usize,
        ),
        (
            "MEMORY.md",
            root.join("memory").join("MEMORY.md"),
            2200usize,
        ),
        ("Soul.md", profile_root.join("Soul.md"), 1200usize),
    ];
    let mut sections = Vec::new();
    for (label, path, max_chars) in paths {
        let snippet = fs::read_to_string(&path)
            .map(|content| truncate_chars(content.trim(), max_chars))
            .unwrap_or_default();
        if !snippet.trim().is_empty() {
            sections.push(format!("### {}\n{}", label, snippet));
        }
    }
    sections.join("\n\n")
}

fn emit_wander_tool_start(
    app: &AppHandle,
    session_id: &str,
    name: &str,
    input: Value,
    description: &str,
) {
    let call_id = format!("wander:{}:{}", session_id, name);
    emit_runtime_tool_request(
        app,
        Some(session_id),
        &call_id,
        name,
        input.clone(),
        Some(description),
    );
}

fn emit_wander_tool_end(
    app: &AppHandle,
    session_id: &str,
    name: &str,
    success: bool,
    content: String,
) {
    let call_id = format!("wander:{}:{}", session_id, name);
    emit_runtime_tool_result(app, Some(session_id), &call_id, name, success, &content);
}

fn read_workspace_text_snippet(path: &Path, max_chars: usize) -> String {
    fs::read_to_string(path)
        .map(|content| content.chars().take(max_chars).collect::<String>())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn build_wander_materials_context(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    items: &[Value],
) -> String {
    let mut sections = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let title = item
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("Untitled");
        let item_type = item
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("note");
        let meta = item
            .get("meta")
            .and_then(|value| value.as_object())
            .cloned()
            .unwrap_or_default();
        let source_type = meta
            .get("sourceType")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut chunks = vec![format!("### 素材 {}: {}", index + 1, title)];
        chunks.push(format!("类型: {}", item_type));
        if !source_type.is_empty() {
            chunks.push(format!("来源类型: {}", source_type));
        }
        if let Some(summary) = item.get("content").and_then(|value| value.as_str()) {
            if !summary.trim().is_empty() {
                chunks.push(format!(
                    "已有摘要:\n{}",
                    summary.chars().take(600).collect::<String>()
                ));
            }
        }

        if source_type == "document" {
            let file_path = meta
                .get("filePath")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if !file_path.is_empty() {
                emit_wander_tool_start(
                    app,
                    session_id,
                    "redbox_read_path",
                    json!({ "path": file_path, "maxChars": 2200 }),
                    "读取文档知识源",
                );
                match resolve_workspace_tool_path(state, file_path) {
                    Ok(path) => {
                        let snippet = read_workspace_text_snippet(&path, 2200);
                        if !snippet.is_empty() {
                            chunks.push(format!("文档正文:\n{}", snippet));
                            emit_wander_tool_end(
                                app,
                                session_id,
                                "redbox_read_path",
                                true,
                                format!("已读取文档文件：{}", path.display()),
                            );
                        } else {
                            emit_wander_tool_end(
                                app,
                                session_id,
                                "redbox_read_path",
                                false,
                                "文档为空或无法读取".to_string(),
                            );
                        }
                    }
                    Err(error) => {
                        emit_wander_tool_end(app, session_id, "redbox_read_path", false, error);
                    }
                }
            }
            sections.push(chunks.join("\n\n"));
            continue;
        }

        let folder_path = meta
            .get("folderPath")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        if folder_path.is_empty() {
            sections.push(chunks.join("\n\n"));
            continue;
        }

        emit_wander_tool_start(
            app,
            session_id,
            "redbox_list_directory",
            json!({ "path": folder_path, "limit": 20 }),
            "列出素材目录",
        );
        let resolved_folder = match resolve_workspace_tool_path(state, folder_path) {
            Ok(path) => path,
            Err(error) => {
                emit_wander_tool_end(app, session_id, "redbox_list_directory", false, error);
                sections.push(chunks.join("\n\n"));
                continue;
            }
        };
        let entries = match list_directory_entries(&resolved_folder, 20) {
            Ok(entries) => {
                emit_wander_tool_end(
                    app,
                    session_id,
                    "redbox_list_directory",
                    true,
                    format!("已列出目录：{}", resolved_folder.display()),
                );
                entries
            }
            Err(error) => {
                emit_wander_tool_end(app, session_id, "redbox_list_directory", false, error);
                sections.push(chunks.join("\n\n"));
                continue;
            }
        };

        let meta_entry = entries
            .iter()
            .find(|entry| entry.get("name").and_then(|value| value.as_str()) == Some("meta.json"));
        let mut transcript_hint = String::new();
        if let Some(meta_entry) = meta_entry {
            if let Some(meta_path) = meta_entry.get("path").and_then(|value| value.as_str()) {
                emit_wander_tool_start(
                    app,
                    session_id,
                    "redbox_read_path",
                    json!({ "path": meta_path, "maxChars": 1800 }),
                    "读取素材 meta.json",
                );
                match resolve_workspace_tool_path(state, meta_path) {
                    Ok(path) => {
                        let snippet = read_workspace_text_snippet(&path, 1800);
                        if !snippet.is_empty() {
                            chunks.push(format!("meta.json:\n{}", snippet));
                            if let Ok(parsed) = serde_json::from_str::<Value>(&snippet) {
                                transcript_hint = payload_string(&parsed, "transcriptFile")
                                    .or_else(|| payload_string(&parsed, "subtitleFile"))
                                    .unwrap_or_default();
                            }
                            emit_wander_tool_end(
                                app,
                                session_id,
                                "redbox_read_path",
                                true,
                                "meta.json 读取完成".to_string(),
                            );
                        } else {
                            emit_wander_tool_end(
                                app,
                                session_id,
                                "redbox_read_path",
                                false,
                                "meta.json 为空或无法读取".to_string(),
                            );
                        }
                    }
                    Err(error) => {
                        emit_wander_tool_end(app, session_id, "redbox_read_path", false, error);
                    }
                }
            }
        }

        let candidate_names = if item_type == "video" {
            let mut items = Vec::new();
            if !transcript_hint.trim().is_empty() {
                items.push(transcript_hint.clone());
            }
            items.extend([
                "transcript.txt".to_string(),
                "transcript.md".to_string(),
                "subtitle.txt".to_string(),
                "subtitle.srt".to_string(),
                "content.md".to_string(),
            ]);
            items
        } else {
            vec!["content.md".to_string(), "note.md".to_string()]
        };
        let content_entry = candidate_names.iter().find_map(|candidate| {
            entries.iter().find(|entry| {
                entry.get("name").and_then(|value| value.as_str()) == Some(candidate.as_str())
            })
        });
        if let Some(content_entry) = content_entry {
            if let Some(content_path) = content_entry.get("path").and_then(|value| value.as_str()) {
                emit_wander_tool_start(
                    app,
                    session_id,
                    "redbox_read_path",
                    json!({ "path": content_path, "maxChars": 2600 }),
                    "读取素材正文或转录文件",
                );
                match resolve_workspace_tool_path(state, content_path) {
                    Ok(path) => {
                        let snippet = read_workspace_text_snippet(&path, 2600);
                        if !snippet.is_empty() {
                            chunks.push(format!(
                                "{}:\n{}",
                                path.file_name()
                                    .and_then(|value| value.to_str())
                                    .unwrap_or("content"),
                                snippet
                            ));
                            emit_wander_tool_end(
                                app,
                                session_id,
                                "redbox_read_path",
                                true,
                                format!("已读取文件：{}", path.display()),
                            );
                        } else {
                            emit_wander_tool_end(
                                app,
                                session_id,
                                "redbox_read_path",
                                false,
                                "正文或转录文件为空".to_string(),
                            );
                        }
                    }
                    Err(error) => {
                        emit_wander_tool_end(app, session_id, "redbox_read_path", false, error);
                    }
                }
            }
        }

        sections.push(chunks.join("\n\n"));
    }
    sections.join("\n\n---\n\n")
}

fn build_wander_deep_agent_prompt(
    items_text: &str,
    long_term_context_section: &str,
    materials_context: &str,
    multi_choice: bool,
) -> String {
    let output_requirement = if multi_choice {
        [
            "硬性输出要求（多选题模式）：",
            "1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；",
            "2) JSON 顶层必须包含：thinking_process, options；",
            "3) options 必须是长度为 3 的数组；",
            "4) 每个 option 必须包含：content_direction, topic；",
            "5) topic 必须包含：title, connections（数组，取值只能是 1-3）；",
            "6) thinking_process 为 3-6 条简洁思考要点。",
        ]
        .join("\n")
    } else {
        [
            "硬性输出要求（单选题模式）：",
            "1) 仅输出 JSON，不要输出 Markdown、解释、前后缀文本；",
            "2) JSON 顶层必须包含：content_direction, thinking_process, topic；",
            "3) topic 必须包含：title, connections（数组，取值只能是 1-3）；",
            "4) thinking_process 为 3-6 条简洁思考要点；",
            "5) content_direction 必须是可直接创作的内容方向说明。",
        ]
        .join("\n")
    };

    let template = load_redbox_prompt_or_embedded(
        "runtime/wander/deep_agent_base.txt",
        include_str!("../../prompts/library/runtime/wander/deep_agent_base.txt"),
    );
    render_redbox_prompt(
        &template,
        &[
            ("output_requirement", output_requirement),
            ("items_text", items_text.to_string()),
            ("materials_context", materials_context.to_string()),
            (
                "long_term_context_section",
                long_term_context_section.to_string(),
            ),
        ],
    )
}

fn resolve_wander_model_config(settings: &Value) -> Value {
    let base_url = payload_string(settings, "api_endpoint").unwrap_or_default();
    let api_key = payload_string(settings, "api_key").unwrap_or_default();
    let model_name = payload_string(settings, "model_name_wander")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "model_name"))
        .unwrap_or_default();
    json!({
        "baseURL": base_url,
        "apiKey": api_key,
        "modelName": model_name,
        "protocol": "openai"
    })
}

fn generate_wander_response(
    state: &State<'_, AppState>,
    config: &Value,
    prompt: &str,
) -> Result<String, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let resolved = resolve_chat_config(&settings_snapshot, Some(config))
        .ok_or_else(|| "wander model config is unavailable".to_string())?;
    if resolved.protocol != "openai" {
        return Ok(invoke_chat_by_protocol(
            &resolved.protocol,
            &resolved.base_url,
            resolved.api_key.as_deref(),
            &resolved.model_name,
            prompt,
        )?);
    }
    let lower_model_hint = format!("{} {}", resolved.model_name, resolved.base_url).to_lowercase();
    let disable_qwen_thinking =
        lower_model_hint.contains("qwen") || lower_model_hint.contains("dashscope");
    let mut body = json!({
        "model": resolved.model_name,
        "messages": [
            {
                "role": "system",
                "content": "你是 RedClaw 的漫步选题 Agent。基于给定素材和关键文件摘录，快速生成高质量结构化选题结果。只输出 JSON。"
            },
            {
                "role": "user",
                "content": prompt,
            }
        ],
        "stream": false,
        "temperature": 0.7,
        "max_tokens": 900,
    });
    if disable_qwen_thinking {
        body["enable_thinking"] = json!(false);
    }
    let response = run_curl_json_with_timeout(
        "POST",
        &format!(
            "{}/chat/completions",
            normalize_base_url(&resolved.base_url)
        ),
        resolved.api_key.as_deref(),
        &[],
        Some(body),
        Some(25),
    )?;
    response
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "wander completion returned empty content".to_string())
}

fn write_placeholder_svg(
    path: &Path,
    title: &str,
    subtitle: &str,
    accent: &str,
) -> Result<(), String> {
    let title = escape_html(title);
    let subtitle = escape_html(subtitle);
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1365" viewBox="0 0 1024 1365" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1024" y2="1365" gradientUnits="userSpaceOnUse">
      <stop stop-color="#F9F6EF"/>
      <stop offset="1" stop-color="{accent}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1365" fill="url(#bg)"/>
  <rect x="72" y="72" width="880" height="1221" rx="44" fill="white" fill-opacity="0.74"/>
  <rect x="128" y="128" width="768" height="16" rx="8" fill="{accent}" fill-opacity="0.45"/>
  <text x="128" y="300" fill="#191919" font-family="Helvetica, Arial, sans-serif" font-size="84" font-weight="700">
    <tspan x="128" dy="0">{title}</tspan>
  </text>
  <text x="128" y="420" fill="#565656" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="400">
    <tspan x="128" dy="0">{subtitle}</tspan>
  </text>
  <rect x="128" y="1040" width="260" height="88" rx="24" fill="{accent}" fill-opacity="0.18"/>
  <text x="164" y="1097" fill="#191919" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">RedBox Placeholder</text>
</svg>"##,
        accent = accent,
        title = title,
        subtitle = subtitle,
    );
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, svg).map_err(|error| error.to_string())
}

fn generate_chat_response(settings: &Value, model_config: Option<&Value>, prompt: &str) -> String {
    if let Some(config) = resolve_chat_config(settings, model_config) {
        invoke_chat_by_protocol(
            &config.protocol,
            &config.base_url,
            config.api_key.as_deref(),
            &config.model_name,
            prompt,
        )
        .unwrap_or_else(|_| build_placeholder_assistant_response(prompt))
    } else {
        build_placeholder_assistant_response(prompt)
    }
}

fn interactive_runtime_system_prompt(state: &State<'_, AppState>, runtime_mode: &str) -> String {
    interactive_runtime_shared::interactive_runtime_system_prompt(state, runtime_mode)
}

fn parse_usize_arg(arguments: &Value, key: &str, default: usize, max: usize) -> usize {
    interactive_runtime_shared::parse_usize_arg(arguments, key, default, max)
}

fn text_snippet(value: &str, limit: usize) -> String {
    interactive_runtime_shared::text_snippet(value, limit)
}

fn collect_recent_chat_messages(
    store: &AppStore,
    session_id: Option<&str>,
    limit: usize,
) -> Vec<Value> {
    interactive_runtime_shared::collect_recent_chat_messages(store, session_id, limit)
}

fn resolve_workspace_tool_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    interactive_runtime_shared::resolve_workspace_tool_path(state, raw_path)
}

fn list_directory_entries(path: &Path, limit: usize) -> Result<Vec<Value>, String> {
    interactive_runtime_shared::list_directory_entries(path, limit)
}

fn interactive_runtime_tools_for_mode(runtime_mode: &str) -> Value {
    interactive_runtime_shared::interactive_runtime_tools_for_mode(runtime_mode)
}

fn resolve_editor_tool_file_path(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    arguments: &Value,
) -> Result<String, String> {
    if let Some(file_path) = payload_string(arguments, "filePath") {
        return Ok(file_path);
    }
    let Some(session_id) = session_id else {
        return Err(
            "filePath is required for editor tool calls outside a bound session".to_string(),
        );
    };
    with_store(state, |store| {
        store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|session| session.metadata.as_ref())
            .and_then(|metadata| {
                payload_string(metadata, "associatedFilePath")
                    .or_else(|| payload_string(metadata, "contextId"))
            })
            .ok_or_else(|| "editor session is not bound to a manuscript package".to_string())
    })
}

fn editor_tool_payload(file_path: String, arguments: &Value, keys: &[&str]) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("filePath".to_string(), json!(file_path));
    for key in keys {
        if let Some(value) = payload_field(arguments, key) {
            object.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(object)
}

fn execute_interactive_tool_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let normalized_call = tools::compat::normalize_tool_call(name, arguments);
    let name = normalized_call.name;
    let arguments = &normalized_call.arguments;
    tools::guards::ensure_tool_allowed_for_runtime_mode(runtime_mode, name)?;
    let call_mcp_channel = |channel: &str, payload: Value| -> Result<Value, String> {
        commands::mcp_tools::handle_mcp_tools_channel(app, state, channel, &payload)
            .unwrap_or_else(|| Err(format!("MCP channel not handled: {channel}")))
    };
    let call_skill_channel = |channel: &str, payload: Value| -> Result<Value, String> {
        commands::skills_ai::handle_skills_ai_channel(app, state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Skill channel not handled: {channel}")))
    };
    let call_runtime_channel = |channel: &str, payload: Value| -> Result<Value, String> {
        commands::runtime::handle_runtime_channel(app, state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Runtime channel not handled: {channel}")))
    };
    let call_bridge_channel = |channel: &str, payload: Value| -> Result<Value, String> {
        commands::bridge::handle_bridge_channel(app, state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Bridge channel not handled: {channel}")))
    };
    let call_manuscript_channel = |channel: &str, payload: Value| -> Result<Value, String> {
        commands::manuscripts::handle_manuscripts_channel(app, state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Manuscript channel not handled: {channel}")))
    };

    match name {
        "redbox_editor" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            let file_path = resolve_editor_tool_file_path(state, session_id, arguments)?;
            match action.as_str() {
                "timeline_read" | "clips" => {
                    call_manuscript_channel("manuscripts:get-package-state", json!(file_path))
                }
                "track_add" | "track-add" => call_manuscript_channel(
                    "manuscripts:add-package-track",
                    editor_tool_payload(file_path, arguments, &["kind"]),
                ),
                "clip_add" | "clip-add" => call_manuscript_channel(
                    "manuscripts:add-package-clip",
                    editor_tool_payload(
                        file_path,
                        arguments,
                        &["assetId", "track", "order", "durationMs"],
                    ),
                ),
                "clip_update" | "clip-update" => call_manuscript_channel(
                    "manuscripts:update-package-clip",
                    editor_tool_payload(
                        file_path,
                        arguments,
                        &[
                            "clipId",
                            "track",
                            "order",
                            "durationMs",
                            "trimInMs",
                            "trimOutMs",
                            "enabled",
                        ],
                    ),
                ),
                "clip_delete" | "clip-delete" => call_manuscript_channel(
                    "manuscripts:delete-package-clip",
                    editor_tool_payload(file_path, arguments, &["clipId"]),
                ),
                "clip_split" | "clip-split" => call_manuscript_channel(
                    "manuscripts:split-package-clip",
                    editor_tool_payload(file_path, arguments, &["clipId", "splitRatio"]),
                ),
                "remotion_generate" | "remotion-generate" => call_manuscript_channel(
                    "manuscripts:generate-remotion-scene",
                    editor_tool_payload(file_path, arguments, &["instructions"]),
                ),
                "remotion_save" | "remotion-save" => call_manuscript_channel(
                    "manuscripts:save-remotion-scene",
                    editor_tool_payload(file_path, arguments, &["scene"]),
                ),
                "export" => call_manuscript_channel(
                    "manuscripts:render-remotion-video",
                    editor_tool_payload(file_path, arguments, &[]),
                ),
                _ => Err(format!("unsupported redbox_editor action: {action}")),
            }
        }
        "redbox_mcp" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            match action.as_str() {
                "list" => call_mcp_channel("mcp:list", json!({})),
                "save" => call_mcp_channel(
                    "mcp:save",
                    json!({ "servers": payload_field(arguments, "servers").cloned().unwrap_or_else(|| json!([])) }),
                ),
                "test" => call_mcp_channel(
                    "mcp:test",
                    json!({ "server": payload_field(arguments, "server").cloned().unwrap_or_else(|| json!({})) }),
                ),
                "call" => call_mcp_channel(
                    "mcp:call",
                    json!({
                        "server": payload_field(arguments, "server").cloned().unwrap_or_else(|| json!({})),
                        "method": payload_string(arguments, "method").unwrap_or_default(),
                        "params": payload_field(arguments, "params").cloned().unwrap_or_else(|| json!({})),
                        "sessionId": payload_string(arguments, "sessionId"),
                    }),
                ),
                "discover_local" => call_mcp_channel("mcp:discover-local", json!({})),
                "import_local" => call_mcp_channel("mcp:import-local", json!({})),
                "oauth_status" => call_mcp_channel(
                    "mcp:oauth-status",
                    json!({ "serverId": payload_string(arguments, "serverId").unwrap_or_default() }),
                ),
                _ => Err(format!("unsupported redbox_mcp action: {action}")),
            }
        }
        "redbox_skill" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            match action.as_str() {
                "list" => call_skill_channel("skills:list", json!({})),
                "create" => call_skill_channel(
                    "skills:create",
                    json!({ "name": payload_string(arguments, "name").unwrap_or_default() }),
                ),
                "save" => call_skill_channel(
                    "skills:save",
                    json!({
                        "location": payload_string(arguments, "location").unwrap_or_default(),
                        "content": payload_string(arguments, "content").unwrap_or_default(),
                    }),
                ),
                "enable" => call_skill_channel(
                    "skills:enable",
                    json!({ "name": payload_string(arguments, "name").unwrap_or_default() }),
                ),
                "disable" => call_skill_channel(
                    "skills:disable",
                    json!({ "name": payload_string(arguments, "name").unwrap_or_default() }),
                ),
                "market_install" => call_skill_channel(
                    "skills:market-install",
                    json!({ "slug": payload_string(arguments, "slug").unwrap_or_default() }),
                ),
                "ai_roles_list" => call_skill_channel("ai:roles:list", json!({})),
                "detect_protocol" => call_skill_channel(
                    "ai:detect-protocol",
                    json!({
                        "baseURL": payload_string(arguments, "baseURL").unwrap_or_default(),
                        "presetId": payload_string(arguments, "presetId"),
                        "protocol": payload_string(arguments, "protocol"),
                    }),
                ),
                "test_connection" => call_skill_channel(
                    "ai:test-connection",
                    json!({
                        "baseURL": payload_string(arguments, "baseURL").unwrap_or_default(),
                        "apiKey": payload_string(arguments, "apiKey"),
                        "presetId": payload_string(arguments, "presetId"),
                        "protocol": payload_string(arguments, "protocol"),
                    }),
                ),
                "fetch_models" => call_skill_channel(
                    "ai:fetch-models",
                    json!({
                        "baseURL": payload_string(arguments, "baseURL").unwrap_or_default(),
                        "apiKey": payload_string(arguments, "apiKey"),
                        "presetId": payload_string(arguments, "presetId"),
                        "protocol": payload_string(arguments, "protocol"),
                    }),
                ),
                _ => Err(format!("unsupported redbox_skill action: {action}")),
            }
        }
        "redbox_runtime_control" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            match action.as_str() {
                "runtime_query" => call_runtime_channel(
                    "runtime:query",
                    json!({
                        "sessionId": payload_string(arguments, "sessionId"),
                        "message": payload_string(arguments, "message").unwrap_or_default(),
                        "modelConfig": payload_field(arguments, "modelConfig").cloned().unwrap_or(Value::Null),
                    }),
                ),
                "runtime_resume" => call_runtime_channel(
                    "runtime:resume",
                    json!({ "sessionId": payload_string(arguments, "sessionId").unwrap_or_default() }),
                ),
                "runtime_fork_session" => call_runtime_channel(
                    "runtime:fork-session",
                    json!({ "sessionId": payload_string(arguments, "sessionId").unwrap_or_default() }),
                ),
                "runtime_get_trace" => call_runtime_channel(
                    "runtime:get-trace",
                    json!({
                        "sessionId": payload_string(arguments, "sessionId").unwrap_or_default(),
                        "limit": payload_field(arguments, "limit").cloned().unwrap_or_else(|| json!(50)),
                    }),
                ),
                "runtime_get_checkpoints" => call_runtime_channel(
                    "runtime:get-checkpoints",
                    json!({
                        "sessionId": payload_string(arguments, "sessionId").unwrap_or_default(),
                        "limit": payload_field(arguments, "limit").cloned().unwrap_or_else(|| json!(50)),
                    }),
                ),
                "runtime_get_tool_results" => call_runtime_channel(
                    "runtime:get-tool-results",
                    json!({
                        "sessionId": payload_string(arguments, "sessionId").unwrap_or_default(),
                        "limit": payload_field(arguments, "limit").cloned().unwrap_or_else(|| json!(50)),
                    }),
                ),
                "tasks_create" => call_runtime_channel(
                    "tasks:create",
                    payload_field(arguments, "payload")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                ),
                "tasks_list" => call_runtime_channel(
                    "tasks:list",
                    payload_field(arguments, "payload")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                ),
                "tasks_get" => call_runtime_channel(
                    "tasks:get",
                    json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
                ),
                "tasks_resume" => call_runtime_channel(
                    "tasks:resume",
                    json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
                ),
                "tasks_cancel" => call_runtime_channel(
                    "tasks:cancel",
                    json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
                ),
                "background_tasks_list" => call_bridge_channel("background-tasks:list", json!({})),
                "background_tasks_get" => call_bridge_channel(
                    "background-tasks:get",
                    json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
                ),
                "background_tasks_cancel" => call_bridge_channel(
                    "background-tasks:cancel",
                    json!({ "taskId": payload_string(arguments, "taskId").unwrap_or_default() }),
                ),
                "session_bridge_status" => call_bridge_channel("session-bridge:status", json!({})),
                "session_bridge_list_sessions" => {
                    call_bridge_channel("session-bridge:list-sessions", json!({}))
                }
                "session_bridge_get_session" => call_bridge_channel(
                    "session-bridge:get-session",
                    json!({ "sessionId": payload_string(arguments, "sessionId").unwrap_or_default() }),
                ),
                _ => Err(format!(
                    "unsupported redbox_runtime_control action: {action}"
                )),
            }
        }
        "redbox_app_query" => {
            let operation = payload_string(arguments, "operation").unwrap_or_default();
            let limit = parse_usize_arg(arguments, "limit", 8, 20);
            let query = payload_string(arguments, "query")
                .unwrap_or_default()
                .to_lowercase();
            let status_filter = payload_string(arguments, "status");
            match operation.as_str() {
                "spaces.list" => with_store(state, |store| {
                    Ok(json!({
                        "spaces": store.spaces.iter().map(|item| json!({
                            "id": item.id,
                            "name": item.name,
                            "isActive": item.id == store.active_space_id,
                            "updatedAt": item.updated_at
                        })).collect::<Vec<_>>()
                    }))
                }),
                "advisors.list" => {
                    let _ = ensure_store_hydrated_for_advisors(state);
                    with_store(state, |store| {
                        let mut items = store.advisors.clone();
                        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                        Ok(json!({
                            "advisors": items.into_iter().take(limit).map(|item| json!({
                                "id": item.id,
                                "name": item.name,
                                "personality": item.personality,
                                "knowledgeLanguage": item.knowledge_language,
                                "knowledgeFileCount": item.knowledge_files.len(),
                                "updatedAt": item.updated_at
                            })).collect::<Vec<_>>()
                        }))
                    })
                }
                "knowledge.search" => {
                    let _ = ensure_store_hydrated_for_knowledge(state);
                    with_store(state, |store| {
                        let mut hits = Vec::<Value>::new();
                        for note in &store.knowledge_notes {
                            let haystack = format!(
                                "{}\n{}\n{}",
                                note.title,
                                note.content,
                                note.transcript.clone().unwrap_or_default()
                            )
                            .to_lowercase();
                            if haystack.contains(&query) {
                                hits.push(json!({
                                    "kind": "note",
                                    "id": note.id,
                                    "title": note.title,
                                    "snippet": text_snippet(&note.content, 220),
                                    "sourceUrl": note.source_url,
                                }));
                            }
                        }
                        for video in &store.youtube_videos {
                            let haystack = format!(
                                "{}\n{}\n{}\n{}",
                                video.title,
                                video.description,
                                video.summary.clone().unwrap_or_default(),
                                video.subtitle_content.clone().unwrap_or_default()
                            )
                            .to_lowercase();
                            if haystack.contains(&query) {
                                hits.push(json!({
                                    "kind": "youtube",
                                    "id": video.id,
                                    "title": video.title,
                                    "snippet": text_snippet(
                                        &video.summary.clone().unwrap_or_else(|| video.description.clone()),
                                        220
                                    ),
                                    "videoUrl": video.video_url,
                                }));
                            }
                        }
                        for source in &store.document_sources {
                            let haystack = format!(
                                "{}\n{}\n{}",
                                source.name,
                                source.root_path,
                                source.sample_files.join("\n")
                            )
                            .to_lowercase();
                            if haystack.contains(&query) {
                                hits.push(json!({
                                    "kind": "document-source",
                                    "id": source.id,
                                    "title": source.name,
                                    "snippet": text_snippet(&source.sample_files.join(", "), 220),
                                    "rootPath": source.root_path,
                                }));
                            }
                        }
                        Ok(json!({ "results": hits.into_iter().take(limit).collect::<Vec<_>>() }))
                    })
                }
                "work.list" => {
                    let _ = ensure_store_hydrated_for_work(state);
                    with_store(state, |store| {
                        let mut items = store.work_items.clone();
                        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                        Ok(json!({
                            "workItems": items
                                .into_iter()
                                .filter(|item| status_filter.as_ref().map(|status| &item.status == status).unwrap_or(true))
                                .take(limit)
                                .map(|item| json!({
                                    "id": item.id,
                                    "title": item.title,
                                    "status": item.status,
                                    "summary": item.summary,
                                    "type": item.r#type,
                                    "updatedAt": item.updated_at
                                }))
                                .collect::<Vec<_>>()
                        }))
                    })
                }
                "memory.search" => with_store(state, |store| {
                    Ok(json!({
                        "memories": store.memories
                            .iter()
                            .filter(|item| item.content.to_lowercase().contains(&query))
                            .take(limit)
                            .map(|item| json!({
                                "id": item.id,
                                "type": item.r#type,
                                "content": text_snippet(&item.content, 220),
                                "tags": item.tags,
                                "updatedAt": item.updated_at
                            }))
                            .collect::<Vec<_>>()
                    }))
                }),
                "chat.sessions.list" => with_store(state, |store| {
                    let mut items = store.chat_sessions.clone();
                    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    Ok(json!({
                        "sessions": items.into_iter().take(limit).map(|item| json!({
                            "id": item.id,
                            "title": item.title,
                            "updatedAt": item.updated_at
                        })).collect::<Vec<_>>()
                    }))
                }),
                "settings.summary" => with_store(state, |store| {
                    let default_ai_source_id =
                        payload_string(&store.settings, "default_ai_source_id");
                    let model_name = payload_string(&store.settings, "model_name");
                    let api_endpoint = payload_string(&store.settings, "api_endpoint");
                    Ok(json!({
                        "defaultAiSourceId": default_ai_source_id,
                        "modelName": model_name,
                        "apiEndpoint": api_endpoint,
                        "hasApiKey": payload_string(&store.settings, "api_key").map(|value| !value.trim().is_empty()).unwrap_or(false),
                        "hasEmbeddingKey": payload_string(&store.settings, "embedding_key").map(|value| !value.trim().is_empty()).unwrap_or(false),
                        "hasMcpConfig": payload_string(&store.settings, "mcp_servers_json").map(|value| value != "[]" && !value.trim().is_empty()).unwrap_or(false)
                    }))
                }),
                "redclaw.projects.list" => with_store(state, |store| {
                    Ok(json!({
                        "projects": store.redclaw_state.projects.iter().take(limit).map(|item| json!({
                            "id": item.id,
                            "goal": item.goal,
                            "platform": item.platform,
                            "taskType": item.task_type,
                            "status": item.status,
                            "updatedAt": item.updated_at
                        })).collect::<Vec<_>>()
                    }))
                }),
                "redclaw.profile.bundle" => {
                    let bundle = load_redclaw_profile_prompt_bundle(state)?;
                    Ok(json!({
                        "profileRoot": bundle.profile_root.display().to_string(),
                        "docs": {
                            "agent": {
                                "path": bundle.profile_root.join("Agent.md").display().to_string(),
                                "chars": bundle.agent.chars().count(),
                                "preview": text_snippet(&bundle.agent, 240)
                            },
                            "soul": {
                                "path": bundle.profile_root.join("Soul.md").display().to_string(),
                                "chars": bundle.soul.chars().count(),
                                "preview": text_snippet(&bundle.soul, 240)
                            },
                            "user": {
                                "path": bundle.profile_root.join("user.md").display().to_string(),
                                "chars": bundle.user.chars().count(),
                                "preview": text_snippet(&bundle.user, 240)
                            },
                            "creatorProfile": {
                                "path": bundle.profile_root.join("CreatorProfile.md").display().to_string(),
                                "chars": bundle.creator_profile.chars().count(),
                                "preview": text_snippet(&bundle.creator_profile, 240)
                            }
                        },
                        "onboarding": bundle.onboarding_state
                    }))
                }
                "redclaw.profile.onboarding" => {
                    let onboarding_state = load_redclaw_onboarding_state(state)?;
                    Ok(json!({
                        "completed": onboarding_state
                            .get("completedAt")
                            .and_then(|value| value.as_str())
                            .map(|value| !value.trim().is_empty())
                            .unwrap_or(false),
                        "state": onboarding_state
                    }))
                }
                _ => Err(format!("unsupported app query operation: {operation}")),
            }
        }
        "redbox_profile_doc" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            match action.as_str() {
                "bundle" => {
                    let bundle = load_redclaw_profile_prompt_bundle(state)?;
                    Ok(json!({
                        "profileRoot": bundle.profile_root.display().to_string(),
                        "agent": bundle.agent,
                        "soul": bundle.soul,
                        "identity": bundle.identity,
                        "user": bundle.user,
                        "creatorProfile": bundle.creator_profile,
                        "bootstrap": bundle.bootstrap,
                        "onboardingState": bundle.onboarding_state
                    }))
                }
                "read" => {
                    let doc_type =
                        payload_string(arguments, "docType").unwrap_or_else(|| "user".to_string());
                    let Some((file_name, _title)) = profile_doc_target(&doc_type) else {
                        return Err(format!("unsupported profile doc type: {doc_type}"));
                    };
                    let bundle = load_redclaw_profile_prompt_bundle(state)?;
                    let content = match doc_type.as_str() {
                        "agent" => bundle.agent,
                        "soul" => bundle.soul,
                        "user" => bundle.user,
                        "creator_profile" => bundle.creator_profile,
                        _ => String::new(),
                    };
                    Ok(json!({
                        "docType": doc_type,
                        "fileName": file_name,
                        "path": bundle.profile_root.join(file_name).display().to_string(),
                        "content": content
                    }))
                }
                "update" => {
                    let doc_type = payload_string(arguments, "docType")
                        .ok_or_else(|| "docType is required for update".to_string())?;
                    let markdown = payload_string(arguments, "markdown")
                        .ok_or_else(|| "markdown is required for update".to_string())?;
                    let reason = payload_string(arguments, "reason");
                    let mut result = update_redclaw_profile_doc(state, &doc_type, &markdown)?;
                    if let Some(reason_text) = reason {
                        if let Some(object) = result.as_object_mut() {
                            object.insert("reason".to_string(), json!(reason_text));
                        }
                    }
                    Ok(result)
                }
                _ => Err(format!("unsupported redbox_profile_doc action: {action}")),
            }
        }
        "redbox_fs" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            let raw_path = payload_string(arguments, "path").unwrap_or_default();
            match action.as_str() {
                "list" => {
                    let limit = parse_usize_arg(arguments, "limit", 20, 50);
                    let resolved = resolve_workspace_tool_path(state, &raw_path)?;
                    if !resolved.is_dir() {
                        return Err(format!("not a directory: {}", resolved.display()));
                    }
                    Ok(json!({
                        "path": resolved.display().to_string(),
                        "entries": list_directory_entries(&resolved, limit)?
                    }))
                }
                "read" => {
                    let max_chars = parse_usize_arg(arguments, "maxChars", 4000, 20000);
                    let resolved = resolve_workspace_tool_path(state, &raw_path)?;
                    if !resolved.is_file() {
                        return Err(format!("not a file: {}", resolved.display()));
                    }
                    let content =
                        fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
                    Ok(json!({
                        "path": resolved.display().to_string(),
                        "content": truncate_chars(&content, max_chars)
                    }))
                }
                _ => Err(format!("unsupported fs action: {action}")),
            }
        }
        other => Err(format!("unsupported interactive tool: {other}")),
    }
}

fn editor_session_prompt_context(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
) -> String {
    if !matches!(runtime_mode, "video-editor" | "audio-editor") {
        return String::new();
    }
    let Some(session_id) = session_id else {
        return String::new();
    };
    let metadata = with_store(state, |store| {
        Ok(store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|session| session.metadata.clone()))
    })
    .ok()
    .flatten();
    let Some(metadata) = metadata else {
        return String::new();
    };
    let file_path = payload_string(&metadata, "associatedFilePath")
        .or_else(|| payload_string(&metadata, "contextId"))
        .unwrap_or_default();
    let title = payload_string(&metadata, "associatedPackageTitle").unwrap_or_default();
    let package_kind = payload_string(&metadata, "associatedPackageKind").unwrap_or_default();
    let clips = metadata
        .get("associatedPackageClips")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let track_names = metadata
        .get("associatedPackageTrackNames")
        .cloned()
        .unwrap_or_else(|| json!([]));
    format!(
        "\n\n## 当前剪辑工程上下文\n\
runtime_mode: {runtime_mode}\n\
filePath: {file_path}\n\
title: {title}\n\
packageKind: {package_kind}\n\
trackNames: {}\n\
clips: {}\n\
\n\
工具规则：使用 `redbox_editor` 读取和修改当前工程。先调用 action=timeline_read 获取完整时间线；再按需使用 clip_add / clip_update / clip_delete / clip_split / track_add / remotion_generate / remotion_save / export。修改时间线后，最终回答要简要说明改动。",
        serde_json::to_string(&track_names).unwrap_or_else(|_| "[]".to_string()),
        serde_json::to_string(&clips).unwrap_or_else(|_| "[]".to_string()),
    )
}

#[derive(Default)]
struct StreamingToolDelta {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct StreamingChatCompletion {
    content: String,
    tool_calls: Vec<InteractiveToolCall>,
}

fn interactive_runtime_message_bundle(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    message: &str,
) -> Result<(String, Vec<Value>), String> {
    let mut system_prompt = interactive_runtime_system_prompt(state, runtime_mode);
    system_prompt.push_str(&editor_session_prompt_context(
        state,
        session_id,
        runtime_mode,
    ));
    let mut messages = with_store(state, |store| {
        Ok(collect_recent_chat_messages(&store, session_id, 10))
    })?;
    messages.push(json!({
        "role": "user",
        "content": message
    }));
    Ok((system_prompt, messages))
}

fn anthropic_tools_for_runtime_mode(runtime_mode: &str) -> Vec<Value> {
    interactive_runtime_tools_for_mode(runtime_mode)
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|schema| {
            let function = schema.get("function")?;
            Some(json!({
                "name": function.get("name").and_then(|value| value.as_str()).unwrap_or("tool"),
                "description": function.get("description").and_then(|value| value.as_str()).unwrap_or(""),
                "input_schema": function.get("parameters").cloned().unwrap_or_else(|| json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                })),
            }))
        })
        .collect()
}

fn gemini_tools_for_runtime_mode(runtime_mode: &str) -> Vec<Value> {
    let declarations = interactive_runtime_tools_for_mode(runtime_mode)
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|schema| schema.get("function").cloned())
        .collect::<Vec<_>>();
    if declarations.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "functionDeclarations": declarations
        })]
    }
}

fn run_openai_streaming_chat_completion(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
    config: &ResolvedChatConfig,
    body: &Value,
    max_time_seconds: Option<u64>,
) -> Result<StreamingChatCompletion, String> {
    let mut child = spawn_curl_json_process(
        "POST",
        &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
        config.api_key.as_deref(),
        &[],
        Some(body),
        max_time_seconds,
        true,
    )?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "streaming curl stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "streaming curl stderr unavailable".to_string())?;
    let child = Arc::new(Mutex::new(child));

    if let Some(session_id) = session_id {
        if let Ok(mut guard) = state.active_chat_requests.lock() {
            guard.insert(session_id.to_string(), Arc::clone(&child));
        }
    }

    let stderr_handle = std::thread::spawn(move || {
        let mut stderr_text = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut stderr_text);
        stderr_text
    });

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut event_data_lines = Vec::<String>::new();
    let mut result = StreamingChatCompletion::default();
    let mut tool_deltas = Vec::<StreamingToolDelta>::new();
    let mut saw_tool_calls = false;
    let mut responding_started = false;
    let mut thought_closed = false;

    let finalize_thought_phase = |app: &AppHandle, session_id: &str| {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(session_id),
            "chat.thought_end",
            "thought stream completed",
            None,
        );
    };

    let mut process_event = |data: &str| -> Result<bool, String> {
        let trimmed = data.trim();
        if trimmed.is_empty() {
            return Ok(false);
        }
        if trimmed == "[DONE]" {
            return Ok(true);
        }
        let payload = serde_json::from_str::<Value>(trimmed)
            .map_err(|error| format!("Invalid SSE JSON: {error}"))?;
        let choice = payload
            .get("choices")
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let delta = choice
            .get("delta")
            .cloned()
            .or_else(|| choice.get("message").cloned())
            .unwrap_or_else(|| json!({}));

        if let Some(items) = delta.get("tool_calls").and_then(|value| value.as_array()) {
            saw_tool_calls = true;
            for item in items {
                let index = item
                    .get("index")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(tool_deltas.len() as u64) as usize;
                while tool_deltas.len() <= index {
                    tool_deltas.push(StreamingToolDelta::default());
                }
                let entry = &mut tool_deltas[index];
                if let Some(id) = item.get("id").and_then(|value| value.as_str()) {
                    entry.id = id.to_string();
                }
                if let Some(function) = item.get("function") {
                    if let Some(name_piece) = function.get("name").and_then(|value| value.as_str())
                    {
                        entry.name.push_str(name_piece);
                    }
                    if let Some(arguments_piece) =
                        function.get("arguments").and_then(|value| value.as_str())
                    {
                        entry.arguments.push_str(arguments_piece);
                    }
                }
            }
        }

        if let Some(content_piece) = delta.get("content").and_then(|value| value.as_str()) {
            if !content_piece.is_empty() {
                result.content.push_str(content_piece);
                if let Some(session_id) = session_id {
                    let _ = commands::chat_state::update_chat_runtime_state(
                        state,
                        session_id,
                        true,
                        result.content.clone(),
                        None,
                    );
                }
                if !saw_tool_calls {
                    if let Some(session_id) = session_id {
                        if !thought_closed {
                            finalize_thought_phase(app, session_id);
                            thought_closed = true;
                        }
                        if !responding_started {
                            emit_runtime_stream_start(
                                app,
                                session_id,
                                "responding",
                                Some(runtime_mode),
                            );
                            responding_started = true;
                        }
                        emit_runtime_text_delta(app, session_id, "response", content_piece);
                    }
                }
            }
        }
        Ok(false)
    };

    loop {
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            if let Ok(mut child_guard) = child.lock() {
                let _ = child_guard.kill();
            }
        }
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            if !event_data_lines.is_empty() {
                let should_stop = process_event(&event_data_lines.join("\n"))?;
                event_data_lines.clear();
                if should_stop {
                    break;
                }
            }
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if !event_data_lines.is_empty() {
                let should_stop = process_event(&event_data_lines.join("\n"))?;
                event_data_lines.clear();
                if should_stop {
                    break;
                }
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("data:") {
            event_data_lines.push(value.trim().to_string());
        }
    }

    if let Some(session_id) = session_id {
        if let Ok(mut guard) = state.active_chat_requests.lock() {
            guard.remove(session_id);
        }
    }

    let status = {
        let mut child_guard = child
            .lock()
            .map_err(|_| "streaming curl child lock 已损坏".to_string())?;
        child_guard.wait().map_err(|error| error.to_string())?
    };
    let stderr_text = stderr_handle.join().unwrap_or_default().trim().to_string();

    if session_id
        .map(|value| is_chat_runtime_cancel_requested(state, value))
        .unwrap_or(false)
    {
        return Err("chat generation cancelled".to_string());
    }

    if !status.success() {
        return Err(if stderr_text.is_empty() {
            format!("curl failed with status {status}")
        } else {
            stderr_text
        });
    }

    if saw_tool_calls && !thought_closed {
        if let Some(session_id) = session_id {
            if !result.content.trim().is_empty() {
                emit_runtime_text_delta(app, session_id, "thought", &result.content);
            }
            finalize_thought_phase(app, session_id);
        }
    }

    result.tool_calls = tool_deltas
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if item.name.trim().is_empty() {
                return None;
            }
            let tool_name = item.name.clone();
            let raw_arguments = item.arguments.trim().to_string();
            let parsed_arguments =
                serde_json::from_str::<Value>(&raw_arguments).unwrap_or_else(|_| json!({}));
            let call_id = if item.id.trim().is_empty() {
                format!("call-{}-{}", session_id.unwrap_or(runtime_mode), index + 1)
            } else {
                item.id
            };
            Some(InteractiveToolCall {
                id: call_id.clone(),
                name: tool_name.clone(),
                arguments: parsed_arguments,
                raw: json!({
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": raw_arguments,
                    }
                }),
            })
        })
        .collect::<Vec<_>>();

    Ok(result)
}

fn run_anthropic_interactive_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    runtime_mode: &str,
) -> Result<String, String> {
    use std::process::Stdio;

    let (system_prompt, openai_messages) =
        interactive_runtime_message_bundle(state, session_id, runtime_mode, message)?;
    let mut messages = openai_messages
        .into_iter()
        .map(|item| {
            json!({
                "role": item.get("role").and_then(|value| value.as_str()).unwrap_or("user"),
                "content": item.get("content").and_then(|value| value.as_str()).unwrap_or("").to_string()
            })
        })
        .collect::<Vec<_>>();
    let tools = anthropic_tools_for_runtime_mode(runtime_mode);
    let is_wander = runtime_mode == "wander";
    let max_turns = if is_wander { 2 } else { 6 };
    let trace_id = session_id.unwrap_or(runtime_mode);
    if let Some(current_session_id) = session_id {
        emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
    }

    for turn in 0..max_turns {
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err("chat generation cancelled".to_string());
        }
        let turn_started_at = now_ms();
        append_debug_log_state(
            state,
            format!(
                "[timing][anthropic-runtime][{}] turn-{}-request elapsed=0ms",
                trace_id,
                turn + 1
            ),
        );

        let mut body = json!({
            "model": config.model_name,
            "system": system_prompt,
            "messages": messages,
            "max_tokens": if is_wander { 900 } else { 2048 },
            "stream": true
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools.clone());
            if is_wander && turn == 0 {
                body["tool_choice"] = json!({ "type": "any" });
            }
        }

        let mut command = std::process::Command::new("curl");
        command
            .arg("-sS")
            .arg("-N")
            .arg("-X")
            .arg("POST")
            .arg(format!("{}/messages", normalize_base_url(&config.base_url)))
            .arg("--max-time")
            .arg(if is_wander { "45" } else { "90" })
            .arg("-H")
            .arg("Content-Type: application/json")
            .arg("-H")
            .arg(format!(
                "x-api-key: {}",
                config.api_key.clone().unwrap_or_default()
            ))
            .arg("-H")
            .arg("anthropic-version: 2023-06-01")
            .arg("-d")
            .arg(serde_json::to_string(&body).map_err(|error| error.to_string())?)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "streaming curl stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "streaming curl stderr unavailable".to_string())?;
        let child = Arc::new(Mutex::new(child));
        if let Some(session_id) = session_id {
            if let Ok(mut guard) = state.active_chat_requests.lock() {
                guard.insert(session_id.to_string(), Arc::clone(&child));
            }
        }
        let stderr_handle = std::thread::spawn(move || {
            let mut stderr_text = String::new();
            let mut reader = BufReader::new(stderr);
            let _ = reader.read_to_string(&mut stderr_text);
            stderr_text
        });

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut event_data_lines = Vec::<String>::new();
        let mut assistant_text = String::new();
        let mut tool_deltas = Vec::<StreamingToolDelta>::new();
        let mut saw_tool_calls = false;
        let mut responding_started = false;

        loop {
            if session_id
                .map(|value| is_chat_runtime_cancel_requested(state, value))
                .unwrap_or(false)
            {
                if let Ok(mut child_guard) = child.lock() {
                    let _ = child_guard.kill();
                }
            }

            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                if event_data_lines.is_empty() {
                    continue;
                }
                let data = event_data_lines.join("\n");
                event_data_lines.clear();
                let payload = serde_json::from_str::<Value>(data.trim())
                    .map_err(|error| format!("Invalid Anthropic SSE JSON: {error}"))?;
                let event_type = payload
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if event_type == "message_stop" {
                    break;
                }
                if event_type == "content_block_start" {
                    let index = payload
                        .get("index")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(tool_deltas.len() as u64)
                        as usize;
                    if let Some(content_block) = payload.get("content_block") {
                        if content_block.get("type").and_then(|value| value.as_str())
                            == Some("tool_use")
                        {
                            saw_tool_calls = true;
                            while tool_deltas.len() <= index {
                                tool_deltas.push(StreamingToolDelta::default());
                            }
                            let entry = &mut tool_deltas[index];
                            entry.id = content_block
                                .get("id")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string();
                            entry.name = content_block
                                .get("name")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string();
                            if let Some(input) = content_block.get("input") {
                                entry.arguments = input.to_string();
                            }
                        }
                    }
                    continue;
                }
                if event_type == "content_block_delta" {
                    let index = payload
                        .get("index")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(0) as usize;
                    if let Some(delta) = payload.get("delta") {
                        match delta
                            .get("type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                        {
                            "text_delta" => {
                                let content_piece = delta
                                    .get("text")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if !content_piece.is_empty() {
                                    assistant_text.push_str(content_piece);
                                    if let Some(session_id) = session_id {
                                        let _ = commands::chat_state::update_chat_runtime_state(
                                            state,
                                            session_id,
                                            true,
                                            assistant_text.clone(),
                                            None,
                                        );
                                        if !saw_tool_calls {
                                            emit_runtime_task_checkpoint_saved(
                                                app,
                                                None,
                                                Some(session_id),
                                                "chat.thought_end",
                                                "thought stream completed",
                                                None,
                                            );
                                            if !responding_started {
                                                emit_runtime_stream_start(
                                                    app,
                                                    session_id,
                                                    "responding",
                                                    Some(runtime_mode),
                                                );
                                                responding_started = true;
                                            }
                                            emit_runtime_text_delta(
                                                app,
                                                session_id,
                                                "response",
                                                content_piece,
                                            );
                                        }
                                    }
                                }
                            }
                            "input_json_delta" => {
                                saw_tool_calls = true;
                                while tool_deltas.len() <= index {
                                    tool_deltas.push(StreamingToolDelta::default());
                                }
                                let partial = delta
                                    .get("partial_json")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                tool_deltas[index].arguments.push_str(partial);
                            }
                            _ => {}
                        }
                    }
                }
                continue;
            }
            if let Some(value) = trimmed.strip_prefix("data:") {
                event_data_lines.push(value.trim().to_string());
            }
        }

        if let Some(session_id) = session_id {
            if let Ok(mut guard) = state.active_chat_requests.lock() {
                guard.remove(session_id);
            }
        }
        let status = {
            let mut child_guard = child
                .lock()
                .map_err(|_| "streaming curl child lock 已损坏".to_string())?;
            child_guard.wait().map_err(|error| error.to_string())?
        };
        let stderr_text = stderr_handle.join().unwrap_or_default().trim().to_string();
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err("chat generation cancelled".to_string());
        }
        if !status.success() {
            return Err(if stderr_text.is_empty() {
                format!("curl failed with status {status}")
            } else {
                stderr_text
            });
        }

        let tool_calls = tool_deltas
            .into_iter()
            .enumerate()
            .filter_map(|(index, item)| {
                if item.name.trim().is_empty() {
                    return None;
                }
                let raw_arguments = item.arguments.trim().to_string();
                let parsed_arguments =
                    serde_json::from_str::<Value>(&raw_arguments).unwrap_or_else(|_| json!({}));
                let call_id = if item.id.trim().is_empty() {
                    format!("call-{}-{}", session_id.unwrap_or(runtime_mode), index + 1)
                } else {
                    item.id
                };
                Some(InteractiveToolCall {
                    id: call_id.clone(),
                    name: item.name.clone(),
                    arguments: parsed_arguments,
                    raw: json!({
                        "id": call_id,
                        "type": "tool_use",
                        "name": item.name,
                        "input": raw_arguments,
                    }),
                })
            })
            .collect::<Vec<_>>();

        append_debug_log_state(
            state,
            format!(
                "[timing][anthropic-runtime][{}] turn-{}-response elapsed={}ms",
                trace_id,
                turn + 1,
                now_ms().saturating_sub(turn_started_at)
            ),
        );

        if tool_calls.is_empty() {
            if assistant_text.trim().is_empty() {
                return Err("interactive runtime returned an empty final response".to_string());
            }
            if let Some(current_session_id) = session_id {
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(current_session_id),
                    "chat.response_end",
                    "chat response completed",
                    Some(json!({ "content": assistant_text })),
                );
            }
            return Ok(assistant_text);
        }

        if !assistant_text.trim().is_empty() {
            emit_runtime_text_delta(
                app,
                session_id.unwrap_or_default(),
                "thought",
                &assistant_text,
            );
        }
        if let Some(current_session_id) = session_id {
            emit_runtime_task_checkpoint_saved(
                app,
                None,
                Some(current_session_id),
                "chat.thought_end",
                "thought stream completed",
                None,
            );
        }

        let mut assistant_blocks = Vec::<Value>::new();
        if !assistant_text.trim().is_empty() {
            assistant_blocks.push(json!({
                "type": "text",
                "text": assistant_text
            }));
        }
        for call in &tool_calls {
            assistant_blocks.push(json!({
                "type": "tool_use",
                "id": call.id,
                "name": call.name,
                "input": call.arguments
            }));
        }
        messages.push(json!({
            "role": "assistant",
            "content": assistant_blocks
        }));

        for call in tool_calls {
            let description = format!("Interactive tool call: {}", call.name);
            emit_runtime_tool_request(
                app,
                session_id,
                &call.id,
                &call.name,
                call.arguments.clone(),
                Some(&description),
            );
            let tool_started_at = now_ms();
            let result = execute_interactive_tool_call(
                app,
                state,
                runtime_mode,
                session_id,
                &call.name,
                &call.arguments,
            );
            match result {
                Ok(result_value) => {
                    let raw_result_text = serde_json::to_string_pretty(&result_value)
                        .unwrap_or_else(|_| result_value.to_string());
                    let (result_text, result_truncated) = tools::guards::apply_output_budget(
                        runtime_mode,
                        &call.name,
                        &raw_result_text,
                    );
                    let partial = text_snippet(&result_text, 1200);
                    emit_runtime_tool_partial(app, session_id, &call.id, &call.name, &partial);
                    emit_runtime_tool_result(
                        app,
                        session_id,
                        &call.id,
                        &call.name,
                        true,
                        &result_text,
                    );
                    messages.push(json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": call.id,
                            "content": result_text
                        }]
                    }));
                    if let Some(session_id) = session_id {
                        let _ = with_store_mut(state, |store| {
                            store.session_tool_results.push(SessionToolResultRecord {
                                id: make_id("tool-result"),
                                session_id: session_id.to_string(),
                                call_id: call.id.clone(),
                                tool_name: call.name.clone(),
                                command: None,
                                success: true,
                                result_text: Some(result_text.clone()),
                                summary_text: Some(partial),
                                prompt_text: None,
                                original_chars: Some(raw_result_text.chars().count() as i64),
                                prompt_chars: Some(result_text.chars().count() as i64),
                                truncated: result_truncated,
                                payload: Some(result_value),
                                created_at: now_i64(),
                                updated_at: now_i64(),
                            });
                            Ok(())
                        });
                    }
                }
                Err(error) => {
                    emit_runtime_tool_result(app, session_id, &call.id, &call.name, false, &error);
                    messages.push(json!({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": call.id,
                            "content": error.clone(),
                            "is_error": true
                        }]
                    }));
                }
            }
            append_debug_log_state(
                state,
                format!(
                    "[timing][anthropic-runtime][{}] turn-{}-tool-{} elapsed={}ms",
                    trace_id,
                    turn + 1,
                    call.name,
                    now_ms().saturating_sub(tool_started_at)
                ),
            );
        }
    }

    Err("interactive runtime exceeded max turns".to_string())
}

fn run_gemini_interactive_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    runtime_mode: &str,
) -> Result<String, String> {
    use std::process::Stdio;

    let (system_prompt, openai_messages) =
        interactive_runtime_message_bundle(state, session_id, runtime_mode, message)?;
    let mut contents = openai_messages
        .into_iter()
        .filter_map(|item| {
            let role = item
                .get("role")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let text = item
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                return None;
            }
            Some(json!({
                "role": if role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": text }]
            }))
        })
        .collect::<Vec<_>>();
    let tools = gemini_tools_for_runtime_mode(runtime_mode);
    let is_wander = runtime_mode == "wander";
    let max_turns = if is_wander { 2 } else { 6 };
    let trace_id = session_id.unwrap_or(runtime_mode);
    if let Some(current_session_id) = session_id {
        emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
    }

    for turn in 0..max_turns {
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err("chat generation cancelled".to_string());
        }
        let turn_started_at = now_ms();
        append_debug_log_state(
            state,
            format!(
                "[timing][gemini-runtime][{}] turn-{}-request elapsed=0ms",
                trace_id,
                turn + 1
            ),
        );

        let mut body = json!({
            "system_instruction": {
                "parts": [{ "text": system_prompt }]
            },
            "contents": contents
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools.clone());
            if is_wander && turn == 0 {
                body["toolConfig"] = json!({
                    "functionCallingConfig": { "mode": "ANY" }
                });
            }
        }

        let mut endpoint = gemini_url(
            &config.base_url,
            &format!("/models/{}:streamGenerateContent", config.model_name),
            config.api_key.as_deref(),
        );
        if endpoint.contains('?') {
            endpoint.push_str("&alt=sse");
        } else {
            endpoint.push_str("?alt=sse");
        }
        let mut command = std::process::Command::new("curl");
        command
            .arg("-sS")
            .arg("-N")
            .arg("-X")
            .arg("POST")
            .arg(endpoint)
            .arg("--max-time")
            .arg(if is_wander { "45" } else { "90" })
            .arg("-H")
            .arg("Content-Type: application/json")
            .arg("-d")
            .arg(serde_json::to_string(&body).map_err(|error| error.to_string())?)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "streaming curl stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "streaming curl stderr unavailable".to_string())?;
        let child = Arc::new(Mutex::new(child));
        if let Some(session_id) = session_id {
            if let Ok(mut guard) = state.active_chat_requests.lock() {
                guard.insert(session_id.to_string(), Arc::clone(&child));
            }
        }
        let stderr_handle = std::thread::spawn(move || {
            let mut stderr_text = String::new();
            let mut reader = BufReader::new(stderr);
            let _ = reader.read_to_string(&mut stderr_text);
            stderr_text
        });

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut event_data_lines = Vec::<String>::new();
        let mut assistant_text = String::new();
        let mut tool_calls = Vec::<InteractiveToolCall>::new();
        let mut saw_tool_calls = false;
        let mut responding_started = false;

        loop {
            if session_id
                .map(|value| is_chat_runtime_cancel_requested(state, value))
                .unwrap_or(false)
            {
                if let Ok(mut child_guard) = child.lock() {
                    let _ = child_guard.kill();
                }
            }

            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                if event_data_lines.is_empty() {
                    continue;
                }
                let data = event_data_lines.join("\n");
                event_data_lines.clear();
                let trimmed_data = data.trim();
                if trimmed_data == "[DONE]" {
                    break;
                }
                let payload = serde_json::from_str::<Value>(trimmed_data)
                    .map_err(|error| format!("Invalid Gemini SSE JSON: {error}"))?;
                if let Some(parts) = payload
                    .get("candidates")
                    .and_then(|value| value.as_array())
                    .and_then(|items| items.first())
                    .and_then(|candidate| candidate.get("content"))
                    .and_then(|content| content.get("parts"))
                    .and_then(|value| value.as_array())
                {
                    for part in parts {
                        if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                            if !text.is_empty() {
                                assistant_text.push_str(text);
                                if let Some(session_id) = session_id {
                                    let _ = commands::chat_state::update_chat_runtime_state(
                                        state,
                                        session_id,
                                        true,
                                        assistant_text.clone(),
                                        None,
                                    );
                                    if !saw_tool_calls {
                                        emit_runtime_task_checkpoint_saved(
                                            app,
                                            None,
                                            Some(session_id),
                                            "chat.thought_end",
                                            "thought stream completed",
                                            None,
                                        );
                                        if !responding_started {
                                            emit_runtime_stream_start(
                                                app,
                                                session_id,
                                                "responding",
                                                Some(runtime_mode),
                                            );
                                            responding_started = true;
                                        }
                                        emit_runtime_text_delta(app, session_id, "response", text);
                                    }
                                }
                            }
                        }
                        if let Some(function_call) = part.get("functionCall") {
                            saw_tool_calls = true;
                            let name = function_call
                                .get("name")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string();
                            if name.trim().is_empty() {
                                continue;
                            }
                            let call_id = function_call
                                .get("id")
                                .and_then(|value| value.as_str())
                                .filter(|value| !value.trim().is_empty())
                                .map(ToString::to_string)
                                .unwrap_or_else(|| {
                                    format!(
                                        "call-{}-{}",
                                        session_id.unwrap_or(runtime_mode),
                                        tool_calls.len() + 1
                                    )
                                });
                            let args = function_call
                                .get("args")
                                .cloned()
                                .unwrap_or_else(|| json!({}));
                            if !tool_calls.iter().any(|item| item.id == call_id) {
                                tool_calls.push(InteractiveToolCall {
                                    id: call_id.clone(),
                                    name: name.clone(),
                                    arguments: args.clone(),
                                    raw: json!({
                                        "id": call_id,
                                        "functionCall": {
                                            "id": function_call.get("id").cloned().unwrap_or(Value::Null),
                                            "name": name,
                                            "args": args
                                        }
                                    }),
                                });
                            }
                        }
                    }
                }
                continue;
            }
            if let Some(value) = trimmed.strip_prefix("data:") {
                event_data_lines.push(value.trim().to_string());
            }
        }

        if let Some(session_id) = session_id {
            if let Ok(mut guard) = state.active_chat_requests.lock() {
                guard.remove(session_id);
            }
        }
        let status = {
            let mut child_guard = child
                .lock()
                .map_err(|_| "streaming curl child lock 已损坏".to_string())?;
            child_guard.wait().map_err(|error| error.to_string())?
        };
        let stderr_text = stderr_handle.join().unwrap_or_default().trim().to_string();
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err("chat generation cancelled".to_string());
        }
        if !status.success() {
            return Err(if stderr_text.is_empty() {
                format!("curl failed with status {status}")
            } else {
                stderr_text
            });
        }

        append_debug_log_state(
            state,
            format!(
                "[timing][gemini-runtime][{}] turn-{}-response elapsed={}ms",
                trace_id,
                turn + 1,
                now_ms().saturating_sub(turn_started_at)
            ),
        );

        if tool_calls.is_empty() {
            if assistant_text.trim().is_empty() {
                return Err("interactive runtime returned an empty final response".to_string());
            }
            if let Some(current_session_id) = session_id {
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(current_session_id),
                    "chat.response_end",
                    "chat response completed",
                    Some(json!({ "content": assistant_text })),
                );
            }
            return Ok(assistant_text);
        }

        if !assistant_text.trim().is_empty() {
            emit_runtime_text_delta(
                app,
                session_id.unwrap_or_default(),
                "thought",
                &assistant_text,
            );
        }
        if let Some(current_session_id) = session_id {
            emit_runtime_task_checkpoint_saved(
                app,
                None,
                Some(current_session_id),
                "chat.thought_end",
                "thought stream completed",
                None,
            );
        }

        let mut assistant_parts = Vec::<Value>::new();
        if !assistant_text.trim().is_empty() {
            assistant_parts.push(json!({ "text": assistant_text }));
        }
        for call in &tool_calls {
            assistant_parts.push(json!({
                "functionCall": {
                    "id": call.id,
                    "name": call.name,
                    "args": call.arguments
                }
            }));
        }
        contents.push(json!({
            "role": "model",
            "parts": assistant_parts
        }));

        let mut response_parts = Vec::<Value>::new();
        for call in tool_calls {
            let description = format!("Interactive tool call: {}", call.name);
            emit_runtime_tool_request(
                app,
                session_id,
                &call.id,
                &call.name,
                call.arguments.clone(),
                Some(&description),
            );
            let tool_started_at = now_ms();
            let result = execute_interactive_tool_call(
                app,
                state,
                runtime_mode,
                session_id,
                &call.name,
                &call.arguments,
            );
            match result {
                Ok(result_value) => {
                    let raw_result_text = serde_json::to_string_pretty(&result_value)
                        .unwrap_or_else(|_| result_value.to_string());
                    let (result_text, result_truncated) = tools::guards::apply_output_budget(
                        runtime_mode,
                        &call.name,
                        &raw_result_text,
                    );
                    let partial = text_snippet(&result_text, 1200);
                    emit_runtime_tool_partial(app, session_id, &call.id, &call.name, &partial);
                    emit_runtime_tool_result(
                        app,
                        session_id,
                        &call.id,
                        &call.name,
                        true,
                        &result_text,
                    );
                    response_parts.push(json!({
                        "functionResponse": {
                            "id": call.id,
                            "name": call.name,
                            "response": if result_value.is_object() { result_value.clone() } else { json!({ "result": result_value }) }
                        }
                    }));
                    if let Some(session_id) = session_id {
                        let _ = with_store_mut(state, |store| {
                            store.session_tool_results.push(SessionToolResultRecord {
                                id: make_id("tool-result"),
                                session_id: session_id.to_string(),
                                call_id: call.id.clone(),
                                tool_name: call.name.clone(),
                                command: None,
                                success: true,
                                result_text: Some(result_text.clone()),
                                summary_text: Some(partial),
                                prompt_text: None,
                                original_chars: Some(raw_result_text.chars().count() as i64),
                                prompt_chars: Some(result_text.chars().count() as i64),
                                truncated: result_truncated,
                                payload: Some(result_value),
                                created_at: now_i64(),
                                updated_at: now_i64(),
                            });
                            Ok(())
                        });
                    }
                }
                Err(error) => {
                    emit_runtime_tool_result(app, session_id, &call.id, &call.name, false, &error);
                    response_parts.push(json!({
                        "functionResponse": {
                            "id": call.id,
                            "name": call.name,
                            "response": { "error": error }
                        }
                    }));
                }
            }
            append_debug_log_state(
                state,
                format!(
                    "[timing][gemini-runtime][{}] turn-{}-tool-{} elapsed={}ms",
                    trace_id,
                    turn + 1,
                    call.name,
                    now_ms().saturating_sub(tool_started_at)
                ),
            );
        }
        contents.push(json!({
            "role": "user",
            "parts": response_parts
        }));
    }

    Err("interactive runtime exceeded max turns".to_string())
}

fn run_openai_interactive_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    runtime_mode: &str,
) -> Result<String, String> {
    let mut system_prompt = interactive_runtime_system_prompt(state, runtime_mode);
    system_prompt.push_str(&editor_session_prompt_context(
        state,
        session_id,
        runtime_mode,
    ));
    let mut messages = with_store(state, |store| {
        Ok(collect_recent_chat_messages(&store, session_id, 10))
    })?;
    messages.insert(
        0,
        json!({
            "role": "system",
            "content": system_prompt
        }),
    );
    messages.push(json!({
        "role": "user",
        "content": message
    }));

    let is_wander = runtime_mode == "wander";
    let max_turns = if is_wander { 2 } else { 6 };
    let lower_model_hint = format!("{} {}", config.model_name, config.base_url).to_lowercase();
    let disable_qwen_thinking =
        is_wander && (lower_model_hint.contains("qwen") || lower_model_hint.contains("dashscope"));
    let trace_id = session_id.unwrap_or(runtime_mode);
    if let Some(current_session_id) = session_id {
        emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
    }

    for turn in 0..max_turns {
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err("chat generation cancelled".to_string());
        }
        let turn_started_at = now_ms();
        append_debug_log_state(
            state,
            format!(
                "[timing][wander-runtime][{}] turn-{}-request elapsed=0ms | toolChoice={} thinkingDisabled={}",
                trace_id,
                turn + 1,
                if is_wander && turn == 0 { "required" } else { "auto" },
                disable_qwen_thinking
            ),
        );
        let mut body = json!({
            "model": config.model_name,
            "messages": messages,
            "tools": interactive_runtime_tools_for_mode(runtime_mode),
            "tool_choice": if is_wander && turn == 0 { "required" } else { "auto" },
            "stream": !is_wander
        });
        if disable_qwen_thinking {
            body["enable_thinking"] = json!(false);
        }
        if is_wander {
            body["temperature"] = json!(0.4);
            body["max_tokens"] = json!(900);
        }
        let streaming_enabled = !is_wander;
        let (assistant_content, tool_calls) = if streaming_enabled {
            let streamed = run_openai_streaming_chat_completion(
                app,
                state,
                session_id,
                runtime_mode,
                config,
                &body,
                Some(if is_wander { 45 } else { 90 }),
            )?;
            (streamed.content, streamed.tool_calls)
        } else {
            let response = run_curl_json_with_timeout(
                "POST",
                &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
                config.api_key.as_deref(),
                &[],
                Some(body),
                Some(if is_wander { 45 } else { 90 }),
            )?;
            let choice = response
                .get("choices")
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
                .cloned()
                .ok_or_else(|| "interactive runtime returned no choices".to_string())?;
            let assistant_message = choice
                .get("message")
                .cloned()
                .ok_or_else(|| "interactive runtime returned no message".to_string())?;
            let assistant_content = assistant_message
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let tool_calls = assistant_message
                .get("tool_calls")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|raw| {
                    let id = raw.get("id").and_then(|value| value.as_str())?.to_string();
                    let function = raw.get("function")?;
                    let name = function
                        .get("name")
                        .and_then(|value| value.as_str())?
                        .to_string();
                    let arguments = function
                        .get("arguments")
                        .and_then(|value| value.as_str())
                        .and_then(|value| serde_json::from_str::<Value>(value).ok())
                        .unwrap_or_else(|| json!({}));
                    Some(InteractiveToolCall {
                        id,
                        name,
                        arguments,
                        raw,
                    })
                })
                .collect::<Vec<_>>();
            (assistant_content, tool_calls)
        };
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            return Err("chat generation cancelled".to_string());
        }
        append_debug_log_state(
            state,
            format!(
                "[timing][wander-runtime][{}] turn-{}-response elapsed={}ms",
                trace_id,
                turn + 1,
                now_ms().saturating_sub(turn_started_at)
            ),
        );

        if tool_calls.is_empty() {
            if assistant_content.trim().is_empty() {
                return Err("interactive runtime returned an empty final response".to_string());
            }
            if streaming_enabled {
                if let Some(current_session_id) = session_id {
                    let final_content = assistant_content.clone();
                    emit_runtime_task_checkpoint_saved(
                        app,
                        None,
                        Some(current_session_id),
                        "chat.response_end",
                        "chat response completed",
                        Some(json!({ "content": final_content })),
                    );
                }
            }
            return Ok(assistant_content);
        }

        if !assistant_content.trim().is_empty() {
            emit_runtime_text_delta(
                app,
                session_id.unwrap_or_default(),
                "thought",
                &assistant_content,
            );
        }
        messages.push(json!({
            "role": "assistant",
            "content": assistant_content,
            "tool_calls": tool_calls.iter().map(|call| call.raw.clone()).collect::<Vec<_>>()
        }));

        for call in tool_calls {
            let tool_started_at = now_ms();
            let normalized_tool_call =
                tools::compat::normalize_tool_call(&call.name, &call.arguments);
            let effective_tool_name = if normalized_tool_call.name.is_empty() {
                call.name.as_str()
            } else {
                normalized_tool_call.name
            };
            let effective_arguments = if normalized_tool_call.name.is_empty() {
                call.arguments.clone()
            } else {
                normalized_tool_call.arguments.clone()
            };
            let description = format!("Interactive tool call: {}", effective_tool_name);
            emit_runtime_tool_request(
                app,
                session_id,
                &call.id,
                effective_tool_name,
                effective_arguments.clone(),
                Some(&description),
            );
            let result = execute_interactive_tool_call(
                app,
                state,
                runtime_mode,
                session_id,
                effective_tool_name,
                &effective_arguments,
            );
            match result {
                Ok(result_value) => {
                    let raw_result_text = serde_json::to_string_pretty(&result_value)
                        .unwrap_or_else(|_| result_value.to_string());
                    let (result_text, result_truncated) = tools::guards::apply_output_budget(
                        runtime_mode,
                        effective_tool_name,
                        &raw_result_text,
                    );
                    let partial = text_snippet(&result_text, 1200);
                    emit_runtime_tool_partial(
                        app,
                        session_id,
                        &call.id,
                        effective_tool_name,
                        &partial,
                    );
                    emit_runtime_tool_result(
                        app,
                        session_id,
                        &call.id,
                        effective_tool_name,
                        true,
                        &result_text,
                    );
                    append_debug_log_state(
                        state,
                        format!(
                            "[timing][wander-runtime][{}] turn-{}-tool-{} elapsed={}ms | success=true",
                            trace_id,
                            turn + 1,
                            effective_tool_name,
                            now_ms().saturating_sub(tool_started_at)
                        ),
                    );
                    with_store_mut(state, |store| {
                        let target_session_id = session_id
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| latest_session_id(store));
                        store.session_tool_results.push(SessionToolResultRecord {
                            id: make_id("tool-result"),
                            session_id: target_session_id.clone(),
                            call_id: call.id.clone(),
                            tool_name: effective_tool_name.to_string(),
                            command: None,
                            success: true,
                            result_text: Some(result_text.clone()),
                            summary_text: Some(format!("{} succeeded", effective_tool_name)),
                            prompt_text: None,
                            original_chars: None,
                            prompt_chars: None,
                            truncated: result_truncated,
                            payload: Some(json!({
                                "arguments": effective_arguments,
                                "requestedToolName": call.name,
                                "result": result_value
                            })),
                            created_at: now_i64(),
                            updated_at: now_i64(),
                        });
                        append_session_transcript(
                            store,
                            &target_session_id,
                            "tool.result",
                            "tool",
                            result_text.clone(),
                            Some(json!({ "callId": call.id, "toolName": effective_tool_name })),
                        );
                        append_session_checkpoint(
                            store,
                            &target_session_id,
                            "tool.call",
                            format!("tool {} completed", effective_tool_name),
                            Some(json!({ "callId": call.id })),
                        );
                        Ok(())
                    })?;
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": result_text
                    }));
                }
                Err(error) => {
                    let failure_text = error.clone();
                    emit_runtime_tool_result(
                        app,
                        session_id,
                        &call.id,
                        effective_tool_name,
                        false,
                        &failure_text,
                    );
                    append_debug_log_state(
                        state,
                        format!(
                            "[timing][wander-runtime][{}] turn-{}-tool-{} elapsed={}ms | success=false",
                            trace_id,
                            turn + 1,
                            effective_tool_name,
                            now_ms().saturating_sub(tool_started_at)
                        ),
                    );
                    with_store_mut(state, |store| {
                        let target_session_id = session_id
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| latest_session_id(store));
                        store.session_tool_results.push(SessionToolResultRecord {
                            id: make_id("tool-result"),
                            session_id: target_session_id.clone(),
                            call_id: call.id.clone(),
                            tool_name: effective_tool_name.to_string(),
                            command: None,
                            success: false,
                            result_text: None,
                            summary_text: Some(failure_text.clone()),
                            prompt_text: None,
                            original_chars: None,
                            prompt_chars: None,
                            truncated: false,
                            payload: Some(json!({
                                "arguments": effective_arguments,
                                "requestedToolName": call.name
                            })),
                            created_at: now_i64(),
                            updated_at: now_i64(),
                        });
                        append_session_transcript(
                            store,
                            &target_session_id,
                            "tool.result",
                            "tool",
                            failure_text.clone(),
                            Some(
                                json!({ "callId": call.id, "toolName": call.name, "success": false }),
                            ),
                        );
                        append_session_checkpoint(
                            store,
                            &target_session_id,
                            "tool.call",
                            format!("tool {} failed", call.name),
                            Some(json!({ "callId": call.id, "error": failure_text })),
                        );
                        Ok(())
                    })?;
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": failure_text
                    }));
                }
            }
        }
    }
    Err(if is_wander {
        "wander interactive runtime exceeded max tool turns".to_string()
    } else {
        "interactive runtime exceeded max tool turns".to_string()
    })
}

fn build_placeholder_assistant_response(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "RedClaw is active inside RedBox.".to_string();
    }
    format!(
        "RedClaw is active inside RedBox。当前未配置可用模型，已返回本地兜底响应。\n\n你刚才输入的是：\n{}",
        trimmed
    )
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    chat_helpers::ensure_parent_dir(path)
}

fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    chat_helpers::write_text_file(path, content)
}

fn wechat_binding_public_value(binding: &WechatOfficialBindingRecord) -> Value {
    chat_helpers::wechat_binding_public_value(binding)
}

fn fetch_wechat_access_token(app_id: &str, secret: &str) -> Result<String, String> {
    chat_helpers::fetch_wechat_access_token(app_id, secret)
}

fn create_wechat_remote_draft(
    access_token: &str,
    title: &str,
    content: &str,
    digest: &str,
    thumb_media_id: &str,
) -> Result<String, String> {
    chat_helpers::create_wechat_remote_draft(access_token, title, content, digest, thumb_media_id)
}

fn extract_cover_source(payload: &Value) -> Option<String> {
    chat_helpers::extract_cover_source(payload)
}

fn materialize_image_source(source: &str, target_dir: &Path) -> Result<PathBuf, String> {
    chat_helpers::materialize_image_source(source, target_dir)
}

fn upload_wechat_thumb_media(access_token: &str, image_path: &Path) -> Result<String, String> {
    chat_helpers::upload_wechat_thumb_media(access_token, image_path)
}

fn generate_response_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    prompt: &str,
) -> String {
    chat_helpers::generate_response_with_settings(settings, model_config, prompt)
}

fn generate_structured_response_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    chat_helpers::generate_structured_response_with_settings(
        settings,
        model_config,
        system_prompt,
        user_prompt,
        require_json,
    )
}

fn find_advisor_name(advisors: &[AdvisorRecord], advisor_id: &str) -> String {
    chat_helpers::find_advisor_name(advisors, advisor_id)
}

fn find_advisor_avatar(advisors: &[AdvisorRecord], advisor_id: &str) -> String {
    chat_helpers::find_advisor_avatar(advisors, advisor_id)
}

fn build_advisor_prompt(
    advisor: Option<&AdvisorRecord>,
    message: &str,
    context: Option<&Value>,
) -> String {
    chat_helpers::build_advisor_prompt(advisor, message, context)
}

fn chatroom_response_phase(index: usize, total: usize) -> String {
    if total <= 1 {
        "discussion".to_string()
    } else if index + 1 == total {
        "summary".to_string()
    } else if index == 0 {
        "introduction".to_string()
    } else {
        "discussion".to_string()
    }
}

fn parse_youtube_channel(url: &str) -> (String, String) {
    let trimmed = url.trim().trim_end_matches('/');
    let slug = trimmed
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("channel");
    let channel_id = slug_from_relative_path(slug);
    let display = slug
        .trim_start_matches('@')
        .replace('-', " ")
        .replace('_', " ");
    let name = if display.trim().is_empty() {
        "YouTube Channel".to_string()
    } else {
        display
    };
    (channel_id, name)
}

fn build_advisor_youtube_channel(existing: Option<&Value>, url: &str, channel_id: &str) -> Value {
    let mut next = existing
        .cloned()
        .unwrap_or_else(|| json!({}))
        .as_object()
        .cloned()
        .unwrap_or_default();
    next.insert("url".to_string(), json!(url));
    next.insert("channelId".to_string(), json!(channel_id));
    next.entry("backgroundEnabled".to_string())
        .or_insert(json!(true));
    next.entry("refreshIntervalMinutes".to_string())
        .or_insert(json!(180));
    next.entry("subtitleDownloadIntervalSeconds".to_string())
        .or_insert(json!(8));
    next.entry("maxVideosPerRefresh".to_string())
        .or_insert(json!(20));
    next.entry("maxDownloadsPerRun".to_string())
        .or_insert(json!(3));
    next.insert("lastRefreshed".to_string(), json!(now_iso()));
    Value::Object(next)
}

fn run_redclaw_scheduler(app: AppHandle, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let state = app.state::<AppState>();
            let now = now_i64();
            let mut scheduled_to_run: Vec<(String, Option<String>, String)> = Vec::new();
            let mut long_to_run: Vec<(String, Option<String>, String)> = Vec::new();
            let mut should_run_maintenance = false;

            if let Ok(store) = state.store.lock() {
                if store.redclaw_state.enabled && store.redclaw_state.is_ticking {
                    for task in &store.redclaw_state.scheduled_tasks {
                        if !task.enabled {
                            continue;
                        }
                        let due =
                            parse_millis_string(task.next_run_at.as_deref()).unwrap_or(0) <= now;
                        if due {
                            scheduled_to_run.push((
                                task.id.clone(),
                                task.project_id.clone(),
                                task.prompt.clone(),
                            ));
                        }
                    }
                    for task in &store.redclaw_state.long_cycle_tasks {
                        if !task.enabled || task.status == "completed" {
                            continue;
                        }
                        let due =
                            parse_millis_string(task.next_run_at.as_deref()).unwrap_or(0) <= now;
                        if due {
                            long_to_run.push((
                                task.id.clone(),
                                task.project_id.clone(),
                                format!(
                                    "目标：{}\n\n当前轮执行指令：{}",
                                    task.objective, task.step_prompt
                                ),
                            ));
                        }
                    }
                    should_run_maintenance =
                        parse_millis_string(store.redclaw_state.next_maintenance_at.as_deref())
                            .unwrap_or(0)
                            <= now;
                }
            }

            for (task_id, project_id, prompt) in scheduled_to_run {
                let _ =
                    execute_redclaw_run(&app, &state, prompt, project_id, "scheduler-scheduled");
                let _ = with_store_mut(&state, |store| {
                    if let Some(task) = store
                        .redclaw_state
                        .scheduled_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    {
                        task.last_run_at = Some(now_iso());
                        task.last_result = Some("success".to_string());
                        task.updated_at = now_iso();
                        task.next_run_at = next_scheduled_timestamp(task, now);
                    }
                    store.redclaw_state.last_tick_at = Some(now.to_string());
                    store.redclaw_state.next_tick_at =
                        Some((now + store.redclaw_state.interval_minutes * 60_000).to_string());
                    sync_redclaw_job_definitions(store);
                    Ok(())
                });
                if let Ok(store) = state.store.lock() {
                    let _ = app.emit(
                        "redclaw:runner-status",
                        redclaw_state_value(&store.redclaw_state),
                    );
                }
            }

            for (task_id, project_id, prompt) in long_to_run {
                let _ =
                    execute_redclaw_run(&app, &state, prompt, project_id, "scheduler-long-cycle");
                let _ = with_store_mut(&state, |store| {
                    if let Some(task) = store
                        .redclaw_state
                        .long_cycle_tasks
                        .iter_mut()
                        .find(|item| item.id == task_id)
                    {
                        task.completed_rounds += 1;
                        task.last_run_at = Some(now_iso());
                        task.last_result = Some("success".to_string());
                        task.updated_at = now_iso();
                        task.next_run_at = next_long_cycle_timestamp(task, now);
                        task.status = if task.completed_rounds >= task.total_rounds {
                            "completed".to_string()
                        } else {
                            "running".to_string()
                        };
                    }
                    store.redclaw_state.last_tick_at = Some(now.to_string());
                    store.redclaw_state.next_tick_at =
                        Some((now + store.redclaw_state.interval_minutes * 60_000).to_string());
                    sync_redclaw_job_definitions(store);
                    Ok(())
                });
                if let Ok(store) = state.store.lock() {
                    let _ = app.emit(
                        "redclaw:runner-status",
                        redclaw_state_value(&store.redclaw_state),
                    );
                }
            }

            if should_run_maintenance {
                let _ = run_memory_maintenance_with_reason(&state, "periodic");
                if let Ok(store) = state.store.lock() {
                    let _ = app.emit(
                        "redclaw:runner-status",
                        redclaw_state_value(&store.redclaw_state),
                    );
                }
            }

            thread::sleep(std::time::Duration::from_millis(1500));
        }
    })
}

fn resolve_local_path(source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("file://") {
        #[cfg(target_os = "windows")]
        let normalized = rest.trim_start_matches('/');
        #[cfg(not(target_os = "windows"))]
        let normalized = rest;
        return Some(PathBuf::from(normalized));
    }
    Some(PathBuf::from(trimmed))
}

fn handle_subject_category_create(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let input: SubjectCategoryMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("分类参数无效: {error}"))?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Ok(json!({ "success": false, "error": "分类名称不能为空" }));
    }

    with_store_mut(state, |store| {
        let timestamp = now_iso();
        let category = SubjectCategory {
            id: make_id("category"),
            name,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        store.categories.push(category.clone());
        Ok(json!({ "success": true, "category": category }))
    })
}

fn handle_subject_category_update(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let input: SubjectCategoryMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("分类参数无效: {error}"))?;
    let Some(id) = input.id else {
        return Ok(json!({ "success": false, "error": "缺少分类 id" }));
    };
    let next_name = input.name.trim().to_string();
    if next_name.is_empty() {
        return Ok(json!({ "success": false, "error": "分类名称不能为空" }));
    }

    with_store_mut(state, |store| {
        let Some(category) = store.categories.iter_mut().find(|item| item.id == id) else {
            return Ok(json!({ "success": false, "error": "分类不存在" }));
        };
        category.name = next_name;
        category.updated_at = now_iso();
        Ok(json!({ "success": true, "category": category.clone() }))
    })
}

fn handle_subject_category_delete(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少分类 id" }));
    };

    with_store_mut(state, |store| {
        if store
            .subjects
            .iter()
            .any(|subject| subject.category_id.as_deref() == Some(id.as_str()))
        {
            return Ok(json!({ "success": false, "error": "仍有主体使用该分类，无法删除" }));
        }
        let before = store.categories.len();
        store.categories.retain(|item| item.id != id);
        if store.categories.len() == before {
            return Ok(json!({ "success": false, "error": "分类不存在" }));
        }
        Ok(json!({ "success": true }))
    })
}

fn handle_subject_create(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let input: SubjectMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("主体参数无效: {error}"))?;
    if input.name.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "主体名称不能为空" }));
    }

    with_store_mut(state, |store| {
        let record = subject_record_from_input(input, None);
        store.subjects.push(record.clone());
        Ok(json!({ "success": true, "subject": record }))
    })
}

fn handle_subject_update(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let input: SubjectMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("主体参数无效: {error}"))?;
    let Some(id) = input.id.clone() else {
        return Ok(json!({ "success": false, "error": "缺少主体 id" }));
    };

    with_store_mut(state, |store| {
        let Some(index) = store.subjects.iter().position(|item| item.id == id) else {
            return Ok(json!({ "success": false, "error": "主体不存在" }));
        };
        let existing = store.subjects.get(index).cloned();
        let record = subject_record_from_input(input, existing);
        store.subjects[index] = record.clone();
        Ok(json!({ "success": true, "subject": record }))
    })
}

fn handle_subject_delete(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少主体 id" }));
    };

    with_store_mut(state, |store| {
        let before = store.subjects.len();
        store.subjects.retain(|item| item.id != id);
        if store.subjects.len() == before {
            return Ok(json!({ "success": false, "error": "主体不存在" }));
        }
        Ok(json!({ "success": true }))
    })
}

fn handle_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    if let Some(result) = commands::system::handle_system_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::official::handle_official_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::wechat_official::handle_wechat_official_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::plugin::handle_plugin_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::spaces::handle_spaces_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::embeddings::handle_embeddings_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::subjects::handle_subjects_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::file_ops::handle_file_ops_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::assistant_daemon::handle_assistant_daemon_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::advisor_ops::handle_advisor_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::chatrooms::handle_chatrooms_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::library::handle_library_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::mcp_tools::handle_mcp_tools_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::skills_ai::handle_skills_ai_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::generation::handle_generation_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::workspace_data::handle_workspace_data_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::manuscripts::handle_manuscripts_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::chat_sessions_wander::handle_chat_sessions_wander_channel(
        app, state, channel, &payload,
    ) {
        return result;
    }
    if let Some(result) = commands::bridge::handle_bridge_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::redclaw::handle_redclaw_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::runtime::handle_runtime_channel(app, state, channel, &payload) {
        return result;
    }
    match channel {
        _ => Err(format!(
            "RedBox host does not recognize channel `{channel}`."
        )),
    }
}

#[tauri::command]
fn ipc_invoke(
    app: AppHandle,
    channel: String,
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    handle_channel(&app, &channel, payload.unwrap_or(Value::Null), &state)
}

#[tauri::command]
fn ipc_send(
    app: AppHandle,
    channel: String,
    payload: Option<Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let payload = payload.unwrap_or(Value::Null);
    if channel == "chat:send-message"
        || channel == "ai:start-chat"
        || channel == "wander:brainstorm"
    {
        let app_handle = app.clone();
        let channel_name = channel.clone();
        let payload_value = payload.clone();
        tauri::async_runtime::spawn(async move {
            let managed_state = app_handle.state::<AppState>();
            if channel_name == "wander:brainstorm" {
                match handle_channel(
                    &app_handle,
                    &channel_name,
                    payload_value.clone(),
                    &managed_state,
                ) {
                    Ok(result) => {
                        let request_id = payload_field(&payload_value, "options")
                            .and_then(|value| payload_field(value, "requestId"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = app_handle.emit(
                            "wander:result",
                            json!({
                                "requestId": request_id,
                                "result": result.get("result").cloned().unwrap_or(Value::Null),
                                "historyId": result.get("historyId").cloned().unwrap_or(Value::Null),
                            }),
                        );
                    }
                    Err(error) => {
                        let request_id = payload_field(&payload_value, "options")
                            .and_then(|value| payload_field(value, "requestId"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = app_handle.emit(
                            "wander:result",
                            json!({
                                "requestId": request_id,
                                "error": error,
                            }),
                        );
                    }
                }
            } else if let Err(error) = commands::chat::handle_send_channel(
                &app_handle,
                &channel_name,
                payload_value.clone(),
                &managed_state,
            ) {
                if error == "chat generation cancelled" {
                    return;
                }
                let session_id = payload_string(&payload_value, "sessionId");
                emit_runtime_task_checkpoint_saved(
                    &app_handle,
                    None,
                    session_id.as_deref(),
                    "chat.error",
                    "chat execution failed",
                    Some(json!({
                        "message": error,
                        "category": "execution",
                        "sessionId": session_id,
                    })),
                );
            }
        });
        Ok(())
    } else {
        commands::chat::handle_send_channel(&app, &channel, payload, &state)
    }
}

fn main() {
    let store_path = build_store_path();
    let mut store = load_store(&store_path);
    if let Err(error) = maybe_import_legacy_store(&mut store, &store_path) {
        eprintln!("[RedBox legacy import] {error}");
    }
    sync_redclaw_job_definitions(&mut store);
    if let Err(error) = persist_store(&store_path, &store) {
        eprintln!("[RedBox store persist] {error}");
    }

    tauri::Builder::default()
        .manage(AppState {
            store_path,
            store: Mutex::new(store),
            chat_runtime_states: Mutex::new(std::collections::HashMap::new()),
            active_chat_requests: Mutex::new(HashMap::new()),
            assistant_runtime: Mutex::new(None),
            assistant_sidecar: Mutex::new(None),
            redclaw_runtime: Mutex::new(None),
            runtime_warm: Mutex::new(RuntimeWarmState::default()),
        })
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send])
        .setup(|app| {
            let _ = app.emit("indexing:status", default_indexing_stats());
            let state = app.state::<AppState>();
            if let Err(error) = ensure_redclaw_profile_files(&state) {
                eprintln!("[RedBox redclaw profile init] {error}");
            }
            if let Err(error) =
                refresh_runtime_warm_state(&state, &["wander", "redclaw", "chatroom"])
            {
                eprintln!("[RedBox runtime warmup] {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run RedBox");
}
