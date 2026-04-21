#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod app_shared;
mod assistant_core;
mod auth;
mod chat_binding;
mod chat_helpers;
mod chat_title;
mod commands;
mod desktop_io;
mod diagnostics;
mod events;
mod helpers;
mod http_utils;
mod interactive_runtime_shared;
mod knowledge;
mod knowledge_index;
mod legacy_import;
mod llm_transport;
mod manuscript_package;
mod mcp;
mod media_generation;
mod memory_maintenance;
mod official_support;
mod persistence;
mod process_utils;
mod provider_compat;
mod redclaw_profile;
mod runtime;
mod scheduler;
mod session_manager;
mod skills;
mod startup_migration;
mod subagents;
mod tools;
mod workspace_loaders;

use agent::{execute_prepared_wander_turn, PreparedWanderTurn};
use commands::chat_state::{
    ensure_chat_session, is_chat_runtime_cancel_requested, latest_session_id,
    resolve_runtime_mode_for_session, update_chat_runtime_state,
};
use events::{
    emit_creative_chat_checkpoint, emit_runtime_done, emit_runtime_stream_start,
    emit_runtime_task_checkpoint_saved, emit_runtime_text_delta, emit_runtime_tool_partial,
    emit_runtime_tool_request, emit_runtime_tool_result, split_stream_chunks,
};
use persistence::{
    build_store_path, ensure_store_hydrated_for_knowledge, hydrate_store_from_workspace_files,
    load_store, persist_store, with_store, with_store_mut,
};
use runtime::{
    append_session_checkpoint, infer_protocol, next_memory_maintenance_at_ms, resolve_chat_config,
    resolve_runtime_mode_from_context_type, role_sequence_for_route, runtime_error_payload,
    runtime_warm_settings_fingerprint, session_lineage_fields, session_title_from_message,
    InteractiveLoopGuard, InteractiveToolCall, InteractiveToolOutcomeDigest, McpServerRecord,
    RedclawJobDefinitionRecord, RedclawJobExecutionRecord, RedclawLongCycleTaskRecord,
    RedclawRuntime, RedclawScheduledTaskRecord, RedclawStateRecord, ResolvedChatConfig,
    RuntimeHookRecord, RuntimeTaskRecord, RuntimeTaskTraceRecord, RuntimeWarmEntry,
    RuntimeWarmState, SessionCheckpointRecord, SessionToolResultRecord, SessionTranscriptRecord,
    SkillRecord,
};
use scheduler::sync_redclaw_job_definitions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use app_shared::*;
pub(crate) use assistant_core::*;
pub(crate) use auth::*;
pub(crate) use diagnostics::*;
pub(crate) use helpers::*;
pub(crate) use http_utils::*;
pub(crate) use legacy_import::*;
pub(crate) use llm_transport::*;
pub(crate) use manuscript_package::*;
pub(crate) use media_generation::*;
pub(crate) use memory_maintenance::*;
pub(crate) use official_support::*;
pub(crate) use process_utils::*;
pub(crate) use provider_compat::*;
pub(crate) use redclaw_profile::*;
pub(crate) use startup_migration::*;

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
struct ChatSessionContextRecord {
    session_id: String,
    summary: String,
    summary_source: String,
    total_message_count: i64,
    compacted_message_count: i64,
    tail_message_count: i64,
    compact_rounds: i64,
    summary_chars: i64,
    estimated_total_tokens: i64,
    first_user_message: Option<String>,
    last_user_message: Option<String>,
    last_assistant_message: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManuscriptWriteProposalRecord {
    id: String,
    file_path: String,
    session_id: Option<String>,
    tool_call_id: Option<String>,
    draft_type: Option<String>,
    title: Option<String>,
    metadata: Option<Value>,
    base_content: String,
    proposed_content: String,
    created_at: String,
    updated_at: String,
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
    subtitle_error: Option<String>,
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
    session_context_records: Vec<ChatSessionContextRecord>,
    manuscript_write_proposals: Vec<ManuscriptWriteProposalRecord>,
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
#[serde(default, rename_all = "camelCase")]
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
    knowledge_api: Value,
}

impl Default for AssistantStateRecord {
    fn default() -> Self {
        Self {
            enabled: true,
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
            knowledge_api: json!({
                "endpointPath": "/api/knowledge",
                "webhookUrl": ""
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
    source_domain: Option<String>,
    source_link: Option<String>,
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
    source_domain: Option<String>,
    source_link: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorRuntimeStateRecord {
    file_path: String,
    session_id: Option<String>,
    playhead_seconds: f64,
    selected_clip_id: Option<String>,
    selected_clip_ids: Option<Value>,
    active_track_id: Option<String>,
    selected_track_ids: Option<Value>,
    selected_scene_id: Option<String>,
    preview_tab: Option<String>,
    canvas_ratio_preset: Option<String>,
    active_panel: Option<String>,
    drawer_panel: Option<String>,
    scene_item_transforms: Option<Value>,
    scene_item_visibility: Option<Value>,
    scene_item_order: Option<Value>,
    scene_item_locks: Option<Value>,
    scene_item_groups: Option<Value>,
    focused_group_id: Option<String>,
    track_ui: Option<Value>,
    viewport_scroll_left: f64,
    viewport_max_scroll_left: f64,
    viewport_scroll_top: f64,
    viewport_max_scroll_top: f64,
    timeline_zoom_percent: f64,
    undo_stack: Vec<Value>,
    redo_stack: Vec<Value>,
    updated_at: u128,
}

struct AppState {
    store_path: PathBuf,
    store: Arc<Mutex<AppStore>>,
    workspace_root_cache: Mutex<PathBuf>,
    startup_migration: Mutex<startup_migration::StartupMigrationStatus>,
    store_persist_version: Arc<AtomicU64>,
    auth_runtime: Mutex<AuthRuntimeState>,
    official_auth_refresh_lock: Mutex<()>,
    official_wechat_status_lock: Mutex<()>,
    official_cache_refresh_inflight: AtomicBool,
    mcp_manager: mcp::McpManager,
    chat_runtime_states: Mutex<std::collections::HashMap<String, ChatRuntimeStateRecord>>,
    editor_runtime_states: Mutex<std::collections::HashMap<String, EditorRuntimeStateRecord>>,
    active_chat_requests: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    creative_chat_cancellations: Mutex<HashSet<String>>,
    assistant_runtime: Mutex<Option<AssistantRuntime>>,
    assistant_sidecar: Mutex<Option<AssistantSidecarRuntime>>,
    redclaw_runtime: Mutex<Option<RedclawRuntime>>,
    runtime_warm: Mutex<RuntimeWarmState>,
    skill_watch: Mutex<skills::SkillWatcherSnapshot>,
    diagnostics: Mutex<DiagnosticsState>,
    knowledge_index_state: Mutex<knowledge_index::KnowledgeIndexRuntimeState>,
}

static GLOBAL_DEBUG_STORE: OnceLock<Arc<Mutex<AppStore>>> = OnceLock::new();
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

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
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    richpost_preview_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    richpost_preview_file_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    richpost_preview_updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    richpost_preview_page_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    richpost_preview_page_file_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    richpost_preview_page_updated_at: Option<i64>,
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

pub(crate) fn parse_timestamp_ms(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = trimmed.parse::<i64>() {
        if parsed.abs() >= 1_000_000_000_000 {
            return Some(parsed);
        }
        if parsed.abs() >= 1_000_000_000 {
            return parsed.checked_mul(1000);
        }
    }
    time::OffsetDateTime::parse(trimmed, &time::format_description::well_known::Rfc3339)
        .ok()
        .and_then(|parsed| i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok())
}

pub(crate) fn format_timestamp_rfc3339_from_ms(timestamp_ms: i64) -> Option<String> {
    let timestamp_ns = i128::from(timestamp_ms).checked_mul(1_000_000)?;
    let parsed = time::OffsetDateTime::from_unix_timestamp_nanos(timestamp_ns).ok()?;
    parsed
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

pub(crate) fn normalize_timestamp_string(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(parsed) = parse_timestamp_ms(trimmed) {
        if parsed > 0 {
            return format_timestamp_rfc3339_from_ms(parsed).unwrap_or_else(|| trimmed.to_string());
        }
        return String::new();
    }
    trimmed.to_string()
}

pub(crate) fn now_rfc3339() -> String {
    format_timestamp_rfc3339_from_ms(now_ms() as i64).unwrap_or_else(now_iso)
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
            system_prompt: interactive_runtime_system_prompt(state, mode, None),
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

pub(crate) fn payload_field<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    payload.as_object().and_then(|object| object.get(key))
}

pub(crate) fn payload_string(payload: &Value, key: &str) -> Option<String> {
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

fn legacy_default_workspace_dir() -> Option<PathBuf> {
    legacy_workspace_dir().map(|root| root.join("spaces").join("default"))
}

fn has_legacy_workspace_layout() -> bool {
    legacy_default_workspace_dir().is_some_and(|path| path.exists())
}

#[allow(dead_code)]
fn managed_workspace_dir_candidates(store_path: &Path) -> Vec<PathBuf> {
    let mut items = Vec::new();
    if let Some(root) = store_path.parent() {
        items.push(root.join("spaces").join("default"));
    }
    items
}

pub(crate) fn is_same_path(left: &Path, right: &Path) -> bool {
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

fn compatible_workspace_base_dir(settings: &Value) -> PathBuf {
    if let Some(configured) = configured_workspace_dir(settings) {
        return configured;
    }
    if let Some(legacy) = legacy_workspace_dir().filter(|_| has_legacy_workspace_layout()) {
        return legacy;
    }
    preferred_workspace_dir()
}

fn is_legacy_workspace_base(path: &Path) -> bool {
    legacy_workspace_dir()
        .as_ref()
        .is_some_and(|legacy| is_same_path(path, legacy))
}

fn workspace_root_from_snapshot(
    settings: &Value,
    active_space_id: &str,
    _store_path: &Path,
) -> Result<PathBuf, String> {
    let base = compatible_workspace_base_dir(settings);
    let root = if is_legacy_workspace_base(&base) {
        if active_space_id == "default" {
            base.join("spaces").join("default")
        } else {
            base.join("spaces").join(active_space_id)
        }
    } else if active_space_id == "default" {
        base
    } else {
        base.join("spaces").join(active_space_id)
    };
    ensure_workspace_dirs(&root)?;
    Ok(root)
}

fn active_space_workspace_root_from_store(
    store: &AppStore,
    active_space_id: &str,
    store_path: &Path,
) -> Result<PathBuf, String> {
    workspace_root_from_snapshot(&store.settings, active_space_id, store_path)
}

pub(crate) fn update_workspace_root_cache(
    state: &State<'_, AppState>,
    settings: &Value,
    active_space_id: &str,
) -> Result<PathBuf, String> {
    let root = workspace_root_from_snapshot(settings, active_space_id, &state.store_path)?;
    let mut cache = state
        .workspace_root_cache
        .lock()
        .map_err(|_| "workspace root cache lock 已损坏".to_string())?;
    *cache = root.clone();
    Ok(root)
}

fn workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let cached_root = state
        .workspace_root_cache
        .lock()
        .map_err(|_| "workspace root cache lock 已损坏".to_string())?
        .clone();
    if !cached_root.as_os_str().is_empty() {
        ensure_workspace_dirs(&cached_root)?;
        return Ok(cached_root);
    }

    let (settings_snapshot, active_space_id) = with_store(state, |store| {
        Ok((store.settings.clone(), store.active_space_id.clone()))
    })?;
    let root = update_workspace_root_cache(state, &settings_snapshot, &active_space_id)?;
    Ok(root)
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
        root.join("remotion-elements"),
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

fn load_skill_bundle_sections(
    state: &State<'_, AppState>,
    skill_name: &str,
) -> (String, String, String, String) {
    let workspace = workspace_root(state).ok();
    let bundle = skills::load_skill_bundle_sections_from_sources(skill_name, workspace.as_deref());
    (
        bundle.skill_name,
        bundle.body,
        bundle.references,
        bundle.scripts,
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

fn remotion_elements_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("remotion-elements");
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
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => (
            format!("image/{}", if ext == "jpg" { "jpeg" } else { ext.as_str() }),
            "image".to_string(),
            true,
        ),
        "svg" => ("image/svg+xml".to_string(), "image".to_string(), true),
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

#[cfg(test)]
mod tests {
    use super::guess_mime_and_kind;
    use std::path::Path;

    #[test]
    fn guess_mime_and_kind_uses_svg_xml_mime() {
        let (mime_type, kind, direct_upload_eligible) = guess_mime_and_kind(Path::new("cover.svg"));
        assert_eq!(mime_type, "image/svg+xml");
        assert_eq!(kind, "image");
        assert!(direct_upload_eligible);
    }
}

#[cfg(target_os = "macos")]
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
    let mut command = std::process::Command::new("powershell");
    configure_background_command(&mut command);
    let output = command
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

fn pick_save_file_native(
    prompt: &str,
    default_name: &str,
    default_dir: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let default_dir_script = default_dir
            .map(|path| format!(", defaultLocation: Path({:?})", path.display().to_string()))
            .unwrap_or_default();
        let picker_call = format!(
            "var app=Application.currentApplication(); app.includeStandardAdditions=true; try {{ var picked=app.chooseFileName({{withPrompt:{prompt:?}, defaultName:{default_name:?}{default_dir_script}}}); JSON.stringify(String(picked)); }} catch (error) {{ JSON.stringify(null); }}"
        );
        let value = run_osascript_json(&picker_call)?;
        return Ok(value.as_str().map(PathBuf::from));
    }

    #[cfg(target_os = "windows")]
    {
        let prompt = escape_powershell_single_quoted(prompt);
        let default_name = escape_powershell_single_quoted(default_name);
        let initial_directory = default_dir
            .map(|path| escape_powershell_single_quoted(&path.display().to_string()))
            .unwrap_or_default();
        let initial_directory_script = if initial_directory.is_empty() {
            String::new()
        } else {
            format!("$dialog.InitialDirectory = '{initial_directory}'")
        };
        let script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = '{prompt}'
$dialog.FileName = '{default_name}'
{initial_directory_script}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  ConvertTo-Json -Compress $dialog.FileName
}} else {{
  'null'
}}
"#
        );
        let value = run_powershell_json(&script)?;
        return Ok(value.as_str().map(PathBuf::from));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = prompt;
        let _ = default_name;
        let _ = default_dir;
        Err("RedBox save picker currently supports macOS and Windows".to_string())
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

fn bundled_resource_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    let mut push = |path: PathBuf| {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            roots.push(path);
        }
    };

    if let Ok(resource_dir) = app.path().resource_dir() {
        push(resource_dir.clone());
        push(resource_dir.join("_up_"));
        push(resource_dir.join("resources"));
        push(resource_dir.join("_up_").join("resources"));
    }

    roots
}

fn browser_plugin_bundled_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    let mut push = |path: PathBuf| {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            candidates.push(path);
        }
    };

    for root in bundled_resource_roots(app) {
        push(root.join("Plugin"));
        push(root.join("browser-extension"));
        collect_browser_plugin_candidates_from_root(&root, 3, &mut push);
    }

    if cfg!(debug_assertions) {
        push(cwd.join("Plugin"));
        push(cwd.join("../Plugin"));
        push(cwd.join("../../Plugin"));
        push(manifest_dir.join("../Plugin"));
        push(manifest_dir.join("../../Plugin"));
    }

    candidates
}

fn collect_browser_plugin_candidates_from_root(
    root: &Path,
    remaining_depth: usize,
    push: &mut impl FnMut(PathBuf),
) {
    if remaining_depth == 0 || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if matches!(file_name, "Plugin" | "browser-extension") {
            push(path.clone());
        }
        collect_browser_plugin_candidates_from_root(&path, remaining_depth - 1, push);
    }
}

fn browser_plugin_bundled_root(app: &AppHandle) -> Option<PathBuf> {
    browser_plugin_bundled_candidates(app)
        .into_iter()
        .find(|path| path.join("manifest.json").exists())
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
    mcp::discover_local_mcp_configs()
}

fn invoke_mcp_server(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
    method: &str,
    params: Value,
) -> Result<mcp::McpInvocationResult, String> {
    state.mcp_manager.invoke(server, method, params)
}

fn test_mcp_server(
    state: &State<'_, AppState>,
    server: &McpServerRecord,
) -> Result<mcp::McpProbeResult, String> {
    state.mcp_manager.probe(server)
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

fn is_debug_log_enabled(store: &AppStore) -> bool {
    store
        .settings
        .as_object()
        .and_then(|settings| settings.get("debug_log_enabled"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn write_debug_line_to_store(store: &Arc<Mutex<AppStore>>, line: &str) {
    let Ok(mut store) = store.lock() else {
        return;
    };
    if !is_debug_log_enabled(&store) {
        return;
    }
    append_debug_log(&mut store, line.to_string());
}

fn register_global_debug_store(store: Arc<Mutex<AppStore>>) {
    let _ = GLOBAL_DEBUG_STORE.set(store);
}

fn register_global_app_handle(app: AppHandle) {
    let _ = GLOBAL_APP_HANDLE.set(app);
}

pub(crate) fn append_debug_trace_global(line: impl Into<String>) {
    let line = format!("{} | {}", now_iso(), line.into());
    eprintln!("{}", line);
    if let Some(store) = GLOBAL_DEBUG_STORE.get() {
        write_debug_line_to_store(store, &line);
    }
}

pub(crate) fn try_refresh_official_auth_for_ai_request(
    request_url: &str,
    api_key: Option<&str>,
    reason: &str,
) -> Result<Option<String>, String> {
    let Some(app) = GLOBAL_APP_HANDLE.get().cloned() else {
        return Ok(None);
    };
    let state = app.state::<AppState>();
    commands::official::refresh_official_auth_for_ai_request(
        &app,
        &state,
        request_url,
        api_key,
        reason,
    )
}

fn build_chat_error_payload(error: &str, session_id: Option<String>) -> Value {
    runtime_error_payload(error, None, None, session_id)
}

pub(crate) fn append_debug_log_state(state: &State<'_, AppState>, line: impl Into<String>) {
    let line = format!("{} | {}", now_iso(), line.into());
    write_debug_line_to_store(&state.store, &line);
}

pub(crate) fn append_debug_trace_state(state: &State<'_, AppState>, line: impl Into<String>) {
    let line = format!("{} | {}", now_iso(), line.into());
    eprintln!("{}", line);
    write_debug_line_to_store(&state.store, &line);
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
    let source_type = note
        .capture_kind
        .clone()
        .unwrap_or_else(|| "note".to_string());
    let is_video_note = note.video.is_some() || note.video_url.is_some();
    let exploration_hint = if is_video_note {
        "先列出素材目录，再优先读取 meta.json。随后根据目录和 meta 中出现的字段，自主寻找 transcript / subtitle / content / description / video 等相关文件；不要预设固定后缀。"
    } else {
        "先列出素材目录，再优先读取 meta.json。随后根据目录和 meta 中出现的字段，自主寻找 content / body / article / html / markdown 等正文文件；不要预设固定文件名。"
    };
    let naming_rules = if is_video_note {
        vec![
            "优先识别 meta.json".to_string(),
            "转录/字幕常见命名可能包含 transcript / subtitle / captions".to_string(),
            "正文或描述可能直接在 meta.json 字段里，也可能在 content / description / note 文件中"
                .to_string(),
            "视频素材文件常见命名可能包含 video，扩展名可能是 mp4 / mov / webm / mkv".to_string(),
        ]
    } else {
        vec![
            "优先识别 meta.json".to_string(),
            "正文常见命名可能包含 content / body / article / note".to_string(),
            "正文扩展名可能是 md / markdown / html / txt".to_string(),
            "如果 meta.json 已包含 description / excerpt / transcript，也要一并利用".to_string(),
        ]
    };
    json!({
        "id": note.id,
        "type": if is_video_note { "video" } else { "note" },
        "title": note.title,
        "content": note.excerpt.clone().unwrap_or_else(|| note.content.chars().take(500).collect::<String>()),
        "cover": note.cover,
        "meta": {
            "sourceType": source_type,
            "folderPath": note.folder_path,
            "sourceDomain": note.source_domain,
            "sourceLink": note.source_link.clone().or(note.source_url.clone()),
            "sourceUrl": note.source_link.clone().or(note.source_url.clone()),
            "materialRef": build_wander_material_ref(
                "redbook-note",
                &source_type,
                "knowledge/redbook",
                note.folder_path.as_deref(),
                &note.id,
                exploration_hint,
                naming_rules,
                &note.title,
                note.source_link.as_deref().or(note.source_url.as_deref()),
            )
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
            "sourceUrl": video.video_url,
            "materialRef": build_wander_material_ref(
                "youtube-video",
                "youtube",
                "knowledge/youtube",
                video.folder_path.as_deref(),
                &video.id,
                "先列出素材目录，再优先读取 meta.json。随后根据目录和 meta 中出现的字段，自主寻找 subtitle / transcript / captions / description 等相关文件；不要预设固定后缀。",
                vec![
                    "优先识别 meta.json".to_string(),
                    "字幕/转录常见命名可能包含 subtitle / transcript / captions".to_string(),
                    "字幕文件扩展名可能是 txt / md / srt / vtt / json".to_string(),
                    "如果没有独立字幕文件，就回退使用 meta.json 中的 description / summary / transcript 字段".to_string(),
                ],
                &video.title,
                Some(video.video_url.as_str()),
            )
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
            "relativePath": source.sample_files.first().cloned().unwrap_or_default(),
            "materialRef": build_wander_material_ref(
                "document-source",
                "document",
                "knowledge/docs",
                Some(source.root_path.as_str()),
                &source.id,
                "先列出文档源目录，再优先从样例文件入手。如果样例文件不存在或信息不足，再按目录结构自行选择最相关的正文文件继续读取。",
                source
                    .sample_files
                    .iter()
                    .map(|value| format!("样例文件：{}", normalize_relative_path(value)))
                    .collect::<Vec<_>>(),
                &source.name,
                None,
            )
        }
    })
}

fn build_wander_material_ref(
    kind: &str,
    source_type: &str,
    storage_root: &str,
    folder_path: Option<&str>,
    fallback_leaf: &str,
    exploration_hint: &str,
    naming_rules: Vec<String>,
    display_title: &str,
    source_url: Option<&str>,
) -> Value {
    let normalized_rules = naming_rules
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.trim().is_empty())
        .fold(Vec::<String>::new(), |mut acc, value| {
            if !acc.iter().any(|item| item == &value) {
                acc.push(value);
            }
            acc
        });
    let workspace_path = derive_workspace_material_path(storage_root, folder_path, fallback_leaf);
    let exists = folder_path.map(Path::new).is_some_and(Path::exists);
    json!({
        "kind": kind,
        "sourceType": source_type,
        "storageRoot": storage_root,
        "folderPath": folder_path,
        "workspacePath": workspace_path,
        "explorationHint": exploration_hint,
        "namingRules": normalized_rules,
        "displayTitle": display_title,
        "sourceUrl": source_url,
        "exists": exists,
    })
}

fn derive_workspace_material_path(
    storage_root: &str,
    folder_path: Option<&str>,
    fallback_leaf: &str,
) -> String {
    let normalized_root = storage_root
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    let normalized_leaf = fallback_leaf
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    let normalized_folder = folder_path.unwrap_or_default().trim().replace('\\', "/");

    if !normalized_root.is_empty() {
        if normalized_folder == normalized_root
            || normalized_folder.starts_with(&(normalized_root.clone() + "/"))
        {
            return normalized_folder.trim_matches('/').to_string();
        }
        let marker = format!("/{}/", normalized_root);
        if let Some(index) = normalized_folder.find(&marker) {
            return normalized_folder[index + 1..].trim_matches('/').to_string();
        }
        let suffix = format!("/{}", normalized_root);
        if normalized_folder.ends_with(&suffix) {
            return normalized_root;
        }
    }

    if normalized_root.is_empty() {
        return normalized_leaf;
    }
    if normalized_leaf.is_empty() {
        return normalized_root;
    }
    format!("{normalized_root}/{normalized_leaf}")
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
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    config: &Value,
    prompt: &str,
) -> Result<String, String> {
    let turn = PreparedWanderTurn::new(session_id.to_string(), prompt.to_string(), Some(config));
    execute_prepared_wander_turn(app, state, &turn).map(|execution| execution.response)
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

fn interactive_runtime_system_prompt(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> String {
    interactive_runtime_shared::interactive_runtime_system_prompt(state, runtime_mode, session_id)
}

fn parse_usize_arg(arguments: &Value, key: &str, default: usize, max: usize) -> usize {
    interactive_runtime_shared::parse_usize_arg(arguments, key, default, max)
}

fn text_snippet(value: &str, limit: usize) -> String {
    interactive_runtime_shared::text_snippet(value, limit)
}

fn collect_recent_chat_messages(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    limit: usize,
) -> Vec<Value> {
    interactive_runtime_shared::collect_recent_chat_messages(state, session_id, limit)
}

fn list_directory_entries(path: &Path, limit: usize) -> Result<Vec<Value>, String> {
    interactive_runtime_shared::list_directory_entries(path, limit)
}

fn interactive_runtime_tools_for_mode(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Value {
    interactive_runtime_shared::interactive_runtime_tools_for_mode(state, runtime_mode, session_id)
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

fn model_config_value_from_resolved(config: &ResolvedChatConfig) -> Value {
    json!({
        "baseURL": config.base_url,
        "apiKey": config.api_key,
        "modelName": config.model_name,
        "protocol": config.protocol
    })
}

fn execute_interactive_tool_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    name: &str,
    arguments: &Value,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    let tool_executor = tools::executor::InteractiveToolExecutor::new(
        app,
        state,
        runtime_mode,
        session_id,
        tool_call_id,
    );
    let prepared = tool_executor.prepare_tool_call(name, arguments)?;
    let name = prepared.name;
    let arguments = &prepared.arguments;
    if let Some(result) = tool_executor.dispatch_action_tool(&prepared) {
        return result;
    }
    let call_manuscript_channel = |channel: &str, payload: Value| -> Result<Value, String> {
        commands::manuscripts::handle_manuscripts_channel(app, state, channel, &payload)
            .unwrap_or_else(|| Err(format!("Manuscript channel not handled: {channel}")))
    };

    match name {
        "redbox_editor" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            let file_path = resolve_editor_tool_file_path(state, session_id, arguments)?;
            let is_video_package = get_package_kind_from_file_name(&file_path) == Some("video");
            let ensure_script_confirmed = |next_action: &str| -> Result<(), String> {
                let script_state = call_manuscript_channel(
                    "manuscripts:get-package-script-state",
                    json!({ "filePath": file_path.clone() }),
                )?;
                let status = script_state
                    .pointer("/script/approval/status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("pending");
                if status == "confirmed" {
                    return Ok(());
                }
                Err(format!(
                    "脚本尚未确认，暂时不能执行 `{next_action}`。请先使用 `script_read` 读取脚本，再用 `script_update` 写入脚本草案，让用户阅读；用户明确确认后，再调用 `script_confirm`，之后才能改时间线、生成 Remotion 动画或导出。"
                ))
            };
            let reject_video_timeline_action = |legacy_action: &str| -> Result<Value, String> {
                Err(format!(
                    "视频稿件已切换到 AI 简化编辑流，`{legacy_action}` 不再可用。请改用 `project_read` 读取工程，或用 `ffmpeg_edit` 执行受控剪辑。"
                ))
            };
            match action.as_str() {
                "script_read" | "script-read" => call_manuscript_channel(
                    "manuscripts:get-package-script-state",
                    json!({ "filePath": file_path }),
                ),
                "project_read" | "project-read" => {
                    if is_video_package {
                        call_manuscript_channel(
                            "manuscripts:get-video-project-state",
                            json!({ "filePath": file_path }),
                        )
                    } else {
                        call_manuscript_channel("manuscripts:get-package-state", json!(file_path))
                    }
                }
                "remotion_read" | "remotion-read" => call_manuscript_channel(
                    "manuscripts:get-remotion-context",
                    json!({ "filePath": file_path }),
                ),
                "script_update" | "script-update" => {
                    let result = call_manuscript_channel(
                        "manuscripts:update-package-script",
                        editor_tool_payload(file_path.clone(), arguments, &["content", "source"]),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.script_changed",
                            "editor script changed",
                            Some(json!({
                                "filePath": file_path,
                                "source": payload_string(arguments, "source").unwrap_or_else(|| "ai".to_string())
                            })),
                        );
                    }
                    Ok(result)
                }
                "script_confirm" | "script-confirm" => {
                    let result = call_manuscript_channel(
                        "manuscripts:confirm-package-script",
                        json!({ "filePath": file_path.clone() }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.script_confirmed",
                            "editor script confirmed",
                            Some(json!({ "filePath": file_path })),
                        );
                    }
                    Ok(result)
                }
                "timeline_read" | "clips" => {
                    if is_video_package {
                        return reject_video_timeline_action("timeline_read");
                    }
                    call_manuscript_channel("manuscripts:get-package-state", json!(file_path))
                }
                "selection_read" | "playhead_read" => call_manuscript_channel(
                    "manuscripts:get-editor-runtime-state",
                    json!({ "filePath": file_path }),
                ),
                "timeline_zoom_read"
                | "timeline-zoom-read"
                | "timeline_scroll_read"
                | "timeline-scroll-read"
                | "panel_read"
                | "panel-read" => call_manuscript_channel(
                    "manuscripts:get-editor-runtime-state",
                    json!({ "filePath": file_path }),
                ),
                "selection_set" | "selection-set" => {
                    let clip_id = payload_string(arguments, "clipId");
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "selectedClipId": clip_id
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.selection_changed",
                            "editor selection changed",
                            Some(json!({
                                "filePath": file_path,
                                "clipId": payload_string(arguments, "clipId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "playhead_seek" | "playhead-seek" => {
                    let seconds = payload_field(arguments, "seconds")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0)
                        .max(0.0);
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "playheadSeconds": seconds
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.playhead_changed",
                            "editor playhead changed",
                            Some(json!({
                                "filePath": file_path,
                                "seconds": seconds
                            })),
                        );
                    }
                    Ok(result)
                }
                "focus_clip" | "focus-clip" => {
                    let clip_id = payload_string(arguments, "clipId").unwrap_or_default();
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "selectedClipId": clip_id
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.selection_changed",
                            "editor selection changed",
                            Some(json!({
                                "filePath": file_path,
                                "clipId": payload_string(arguments, "clipId").unwrap_or_default()
                            })),
                        );
                    }
                    Ok(result)
                }
                "focus_item" | "focus-item" => {
                    let clip_id = payload_string(arguments, "clipId");
                    let scene_id = payload_string(arguments, "sceneId");
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "selectedClipId": clip_id,
                            "selectedSceneId": scene_id
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.selection_changed",
                            "editor selection changed",
                            Some(json!({
                                "filePath": file_path,
                                "clipId": payload_string(arguments, "clipId"),
                                "sceneId": payload_string(arguments, "sceneId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "panel_open" | "panel-open" => {
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "previewTab": payload_string(arguments, "previewTab"),
                            "activePanel": payload_string(arguments, "activePanel"),
                            "drawerPanel": payload_string(arguments, "drawerPanel")
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.panel_changed",
                            "editor panel changed",
                            Some(json!({
                                "filePath": file_path,
                                "previewTab": payload_string(arguments, "previewTab"),
                                "activePanel": payload_string(arguments, "activePanel"),
                                "drawerPanel": payload_string(arguments, "drawerPanel")
                            })),
                        );
                    }
                    Ok(result)
                }
                "timeline_zoom_set" | "timeline-zoom-set" => {
                    let zoom_percent = payload_field(arguments, "zoomPercent")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(100.0)
                        .clamp(25.0, 400.0);
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "timelineZoomPercent": zoom_percent
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.viewport_changed",
                            "editor viewport changed",
                            Some(json!({
                                "filePath": file_path,
                                "zoomPercent": zoom_percent
                            })),
                        );
                    }
                    Ok(result)
                }
                "timeline_scroll_set" | "timeline-scroll-set" => {
                    let scroll_left = payload_field(arguments, "scrollLeft")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0)
                        .max(0.0);
                    let max_scroll_left = payload_field(arguments, "maxScrollLeft")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(scroll_left)
                        .max(scroll_left);
                    let result = call_manuscript_channel(
                        "manuscripts:update-editor-runtime-state",
                        json!({
                            "filePath": file_path.clone(),
                            "sessionId": session_id,
                            "viewportScrollLeft": scroll_left,
                            "viewportMaxScrollLeft": max_scroll_left
                        }),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.viewport_changed",
                            "editor viewport changed",
                            Some(json!({
                                "filePath": file_path,
                                "scrollLeft": scroll_left,
                                "maxScrollLeft": max_scroll_left
                            })),
                        );
                    }
                    Ok(result)
                }
                "track_add" | "track-add" => {
                    if is_video_package {
                        return reject_video_timeline_action("track_add");
                    }
                    call_manuscript_channel("manuscripts:add-package-track", {
                        ensure_script_confirmed("track_add")?;
                        editor_tool_payload(file_path, arguments, &["kind"])
                    })
                }
                "track_reorder" | "track-reorder" => {
                    if is_video_package {
                        return reject_video_timeline_action("track_reorder");
                    }
                    ensure_script_confirmed("track_reorder")?;
                    let result = call_manuscript_channel(
                        "manuscripts:move-package-track",
                        editor_tool_payload(
                            file_path.clone(),
                            arguments,
                            &["trackId", "direction"],
                        ),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor track reordered",
                            Some(json!({
                                "filePath": file_path,
                                "trackId": payload_string(arguments, "trackId"),
                                "direction": payload_string(arguments, "direction")
                            })),
                        );
                    }
                    Ok(result)
                }
                "track_delete" | "track-delete" => {
                    if is_video_package {
                        return reject_video_timeline_action("track_delete");
                    }
                    ensure_script_confirmed("track_delete")?;
                    let result = call_manuscript_channel(
                        "manuscripts:delete-package-track",
                        editor_tool_payload(file_path.clone(), arguments, &["trackId"]),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor track deleted",
                            Some(json!({
                                "filePath": file_path,
                                "trackId": payload_string(arguments, "trackId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "clip_add" | "clip-add" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_add");
                    }
                    call_manuscript_channel("manuscripts:add-package-clip", {
                        ensure_script_confirmed("clip_add")?;
                        editor_tool_payload(
                            file_path,
                            arguments,
                            &["assetId", "track", "order", "durationMs"],
                        )
                    })
                }
                "clip_insert_at_playhead" | "clip-insert-at-playhead" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_insert_at_playhead");
                    }
                    ensure_script_confirmed("clip_insert_at_playhead")?;
                    let result = call_manuscript_channel(
                        "manuscripts:insert-package-clip-at-playhead",
                        editor_tool_payload(
                            file_path.clone(),
                            arguments,
                            &["assetId", "track", "order", "durationMs"],
                        ),
                    )?;
                    let inserted_clip_id = payload_field(&result, "insertedClipId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !inserted_clip_id.is_empty() {
                        let _ = call_manuscript_channel(
                            "manuscripts:update-editor-runtime-state",
                            json!({
                                "filePath": file_path.clone(),
                                "sessionId": session_id,
                                "selectedClipId": inserted_clip_id.clone()
                            }),
                        );
                    }
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor timeline changed",
                            Some(json!({
                                "filePath": file_path.clone(),
                                "action": "clip_insert_at_playhead",
                                "clipId": inserted_clip_id.clone()
                            })),
                        );
                        if !inserted_clip_id.is_empty() {
                            emit_runtime_task_checkpoint_saved(
                                app,
                                None,
                                Some(active_session_id),
                                "editor.selection_changed",
                                "editor selection changed",
                                Some(json!({
                                    "filePath": file_path,
                                    "clipId": inserted_clip_id
                                })),
                            );
                        }
                    }
                    Ok(result)
                }
                "subtitle_add" | "subtitle-add" => {
                    if is_video_package {
                        return reject_video_timeline_action("subtitle_add");
                    }
                    ensure_script_confirmed("subtitle_add")?;
                    let result = call_manuscript_channel(
                        "manuscripts:insert-package-subtitle-at-playhead",
                        editor_tool_payload(
                            file_path.clone(),
                            arguments,
                            &["text", "track", "order", "durationMs"],
                        ),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor subtitle added",
                            Some(json!({
                                "filePath": file_path,
                                "text": payload_string(arguments, "text")
                            })),
                        );
                    }
                    Ok(result)
                }
                "text_add" | "text-add" => {
                    if is_video_package {
                        return reject_video_timeline_action("text_add");
                    }
                    ensure_script_confirmed("text_add")?;
                    let result = call_manuscript_channel(
                        "manuscripts:insert-package-text-at-playhead",
                        editor_tool_payload(
                            file_path.clone(),
                            arguments,
                            &["text", "track", "durationMs", "textStyle"],
                        ),
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor text added",
                            Some(json!({
                                "filePath": file_path,
                                "text": payload_string(arguments, "text")
                            })),
                        );
                    }
                    Ok(result)
                }
                "clip_update" | "clip-update" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_update");
                    }
                    call_manuscript_channel("manuscripts:update-package-clip", {
                        ensure_script_confirmed("clip_update")?;
                        editor_tool_payload(
                            file_path,
                            arguments,
                            &[
                                "clipId",
                                "name",
                                "assetKind",
                                "subtitleStyle",
                                "textStyle",
                                "transitionStyle",
                                "track",
                                "order",
                                "durationMs",
                                "trimInMs",
                                "trimOutMs",
                                "enabled",
                            ],
                        )
                    })
                }
                "clip_move" | "clip-move" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_move");
                    }
                    call_manuscript_channel("manuscripts:update-package-clip", {
                        ensure_script_confirmed("clip_move")?;
                        editor_tool_payload(file_path, arguments, &["clipId", "track", "order"])
                    })
                }
                "clip_toggle_enabled" | "clip-toggle-enabled" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_toggle_enabled");
                    }
                    call_manuscript_channel("manuscripts:update-package-clip", {
                        ensure_script_confirmed("clip_toggle_enabled")?;
                        editor_tool_payload(file_path, arguments, &["clipId", "enabled"])
                    })
                }
                "clip_delete" | "clip-delete" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_delete");
                    }
                    call_manuscript_channel("manuscripts:delete-package-clip", {
                        ensure_script_confirmed("clip_delete")?;
                        editor_tool_payload(file_path, arguments, &["clipId"])
                    })
                }
                "clip_split" | "clip-split" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_split");
                    }
                    call_manuscript_channel("manuscripts:split-package-clip", {
                        ensure_script_confirmed("clip_split")?;
                        editor_tool_payload(file_path, arguments, &["clipId", "splitRatio"])
                    })
                }
                "clip_duplicate" | "clip-duplicate" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_duplicate");
                    }
                    let result =
                        call_manuscript_channel("manuscripts:duplicate-editor-project-clip", {
                            ensure_script_confirmed("clip_duplicate")?;
                            editor_tool_payload(
                                file_path.clone(),
                                arguments,
                                &["clipId", "trackId", "fromMs"],
                            )
                        })?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor clip duplicated",
                            Some(json!({
                                "filePath": file_path,
                                "clipId": payload_string(arguments, "clipId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "clip_replace_asset" | "clip-replace-asset" => {
                    if is_video_package {
                        return reject_video_timeline_action("clip_replace_asset");
                    }
                    let result = call_manuscript_channel(
                        "manuscripts:replace-editor-project-clip-asset",
                        {
                            ensure_script_confirmed("clip_replace_asset")?;
                            editor_tool_payload(
                                file_path.clone(),
                                arguments,
                                &["clipId", "assetId"],
                            )
                        },
                    )?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor clip asset replaced",
                            Some(json!({
                                "filePath": file_path,
                                "clipId": payload_string(arguments, "clipId"),
                                "assetId": payload_string(arguments, "assetId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "marker_add" | "marker-add" => {
                    if is_video_package {
                        return reject_video_timeline_action("marker_add");
                    }
                    let result =
                        call_manuscript_channel("manuscripts:add-editor-project-marker", {
                            ensure_script_confirmed("marker_add")?;
                            editor_tool_payload(
                                file_path.clone(),
                                arguments,
                                &["frame", "color", "label"],
                            )
                        })?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor marker added",
                            Some(json!({
                                "filePath": file_path,
                                "frame": payload_field(arguments, "frame").cloned().unwrap_or(Value::Null)
                            })),
                        );
                    }
                    Ok(result)
                }
                "marker_update" | "marker-update" => {
                    if is_video_package {
                        return reject_video_timeline_action("marker_update");
                    }
                    let result =
                        call_manuscript_channel("manuscripts:update-editor-project-marker", {
                            ensure_script_confirmed("marker_update")?;
                            editor_tool_payload(
                                file_path.clone(),
                                arguments,
                                &["markerId", "frame", "color", "label"],
                            )
                        })?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor marker updated",
                            Some(json!({
                                "filePath": file_path,
                                "markerId": payload_string(arguments, "markerId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "marker_delete" | "marker-delete" => {
                    if is_video_package {
                        return reject_video_timeline_action("marker_delete");
                    }
                    let result =
                        call_manuscript_channel("manuscripts:delete-editor-project-marker", {
                            ensure_script_confirmed("marker_delete")?;
                            editor_tool_payload(file_path.clone(), arguments, &["markerId"])
                        })?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor marker deleted",
                            Some(json!({
                                "filePath": file_path,
                                "markerId": payload_string(arguments, "markerId")
                            })),
                        );
                    }
                    Ok(result)
                }
                "undo" => {
                    if is_video_package {
                        return reject_video_timeline_action("undo");
                    }
                    let result = call_manuscript_channel("manuscripts:undo-editor-project", {
                        ensure_script_confirmed("undo")?;
                        json!({ "filePath": file_path.clone() })
                    })?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor undo",
                            Some(json!({ "filePath": file_path })),
                        );
                    }
                    Ok(result)
                }
                "redo" => {
                    if is_video_package {
                        return reject_video_timeline_action("redo");
                    }
                    let result = call_manuscript_channel("manuscripts:redo-editor-project", {
                        ensure_script_confirmed("redo")?;
                        json!({ "filePath": file_path.clone() })
                    })?;
                    if let Some(active_session_id) = session_id {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            Some(active_session_id),
                            "editor.timeline_changed",
                            "editor redo",
                            Some(json!({ "filePath": file_path })),
                        );
                    }
                    Ok(result)
                }
                "ffmpeg_edit" | "ffmpeg-edit" => {
                    call_manuscript_channel("manuscripts:ffmpeg-edit", {
                        ensure_script_confirmed("ffmpeg_edit")?;
                        editor_tool_payload(file_path, arguments, &["operations", "intentSummary"])
                    })
                }
                "remotion_generate" | "remotion-generate" => {
                    call_manuscript_channel("manuscripts:generate-remotion-scene", {
                        ensure_script_confirmed("remotion_generate")?;
                        let mut payload =
                            editor_tool_payload(file_path, arguments, &["instructions"]);
                        if let Some(active_session_id) = session_id {
                            if let Some(object) = payload.as_object_mut() {
                                object.insert("sessionId".to_string(), json!(active_session_id));
                            }
                        }
                        if let (Some(object), Some(config)) =
                            (payload.as_object_mut(), model_config)
                        {
                            object.insert("modelConfig".to_string(), config.clone());
                        }
                        payload
                    })
                }
                "remotion_save" | "remotion-save" => {
                    call_manuscript_channel("manuscripts:save-remotion-scene", {
                        ensure_script_confirmed("remotion_save")?;
                        editor_tool_payload(file_path, arguments, &["scene"])
                    })
                }
                "export" => call_manuscript_channel("manuscripts:render-remotion-video", {
                    ensure_script_confirmed("export")?;
                    editor_tool_payload(file_path, arguments, &[])
                }),
                _ => Err(format!("unsupported redbox_editor action: {action}")),
            }
        }
        "redbox_fs" => {
            let action = payload_string(arguments, "action").unwrap_or_default();
            let scope = payload_string(arguments, "scope")
                .unwrap_or_else(|| "workspace".to_string())
                .to_ascii_lowercase();
            let raw_path = payload_string(arguments, "path").unwrap_or_default();
            match action.as_str() {
                "search" if scope == "knowledge" => {
                    crate::tools::knowledge_search::execute_grep(state, session_id, arguments)
                }
                "list" if scope == "knowledge" => {
                    crate::tools::knowledge_search::execute_glob(state, session_id, arguments)
                }
                "read" if scope == "knowledge" => {
                    crate::tools::knowledge_search::execute_read(state, session_id, arguments)
                }
                "search" => {
                    crate::tools::workspace_search::execute_search(state, session_id, arguments)
                }
                "list" => {
                    if raw_path.trim().is_empty() {
                        return Err(
                            "path is required for redbox_fs(action=list, scope=workspace)"
                                .to_string(),
                        );
                    }
                    let limit = parse_usize_arg(arguments, "limit", 20, 50);
                    let resolved =
                        interactive_runtime_shared::resolve_workspace_tool_path_for_session(
                            state, session_id, &raw_path,
                        )?;
                    if !resolved.is_dir() {
                        return Err(format!("not a directory: {}", resolved.display()));
                    }
                    Ok(json!({
                        "path": resolved.display().to_string(),
                        "entries": list_directory_entries(&resolved, limit)?
                    }))
                }
                "read" => {
                    if raw_path.trim().is_empty() {
                        return Err(
                            "path is required for redbox_fs(action=read, scope=workspace)"
                                .to_string(),
                        );
                    }
                    let max_chars = parse_usize_arg(arguments, "maxChars", 4000, 20000);
                    let resolved =
                        interactive_runtime_shared::resolve_workspace_tool_path_for_session(
                            state, session_id, &raw_path,
                        )?;
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

fn read_text_excerpt_from_path(path: &str, max_chars: usize) -> String {
    let normalized = path.trim();
    if normalized.is_empty() {
        return String::new();
    }
    fs::read_to_string(normalized)
        .map(|content| truncate_chars(&content, max_chars))
        .unwrap_or_default()
}

fn find_richpost_theme_record<'a>(value: &'a Value, theme_id: &str) -> Option<&'a Value> {
    if theme_id.trim().is_empty() {
        return None;
    }
    if let Some(items) = value.as_array() {
        return items.iter().find(|item| {
            item.get("id").and_then(Value::as_str).map(str::trim) == Some(theme_id.trim())
        });
    }
    for field in ["themes", "items", "records"] {
        if let Some(items) = value.get(field).and_then(Value::as_array) {
            if let Some(found) = items.iter().find(|item| {
                item.get("id").and_then(Value::as_str).map(str::trim) == Some(theme_id.trim())
            }) {
                return Some(found);
            }
        }
    }
    None
}

fn load_richpost_theme_record_excerpt(
    theme_file: &str,
    theme_id: &str,
    max_chars: usize,
) -> String {
    let normalized = theme_file.trim();
    if normalized.is_empty() || theme_id.trim().is_empty() {
        return String::new();
    }
    let Ok(content) = fs::read_to_string(normalized) else {
        return String::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&content) else {
        return String::new();
    };
    if parsed.get("id").and_then(Value::as_str).map(str::trim) == Some(theme_id.trim()) {
        return serde_json::to_string_pretty(&parsed)
            .map(|value| truncate_chars(&value, max_chars))
            .unwrap_or_default();
    }
    let Some(record) = find_richpost_theme_record(&parsed, theme_id) else {
        return String::new();
    };
    serde_json::to_string_pretty(record)
        .map(|value| truncate_chars(&value, max_chars))
        .unwrap_or_default()
}

fn editor_session_prompt_context(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
) -> String {
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
    if runtime_mode == "chatroom" {
        let workspace_mode =
            payload_string(&metadata, "associatedPackageWorkspaceMode").unwrap_or_default();
        let package_kind = payload_string(&metadata, "associatedPackageKind").unwrap_or_default();
        if workspace_mode == "richpost-theme-editing" && package_kind == "richpost" {
            let theme_id =
                payload_string(&metadata, "associatedPackageThemeEditingId").unwrap_or_default();
            let theme_label =
                payload_string(&metadata, "associatedPackageThemeEditingLabel").unwrap_or_default();
            let applied_theme_id =
                payload_string(&metadata, "associatedPackageAppliedThemeId").unwrap_or_default();
            let applied_theme_label =
                payload_string(&metadata, "associatedPackageAppliedThemeLabel").unwrap_or_default();
            let theme_file =
                payload_string(&metadata, "associatedPackageThemeEditingFile").unwrap_or_default();
            let template_file =
                payload_string(&metadata, "associatedPackageThemeEditingTemplateFile")
                    .unwrap_or_default();
            let style_rule =
                payload_string(&metadata, "associatedPackageStyleEditRule").unwrap_or_default();
            let target_files = metadata
                .get("associatedPackageThemeEditingTargetFiles")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let theme_root = target_files
                .get("themeRoot")
                .and_then(|value| value.as_str().map(ToString::to_string))
                .or_else(|| payload_string(&metadata, "associatedPackageThemeEditingRoot"))
                .or_else(|| payload_string(&metadata, "associatedPackageThemeRoot"))
                .unwrap_or_default();
            let master_files = target_files
                .get("masterFiles")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let layout_tokens_file = target_files
                .get("layoutTokensFile")
                .and_then(|value| value.as_str().map(ToString::to_string))
                .unwrap_or_default();
            let page_plan_file = target_files
                .get("pagePlanFile")
                .and_then(|value| value.as_str().map(ToString::to_string))
                .unwrap_or_default();
            let template_guide_file = target_files
                .get("templateGuideFile")
                .and_then(|value| value.as_str().map(ToString::to_string))
                .unwrap_or_else(|| template_file.clone());
            let theme_assets_dir = target_files
                .get("assetsDir")
                .and_then(|value| value.as_str().map(ToString::to_string))
                .or_else(|| {
                    if !theme_root.trim().is_empty() {
                        Some(
                            PathBuf::from(&theme_root)
                                .join("assets")
                                .display()
                                .to_string(),
                        )
                    } else if !theme_file.trim().is_empty() {
                        PathBuf::from(&theme_file)
                            .parent()
                            .map(|parent| parent.join("assets").display().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let theme_record_json =
                load_richpost_theme_record_excerpt(&theme_file, &theme_id, 2600);
            let template_guide_excerpt = read_text_excerpt_from_path(&template_guide_file, 2600);
            let master_files_json =
                serde_json::to_string_pretty(&master_files).unwrap_or_else(|_| "[]".to_string());
            let theme_record_json_for_prompt = theme_record_json.clone();
            if let Some(template) = load_redbox_prompt("runtime/pi/richpost_theme_editor.txt") {
                let rendered = render_redbox_prompt(
                    &template,
                    &[
                        ("runtime_mode", runtime_mode.to_string()),
                        ("workspace_mode", workspace_mode.clone()),
                        ("theme_root", theme_root.clone()),
                        ("theme_id", theme_id.clone()),
                        ("theme_label", theme_label.clone()),
                        ("applied_theme_id", applied_theme_id),
                        ("applied_theme_label", applied_theme_label),
                        ("theme_file", theme_file.clone()),
                        ("template_file", template_file.clone()),
                        ("template_guide_file", template_guide_file.clone()),
                        ("layout_tokens_file", layout_tokens_file.clone()),
                        ("page_plan_file", page_plan_file.clone()),
                        ("master_files", master_files_json),
                        ("theme_assets_dir", theme_assets_dir.clone()),
                        ("style_rule", style_rule.clone()),
                        ("theme_record_json", theme_record_json_for_prompt),
                        ("template_guide_excerpt", template_guide_excerpt),
                    ],
                );
                if !rendered.trim().is_empty() {
                    return format!("\n\n{}", rendered.trim());
                }
            }
            return format!(
                "\n\n## 当前图文主题编辑上下文\n\
runtime_mode: {runtime_mode}\n\
workspaceMode: {workspace_mode}\n\
themeId: {theme_id}\n\
themeLabel: {theme_label}\n\
\n\
## 当前真实编辑目标\n\
themeRecordFile: {theme_file}\n\
themeTemplateGuideFile: {template_file}\n\
layoutTokensFile: {layout_tokens_file}\n\
masterFiles: {}\n\
themeAssetsDir: {theme_assets_dir}\n\
\n\
## 理解规则\n\
- 当前主题有自己的 theme root，当前正在编辑的是工作区 `themes/<themeId>/` 下这一整套文件。\n\
- 当前会话只允许处理当前绑定主题 root；不要顺手改其他 theme root。\n\
- 如果 `themeRecordFile` 为空，先创建或保存当前工作区主题，再继续编辑。\n\
- 修改主题前，先阅读 `richpost-theme-template.md`，再决定改 `<themeId>.json`、layout tokens 还是母版 HTML。\n\
- 添加渐变背景、背景图、容器、颜色、圆角、阴影、文字区域时，优先修改当前 theme root 里的 `<themeId>.json`、`layout.tokens.json` 和 `masters/*.master.html`。\n\
- 不要扫描其他 richpost 工程来猜当前模板；以上这些文件就是当前主题编辑页绑定的真实目标。\n\
- 不要改正文，不要手改渲染产物作为最终来源。\n\
- 工具调用失败就表示这次修改没有完成；在读回当前 theme root 的 tokens 或预览前，不要宣称成功。\n\
\n\
## 当前规则\n\
{style_rule}\n\
\n\
## 目标文件快照\n\
themeRecordFileAgain: {theme_file}\n\
themeTemplateGuideFileAgain: {template_guide_file}\n\
\n\
## 当前主题记录快照\n\
{theme_record_json}\n",
                serde_json::to_string(&master_files).unwrap_or_else(|_| "[]".to_string()),
            );
        }
        return String::new();
    }
    if !matches!(runtime_mode, "video-editor" | "audio-editor") {
        return String::new();
    }
    let file_path = payload_string(&metadata, "associatedFilePath")
        .or_else(|| payload_string(&metadata, "contextId"))
        .unwrap_or_default();
    let package_root = PathBuf::from(&file_path);
    let manifest_path = package_manifest_path(&package_root).display().to_string();
    let editor_project_path = package_editor_project_path(&package_root)
        .display()
        .to_string();
    let timeline_path = package_timeline_path(&package_root).display().to_string();
    let remotion_scene_path = package_remotion_path(&package_root).display().to_string();
    let track_ui_path = package_track_ui_path(&package_root).display().to_string();
    let scene_ui_path = package_scene_ui_path(&package_root).display().to_string();
    let assets_path = package_assets_path(&package_root).display().to_string();
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
packageRoot: {}\n\
title: {title}\n\
packageKind: {package_kind}\n\
trackNames: {}\n\
clips: {}\n\
\n\
## 工程关键文件\n\
manifest: {manifest_path}\n\
editorProject: {editor_project_path}\n\
timelineOtio: {timeline_path}\n\
remotionScene: {remotion_scene_path}\n\
trackUi: {track_ui_path}\n\
sceneUi: {scene_ui_path}\n\
assets: {assets_path}\n\
\n\
## 工程理解规则\n\
- 视频稿件当前以 `manifest.json` + entry 脚本 + `remotion.scene.json` 为主。脚本确认状态存放在 `manifest.json.videoAi.scriptApproval`。\n\
- `remotion.scene.json` 是视频工程真相层，包含 `baseMedia`、`ffmpegRecipe` 与 `scenes`。AI 剪辑完成后，应把基础视频产物写回 `baseMedia.outputPath`。\n\
- `editor.project.json` 与 `timeline.otio.json` 在视频稿件里只作为 legacy 兼容输入，不再是新的写入目标；音频稿件仍可继续使用旧编辑路径。\n\
- `track-ui.json` / `scene-ui.json` 不是视频 AI 工作流的主真相，不要把它们误当成正文内容。\n\
\n\
工具规则：使用 `redbox_editor` 读取和修改当前工程，但必须遵守 script-first 协议。先调用 `script_read` 读取当前脚本与确认状态；如果用户要求改节奏、改镜头、改动画、做剪辑或导出，先用 `script_update` 把新的完整脚本草案写回脚本区，让用户阅读；只有用户明确确认后，才能调用 `script_confirm`。视频稿件确认后，先用 `project_read` 读取最新 `videoProject`，再用 `ffmpeg_edit` 产出基础视频到 `baseMedia.outputPath`，然后再用 `remotion_read` / `remotion_generate` / `remotion_save` 叠加标题、字幕和图形动画，最后才 `export`。不要再使用 `timeline_read`、`track_add`、`clip_*`、`marker_*`、`undo`、`redo` 这些旧时间轴动作编辑视频。Remotion 在当前宿主里默认是一个主 scene 加若干 overlay/entity 的结构：优先在主 scene 内继续叠加动画，而不是机械拆分多个 scene。生成动画后，默认目标是让编辑器直接预览基础视频与 Remotion 叠层，不要把“立即导出成视频”当作默认下一步。修改脚本、基础剪辑或 Remotion 动画后，最终回答要简要说明改动与脚本确认状态。",
        package_root.display(),
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
    terminal_reason: Option<String>,
    saw_done: bool,
    saw_eof: bool,
}

fn interactive_runtime_message_bundle(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    message: &str,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let history_messages = load_runtime_history_messages(state, session_id)?;
    let mut prompt_messages = collect_recent_chat_messages(state, session_id, 10);
    let user_message = canonical_text_message("user", message.to_string());
    prompt_messages.push(user_message.clone());
    let mut full_history_messages = history_messages;
    full_history_messages.push(user_message);
    Ok((prompt_messages, full_history_messages))
}

fn interactive_runtime_turn_system_prompt(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    runtime_mode: &str,
) -> String {
    let mut system_prompt = interactive_runtime_system_prompt(state, runtime_mode, session_id);
    system_prompt.push_str(&editor_session_prompt_context(
        state,
        session_id,
        runtime_mode,
    ));
    system_prompt
}

fn load_runtime_history_messages(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let Some(session_id) = session_id else {
        return Ok(Vec::new());
    };
    let bundle_messages = runtime::load_session_bundle_messages(state, session_id)?;
    if !bundle_messages.is_empty() {
        return Ok(bundle_messages);
    }
    with_store(state, |store| {
        Ok(runtime::chat_messages_for_session(&store, session_id)
            .into_iter()
            .map(|item| canonical_text_message(&item.role, item.content))
            .collect())
    })
}

fn canonical_text_message(role: &str, content: String) -> Value {
    json!({
        "role": role,
        "content": content
    })
}

fn canonical_assistant_message(content: String, tool_calls: &[InteractiveToolCall]) -> Value {
    json!({
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls.iter().map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string())
                }
            })
        }).collect::<Vec<_>>()
    })
}

const INTERACTIVE_MAX_TOOL_TURNS: usize = 100;
const TOOL_BUDGET_EXHAUSTED_MESSAGE: &str =
    "你已经用完本次会话允许的工具轮次预算。不要继续调用工具；基于已有上下文和工具结果直接完成最终答复，如果仍有缺口，请明确指出缺口。";

fn canonical_tool_result_message(
    call_id: &str,
    tool_name: &str,
    content: String,
    success: bool,
) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": call_id,
        "tool_name": tool_name,
        "content": content,
        "success": success
    })
}

fn canonical_messages_to_openai_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => Some(json!({
                    "role": "user",
                    "content": message.get("content").and_then(Value::as_str).unwrap_or("")
                })),
                "assistant" => {
                    let mut value = json!({
                        "role": "assistant",
                        "content": message.get("content").and_then(Value::as_str).unwrap_or("")
                    });
                    if let Some(tool_calls) = message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .filter(|items| !items.is_empty())
                    {
                        value["tool_calls"] = Value::Array(tool_calls.clone());
                    }
                    Some(value)
                }
                "tool" => Some(json!({
                    "role": "tool",
                    "tool_call_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                    "content": message.get("content").and_then(Value::as_str).unwrap_or("")
                })),
                _ => None,
            }
        })
        .collect()
}

fn canonical_messages_to_anthropic_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => Some(json!({
                    "role": "user",
                    "content": message.get("content").and_then(Value::as_str).unwrap_or("").to_string()
                })),
                "assistant" => {
                    let mut blocks = Vec::<Value>::new();
                    let text = message
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !text.trim().is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                        for tool_call in tool_calls {
                            let function =
                                tool_call.get("function").cloned().unwrap_or_else(|| json!({}));
                            let input = function
                                .get("arguments")
                                .and_then(Value::as_str)
                                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                                .unwrap_or_else(|| json!({}));
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": tool_call.get("id").and_then(Value::as_str).unwrap_or(""),
                                "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                                "input": input
                            }));
                        }
                    }
                    if blocks.is_empty() {
                        None
                    } else {
                        Some(json!({ "role": "assistant", "content": blocks }))
                    }
                }
                "tool" => Some(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                        "content": message.get("content").and_then(Value::as_str).unwrap_or(""),
                        "is_error": !message.get("success").and_then(Value::as_bool).unwrap_or(true)
                    }]
                })),
                _ => None,
            }
        })
        .collect()
}

fn canonical_messages_to_gemini_contents(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => {
                    let text = message
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if text.is_empty() {
                        None
                    } else {
                        Some(json!({
                            "role": "user",
                            "parts": [{ "text": text }]
                        }))
                    }
                }
                "assistant" => {
                    let mut parts = Vec::<Value>::new();
                    let text = message
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                        for tool_call in tool_calls {
                            let function =
                                tool_call.get("function").cloned().unwrap_or_else(|| json!({}));
                            let args = function
                                .get("arguments")
                                .and_then(Value::as_str)
                                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                                .unwrap_or_else(|| json!({}));
                            parts.push(json!({
                                "functionCall": {
                                    "id": tool_call.get("id").and_then(Value::as_str).unwrap_or(""),
                                    "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                                    "args": args
                                }
                            }));
                        }
                    }
                    if parts.is_empty() {
                        None
                    } else {
                        Some(json!({ "role": "model", "parts": parts }))
                    }
                }
                "tool" => Some(json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                            "name": message.get("tool_name").and_then(Value::as_str).unwrap_or("tool"),
                            "response": if message.get("success").and_then(Value::as_bool).unwrap_or(true) {
                                json!({ "result": message.get("content").and_then(Value::as_str).unwrap_or("") })
                            } else {
                                json!({ "error": message.get("content").and_then(Value::as_str).unwrap_or("") })
                            }
                        }
                    }]
                })),
                _ => None,
            }
        })
        .collect()
}

fn save_runtime_session_bundle(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    protocol: &str,
    runtime_mode: &str,
    model_name: &str,
    messages: &[Value],
) -> Result<(), String> {
    let Some(session_id) = session_id else {
        return Ok(());
    };
    runtime::save_session_bundle_messages(
        state,
        session_id,
        protocol,
        runtime_mode,
        Some(model_name),
        messages,
    )
}

fn finalize_interactive_runtime_state(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    content: &str,
    error: Option<&str>,
) {
    let Some(session_id) = session_id else {
        return;
    };
    let _ = update_chat_runtime_state(
        state,
        session_id,
        false,
        content.to_string(),
        error.map(ToString::to_string),
    );
}

fn append_prompt_and_canonical_message(
    prompt_messages: &mut Vec<Value>,
    canonical_messages: &mut Vec<Value>,
    message: Value,
) {
    prompt_messages.push(message.clone());
    canonical_messages.push(message);
}

fn append_internal_runtime_user_message(
    prompt_messages: &mut Vec<Value>,
    canonical_messages: &mut Vec<Value>,
    instruction: String,
) {
    append_prompt_and_canonical_message(
        prompt_messages,
        canonical_messages,
        canonical_text_message("user", instruction),
    );
}

fn build_interactive_tool_outcome_digest(
    tool_name: &str,
    arguments: &Value,
    success: bool,
    content: &str,
) -> InteractiveToolOutcomeDigest {
    InteractiveToolOutcomeDigest::new(
        tool_name.to_string(),
        arguments.clone(),
        success,
        text_snippet(content, 240),
    )
}

fn interactive_skill_activation_names(tool_name: &str, result: &Value) -> Vec<String> {
    if tool_name != "app_cli" {
        return Vec::new();
    }
    let Some(transition) = result.get("activationTransition") else {
        return Vec::new();
    };
    if !transition
        .get("continueWithUpdatedContext")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Vec::new();
    }
    let mut activated = transition
        .get("activatedSkillNames")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    activated.sort_by_key(|name| name.to_ascii_lowercase());
    activated.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    activated
}

fn interactive_skill_activation_continuation(names: &[String]) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    Some(format!(
        "系统状态更新：以下技能已激活并写入当前会话：{}。不要向用户复述技能激活过程，不要输出 `<tool_call>`、`<activated_skill>` 或其他协议标签，也不要再次激活相同技能。基于更新后的技能上下文继续当前任务；如果下一步需要工具，直接发起真实工具调用。",
        names.join(", ")
    ))
}

#[derive(Debug, Clone, Default)]
struct InteractiveExecutionContract {
    require_source_read: bool,
    require_profile_read: bool,
    require_save: bool,
    save_artifact: Option<String>,
}

impl InteractiveExecutionContract {
    fn requires_tool_turn(&self) -> bool {
        self.require_source_read || self.require_profile_read || self.require_save
    }

    fn missing_steps(&self, progress: &InteractiveExecutionProgress) -> Vec<&'static str> {
        let mut missing = Vec::<&'static str>::new();
        if self.require_source_read && !progress.source_read_completed {
            missing.push("读取素材真实文件");
        }
        if self.require_profile_read && !progress.profile_read_completed {
            missing.push("读取 RedClaw 用户档案");
        }
        if self.require_save && !progress.save_completed {
            missing.push("调用 manuscripts write 保存稿件");
        }
        missing
    }
}

#[derive(Debug, Clone, Default)]
struct InteractiveExecutionProgress {
    source_read_completed: bool,
    profile_read_completed: bool,
    save_completed: bool,
}

fn interactive_execution_contract(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> InteractiveExecutionContract {
    let Some(session_id) = session_id else {
        return InteractiveExecutionContract::default();
    };
    with_store(state, |store| {
        let task_hints = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|session| session.metadata.as_ref())
            .and_then(|metadata| metadata.get("taskHints"));
        Ok(InteractiveExecutionContract {
            require_source_read: task_hints
                .and_then(|value| value.get("requireSourceRead"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            require_profile_read: task_hints
                .and_then(|value| value.get("requireProfileRead"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            require_save: task_hints
                .and_then(|value| value.get("requireSave"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            save_artifact: task_hints
                .and_then(|value| value.get("saveArtifact"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
        })
    })
    .unwrap_or_default()
}

fn interactive_execution_contract_instruction(
    contract: &InteractiveExecutionContract,
) -> Option<String> {
    if !contract.requires_tool_turn() {
        return None;
    }
    let mut lines = vec![
        "当前任务是执行型创作任务，不要先输出计划、承诺或阶段说明。".to_string(),
        "先直接发起真实工具调用，完成必要读取/保存后再给最终回复。".to_string(),
    ];
    if contract.require_source_read {
        lines.push("必须先读取素材目录中的真实文件内容。".to_string());
    }
    if contract.require_profile_read {
        lines.push("必须先读取 RedClaw 用户档案。".to_string());
    }
    if contract.require_save {
        let save_target = contract
            .save_artifact
            .as_deref()
            .map(|value| format!(".{value}"))
            .unwrap_or_else(|| "目标稿件".to_string());
        lines.push(format!(
            "必须先调用 `manuscripts write` 把完整内容保存到 {save_target} 工程，再汇报结果。"
        ));
    }
    Some(lines.join(" "))
}

fn interactive_execution_contract_followup(
    contract: &InteractiveExecutionContract,
    progress: &InteractiveExecutionProgress,
) -> Option<String> {
    let missing = contract.missing_steps(progress);
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "当前任务还没有完成这些必需动作：{}。不要继续口头描述“我会去做”或“接下来要做什么”。现在直接发起真实工具调用补齐这些动作，完成后再输出最终结果。",
        missing.join("、")
    ))
}

fn interactive_execution_progress_observe_success(
    progress: &mut InteractiveExecutionProgress,
    contract: &InteractiveExecutionContract,
    tool_name: &str,
    arguments: &Value,
    result: &Value,
) {
    match tool_name {
        "redbox_fs" => {
            let action = payload_string(arguments, "action")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let scope = payload_string(arguments, "scope")
                .unwrap_or_else(|| "workspace".to_string())
                .to_ascii_lowercase();
            if contract.require_source_read && scope == "workspace" && action == "read" {
                progress.source_read_completed = true;
            }
        }
        "app_cli" => {
            let command = payload_string(arguments, "command")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if contract.require_profile_read
                && (command.starts_with("redclaw profile-read")
                    || command.starts_with("redclaw profile-bundle"))
            {
                progress.profile_read_completed = true;
            }
            if contract.require_save && command.starts_with("manuscripts write") {
                let artifact_suffix = contract
                    .save_artifact
                    .as_deref()
                    .map(|value| format!(".{value}"));
                let command_matches = artifact_suffix
                    .as_deref()
                    .map(|suffix| command.contains(suffix))
                    .unwrap_or(true);
                let result_matches = artifact_suffix
                    .as_deref()
                    .and_then(|suffix| {
                        result
                            .get("filePath")
                            .and_then(Value::as_str)
                            .map(|path| path.ends_with(suffix))
                    })
                    .unwrap_or(command_matches);
                if command_matches || result_matches {
                    progress.save_completed = true;
                }
            }
        }
        _ => {}
    }
}

fn emit_loop_guard_checkpoint(
    app: &AppHandle,
    session_id: Option<&str>,
    reason: &str,
    outcomes: &[InteractiveToolOutcomeDigest],
) {
    let Some(session_id) = session_id else {
        return;
    };
    emit_runtime_task_checkpoint_saved(
        app,
        None,
        Some(session_id),
        "chat.loop_guard",
        "loop guard forced finalization",
        Some(json!({
            "reason": reason,
            "outcomes": outcomes,
        })),
    );
}

fn anthropic_tools_for_session(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Vec<Value> {
    interactive_runtime_tools_for_mode(state, runtime_mode, session_id)
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

fn gemini_tools_for_session(
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
) -> Vec<Value> {
    let declarations = interactive_runtime_tools_for_mode(state, runtime_mode, session_id)
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
    allow_official_reauth_retry: bool,
) -> Result<StreamingChatCompletion, String> {
    run_openai_streaming_chat_completion_transport(
        app,
        state,
        session_id,
        runtime_mode,
        config,
        body,
        max_time_seconds,
        allow_official_reauth_retry,
    )
}

fn extract_openai_json_assistant_response(
    response: &Value,
) -> Result<(String, Vec<InteractiveToolCall>), String> {
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
                raw: json!({
                    "id": raw.get("id").cloned().unwrap_or_else(|| json!(null)),
                    "type": raw.get("type").cloned().unwrap_or_else(|| json!("function")),
                    "function": function.clone(),
                }),
            })
        })
        .collect::<Vec<_>>();
    Ok((assistant_content, tool_calls))
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GeneratedMediaPreview {
    id: String,
    preview_url: String,
}

fn generated_media_kind_from_tool_result(
    tool_name: &str,
    tool_arguments: &Value,
    result_value: &Value,
) -> Option<&'static str> {
    if tool_name != "app_cli" {
        return None;
    }

    let declared_kind = result_value
        .get("kind")
        .and_then(Value::as_str)
        .or_else(|| {
            result_value
                .get("data")
                .and_then(Value::as_object)
                .and_then(|value| value.get("kind"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    match declared_kind {
        "generated-images" => return Some("image"),
        "generated-videos" => return Some("video"),
        _ => {}
    }

    let command = payload_string(tool_arguments, "command")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if command.starts_with("image generate") {
        return Some("image");
    }
    if command.starts_with("video generate") {
        return Some("video");
    }
    None
}

fn media_preview_matches_kind(url_or_path: &str, media_kind: &str) -> bool {
    let normalized = url_or_path.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let video_hints = [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"];
    let image_hints = [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".avif",
    ];
    match media_kind {
        "video" => video_hints.iter().any(|ext| normalized.contains(ext)),
        "image" => image_hints.iter().any(|ext| normalized.contains(ext)),
        _ => false,
    }
}

fn asset_preview_url_from_result(asset: &Value, media_kind: &str) -> Option<String> {
    let preview_url = asset
        .get("previewUrl")
        .or_else(|| asset.get("preview_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(url) = preview_url.filter(|value| media_preview_matches_kind(value, media_kind)) {
        return Some(url.to_string());
    }

    let absolute_path = asset
        .get("absolutePath")
        .or_else(|| asset.get("absolute_path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(path) = absolute_path.filter(|value| media_preview_matches_kind(value, media_kind))
    {
        return Some(file_url_for_path(Path::new(path)));
    }

    None
}

fn extract_generated_media_previews_from_tool_result(
    tool_name: &str,
    tool_arguments: &Value,
    result_value: &Value,
) -> (Vec<GeneratedMediaPreview>, Vec<GeneratedMediaPreview>) {
    let Some(media_kind) =
        generated_media_kind_from_tool_result(tool_name, tool_arguments, result_value)
    else {
        return (Vec::new(), Vec::new());
    };

    let assets = result_value
        .get("assets")
        .and_then(Value::as_array)
        .or_else(|| {
            result_value
                .get("data")
                .and_then(|value| value.get("assets"))
                .and_then(Value::as_array)
        });
    let Some(assets) = assets else {
        return (Vec::new(), Vec::new());
    };

    let previews = assets
        .iter()
        .filter_map(|asset| {
            let preview_url = asset_preview_url_from_result(asset, media_kind)?;
            let id = asset
                .get("id")
                .or_else(|| asset.get("assetId"))
                .or_else(|| asset.get("relativePath"))
                .or_else(|| asset.get("absolutePath"))
                .or_else(|| asset.get("previewUrl"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(preview_url.as_str())
                .to_string();
            Some(GeneratedMediaPreview { id, preview_url })
        })
        .collect::<Vec<_>>();

    if media_kind == "image" {
        (previews, Vec::new())
    } else {
        (Vec::new(), previews)
    }
}

fn has_generated_media_embed(content: &str, preview_url: &str) -> bool {
    let normalized = content.trim();
    let url = preview_url.trim();
    if normalized.is_empty() || url.is_empty() {
        return false;
    }
    normalized.contains(&format!("]({url})"))
        || normalized.contains(&format!("src=\"{url}\""))
        || normalized.contains(&format!("src='{url}'"))
}

fn append_generated_media_markdown(
    content: &str,
    heading: &str,
    items: &[GeneratedMediaPreview],
) -> String {
    let normalized = content.trim().to_string();
    let mut seen = HashSet::<String>::new();
    let unique_items = items
        .iter()
        .filter(|item| !item.id.trim().is_empty() && !item.preview_url.trim().is_empty())
        .filter(|item| seen.insert(item.preview_url.clone()))
        .filter(|item| !has_generated_media_embed(&normalized, &item.preview_url))
        .cloned()
        .collect::<Vec<_>>();
    if unique_items.is_empty() {
        return normalized;
    }

    let gallery = [
        heading.to_string(),
        unique_items
            .iter()
            .enumerate()
            .map(|(index, item)| format!("![generated-{}]({})", index + 1, item.preview_url))
            .collect::<Vec<_>>()
            .join("\n\n"),
    ]
    .join("\n\n");

    if normalized.is_empty() {
        gallery
    } else {
        format!("{normalized}\n\n{gallery}")
    }
}

fn append_generated_media_sections(
    content: &str,
    images: &[GeneratedMediaPreview],
    videos: &[GeneratedMediaPreview],
) -> String {
    let with_images = append_generated_media_markdown(content, "## 生成图片", images);
    append_generated_media_markdown(&with_images, "## 生成视频", videos)
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

    let (mut prompt_messages, mut canonical_messages) =
        interactive_runtime_message_bundle(state, session_id, message)?;
    let is_wander = runtime_mode == "wander";
    let trace_id = session_id.unwrap_or(runtime_mode);
    let mut generated_images = Vec::<GeneratedMediaPreview>::new();
    let mut generated_videos = Vec::<GeneratedMediaPreview>::new();
    let mut loop_guard = InteractiveLoopGuard::default();
    let mut tool_turn = 0usize;

    while tool_turn < usize::MAX || loop_guard.has_pending_toolless_turn() {
        let forced_toolless_instruction = loop_guard.take_toolless_turn_message();
        let forcing_toolless_turn = forced_toolless_instruction.is_some();
        let tool_turn_limit_reached = tool_turn >= INTERACTIVE_MAX_TOOL_TURNS;
        if !forcing_toolless_turn && !tool_turn_limit_reached {
            tool_turn += 1;
        }
        let turn_index = tool_turn + usize::from(forcing_toolless_turn);
        if let Some(current_session_id) = session_id {
            emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
        }
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            finalize_interactive_runtime_state(state, session_id, "", Some("cancelled"));
            return Err("chat generation cancelled".to_string());
        }
        let turn_started_at = now_ms();
        append_debug_log_state(
            state,
            format!(
                "[timing][anthropic-runtime][{}] turn-{}-request elapsed=0ms",
                trace_id, turn_index
            ),
        );

        if let Some(instruction) = forced_toolless_instruction {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        } else if tool_turn_limit_reached {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                TOOL_BUDGET_EXHAUSTED_MESSAGE.to_string(),
            );
        }

        let tools = if forcing_toolless_turn || tool_turn_limit_reached {
            Vec::new()
        } else {
            anthropic_tools_for_session(state, runtime_mode, session_id)
        };
        let system_prompt = interactive_runtime_turn_system_prompt(state, session_id, runtime_mode);
        let messages = canonical_messages_to_anthropic_messages(&prompt_messages);

        let mut body = json!({
            "model": config.model_name,
            "system": system_prompt,
            "messages": messages,
            "max_tokens": if is_wander { 900 } else { 2048 },
            "stream": true
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools.clone());
            if is_wander && tool_turn == 1 {
                body["tool_choice"] = json!({ "type": "any" });
            }
        }

        let mut command = std::process::Command::new("curl");
        configure_background_command(&mut command);
        command
            .arg("-sS")
            .arg("-N")
            .arg("-X")
            .arg("POST")
            .arg(format!("{}/messages", normalize_base_url(&config.base_url)))
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
            .arg("-w")
            .arg(format!("\n{HTTP_STATUS_MARKER}%{{http_code}}"))
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
        let mut http_status_code: Option<u16> = None;
        let mut raw_response_lines = Vec::<String>::new();

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
            if let Some(status_text) = trimmed.strip_prefix(HTTP_STATUS_MARKER) {
                http_status_code = status_text.trim().parse::<u16>().ok();
                continue;
            }
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
            } else {
                raw_response_lines.push(trimmed.to_string());
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
        if let Some(status_code) = http_status_code.filter(|code| !(200..300).contains(code)) {
            let raw_body = raw_response_lines.join("\n");
            let details = http_error_details_from_text(status_code, &raw_body);
            append_debug_trace_state(
                state,
                format!(
                    "{} | runtimeMode={} model={}",
                    http_error_debug_line(
                        "ai-http",
                        "POST",
                        &format!("{}/messages", normalize_base_url(&config.base_url)),
                        &details
                    ),
                    runtime_mode,
                    config.model_name,
                ),
            );
            return Err(format_http_error_message("AI request", &details));
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
                turn_index,
                now_ms().saturating_sub(turn_started_at)
            ),
        );

        if tool_calls.is_empty() {
            let final_content = append_generated_media_sections(
                &assistant_text,
                &generated_images,
                &generated_videos,
            );
            if final_content.trim().is_empty() {
                finalize_interactive_runtime_state(
                    state,
                    session_id,
                    &assistant_text,
                    Some("empty final response"),
                );
                return Err("interactive runtime returned an empty final response".to_string());
            }
            canonical_messages.push(canonical_text_message("assistant", final_content.clone()));
            save_runtime_session_bundle(
                state,
                session_id,
                "anthropic",
                runtime_mode,
                &config.model_name,
                &canonical_messages,
            )?;
            finalize_interactive_runtime_state(state, session_id, &final_content, None);
            if let Some(current_session_id) = session_id {
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(current_session_id),
                    "chat.response_end",
                    "chat response completed",
                    Some(json!({ "content": final_content.clone() })),
                );
                emit_runtime_done(
                    app,
                    current_session_id,
                    "completed",
                    Some(runtime_mode),
                    Some(&final_content),
                    Some("response_end"),
                );
            }
            return Ok(final_content);
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
        append_prompt_and_canonical_message(
            &mut prompt_messages,
            &mut canonical_messages,
            canonical_assistant_message(assistant_text.clone(), &tool_calls),
        );
        let mut skill_activation_names = Vec::<String>::new();
        let mut tool_round_digests = Vec::<InteractiveToolOutcomeDigest>::new();
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
                Some(&call.id),
                &call.name,
                &call.arguments,
                Some(&model_config_value_from_resolved(config)),
            );
            match result {
                Ok(result_value) => {
                    let activated_skills =
                        interactive_skill_activation_names(&call.name, &result_value);
                    let (image_previews, video_previews) =
                        extract_generated_media_previews_from_tool_result(
                            &call.name,
                            &call.arguments,
                            &result_value,
                        );
                    generated_images.extend(image_previews);
                    generated_videos.extend(video_previews);
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
                    if let Some(session_id) = session_id {
                        let _ = with_store_mut(state, |store| {
                            let (runtime_id, parent_runtime_id, source_task_id) =
                                session_lineage_fields(store, session_id);
                            store.session_tool_results.push(SessionToolResultRecord {
                                id: make_id("tool-result"),
                                session_id: session_id.to_string(),
                                runtime_id,
                                parent_runtime_id,
                                source_task_id,
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
                                payload: Some(result_value.clone()),
                                created_at: now_i64(),
                                updated_at: now_i64(),
                            });
                            Ok(())
                        });
                    }
                    let tool_message = canonical_tool_result_message(
                        &call.id,
                        &call.name,
                        result_text.clone(),
                        true,
                    );
                    append_prompt_and_canonical_message(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        tool_message,
                    );
                    skill_activation_names.extend(activated_skills);
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        &call.name,
                        &call.arguments,
                        true,
                        &result_text,
                    ));
                }
                Err(error) => {
                    emit_runtime_tool_result(app, session_id, &call.id, &call.name, false, &error);
                    append_prompt_and_canonical_message(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        canonical_tool_result_message(&call.id, &call.name, error.clone(), false),
                    );
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        &call.name,
                        &call.arguments,
                        false,
                        &error,
                    ));
                }
            }
            append_debug_log_state(
                state,
                format!(
                    "[timing][anthropic-runtime][{}] turn-{}-tool-{} elapsed={}ms",
                    trace_id,
                    turn_index,
                    call.name,
                    now_ms().saturating_sub(tool_started_at)
                ),
            );
        }
        if let Some(instruction) =
            interactive_skill_activation_continuation(&skill_activation_names)
        {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        save_runtime_session_bundle(
            state,
            session_id,
            "anthropic",
            runtime_mode,
            &config.model_name,
            &canonical_messages,
        )?;
        if let Some(reason) = loop_guard.observe_tool_round(&tool_round_digests) {
            emit_loop_guard_checkpoint(app, session_id, &reason, &tool_round_digests);
        }
    }

    Err("interactive runtime terminated unexpectedly".to_string())
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

    let (mut prompt_messages, mut canonical_messages) =
        interactive_runtime_message_bundle(state, session_id, message)?;
    let is_wander = runtime_mode == "wander";
    let trace_id = session_id.unwrap_or(runtime_mode);
    let mut generated_images = Vec::<GeneratedMediaPreview>::new();
    let mut generated_videos = Vec::<GeneratedMediaPreview>::new();
    let mut loop_guard = InteractiveLoopGuard::default();
    let mut tool_turn = 0usize;

    while tool_turn < usize::MAX || loop_guard.has_pending_toolless_turn() {
        let forced_toolless_instruction = loop_guard.take_toolless_turn_message();
        let forcing_toolless_turn = forced_toolless_instruction.is_some();
        let tool_turn_limit_reached = tool_turn >= INTERACTIVE_MAX_TOOL_TURNS;
        if !forcing_toolless_turn && !tool_turn_limit_reached {
            tool_turn += 1;
        }
        let turn_index = tool_turn + usize::from(forcing_toolless_turn);
        if let Some(current_session_id) = session_id {
            emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
        }
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            finalize_interactive_runtime_state(state, session_id, "", Some("cancelled"));
            return Err("chat generation cancelled".to_string());
        }
        let turn_started_at = now_ms();
        append_debug_log_state(
            state,
            format!(
                "[timing][gemini-runtime][{}] turn-{}-request elapsed=0ms",
                trace_id, turn_index
            ),
        );

        if let Some(instruction) = forced_toolless_instruction {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        } else if tool_turn_limit_reached {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                TOOL_BUDGET_EXHAUSTED_MESSAGE.to_string(),
            );
        }

        let tools = if forcing_toolless_turn || tool_turn_limit_reached {
            Vec::new()
        } else {
            gemini_tools_for_session(state, runtime_mode, session_id)
        };
        let system_prompt = interactive_runtime_turn_system_prompt(state, session_id, runtime_mode);
        let contents = canonical_messages_to_gemini_contents(&prompt_messages);

        let mut body = json!({
            "system_instruction": {
                "parts": [{ "text": system_prompt }]
            },
            "contents": contents
        });
        if !tools.is_empty() {
            body["tools"] = json!(tools.clone());
            if is_wander && tool_turn == 1 {
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
        configure_background_command(&mut command);
        command
            .arg("-sS")
            .arg("-N")
            .arg("-X")
            .arg("POST")
            .arg(&endpoint)
            .arg("-H")
            .arg("Content-Type: application/json")
            .arg("-d")
            .arg(serde_json::to_string(&body).map_err(|error| error.to_string())?)
            .arg("-w")
            .arg(format!("\n{HTTP_STATUS_MARKER}%{{http_code}}"))
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
        let mut terminal_reason: Option<String> = None;
        let mut saw_done = false;
        let mut saw_eof = false;
        let mut http_status_code: Option<u16> = None;
        let mut raw_response_lines = Vec::<String>::new();

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
                saw_eof = true;
                break;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if let Some(status_text) = trimmed.strip_prefix(HTTP_STATUS_MARKER) {
                http_status_code = status_text.trim().parse::<u16>().ok();
                continue;
            }
            if trimmed.is_empty() {
                if event_data_lines.is_empty() {
                    continue;
                }
                let data = event_data_lines.join("\n");
                event_data_lines.clear();
                let trimmed_data = data.trim();
                if trimmed_data == "[DONE]" {
                    saw_done = true;
                    if terminal_reason.is_none() {
                        terminal_reason = Some("done".to_string());
                    }
                    break;
                }
                let payload = serde_json::from_str::<Value>(trimmed_data)
                    .map_err(|error| format!("Invalid Gemini SSE JSON: {error}"))?;
                let finish_reason = payload
                    .get("candidates")
                    .and_then(|value| value.as_array())
                    .and_then(|items| items.first())
                    .and_then(|candidate| candidate.get("finishReason"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                if !finish_reason.is_empty() {
                    terminal_reason = Some(finish_reason.to_string());
                }
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
                if matches!(
                    finish_reason,
                    "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION"
                ) {
                    break;
                }
                continue;
            }
            if let Some(value) = trimmed.strip_prefix("data:") {
                event_data_lines.push(value.trim().to_string());
            } else {
                raw_response_lines.push(trimmed.to_string());
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
        if let Some(status_code) = http_status_code.filter(|code| !(200..300).contains(code)) {
            let raw_body = raw_response_lines.join("\n");
            let details = http_error_details_from_text(status_code, &raw_body);
            append_debug_trace_state(
                state,
                format!(
                    "{} | runtimeMode={} model={}",
                    http_error_debug_line("ai-http", "POST", &endpoint, &details),
                    runtime_mode,
                    config.model_name,
                ),
            );
            return Err(format_http_error_message("AI request", &details));
        }
        append_debug_trace_state(
            state,
            format!(
                "[runtime][stream][gemini][{}] terminal_reason={} done={} eof={} content_chars={} tool_calls={} status_success={} stderr={}",
                session_id.unwrap_or("no-session"),
                terminal_reason.as_deref().unwrap_or("none"),
                saw_done,
                saw_eof,
                assistant_text.chars().count(),
                tool_calls.len(),
                status.success(),
                text_snippet(&stderr_text, 160),
            ),
        );

        append_debug_log_state(
            state,
            format!(
                "[timing][gemini-runtime][{}] turn-{}-response elapsed={}ms",
                trace_id,
                turn_index,
                now_ms().saturating_sub(turn_started_at)
            ),
        );

        if tool_calls.is_empty() {
            let final_content = append_generated_media_sections(
                &assistant_text,
                &generated_images,
                &generated_videos,
            );
            if final_content.trim().is_empty() {
                finalize_interactive_runtime_state(
                    state,
                    session_id,
                    &assistant_text,
                    Some("empty final response"),
                );
                return Err("interactive runtime returned an empty final response".to_string());
            }
            canonical_messages.push(canonical_text_message("assistant", final_content.clone()));
            save_runtime_session_bundle(
                state,
                session_id,
                "gemini",
                runtime_mode,
                &config.model_name,
                &canonical_messages,
            )?;
            finalize_interactive_runtime_state(state, session_id, &final_content, None);
            if let Some(current_session_id) = session_id {
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(current_session_id),
                    "chat.response_end",
                    "chat response completed",
                    Some(json!({ "content": final_content.clone() })),
                );
                emit_runtime_done(
                    app,
                    current_session_id,
                    "completed",
                    Some(runtime_mode),
                    Some(&final_content),
                    Some("response_end"),
                );
            }
            return Ok(final_content);
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
        append_prompt_and_canonical_message(
            &mut prompt_messages,
            &mut canonical_messages,
            canonical_assistant_message(assistant_text.clone(), &tool_calls),
        );
        let mut tool_round_digests = Vec::<InteractiveToolOutcomeDigest>::new();
        let mut skill_activation_names = Vec::<String>::new();
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
                Some(&call.id),
                &call.name,
                &call.arguments,
                Some(&model_config_value_from_resolved(config)),
            );
            match result {
                Ok(result_value) => {
                    let activated_skills =
                        interactive_skill_activation_names(&call.name, &result_value);
                    let (image_previews, video_previews) =
                        extract_generated_media_previews_from_tool_result(
                            &call.name,
                            &call.arguments,
                            &result_value,
                        );
                    generated_images.extend(image_previews);
                    generated_videos.extend(video_previews);
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
                    if let Some(session_id) = session_id {
                        let _ = with_store_mut(state, |store| {
                            let (runtime_id, parent_runtime_id, source_task_id) =
                                session_lineage_fields(store, session_id);
                            store.session_tool_results.push(SessionToolResultRecord {
                                id: make_id("tool-result"),
                                session_id: session_id.to_string(),
                                runtime_id,
                                parent_runtime_id,
                                source_task_id,
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
                                payload: Some(result_value.clone()),
                                created_at: now_i64(),
                                updated_at: now_i64(),
                            });
                            Ok(())
                        });
                    }
                    append_prompt_and_canonical_message(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        canonical_tool_result_message(
                            &call.id,
                            &call.name,
                            result_text.clone(),
                            true,
                        ),
                    );
                    skill_activation_names.extend(activated_skills);
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        &call.name,
                        &call.arguments,
                        true,
                        &result_text,
                    ));
                }
                Err(error) => {
                    emit_runtime_tool_result(app, session_id, &call.id, &call.name, false, &error);
                    append_prompt_and_canonical_message(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        canonical_tool_result_message(&call.id, &call.name, error.clone(), false),
                    );
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        &call.name,
                        &call.arguments,
                        false,
                        &error,
                    ));
                }
            }
            append_debug_log_state(
                state,
                format!(
                    "[timing][gemini-runtime][{}] turn-{}-tool-{} elapsed={}ms",
                    trace_id,
                    turn_index,
                    call.name,
                    now_ms().saturating_sub(tool_started_at)
                ),
            );
        }
        if let Some(instruction) =
            interactive_skill_activation_continuation(&skill_activation_names)
        {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        save_runtime_session_bundle(
            state,
            session_id,
            "gemini",
            runtime_mode,
            &config.model_name,
            &canonical_messages,
        )?;
        if let Some(reason) = loop_guard.observe_tool_round(&tool_round_digests) {
            emit_loop_guard_checkpoint(app, session_id, &reason, &tool_round_digests);
        }
    }

    Err("interactive runtime terminated unexpectedly".to_string())
}

fn run_openai_interactive_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    runtime_mode: &str,
) -> Result<String, String> {
    let (mut prompt_messages, mut canonical_messages) =
        interactive_runtime_message_bundle(state, session_id, message)?;
    let is_wander = runtime_mode == "wander";
    let provider_profile = provider_profile_from_config(config);
    let trace_id = session_id.unwrap_or(runtime_mode);
    let mut wander_saw_tool_call = false;
    let mut generated_images = Vec::<GeneratedMediaPreview>::new();
    let mut generated_videos = Vec::<GeneratedMediaPreview>::new();
    let mut loop_guard = InteractiveLoopGuard::default();
    let mut tool_turn = 0usize;
    let execution_contract = interactive_execution_contract(state, session_id);
    let mut execution_progress = InteractiveExecutionProgress::default();
    let mut execution_contract_nudge_count = 0usize;

    if let Some(instruction) = interactive_execution_contract_instruction(&execution_contract) {
        append_internal_runtime_user_message(
            &mut prompt_messages,
            &mut canonical_messages,
            instruction,
        );
    }

    while tool_turn < usize::MAX || loop_guard.has_pending_toolless_turn() {
        let forced_toolless_instruction = loop_guard.take_toolless_turn_message();
        let forcing_toolless_turn = forced_toolless_instruction.is_some();
        let tool_turn_limit_reached = tool_turn >= INTERACTIVE_MAX_TOOL_TURNS;
        let must_force_first_tool_turn =
            execution_contract.requires_tool_turn() && !forcing_toolless_turn && tool_turn == 0;
        if !forcing_toolless_turn && !tool_turn_limit_reached {
            tool_turn += 1;
        }
        let requires_forced_tool_choice =
            ((is_wander && tool_turn == 1) || must_force_first_tool_turn) && !forcing_toolless_turn;
        let disable_thinking_for_turn =
            provider_profile.should_disable_thinking(runtime_mode, requires_forced_tool_choice);
        let turn_index = tool_turn + usize::from(forcing_toolless_turn);
        if let Some(current_session_id) = session_id {
            emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
        }
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            finalize_interactive_runtime_state(state, session_id, "", Some("cancelled"));
            return Err("chat generation cancelled".to_string());
        }
        let turn_started_at = now_ms();
        append_debug_log_state(
            state,
            format!(
                "[timing][wander-runtime][{}] turn-{}-request elapsed=0ms | toolChoice={} thinkingDisabled={}",
                trace_id,
                turn_index,
                if forcing_toolless_turn {
                    "none"
                } else if (is_wander && tool_turn == 1) || must_force_first_tool_turn {
                    "required"
                } else if tool_turn_limit_reached {
                    "none"
                } else {
                    "auto"
                },
                disable_thinking_for_turn
            ),
        );
        if let Some(instruction) = forced_toolless_instruction {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        } else if tool_turn_limit_reached {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                TOOL_BUDGET_EXHAUSTED_MESSAGE.to_string(),
            );
        }
        let system_prompt = interactive_runtime_turn_system_prompt(state, session_id, runtime_mode);
        let mut messages = canonical_messages_to_openai_messages(&prompt_messages);
        messages.insert(
            0,
            json!({
                "role": "system",
                "content": system_prompt
            }),
        );
        let tool_choice = if forcing_toolless_turn {
            json!("none")
        } else if (is_wander && tool_turn == 1) || must_force_first_tool_turn {
            json!("required")
        } else if tool_turn_limit_reached {
            json!("none")
        } else {
            json!("auto")
        };
        let mut body = json!({
            "model": config.model_name,
            "messages": messages,
            "tools": if forcing_toolless_turn {
                json!([])
            } else {
                interactive_runtime_tools_for_mode(state, runtime_mode, session_id)
            },
            "tool_choice": tool_choice,
            "stream": !is_wander
        });
        if disable_thinking_for_turn {
            body["enable_thinking"] = json!(false);
        }
        if is_wander {
            body["temperature"] = json!(0.4);
            body["max_tokens"] = json!(900);
        }
        let streaming_enabled = !is_wander;
        let (assistant_content, tool_calls) = if streaming_enabled {
            let streamed = match run_openai_streaming_chat_completion(
                app,
                state,
                session_id,
                runtime_mode,
                config,
                &body,
                None,
                true,
            ) {
                Ok(value) => value,
                Err(error) => {
                    finalize_interactive_runtime_state(state, session_id, "", Some(&error));
                    return Err(error);
                }
            };
            (streamed.content, streamed.tool_calls)
        } else {
            let response =
                run_openai_json_chat_completion_transport(state, config, &body, None, true)?;
            let (assistant_content, tool_calls) =
                extract_openai_json_assistant_response(&response)?;
            (assistant_content, tool_calls)
        };
        if session_id
            .map(|value| is_chat_runtime_cancel_requested(state, value))
            .unwrap_or(false)
        {
            finalize_interactive_runtime_state(state, session_id, "", Some("cancelled"));
            return Err("chat generation cancelled".to_string());
        }
        append_debug_log_state(
            state,
            format!(
                "[timing][wander-runtime][{}] turn-{}-response elapsed={}ms",
                trace_id,
                turn_index,
                now_ms().saturating_sub(turn_started_at)
            ),
        );

        if tool_calls.is_empty() {
            let final_content = append_generated_media_sections(
                &assistant_content,
                &generated_images,
                &generated_videos,
            );
            if let Some(correction) =
                interactive_execution_contract_followup(&execution_contract, &execution_progress)
            {
                execution_contract_nudge_count += 1;
                if execution_contract_nudge_count >= 3 {
                    finalize_interactive_runtime_state(
                        state,
                        session_id,
                        &assistant_content,
                        Some("required tool execution was not completed"),
                    );
                    return Err(format!(
                        "interactive runtime ended before completing required execution steps: {}",
                        execution_contract
                            .missing_steps(&execution_progress)
                            .join("、")
                    ));
                }
                append_internal_runtime_user_message(
                    &mut prompt_messages,
                    &mut canonical_messages,
                    correction,
                );
                continue;
            }
            if is_wander && !wander_saw_tool_call && tool_turn < INTERACTIVE_MAX_TOOL_TURNS {
                let correction = "你上一轮没有完成任何有效文件读取。现在必须先调用 redbox_fs 读取给定素材路径中的真实文件，再输出最终 JSON。禁止继续给出泛化标题或空泛方向。";
                append_internal_runtime_user_message(
                    &mut prompt_messages,
                    &mut canonical_messages,
                    correction.to_string(),
                );
                continue;
            }
            if final_content.trim().is_empty() {
                finalize_interactive_runtime_state(
                    state,
                    session_id,
                    &assistant_content,
                    Some("empty final response"),
                );
                return Err("interactive runtime returned an empty final response".to_string());
            }
            canonical_messages.push(canonical_text_message("assistant", final_content.clone()));
            save_runtime_session_bundle(
                state,
                session_id,
                "openai",
                runtime_mode,
                &config.model_name,
                &canonical_messages,
            )?;
            finalize_interactive_runtime_state(state, session_id, &final_content, None);
            if streaming_enabled {
                if let Some(current_session_id) = session_id {
                    emit_runtime_task_checkpoint_saved(
                        app,
                        None,
                        Some(current_session_id),
                        "chat.response_end",
                        "chat response completed",
                        Some(json!({ "content": final_content.clone() })),
                    );
                    emit_runtime_done(
                        app,
                        current_session_id,
                        "completed",
                        Some(runtime_mode),
                        Some(&final_content),
                        Some("response_end"),
                    );
                }
            } else if let Some(current_session_id) = session_id {
                emit_runtime_task_checkpoint_saved(
                    app,
                    None,
                    Some(current_session_id),
                    "chat.response_end",
                    "chat response completed",
                    Some(json!({ "content": final_content.clone() })),
                );
                emit_runtime_done(
                    app,
                    current_session_id,
                    "completed",
                    Some(runtime_mode),
                    Some(&final_content),
                    Some("response_end"),
                );
            }
            return Ok(final_content);
        }

        wander_saw_tool_call = true;
        if !streaming_enabled && !assistant_content.trim().is_empty() {
            emit_runtime_text_delta(
                app,
                session_id.unwrap_or_default(),
                "thought",
                &assistant_content,
            );
        }
        if !streaming_enabled {
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
        }
        append_prompt_and_canonical_message(
            &mut prompt_messages,
            &mut canonical_messages,
            canonical_assistant_message(assistant_content.clone(), &tool_calls),
        );
        let mut tool_round_digests = Vec::<InteractiveToolOutcomeDigest>::new();
        let mut skill_activation_names = Vec::<String>::new();
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
                Some(&call.id),
                effective_tool_name,
                &effective_arguments,
                Some(&model_config_value_from_resolved(config)),
            );
            match result {
                Ok(result_value) => {
                    let activated_skills =
                        interactive_skill_activation_names(effective_tool_name, &result_value);
                    let (image_previews, video_previews) =
                        extract_generated_media_previews_from_tool_result(
                            effective_tool_name,
                            &effective_arguments,
                            &result_value,
                        );
                    generated_images.extend(image_previews);
                    generated_videos.extend(video_previews);
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
                            turn_index,
                            effective_tool_name,
                            now_ms().saturating_sub(tool_started_at)
                        ),
                    );
                    with_store_mut(state, |store| {
                        let target_session_id = session_id
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| latest_session_id(store));
                        let (runtime_id, parent_runtime_id, source_task_id) =
                            session_lineage_fields(store, &target_session_id);
                        store.session_tool_results.push(SessionToolResultRecord {
                            id: make_id("tool-result"),
                            session_id: target_session_id.clone(),
                            runtime_id,
                            parent_runtime_id,
                            source_task_id,
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
                                "arguments": effective_arguments.clone(),
                                "requestedToolName": call.name,
                                "result": result_value.clone()
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
                    append_prompt_and_canonical_message(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        canonical_tool_result_message(
                            &call.id,
                            effective_tool_name,
                            result_text.clone(),
                            true,
                        ),
                    );
                    interactive_execution_progress_observe_success(
                        &mut execution_progress,
                        &execution_contract,
                        effective_tool_name,
                        &effective_arguments,
                        &result_value,
                    );
                    execution_contract_nudge_count = 0;
                    skill_activation_names.extend(activated_skills);
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        effective_tool_name,
                        &effective_arguments,
                        true,
                        &result_text,
                    ));
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
                            turn_index,
                            effective_tool_name,
                            now_ms().saturating_sub(tool_started_at)
                        ),
                    );
                    with_store_mut(state, |store| {
                        let target_session_id = session_id
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| latest_session_id(store));
                        let (runtime_id, parent_runtime_id, source_task_id) =
                            session_lineage_fields(store, &target_session_id);
                        store.session_tool_results.push(SessionToolResultRecord {
                            id: make_id("tool-result"),
                            session_id: target_session_id.clone(),
                            runtime_id,
                            parent_runtime_id,
                            source_task_id,
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
                                "arguments": effective_arguments.clone(),
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
                    append_prompt_and_canonical_message(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        canonical_tool_result_message(
                            &call.id,
                            effective_tool_name,
                            failure_text.clone(),
                            false,
                        ),
                    );
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        effective_tool_name,
                        &effective_arguments,
                        false,
                        &failure_text,
                    ));
                }
            }
        }
        if let Some(instruction) =
            interactive_skill_activation_continuation(&skill_activation_names)
        {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        save_runtime_session_bundle(
            state,
            session_id,
            "openai",
            runtime_mode,
            &config.model_name,
            &canonical_messages,
        )?;
        if let Some(reason) = loop_guard.observe_tool_round(&tool_round_digests) {
            emit_loop_guard_checkpoint(app, session_id, &reason, &tool_round_digests);
        }
    }
    Err(if is_wander {
        "wander interactive runtime terminated unexpectedly".to_string()
    } else {
        "interactive runtime terminated unexpectedly".to_string()
    })
}

fn run_openai_prompted_json_fallback(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    runtime_mode: &str,
) -> Result<String, String> {
    let (prompt_messages, mut canonical_messages) =
        interactive_runtime_message_bundle(state, session_id, message)?;
    let provider_profile = provider_profile_from_config(config);
    let system_prompt = interactive_runtime_turn_system_prompt(state, session_id, runtime_mode);
    let mut messages = canonical_messages_to_openai_messages(&prompt_messages);
    messages.insert(
        0,
        json!({
            "role": "system",
            "content": system_prompt
        }),
    );

    if let Some(current_session_id) = session_id {
        emit_runtime_stream_start(app, current_session_id, "thinking", Some(runtime_mode));
    }

    let mut body = json!({
        "model": config.model_name,
        "messages": messages,
        "stream": false
    });
    if provider_profile.should_disable_thinking(runtime_mode, false) {
        body["enable_thinking"] = json!(false);
    }

    let response = run_openai_json_chat_completion_transport(state, config, &body, Some(90), true)?;
    let (final_content, tool_calls) = extract_openai_json_assistant_response(&response)?;
    if !tool_calls.is_empty() {
        finalize_interactive_runtime_state(
            state,
            session_id,
            &final_content,
            Some("json fallback returned tool calls"),
        );
        return Err("interactive json fallback returned tool calls".to_string());
    }
    if final_content.trim().is_empty() {
        finalize_interactive_runtime_state(
            state,
            session_id,
            &final_content,
            Some("empty fallback response"),
        );
        return Err("interactive fallback returned an empty response".to_string());
    }

    canonical_messages.push(canonical_text_message("assistant", final_content.clone()));
    save_runtime_session_bundle(
        state,
        session_id,
        "openai",
        runtime_mode,
        &config.model_name,
        &canonical_messages,
    )?;
    finalize_interactive_runtime_state(state, session_id, &final_content, None);

    if let Some(current_session_id) = session_id {
        emit_runtime_task_checkpoint_saved(
            app,
            None,
            Some(current_session_id),
            "chat.response_end",
            "chat response completed",
            Some(json!({ "content": final_content.clone() })),
        );
        emit_runtime_done(
            app,
            current_session_id,
            "completed",
            Some(runtime_mode),
            Some(&final_content),
            Some("json_fallback"),
        );
    }
    Ok(final_content)
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

fn run_model_text_task_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    prompt: &str,
) -> Result<String, String> {
    chat_helpers::run_model_text_task_with_settings(settings, model_config, prompt)
}

fn run_model_structured_task_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    chat_helpers::run_model_structured_task_with_settings(
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
async fn ipc_invoke(
    app: AppHandle,
    channel: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload_value = payload.unwrap_or(Value::Null);
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let managed_state = app_for_blocking.state::<AppState>();
        handle_channel(&app_for_blocking, &channel, payload_value, &managed_state)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result)
}

#[tauri::command]
async fn ipc_send(app: AppHandle, channel: String, payload: Option<Value>) -> Result<(), String> {
    let payload = payload.unwrap_or(Value::Null);
    if channel == "chat:send-message"
        || channel == "ai:start-chat"
        || channel == "wander:brainstorm"
        || channel == "chatrooms:send"
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
            } else if channel_name == "chatrooms:send" {
                if let Err(error) = handle_channel(
                    &app_handle,
                    &channel_name,
                    payload_value.clone(),
                    &managed_state,
                ) {
                    let room_id = payload_string(&payload_value, "roomId").unwrap_or_default();
                    emit_creative_chat_checkpoint(
                        &app_handle,
                        &room_id,
                        "creative_chat.error",
                        json!({
                            "roomId": room_id.clone(),
                            "message": error,
                        }),
                    );
                    emit_creative_chat_checkpoint(
                        &app_handle,
                        &room_id,
                        "creative_chat.done",
                        json!({ "roomId": room_id }),
                    );
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
                    Some(build_chat_error_payload(&error, session_id.clone())),
                );
            }
        });
        Ok(())
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            let managed_state = app.state::<AppState>();
            commands::chat::handle_send_channel(&app, &channel, payload, &managed_state)
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

const OFFICIAL_CACHE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

fn run_official_cache_refresher(app: AppHandle) -> JoinHandle<()> {
    thread::spawn(move || loop {
        let state = app.state::<AppState>();
        if auth::should_run_background_refresh(&state) {
            let _ = commands::official::trigger_official_cached_data_refresh(app.clone());
        }
        thread::sleep(OFFICIAL_CACHE_REFRESH_INTERVAL);
    })
}

fn run_ytdlp_auto_updater(app: AppHandle) -> JoinHandle<()> {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        if !desktop_io::should_auto_update_ytdlp(&state.store_path) {
            return;
        }
        let outcome = match desktop_io::detect_ytdlp() {
            Some((path, version)) => match desktop_io::ensure_ytdlp_installed(true) {
                Ok((updated_path, updated_version)) => {
                    let _ = app.emit(
                        "youtube:ytdlp-auto-update",
                        json!({
                            "success": true,
                            "previousPath": path,
                            "previousVersion": version,
                            "path": updated_path,
                            "version": updated_version
                        }),
                    );
                    format!("updated:{updated_path}:{updated_version}")
                }
                Err(error) => {
                    eprintln!("[RedBox yt-dlp auto update] {error}");
                    let _ = app.emit(
                        "youtube:ytdlp-auto-update",
                        json!({
                            "success": false,
                            "path": path,
                            "version": version,
                            "error": error
                        }),
                    );
                    format!("error:{error}")
                }
            },
            None => "skipped:not-installed".to_string(),
        };
        desktop_io::record_ytdlp_update_check(&state.store_path, &outcome);
    })
}

fn main() {
    let store_path = build_store_path();
    let mut store = load_store(&store_path);
    if let Err(error) = normalize_workspace_dir_setting(&mut store) {
        eprintln!("[RedBox workspace compatibility] {error}");
    }
    if let Err(error) = auth::migrate_legacy_auth_store(&store_path, &mut store) {
        eprintln!("[RedBox auth migrate] {error}");
    }
    let startup_migration_status = probe_startup_migration(&store, &store_path);
    sync_redclaw_job_definitions(&mut store);
    if let Err(error) = persist_store(&store_path, &store) {
        eprintln!("[RedBox store persist] {error}");
    }
    let initial_workspace_root =
        workspace_root_from_snapshot(&store.settings, &store.active_space_id, &store_path)
            .unwrap_or_else(|_| preferred_workspace_dir());
    let shared_store = Arc::new(Mutex::new(store));
    register_global_debug_store(Arc::clone(&shared_store));

    tauri::Builder::default()
        .manage(AppState {
            store_path,
            store: shared_store,
            workspace_root_cache: Mutex::new(initial_workspace_root),
            startup_migration: Mutex::new(startup_migration_status),
            store_persist_version: Arc::new(AtomicU64::new(0)),
            auth_runtime: Mutex::new(AuthRuntimeState::default()),
            official_auth_refresh_lock: Mutex::new(()),
            official_wechat_status_lock: Mutex::new(()),
            official_cache_refresh_inflight: AtomicBool::new(false),
            mcp_manager: mcp::McpManager::default(),
            chat_runtime_states: Mutex::new(std::collections::HashMap::new()),
            editor_runtime_states: Mutex::new(std::collections::HashMap::new()),
            active_chat_requests: Mutex::new(HashMap::new()),
            creative_chat_cancellations: Mutex::new(HashSet::new()),
            assistant_runtime: Mutex::new(None),
            assistant_sidecar: Mutex::new(None),
            redclaw_runtime: Mutex::new(None),
            runtime_warm: Mutex::new(RuntimeWarmState::default()),
            skill_watch: Mutex::new(skills::SkillWatcherSnapshot::default()),
            diagnostics: Mutex::new(DiagnosticsState::default()),
            knowledge_index_state: Mutex::new(
                knowledge_index::KnowledgeIndexRuntimeState::default(),
            ),
        })
        .invoke_handler(tauri::generate_handler![
            ipc_invoke,
            ipc_send,
            commands::spaces::spaces_list,
            commands::advisor_ops::advisors_list,
            commands::advisor_ops::advisors_list_templates,
            commands::library::knowledge_list,
            commands::library::knowledge_list_youtube,
            commands::library::knowledge_docs_list,
            commands::library::knowledge_list_page,
            commands::library::knowledge_get_item_detail,
            commands::library::knowledge_get_index_status,
            commands::library::knowledge_rebuild_catalog,
            commands::library::knowledge_open_index_root,
            commands::redclaw::redclaw_runner_status
        ])
        .setup(|app| {
            register_global_app_handle(app.handle().clone());
            let _ = app.emit("indexing:status", default_indexing_stats());
            let state = app.state::<AppState>();
            if let Err(error) = knowledge_index::initialize(app.handle(), &state) {
                eprintln!("[RedBox knowledge index init] {error}");
            }
            if let Err(error) = auth::initialize_auth_runtime(app.handle(), &state) {
                eprintln!("[RedBox auth init] {error}");
            }
            if let Err(error) = ensure_redclaw_profile_files(&state) {
                eprintln!("[RedBox redclaw profile init] {error}");
            }
            if let Err(error) =
                commands::redclaw::ensure_redclaw_runtime_running(app.handle(), &state)
            {
                eprintln!("[RedBox redclaw runtime restore] {error}");
            }
            if let Err(error) = commands::assistant_daemon::ensure_assistant_daemon_running(
                app.handle(),
                &state,
                true,
            ) {
                eprintln!("[RedBox assistant daemon restore] {error}");
            }
            if let Err(error) =
                refresh_runtime_warm_state(&state, &["wander", "redclaw", "chatroom"])
            {
                eprintln!("[RedBox runtime warmup] {error}");
            }
            {
                let auth_bootstrap_app = app.handle().clone();
                thread::spawn(move || {
                    let state = auth_bootstrap_app.state::<AppState>();
                    if let Err(error) = commands::official::bootstrap_official_auth_session(
                        &auth_bootstrap_app,
                        &state,
                        "app-setup",
                    ) {
                        if error != "官方账号未登录" {
                            eprintln!("[RedBox official auth bootstrap] {error}");
                        }
                    }
                });
            }
            let _ = run_official_cache_refresher(app.handle().clone());
            let _ = run_ytdlp_auto_updater(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run RedBox");
}
