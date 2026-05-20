#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod agent;
mod agent_hub;
mod app_shared;
mod assistant_core;
mod auth;
mod chat_binding;
mod chat_helpers;
mod chat_title;
mod cli_runtime;
mod commands;
mod desktop_io;
mod diagnostics;
mod document_ingest;
mod document_parse;
mod events;
mod ffmpeg_runtime;
mod helpers;
mod http_utils;
mod interactive_runtime_shared;
mod json_util;
mod knowledge;
mod knowledge_index;
mod legacy_import;
mod llm_transport;
pub(crate) mod logging;
mod manuscript_package;
mod mcp;
mod media_generation;
mod media_runtime;
mod media_task_context;
mod member_skill;
mod memory;
mod memory_maintenance;
mod model_config;
mod official_support;
mod persistence;
mod process_utils;
mod profile_learning;
mod provider_compat;
mod provider_runtime;
mod redclaw_profile;
mod runtime;
mod scheduler;
mod session_manager;
mod skills;
mod startup_migration;
mod subagents;
mod tools;
mod voice_service;
mod workspace_loaders;

use agent::{execute_prepared_wander_turn, PreparedWanderTurn};
use base64::Engine;
use commands::chat_state::{
    begin_chat_runtime_state, ensure_chat_session, is_chat_runtime_cancel_requested,
    latest_session_id, resolve_runtime_mode_for_session, update_chat_runtime_state,
};
use events::{
    emit_runtime_done, emit_runtime_stream_start, emit_runtime_task_checkpoint_saved,
    emit_runtime_text_delta, emit_runtime_tool_partial, emit_runtime_tool_request,
    emit_runtime_tool_result,
};
pub(crate) use ffmpeg_runtime::{ffmpeg_executable, ffmpeg_program};
use persistence::{
    build_store_path, ensure_store_hydrated_for_knowledge, hydrate_store_from_workspace_files,
    load_store, persist_store, with_store, with_store_mut,
};
use runtime::{
    append_session_checkpoint, infer_protocol, next_memory_maintenance_at_ms, resolve_chat_config,
    resolve_runtime_mode_from_context_type, role_sequence_for_route, runtime_error_payload,
    runtime_warm_settings_fingerprint, session_lineage_fields, session_title_from_message,
    ApprovalRuntimeState, CollabMailboxMessageRecord, CollabMemberRecord,
    CollabProgressReportRecord, CollabSessionRecord, CollabTaskRecord, InteractiveLoopGuard,
    InteractiveToolCall, InteractiveToolOutcomeDigest, McpServerRecord, RedclawJobDefinitionRecord,
    RedclawJobExecutionRecord, RedclawLongCycleTaskRecord, RedclawRuntime,
    RedclawScheduledTaskRecord, RedclawStateRecord, ResolvedChatConfig, ReviewDecisionRecord,
    ReviewDocketRecord, RuntimeHookRecord, RuntimeTaskRecord, RuntimeTaskTraceRecord,
    RuntimeWarmEntry, RuntimeWarmState, SessionCheckpointRecord, SessionToolResultRecord,
    SessionTranscriptRecord, SkillRecord,
};
use scheduler::sync_redclaw_job_definitions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Arc, Mutex, OnceLock,
};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use app_shared::*;
pub(crate) use assistant_core::*;
pub(crate) use auth::*;
pub(crate) use diagnostics::*;
pub(crate) use helpers::*;
pub(crate) use http_utils::*;
pub(crate) use legacy_import::*;
pub(crate) use manuscript_package::*;
pub(crate) use media_generation::*;
pub(crate) use memory_maintenance::*;
pub(crate) use official_support::*;
pub(crate) use process_utils::*;
pub(crate) use provider_compat::*;
pub(crate) use provider_runtime::*;
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
    video_path: Option<String>,
    voice_script: Option<String>,
    voice: Option<Value>,
    created_at: String,
    updated_at: String,
    absolute_image_paths: Vec<String>,
    preview_urls: Vec<String>,
    primary_preview_url: Option<String>,
    absolute_voice_path: Option<String>,
    voice_preview_url: Option<String>,
    absolute_video_path: Option<String>,
    video_preview_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSessionRecord {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
    #[serde(default)]
    starred: bool,
    #[serde(default)]
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    archived_at: Option<i64>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
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
    member_skill_ref: Option<String>,
    member_skill_status: Option<String>,
    member_skill_version: Option<String>,
    member_skill_last_distilled_at: Option<String>,
    member_skill_last_error: Option<String>,
    member_skill_candidate_version: Option<String>,
    member_skill_candidate_path: Option<String>,
    member_skill_candidate_created_at: Option<String>,
    member_skill_candidate_source_event: Option<String>,
    detected_knowledge_language: Option<String>,
    language_detection_status: Option<String>,
    language_confidence: Option<f64>,
    redclaw_visible: Option<bool>,
    redclaw_order: Option<i64>,
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
    knowledge_authors: Vec<KnowledgeAuthorRecord>,
    document_sources: Vec<DocumentKnowledgeSourceRecord>,
    session_transcript_records: Vec<SessionTranscriptRecord>,
    session_checkpoints: Vec<SessionCheckpointRecord>,
    session_tool_results: Vec<SessionToolResultRecord>,
    runtime_tasks: Vec<RuntimeTaskRecord>,
    runtime_task_traces: Vec<RuntimeTaskTraceRecord>,
    collab_sessions: Vec<CollabSessionRecord>,
    collab_members: Vec<CollabMemberRecord>,
    collab_tasks: Vec<CollabTaskRecord>,
    collab_mailbox_messages: Vec<CollabMailboxMessageRecord>,
    collab_progress_reports: Vec<CollabProgressReportRecord>,
    review_dockets: Vec<ReviewDocketRecord>,
    review_decisions: Vec<ReviewDecisionRecord>,
    cli_tools: Vec<cli_runtime::CliToolRecord>,
    cli_environments: Vec<cli_runtime::CliEnvironmentRecord>,
    cli_manifests: Vec<cli_runtime::CliToolManifestRecord>,
    cli_executions: Vec<cli_runtime::CliExecutionRecord>,
    cli_escalations: Vec<cli_runtime::CliEscalationRequestRecord>,
    cli_verifications: Vec<cli_runtime::CliVerificationRecord>,
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
            last_error: Some("Assistant daemon is idle.".to_string()),
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
    #[serde(default)]
    entities: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    source: Option<Value>,
    #[serde(default)]
    confidence: Option<f64>,
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
    author_id: Option<String>,
    author_url: Option<String>,
    author_avatar_url: Option<String>,
    author_description: Option<String>,
    content: String,
    excerpt: Option<String>,
    site_name: Option<String>,
    capture_kind: Option<String>,
    metadata: Option<Value>,
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
struct KnowledgeAuthorRecord {
    id: String,
    r#type: String,
    name: String,
    platform: String,
    platform_user_id: Option<String>,
    handle: Option<String>,
    profile_url: Option<String>,
    avatar_url: Option<String>,
    description: Option<String>,
    source_domain: Option<String>,
    linked_note_ids: Vec<String>,
    note_count: i64,
    first_seen_at: String,
    latest_note_at: Option<String>,
    created_at: String,
    updated_at: String,
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
    content_hash: Option<String>,
    relative_path: Option<String>,
    bound_manuscript_path: Option<String>,
    created_at: String,
    updated_at: String,
    absolute_path: Option<String>,
    preview_url: Option<String>,
    thumbnail_url: Option<String>,
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
    store_persist_scheduled: Arc<AtomicBool>,
    auth_runtime: Mutex<AuthRuntimeState>,
    official_auth_refresh_lock: Mutex<()>,
    official_wechat_status_lock: Mutex<()>,
    official_cache_refresh_inflight: AtomicBool,
    mcp_manager: mcp::McpManager,
    chat_runtime_states: Mutex<std::collections::HashMap<String, ChatRuntimeStateRecord>>,
    editor_runtime_states: Mutex<std::collections::HashMap<String, EditorRuntimeStateRecord>>,
    active_chat_requests: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    assistant_runtime: Mutex<Option<AssistantRuntime>>,
    assistant_sidecar: Mutex<Option<AssistantSidecarRuntime>>,
    redclaw_runtime: Mutex<Option<RedclawRuntime>>,
    media_generation_runtime: Mutex<Option<media_runtime::MediaGenerationRuntime>>,
    runtime_warm: Mutex<RuntimeWarmState>,
    approval_runtime: Mutex<ApprovalRuntimeState>,
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
    voice: Option<Value>,
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
    video: Option<SubjectMediaInput>,
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

pub(crate) fn refresh_runtime_warm_state(
    state: &State<'_, AppState>,
    modes: &[&str],
) -> Result<(), String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let workspace_root_value = workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let fingerprint = runtime_warm_settings_fingerprint(&settings_snapshot, &workspace_root_value);
    let mut warmed_entries = Vec::new();
    for mode in modes {
        let bundle =
            interactive_runtime_shared::interactive_runtime_context_bundle(state, mode, None);
        let entry = RuntimeWarmEntry {
            mode: (*mode).to_string(),
            system_prompt: bundle.system_prompt,
            model_config: if *mode == "wander" {
                Some(resolve_wander_model_config(&settings_snapshot))
            } else {
                None
            },
            context_bundle: bundle.summary,
            long_term_context: None,
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

pub(crate) fn normalized_structured_payload_arguments(arguments: &Value) -> Value {
    let Some(object) = arguments.as_object() else {
        return arguments.clone();
    };
    let Some(payload_text) = object
        .get("payload")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return arguments.clone();
    };
    let Ok(parsed_payload) = serde_json::from_str::<Value>(payload_text) else {
        return arguments.clone();
    };
    if !parsed_payload.is_object() {
        return arguments.clone();
    }
    let mut normalized = object.clone();
    normalized.insert("payload".to_string(), parsed_payload);
    Value::Object(normalized)
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
        .ok_or_else(|| format!("{} store root is unavailable", app_brand_display_name()))?
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
        root.join("assets"),
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
        "mp3" => ("audio/mpeg".to_string(), "audio".to_string(), true),
        "wav" => ("audio/wav".to_string(), "audio".to_string(), true),
        "m4a" => ("audio/mp4".to_string(), "audio".to_string(), true),
        "aac" => ("audio/aac".to_string(), "audio".to_string(), true),
        "ogg" => ("audio/ogg".to_string(), "audio".to_string(), true),
        "mp4" | "mov" | "mkv" | "avi" | "webm" => {
            ("video/*".to_string(), "video".to_string(), false)
        }
        "md" | "txt" | "json" | "csv" | "ts" | "tsx" | "js" | "jsx" | "html" | "css" => {
            ("text/plain".to_string(), "text".to_string(), true)
        }
        "pdf" => ("application/pdf".to_string(), "document".to_string(), false),
        "docx" => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
            "document".to_string(),
            false,
        ),
        "xlsx" => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
            "document".to_string(),
            false,
        ),
        "pptx" => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_string(),
            "document".to_string(),
            false,
        ),
        _ => (
            "application/octet-stream".to_string(),
            "binary".to_string(),
            false,
        ),
    }
}

fn video_thumbnail_key(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.display().to_string().hash(&mut hasher);
    if let Ok(metadata) = fs::metadata(path) {
        metadata.len().hash(&mut hasher);
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                duration.as_secs().hash(&mut hasher);
                duration.subsec_nanos().hash(&mut hasher);
            }
        }
    }
    format!("{:016x}", hasher.finish())
}

pub(crate) fn ensure_video_thumbnail_for_path(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    path: &Path,
) -> Option<String> {
    let normalized = normalize_legacy_workspace_path(path);
    let (_, kind, _) = guess_mime_and_kind(&normalized);
    eprintln!(
        "[video-thumbnail] request path={} normalized={} kind={} exists={}",
        path.display(),
        normalized.display(),
        kind,
        normalized.is_file()
    );
    if kind != "video" || !normalized.is_file() {
        append_debug_log_state(
            state,
            format!(
                "[video-thumbnail] skip path={} kind={} exists={}",
                normalized.display(),
                kind,
                normalized.is_file()
            ),
        );
        return None;
    }

    let thumbnail_dir = match media_root(state) {
        Ok(root) => root.join("thumbnails"),
        Err(error) => {
            eprintln!("[video-thumbnail] media root failed: {error}");
            append_debug_log_state(
                state,
                format!("[video-thumbnail] media root failed: {error}"),
            );
            return None;
        }
    };
    if let Err(error) = fs::create_dir_all(&thumbnail_dir) {
        eprintln!(
            "[video-thumbnail] create thumbnail dir failed dir={} error={error}",
            thumbnail_dir.display()
        );
        append_debug_log_state(
            state,
            format!(
                "[video-thumbnail] create thumbnail dir failed dir={} error={error}",
                thumbnail_dir.display()
            ),
        );
        return None;
    }
    let thumbnail_path = thumbnail_dir.join(format!("{}.jpg", video_thumbnail_key(&normalized)));
    if thumbnail_path.is_file() {
        eprintln!(
            "[video-thumbnail] cache hit source={} thumbnail={}",
            normalized.display(),
            thumbnail_path.display()
        );
        return Some(file_url_for_path(&thumbnail_path));
    }

    let ffmpeg_path = match ffmpeg_executable(app) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[video-thumbnail] ffmpeg resolve failed: {error}");
            append_debug_log_state(
                state,
                format!("[video-thumbnail] ffmpeg resolve failed: {error}"),
            );
            return None;
        }
    };
    eprintln!(
        "[video-thumbnail] run ffmpeg={} source={} output={}",
        ffmpeg_path.display(),
        normalized.display(),
        thumbnail_path.display()
    );
    let output = match std::process::Command::new(&ffmpeg_path)
        .args(["-v", "error", "-nostdin", "-y", "-ss", "00:00:00.5", "-i"])
        .arg(&normalized)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale='min(640,iw)':-2,format=yuvj420p",
            "-q:v",
            "3",
        ])
        .arg(&thumbnail_path)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[video-thumbnail] spawn failed: {error}");
            append_debug_log_state(state, format!("[video-thumbnail] spawn failed: {error}"));
            return None;
        }
    };
    if output.status.success() && thumbnail_path.is_file() {
        eprintln!(
            "[video-thumbnail] success source={} thumbnail={}",
            normalized.display(),
            thumbnail_path.display()
        );
        Some(file_url_for_path(&thumbnail_path))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        eprintln!(
            "[video-thumbnail] failed status={} source={} output={} stderr={}",
            output.status,
            normalized.display(),
            thumbnail_path.display(),
            stderr
        );
        append_debug_log_state(
            state,
            format!(
                "[video-thumbnail] failed status={} source={} output={} stderr={}",
                output.status,
                normalized.display(),
                thumbnail_path.display(),
                stderr
            ),
        );
        let _ = fs::remove_file(&thumbnail_path);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_generated_media_markdown, asset_preview_url_from_result,
        authoring_saved_final_summary, build_interactive_user_turn_messages,
        build_subject_record_for_workspace, clear_interactive_execution_contract_metadata,
        decode_command_json_stdout, guess_mime_and_kind, interactive_attachment_inline_data_url,
        interactive_base64_payload_size, interactive_execution_contract_instruction,
        interactive_execution_progress_observe_success, interactive_history_attachment_note,
        interactive_model_supports_direct_attachment, interactive_skill_activation_continuation,
        interactive_skill_activations, interactive_tool_panic_message,
        is_authoring_project_link_target, json_value_to_path_list,
        looks_like_authoring_status_summary, manuscript_save_result_path,
        message_is_successful_manuscript_write_tool_result, metadata_requires_voice_speech,
        normalized_structured_payload_arguments, persist_subjects_workspace,
        redbox_fs_profile_read_completed, resolve_local_path, structured_tool_error_code,
        validate_runtime_tool_message_sequence, workspace_read_directory_response,
        GeneratedMediaPreview, InteractiveExecutionContract, InteractiveExecutionProgress,
        SubjectAttribute, SubjectCategory, SubjectMediaInput, SubjectMutationInput, SubjectRecord,
        SubjectVoiceInput,
    };
    use serde_json::{json, Value};
    use std::fs;
    use std::path::Path;
    use std::time::Instant;

    #[test]
    fn guess_mime_and_kind_uses_svg_xml_mime() {
        let (mime_type, kind, direct_upload_eligible) = guess_mime_and_kind(Path::new("cover.svg"));
        assert_eq!(mime_type, "image/svg+xml");
        assert_eq!(kind, "image");
        assert!(direct_upload_eligible);
    }

    #[test]
    fn interactive_attachment_inline_data_url_reads_base64_payload() {
        let attachment = json!({
            "inlineDataUrl": "data:image/png;base64,aGVsbG8="
        });
        let (mime_type, base64_data) =
            interactive_attachment_inline_data_url(&attachment).expect("inline data url");
        assert_eq!(mime_type, "image/png");
        assert_eq!(base64_data, "aGVsbG8=");
        assert_eq!(interactive_base64_payload_size(&base64_data), 5);
    }

    #[test]
    fn interactive_model_supports_qwen35_image_direct_input() {
        assert!(interactive_model_supports_direct_attachment(
            "openai",
            "qwen3.5-plus",
            "image",
            "image/jpeg"
        ));
    }

    #[test]
    fn video_tool_read_attachment_prompt_names_required_operate_call() {
        let attachment = json!({
            "type": "uploaded-file",
            "name": "video.mp4",
            "kind": "video",
            "workspaceRelativePath": "knowledge/redbook/demo/video.mp4",
            "deliveryPlan": {
                "mode": "media-tool",
                "requiresTool": true,
                "toolPath": "knowledge/redbook/demo/video.mp4"
            }
        });

        let (prompt_message, history_message) = build_interactive_user_turn_messages(
            "分析一下这个视频",
            Some(&attachment),
            "openai",
            "qwen3.5-plus",
        )
        .expect("turn messages");
        let prompt = prompt_message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let history = history_message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();

        assert!(prompt.contains("Operate(resource=\"video\", operation=\"analyze\""));
        assert!(prompt.contains("\"toolPath\":\"knowledge/redbook/demo/video.mp4\""));
        assert!(prompt.contains("不要先用 `Read`、`bash`"));
        assert!(history.contains("Operate(resource=\"video\", operation=\"analyze\""));
        assert!(history.contains("不要用 Read/bash/meta.json 代替视频分析"));
    }

    #[test]
    fn video_history_attachment_note_keeps_tool_path() {
        let attachment = json!({
            "name": "video.mp4",
            "kind": "video",
            "workspaceRelativePath": "knowledge/redbook/demo/video.mp4"
        });
        let note =
            interactive_history_attachment_note(&attachment, false).expect("history attachment");

        assert!(note.contains("video.mp4"));
        assert!(note.contains("Operate(resource=\"video\", operation=\"analyze\""));
        assert!(note.contains("\"toolPath\":\"knowledge/redbook/demo/video.mp4\""));
    }

    #[test]
    fn direct_image_attachment_prompt_exposes_tool_reference() {
        let attachment = json!({
            "type": "uploaded-file",
            "name": "WechatIMG1615.jpg",
            "kind": "image",
            "mimeType": "image/jpeg",
            "deliveryMode": "direct-input",
            "absolutePath": "/Users/Jam/Downloads/WechatIMG1615.jpg",
            "size": 1234
        });

        let (prompt_message, history_message) = build_interactive_user_turn_messages(
            "做一个宣传视频",
            Some(&attachment),
            "openai",
            "qwen3.5-plus",
        )
        .expect("turn messages");
        let prompt = prompt_message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let history = history_message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();

        assert!(prompt.contains("referenceImages"));
        assert!(prompt.contains("/Users/Jam/Downloads/WechatIMG1615.jpg"));
        assert!(prompt.contains("按用户目标选择"));
        assert!(history.contains("referenceImages"));
        assert!(history.contains("/Users/Jam/Downloads/WechatIMG1615.jpg"));
    }

    #[test]
    fn redbox_fs_profile_read_completed_matches_workspace_profile_reads() {
        assert!(redbox_fs_profile_read_completed(&json!({
            "action": "read",
            "scope": "workspace",
            "path": "redclaw/profile/user.md"
        })));
        assert!(!redbox_fs_profile_read_completed(&json!({
            "action": "read",
            "scope": "workspace",
            "path": "notes/demo.md"
        })));
    }

    #[test]
    fn workspace_read_directory_response_lists_entries_without_error() {
        let root = std::env::temp_dir().join(format!(
            "redbox-read-directory-response-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&root).expect("create temp directory");
        fs::write(root.join("meta.json"), "{}").expect("write meta file");
        fs::write(root.join("transcript.txt"), "body").expect("write transcript file");

        let response =
            workspace_read_directory_response(&root, 10).expect("directory read response");
        assert_eq!(
            response.get("kind").and_then(Value::as_str),
            Some("directory")
        );
        assert_eq!(
            response.get("isDirectory").and_then(Value::as_bool),
            Some(true)
        );
        let content = response
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(content.contains("meta.json"));
        assert!(content.contains("transcript.txt"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn subjects_workspace_roundtrip_persists_catalog_categories_and_assets() {
        let root =
            std::env::temp_dir().join(format!("redbox-subjects-roundtrip-{}", crate::now_ms()));
        let subjects_root = root.join("assets");
        let category = SubjectCategory {
            id: "category-test".to_string(),
            name: "测试分类".to_string(),
            created_at: "2026-04-28T00:00:00Z".to_string(),
            updated_at: "2026-04-28T00:00:00Z".to_string(),
        };
        let input = SubjectMutationInput {
            id: Some("subject-test".to_string()),
            name: "测试资产".to_string(),
            category_id: Some(category.id.clone()),
            description: Some("描述".to_string()),
            tags: Some(vec!["标签".to_string()]),
            attributes: Some(vec![SubjectAttribute {
                key: "颜色".to_string(),
                value: "红色".to_string(),
            }]),
            images: Some(vec![SubjectMediaInput {
                relative_path: None,
                data_url: Some("data:image/png;base64,aGVsbG8=".to_string()),
                name: Some("portrait.png".to_string()),
            }]),
            voice: Some(SubjectVoiceInput {
                relative_path: None,
                data_url: Some("data:audio/webm;base64,aGVsbG8=".to_string()),
                name: Some("voice.webm".to_string()),
                script_text: Some("声音脚本".to_string()),
                voice: None,
            }),
            video: Some(SubjectMediaInput {
                relative_path: None,
                data_url: Some("data:video/mp4;base64,aGVsbG8=".to_string()),
                name: Some("talking-head.mp4".to_string()),
            }),
        };
        let subject =
            build_subject_record_for_workspace(&subjects_root, input, None).expect("build subject");

        persist_subjects_workspace(&subjects_root, &[category.clone()], &[subject.clone()])
            .expect("persist subjects workspace");

        let categories = crate::workspace_loaders::load_subject_categories_from_fs(&subjects_root);
        let subjects = crate::workspace_loaders::load_subjects_from_fs(&subjects_root);
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].name, "测试分类");
        assert_eq!(subjects.len(), 1);
        assert_eq!(subjects[0].name, "测试资产");
        assert_eq!(subjects[0].category_id.as_deref(), Some("category-test"));
        assert_eq!(subjects[0].image_paths.len(), 1);
        assert!(subjects_root
            .join("subject-test")
            .join(&subjects[0].image_paths[0])
            .exists());
        assert!(subjects[0].voice_path.is_some());
        assert!(subjects[0].video_path.is_some());
        assert!(subjects[0].primary_preview_url.is_some());
        assert!(subjects[0].voice_preview_url.is_some());
        assert!(subjects[0].video_preview_url.is_some());

        let updated = SubjectRecord {
            name: "更新资产".to_string(),
            image_paths: Vec::new(),
            absolute_image_paths: Vec::new(),
            preview_urls: Vec::new(),
            primary_preview_url: None,
            voice_path: None,
            video_path: None,
            absolute_voice_path: None,
            voice_preview_url: None,
            absolute_video_path: None,
            video_preview_url: None,
            voice: None,
            ..subject
        };
        persist_subjects_workspace(&subjects_root, &[category], &[updated])
            .expect("persist updated subjects workspace");
        let subjects = crate::workspace_loaders::load_subjects_from_fs(&subjects_root);
        assert_eq!(subjects.len(), 1);
        assert_eq!(subjects[0].name, "更新资产");
        assert!(subjects[0].image_paths.is_empty());

        persist_subjects_workspace(&subjects_root, &[], &[])
            .expect("persist empty subjects workspace");
        let categories = crate::workspace_loaders::load_subject_categories_from_fs(&subjects_root);
        let subjects = crate::workspace_loaders::load_subjects_from_fs(&subjects_root);
        assert!(categories.is_empty());
        assert!(subjects.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn subjects_workspace_bench_persists_and_loads_large_catalog() {
        let root = std::env::temp_dir().join(format!("redbox-subjects-bench-{}", crate::now_ms()));
        let subjects_root = root.join("assets");
        let categories = (0..25)
            .map(|index| SubjectCategory {
                id: format!("category-{index}"),
                name: format!("分类 {index}"),
                created_at: "2026-04-28T00:00:00Z".to_string(),
                updated_at: "2026-04-28T00:00:00Z".to_string(),
            })
            .collect::<Vec<_>>();
        let subjects = (0..1000)
            .map(|index| {
                let record = SubjectRecord {
                    id: format!("subject-{index}"),
                    name: format!("资产 {index}"),
                    category_id: Some(format!("category-{}", index % categories.len())),
                    description: Some(format!("资产描述 {index}")),
                    tags: vec!["bench".to_string(), format!("tag-{}", index % 10)],
                    attributes: vec![SubjectAttribute {
                        key: "序号".to_string(),
                        value: index.to_string(),
                    }],
                    image_paths: Vec::new(),
                    voice_path: None,
                    video_path: None,
                    voice_script: None,
                    voice: None,
                    created_at: "2026-04-28T00:00:00Z".to_string(),
                    updated_at: "2026-04-28T00:00:00Z".to_string(),
                    absolute_image_paths: Vec::new(),
                    preview_urls: Vec::new(),
                    primary_preview_url: None,
                    absolute_voice_path: None,
                    voice_preview_url: None,
                    absolute_video_path: None,
                    video_preview_url: None,
                };
                super::hydrated_subject_record(&subjects_root, record)
            })
            .collect::<Vec<_>>();

        let persist_start = Instant::now();
        persist_subjects_workspace(&subjects_root, &categories, &subjects)
            .expect("persist large subjects workspace");
        let persist_elapsed = persist_start.elapsed();

        let load_start = Instant::now();
        let loaded_categories =
            crate::workspace_loaders::load_subject_categories_from_fs(&subjects_root);
        let loaded_subjects = crate::workspace_loaders::load_subjects_from_fs(&subjects_root);
        let load_elapsed = load_start.elapsed();

        eprintln!(
            "subjects bench: persist={}ms load={}ms subjects={} categories={}",
            persist_elapsed.as_millis(),
            load_elapsed.as_millis(),
            loaded_subjects.len(),
            loaded_categories.len()
        );
        assert_eq!(loaded_categories.len(), categories.len());
        assert_eq!(loaded_subjects.len(), subjects.len());
        assert!(
            persist_elapsed.as_millis() < 3000,
            "persisting 1000 subjects should stay comfortably interactive"
        );
        assert!(
            load_elapsed.as_millis() < 1000,
            "loading 1000 subjects should stay fast for refresh"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manuscript_save_result_path_prefers_new_path() {
        assert_eq!(
            manuscript_save_result_path(&json!({
                "success": true,
                "newPath": "wander/demo"
            })),
            Some("wander/demo")
        );
        assert_eq!(
            manuscript_save_result_path(&json!({
                "success": true,
                "projectPath": "wander/demo"
            })),
            Some("wander/demo")
        );
    }

    #[test]
    fn interactive_tool_panic_message_keeps_string_payload() {
        let message = interactive_tool_panic_message(
            "workflow",
            Box::new("memory list exploded".to_string()),
        );
        assert!(message.contains("workflow"));
        assert!(message.contains("memory list exploded"));
    }

    #[test]
    fn interactive_tool_panic_message_handles_unknown_payload() {
        let message = interactive_tool_panic_message("workflow", Box::new(42usize));
        assert_eq!(message, "工具 workflow 执行时发生 panic");
    }

    #[test]
    fn structured_tool_error_code_reads_envelope_code() {
        let code = structured_tool_error_code(
            r#"{
                "ok": false,
                "action": "memory.search",
                "error": {
                    "code": "ACTION_FAILED",
                    "message": "backend unavailable",
                    "retryable": true
                }
            }"#,
        );
        assert_eq!(code.as_deref(), Some("ACTION_FAILED"));
    }

    #[test]
    fn normalized_structured_payload_arguments_parses_stringified_payload_object() {
        let normalized = normalized_structured_payload_arguments(&json!({
            "action": "workspace.list",
            "payload": "{\"path\":\"knowledge/demo\",\"limit\":12}"
        }));
        assert_eq!(
            normalized.pointer("/payload/path"),
            Some(&json!("knowledge/demo"))
        );
        assert_eq!(normalized.pointer("/payload/limit"), Some(&json!(12)));
    }

    #[test]
    fn interactive_execution_progress_counts_knowledge_read_as_source_read() {
        let mut progress = InteractiveExecutionProgress::default();
        let contract = InteractiveExecutionContract {
            require_source_read: true,
            ..Default::default()
        };
        interactive_execution_progress_observe_success(
            &mut progress,
            &contract,
            "resource",
            &json!({
                "action": "knowledge.read",
                "path": "knowledge/demo/content.md"
            }),
            &json!({
                "ok": true
            }),
        );
        assert!(progress.source_read_completed);
    }

    #[test]
    fn interactive_execution_progress_counts_write_current_as_save() {
        let mut progress = InteractiveExecutionProgress::default();
        let contract = InteractiveExecutionContract {
            require_save: true,
            ..Default::default()
        };
        interactive_execution_progress_observe_success(
            &mut progress,
            &contract,
            "Write",
            &json!({
                "path": "manuscripts://current",
                "content": "正文"
            }),
            &json!({
                "ok": true,
                "data": {
                    "projectPath": "wander/demo",
                    "result": {
                        "content": "正文"
                    }
                }
            }),
        );

        assert!(progress.save_completed);
        assert_eq!(progress.saved_project_path.as_deref(), Some("wander/demo"));
        assert_eq!(progress.saved_content.as_deref(), Some("正文"));
    }

    #[test]
    fn generation_agent_audio_metadata_requires_voice_speech() {
        assert!(metadata_requires_voice_speech(&json!({
            "contextType": "generation-agent",
            "generationTarget": "audio"
        })));
        assert!(!metadata_requires_voice_speech(&json!({
            "contextType": "generation-agent",
            "generationTarget": "image"
        })));
        assert!(!metadata_requires_voice_speech(&json!({
            "contextType": "redclaw",
            "generationTarget": "audio"
        })));
    }

    #[test]
    fn interactive_execution_progress_counts_voice_speech_as_audio_completion() {
        let mut progress = InteractiveExecutionProgress::default();
        let contract = InteractiveExecutionContract {
            require_voice_speech: true,
            ..Default::default()
        };
        interactive_execution_progress_observe_success(
            &mut progress,
            &contract,
            "workflow",
            &json!({
                "action": "voice.speech",
                "payload": {
                    "model": "cosyvoice-v3.5-plus",
                    "voiceId": "voice_demo"
                }
            }),
            &json!({
                "ok": true,
                "action": "voice.speech",
                "data": {
                    "relativePath": "generated/tts/demo.mp3"
                }
            }),
        );

        assert!(progress.voice_speech_completed);
        assert!(contract.missing_steps(&progress).is_empty());
    }

    #[test]
    fn authoring_status_summary_is_not_auto_save_content() {
        assert!(looks_like_authoring_status_summary(
            "稿件已保存成功。\n\n**运行总结：**\n- 已保存\n\n**稿件链接：**\n[demo](workspace://wander/demo/content.md)"
        ));
        assert!(!looks_like_authoring_status_summary(
            "别用 AI 提效了\n\n这是文章正文第一段。"
        ));
    }

    #[test]
    fn clear_interactive_execution_contract_metadata_removes_task_scoped_fields_only() {
        let mut metadata = json!({
            "contextType": "redclaw",
            "initialContext": "space bootstrap",
            "taskHints": {
                "intent": "manuscript_creation",
                "requireSourceRead": true,
                "requireProfileRead": true,
                "requireSave": true
            },
            "intent": "manuscript_creation",
            "platform": "xiaohongshu",
            "taskType": "direct_write",
            "formatTarget": "markdown",
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "writeTarget": "manuscripts://current",
            "requiredSkill": "writing-style",
            "allowedTools": ["resource", "workflow"],
            "allowedAppCliActions": ["manuscripts.writeCurrent", "skills.invoke"],
            "allowedOperateActions": ["skills.invoke", "manuscripts.createProject"],
            "allowedWriteTargets": ["manuscripts://current"],
            "saveSubdir": "wander",
            "deferredDiscovery": false,
            "teamEscalation": "disabled",
            "sourceMode": "knowledge",
            "currentAuthoringProjectPath": "wander/demo",
            "currentAuthoringContentPath": "wander/demo/content.md"
        })
        .as_object()
        .cloned()
        .expect("metadata object");

        assert!(clear_interactive_execution_contract_metadata(&mut metadata));

        for field in [
            "taskHints",
            "intent",
            "platform",
            "taskType",
            "formatTarget",
            "executionProfile",
            "artifactType",
            "writeTarget",
            "requiredSkill",
            "allowedTools",
            "allowedAppCliActions",
            "allowedOperateActions",
            "allowedWriteTargets",
            "saveSubdir",
            "deferredDiscovery",
            "teamEscalation",
            "sourceMode",
        ] {
            assert!(metadata.get(field).is_none(), "{field} should be cleared");
        }
        assert_eq!(metadata.get("contextType"), Some(&json!("redclaw")));
        assert_eq!(
            metadata.get("initialContext"),
            Some(&json!("space bootstrap"))
        );
        assert_eq!(
            metadata.get("currentAuthoringProjectPath"),
            Some(&json!("wander/demo"))
        );
        assert_eq!(
            metadata.get("currentAuthoringContentPath"),
            Some(&json!("wander/demo/content.md"))
        );
    }

    #[test]
    fn interactive_execution_contract_instruction_keeps_body_out_of_final_reply() {
        let instruction =
            interactive_execution_contract_instruction(&InteractiveExecutionContract {
                require_source_read: true,
                require_profile_read: true,
                require_save: true,
                save_artifact: Some("folder".to_string()),
                ..Default::default()
            })
            .expect("instruction should be generated");

        assert!(instruction.contains("保存到 文件夹稿件"));
        assert!(instruction.contains("正文只能作为 Write 工具参数提交"));
        assert!(instruction.contains("最终回复只给运行总结和稿件链接"));
        assert!(!instruction.contains("先输出完整正文"));
    }

    #[test]
    fn message_is_successful_manuscript_write_tool_result_matches_structured_result() {
        assert!(message_is_successful_manuscript_write_tool_result(&json!({
            "role": "tool",
            "tool_name": "workflow",
            "content": r#"{
                "ok": true,
                "tool": "workflow",
                "action": "manuscripts.writeCurrent",
                "data": {
                    "projectPath": "wander/demo",
                    "savedBytes": 12
                }
            }"#
        })));
        assert!(!message_is_successful_manuscript_write_tool_result(
            &json!({
                "role": "tool",
                "tool_name": "workflow",
                "content": r#"{
                "ok": true,
                "tool": "workflow",
                "action": "manuscripts.writeCurrent",
                "data": {
                    "projectPath": "wander/demo",
                    "savedBytes": 0
                }
            }"#
            })
        ));
        assert!(!message_is_successful_manuscript_write_tool_result(
            &json!({
                "role": "tool",
                "tool_name": "workflow",
                "content": r#"{
                "ok": true,
                "tool": "workflow",
                "action": "manuscripts.createProject"
            }"#
            })
        ));
    }

    #[test]
    fn authoring_saved_final_summary_links_folder_project_without_full_body() {
        let content = "# 别做摘要了，把播客印成书\n\n这是一段完整正文。";
        let summary = authoring_saved_final_summary("wander/别做摘要了", content);

        assert!(summary.contains("已完成创作并保存为稿件"));
        assert!(summary.contains("标题：别做摘要了，把播客印成书"));
        assert!(summary.contains("[别做摘要了](<manuscripts://wander/别做摘要了>)"));
        assert!(!summary.contains("这是一段完整正文"));
    }

    #[test]
    fn authoring_saved_final_summary_wraps_spaced_virtual_path() {
        let content = "别用 AI 提效了，用它做个只有你会做出来的东西\n\n正文。";
        let summary = authoring_saved_final_summary(
            "wander/别用 AI 提效了，用它做个只有你会做出来的东西-1778213490701",
            content,
        );

        assert!(summary.contains("标题：别用 AI 提效了，用它做个只有你会做出来的东西"));
        assert!(summary.contains(
            "[别用 AI 提效了，用它做个只有你会做出来的东西-1778213490701](<manuscripts://wander/别用 AI 提效了，用它做个只有你会做出来的东西-1778213490701>)"
        ));
    }

    #[test]
    fn authoring_project_link_target_accepts_folder_projects() {
        assert!(is_authoring_project_link_target("wander/demo"));
        assert!(is_authoring_project_link_target("articles/demo"));
        assert!(!is_authoring_project_link_target("wander/demo.md"));
    }

    #[test]
    fn json_value_to_path_list_accepts_single_string_payload() {
        let items = json_value_to_path_list(&json!("C:\\Knowledge"));
        assert_eq!(items, vec![std::path::PathBuf::from("C:\\Knowledge")]);
    }

    #[test]
    fn json_value_to_path_list_accepts_array_payload() {
        let items = json_value_to_path_list(&json!(["C:\\A", "C:\\B"]));
        assert_eq!(
            items,
            vec![
                std::path::PathBuf::from("C:\\A"),
                std::path::PathBuf::from("C:\\B")
            ]
        );
    }

    #[test]
    fn decode_command_json_stdout_accepts_utf8_json() {
        let decoded = decode_command_json_stdout(br#"["C:\\RedBox\\cover.png"]"#);
        assert_eq!(decoded, r#"["C:\\RedBox\\cover.png"]"#);
    }

    #[test]
    fn decode_command_json_stdout_accepts_utf16le_json() {
        let utf16 = r#"["C:\\RedBox\\cover.png"]"#
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect::<Vec<_>>();
        let decoded = decode_command_json_stdout(&utf16);
        assert_eq!(decoded, r#"["C:\\RedBox\\cover.png"]"#);
    }

    #[test]
    fn append_generated_media_markdown_wraps_windows_urls_for_markdown() {
        let markdown = append_generated_media_markdown(
            "",
            "## 生成图片",
            &[GeneratedMediaPreview {
                id: "asset-1".to_string(),
                preview_url: "file:///C:/Users/Jam/My Images/cover (1).png".to_string(),
            }],
        );
        assert!(markdown.contains("![generated-1](<file:///C:/Users/Jam/My Images/cover (1).png>)"));
    }

    #[test]
    fn asset_preview_url_from_result_normalizes_windows_preview_path() {
        let asset = json!({
            "previewUrl": r#"C:\Users\Jam\.redconvert\spaces\default\media\generated\demo 1.png"#
        });
        let preview = asset_preview_url_from_result(&asset, "image");
        assert_eq!(
            preview.as_deref(),
            Some("file:///C:/Users/Jam/.redconvert/spaces/default/media/generated/demo%201.png")
        );
    }

    #[test]
    fn resolve_local_path_decodes_file_url_spaces() {
        let path = resolve_local_path("file:///Users/Jam/My%20Images/demo%201.png")
            .expect("file url path");
        assert_eq!(
            path,
            std::path::PathBuf::from("/Users/Jam/My Images/demo 1.png")
        );
    }

    #[test]
    fn resolve_local_path_accepts_local_file_and_redbox_asset_urls() {
        let legacy = resolve_local_path("local-file:///Users/Jam/My%20Images/demo%201.png")
            .expect("legacy local file url path");
        assert_eq!(
            legacy,
            std::path::PathBuf::from("/Users/Jam/My Images/demo 1.png")
        );

        let asset =
            resolve_local_path("redbox-asset://asset/%2FUsers%2FJam%2FMy%20Images%2Fdemo%201.png")
                .expect("redbox asset path");
        assert_eq!(
            asset,
            std::path::PathBuf::from("/Users/Jam/My Images/demo 1.png")
        );
    }

    #[test]
    fn resolve_local_path_decodes_windows_file_url_with_unicode_user() {
        let path = resolve_local_path("file:///C:/Users/%E5%BC%A0%E4%B8%89/RedBox/demo%201.png")
            .expect("windows file url path");
        let expected =
            ["C:", "Users", "张三", "RedBox", "demo 1.png"].join(std::path::MAIN_SEPARATOR_STR);
        assert_eq!(path.to_string_lossy(), expected);
    }

    #[test]
    fn resolve_local_path_decodes_redbox_asset_windows_path_with_unicode_user() {
        let encoded = urlencoding::encode(r#"C:\Users\张三\RedBox\demo 1.png"#);
        let path = resolve_local_path(&format!("redbox-asset://asset/{encoded}"))
            .expect("redbox asset windows path");
        let expected =
            ["C:", "Users", "张三", "RedBox", "demo 1.png"].join(std::path::MAIN_SEPARATOR_STR);
        assert_eq!(path.to_string_lossy(), expected);
    }

    #[test]
    fn validate_runtime_tool_message_sequence_accepts_paired_messages() {
        let messages = vec![
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "resource",
                        "arguments": "{}"
                    }
                }]
            }),
            json!({
                "role": "tool",
                "tool_call_id": "call-1",
                "tool_name": "resource",
                "content": "{\"ok\":true}"
            }),
        ];

        assert!(validate_runtime_tool_message_sequence(&messages).is_ok());
    }

    #[test]
    fn validate_runtime_tool_message_sequence_rejects_orphan_tool_results() {
        let messages = vec![json!({
            "role": "tool",
            "tool_call_id": "call-orphan",
            "tool_name": "resource",
            "content": "{\"ok\":true}"
        })];

        let error = validate_runtime_tool_message_sequence(&messages)
            .expect_err("orphan tool results should be rejected");
        assert!(error.contains("call-orphan"));
    }

    #[test]
    fn interactive_skill_activations_keep_turn_scope_out_of_session_copy() {
        let activations = interactive_skill_activations(
            "workflow",
            &json!({
                "data": {
                    "description": "writing helper",
                    "persistedToSession": false,
                    "activationTransition": {
                        "continueWithUpdatedContext": true,
                        "activatedSkillNames": ["writing-style"]
                    }
                }
            }),
        );
        assert_eq!(activations.len(), 1);
        assert_eq!(activations[0].name, "writing-style");
        assert!(!activations[0].persisted_to_session);

        let continuation = interactive_skill_activation_continuation(&activations)
            .expect("continuation should exist");
        assert!(continuation.contains("加入当前轮上下文"));
        assert!(!continuation.contains("写入当前会话"));
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
    let stdout = decode_command_json_stdout(&output.stdout)
        .trim()
        .to_string();
    if stdout.is_empty() {
        return Ok(json!([]));
    }
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid powershell JSON: {error}"))
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(any(target_os = "windows", test))]
fn decode_command_json_stdout(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16_stdout(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16_stdout(&bytes[2..], false);
    }

    if bytes.len() >= 2 {
        let even_nuls = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();
        let odd_nuls = bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count();
        let pair_count = bytes.len() / 2;
        if pair_count > 0 {
            if odd_nuls * 2 >= pair_count {
                return decode_utf16_stdout(bytes, true);
            }
            if even_nuls * 2 >= pair_count {
                return decode_utf16_stdout(bytes, false);
            }
        }
    }

    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(any(target_os = "windows", test))]
fn decode_utf16_stdout(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn json_value_to_path_list(value: &Value) -> Vec<PathBuf> {
    match value {
        Value::String(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![PathBuf::from(trimmed)]
            }
        }
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(PathBuf::from)
            .collect(),
        _ => Vec::new(),
    }
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
        let items = json_value_to_path_list(&value);
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
        let items = json_value_to_path_list(&value);
        return Ok(items);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = prompt;
        let _ = folders_only;
        let _ = multiple;
        Err(format!(
            "{} picker currently supports macOS and Windows",
            app_brand_display_name()
        ))
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
        Err(format!(
            "{} save picker currently supports macOS and Windows",
            app_brand_display_name()
        ))
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

fn file_content_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
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

fn load_knowledge_authors_from_fs(knowledge_root: &Path) -> Vec<KnowledgeAuthorRecord> {
    workspace_loaders::load_knowledge_authors_from_fs(knowledge_root)
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
    logging::emit_legacy_line(
        logging::event::LogSource::Host,
        logging::event::LogLevel::Info,
        "app.lifecycle",
        "legacy.trace",
        line.clone(),
        Value::Null,
        Some(line.clone()),
    );
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
    if let Ok(store) = state.store.lock() {
        if !is_debug_log_enabled(&store) {
            return;
        }
    }
    logging::emit_legacy_line(
        logging::event::LogSource::Host,
        logging::event::LogLevel::Debug,
        "app.lifecycle",
        "legacy.debug",
        line.clone(),
        Value::Null,
        Some(line),
    );
}

pub(crate) fn append_debug_trace_state(state: &State<'_, AppState>, line: impl Into<String>) {
    let line = format!("{} | {}", now_iso(), line.into());
    logging::emit_legacy_line(
        logging::event::LogSource::Host,
        logging::event::LogLevel::Info,
        "app.lifecycle",
        "legacy.trace",
        line.clone(),
        Value::Null,
        Some(line.clone()),
    );
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
    append_debug_trace_state(state, line);
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
        "{}:{}:{}:{}",
        store.knowledge_notes.len(),
        store.knowledge_authors.len(),
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

fn resolve_wander_model_config(_settings: &Value) -> Value {
    json!({
        "runtimeMode": "wander"
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
  <text x="164" y="1097" fill="#191919" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">App Placeholder</text>
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

fn reject_parent_directory_traversal(raw_path: &str) -> Result<(), String> {
    if Path::new(raw_path)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("parent directory traversal is not allowed".to_string());
    }
    Ok(())
}

fn workspace_read_directory_response(path: &Path, limit: usize) -> Result<Value, String> {
    let entries = list_directory_entries(path, limit)?;
    let entry_names = entries
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?;
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(format!("- {name} ({kind})"))
        })
        .collect::<Vec<_>>();
    let content = format!(
        "This path is a directory, not a readable file. Use List(path=\"{}\") to inspect it, then call Read(path=\"<one concrete file path>\"). For knowledge material folders, start with meta.json and the main transcript/content file when present.\n\nEntries:\n{}",
        path.display(),
        if entry_names.is_empty() {
            "(empty)".to_string()
        } else {
            entry_names.join("\n")
        }
    );
    Ok(json!({
        "path": path.display().to_string(),
        "kind": "directory",
        "isDirectory": true,
        "message": "Read received a directory path. Choose a concrete file from entries and call Read again.",
        "nextAction": "Read one concrete file path, such as meta.json or the transcript/content file.",
        "entries": entries,
        "content": content
    }))
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
    let mut value = json!({
        "baseURL": config.base_url,
        "apiKey": config.api_key,
        "modelName": config.model_name,
        "protocol": config.protocol
    });
    if let Some(reasoning_effort) = config.reasoning_effort.as_ref() {
        value["reasoningEffort"] = json!(reasoning_effort);
    }
    value
}

fn openai_reasoning_effort_default(config: &ResolvedChatConfig) -> Option<&'static str> {
    let protocol = config.protocol.trim().to_ascii_lowercase();
    if protocol != "openai" {
        return None;
    }
    let base_url = config.base_url.trim().to_ascii_lowercase();
    if !base_url.contains("api.openai.com") {
        return None;
    }
    let model = config.model_name.trim().to_ascii_lowercase();
    if model.starts_with("gpt-5")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
    {
        return Some("low");
    }
    None
}

fn apply_openai_reasoning_effort(config: &ResolvedChatConfig, body: &mut Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if object.contains_key("reasoning_effort") {
        return;
    }
    let effort = config
        .reasoning_effort
        .as_deref()
        .or_else(|| openai_reasoning_effort_default(config));
    let Some(effort) = effort else {
        return;
    };
    object.insert("reasoning_effort".to_string(), json!(effort));
}

fn execute_interactive_tool_call(
    app: &AppHandle,
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    tool_call_id: Option<&str>,
    name: &str,
    arguments: &Value,
    _model_config: Option<&Value>,
) -> Result<Value, String> {
    let execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let tool_executor = tools::executor::InteractiveToolExecutor::new(
            app,
            state,
            runtime_mode,
            session_id,
            tool_call_id,
        );
        let prepared = tool_executor.prepare_tool_call(name, arguments)?;
        let name = prepared.name.clone();
        let arguments = &prepared.arguments;
        let action = tool_action_name(arguments);
        let tool_plan_fingerprint = prepared.plan_fingerprint.clone();
        if let Some(result) = tool_executor.dispatch_mcp_tool(&prepared) {
            return result
                .map(|value| {
                    ensure_structured_tool_success(
                        &name,
                        action.as_deref(),
                        value,
                        Some(&tool_plan_fingerprint),
                    )
                })
                .map_err(|error| {
                    ensure_structured_tool_error(
                        &name,
                        action.as_deref(),
                        &error,
                        Some(&tool_plan_fingerprint),
                    )
                });
        }
        if let Some(result) = tool_executor.dispatch_mcp_resource_tool(&prepared) {
            return result
                .map(|value| {
                    ensure_structured_tool_success(
                        &name,
                        action.as_deref(),
                        value,
                        Some(&tool_plan_fingerprint),
                    )
                })
                .map_err(|error| {
                    ensure_structured_tool_error(
                        &name,
                        action.as_deref(),
                        &error,
                        Some(&tool_plan_fingerprint),
                    )
                });
        }
        if let Some(result) = tool_executor.dispatch_tool_search(&prepared) {
            return result
                .map(|value| {
                    ensure_structured_tool_success(
                        &name,
                        action.as_deref(),
                        value,
                        Some(&tool_plan_fingerprint),
                    )
                })
                .map_err(|error| {
                    ensure_structured_tool_error(
                        &name,
                        action.as_deref(),
                        &error,
                        Some(&tool_plan_fingerprint),
                    )
                });
        }
        if let Some(result) = tool_executor.dispatch_action_tool(&prepared) {
            return result
                .map(|value| {
                    ensure_structured_tool_success(
                        &name,
                        action.as_deref(),
                        value,
                        Some(&tool_plan_fingerprint),
                    )
                })
                .map_err(|error| {
                    ensure_structured_tool_error(
                        &name,
                        action.as_deref(),
                        &error,
                        Some(&tool_plan_fingerprint),
                    )
                });
        }
        let call_manuscript_channel = |channel: &str, payload: Value| -> Result<Value, String> {
            commands::manuscripts::handle_manuscripts_channel(app, state, channel, &payload)
                .unwrap_or_else(|| Err(format!("Manuscript channel not handled: {channel}")))
        };

        let raw_result = match name.as_str() {
            "editor" => {
                let action = payload_string(arguments, "action").unwrap_or_default();
                let file_path = resolve_editor_tool_file_path(state, session_id, arguments)?;
                let is_video_package = resolve_manuscript_path(state, &file_path)
                    .ok()
                    .and_then(|path| get_package_kind_from_manifest(&path))
                    .as_deref()
                    == Some("video");
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
                        "脚本尚未确认，暂时不能执行 `{next_action}`。请先使用 `script_read` 读取脚本，再用 `script_update` 写入脚本草案，让用户阅读；用户明确确认后，再调用 `script_confirm`，之后才能剪辑或导出。"
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
                            call_manuscript_channel(
                                "manuscripts:get-package-state",
                                json!(file_path),
                            )
                        }
                    }
                    "script_update" | "script-update" => {
                        let result = call_manuscript_channel(
                            "manuscripts:update-package-script",
                            editor_tool_payload(
                                file_path.clone(),
                                arguments,
                                &["content", "source"],
                            ),
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
                        let result = call_manuscript_channel(
                            "manuscripts:duplicate-editor-project-clip",
                            {
                                ensure_script_confirmed("clip_duplicate")?;
                                editor_tool_payload(
                                    file_path.clone(),
                                    arguments,
                                    &["clipId", "trackId", "fromMs"],
                                )
                            },
                        )?;
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
                            editor_tool_payload(
                                file_path,
                                arguments,
                                &["operations", "intentSummary"],
                            )
                        })
                    }
                    "export" => call_manuscript_channel("manuscripts:render-remotion-video", {
                        ensure_script_confirmed("export")?;
                        editor_tool_payload(file_path, arguments, &[])
                    }),
                    _ => Err(format!("unsupported editor action: {action}")),
                }
            }
            "resource" => {
                let normalized_arguments = normalized_structured_payload_arguments(arguments);
                let action = payload_string(&normalized_arguments, "action").unwrap_or_default();
                let raw_path = payload_string(&normalized_arguments, "path").unwrap_or_default();
                match action.as_str() {
                    "knowledge.search" | "search"
                        if payload_string(&normalized_arguments, "scope")
                            .unwrap_or_default()
                            .eq_ignore_ascii_case("knowledge")
                            || action == "knowledge.search" =>
                    {
                        crate::tools::knowledge_search::execute_grep(
                            state,
                            session_id,
                            &normalized_arguments,
                        )
                    }
                    "knowledge.list" | "list"
                        if payload_string(&normalized_arguments, "scope")
                            .unwrap_or_default()
                            .eq_ignore_ascii_case("knowledge")
                            || action == "knowledge.list" =>
                    {
                        crate::tools::knowledge_search::execute_glob(
                            state,
                            session_id,
                            &normalized_arguments,
                        )
                    }
                    "knowledge.read" | "read"
                        if payload_string(&normalized_arguments, "scope")
                            .unwrap_or_default()
                            .eq_ignore_ascii_case("knowledge")
                            || action == "knowledge.read" =>
                    {
                        crate::tools::knowledge_search::execute_read(
                            state,
                            session_id,
                            &normalized_arguments,
                        )
                    }
                    "knowledge.attach" => crate::tools::knowledge_search::execute_attach(
                        state,
                        session_id,
                        &normalized_arguments,
                    ),
                    "workspace.search" | "search" => {
                        crate::tools::workspace_search::execute_search(
                            state,
                            session_id,
                            &normalized_arguments,
                        )
                    }
                    "workspace.list" | "list" => {
                        let list_path = if raw_path.trim().is_empty() {
                            "."
                        } else {
                            raw_path.as_str()
                        };
                        let limit = parse_usize_arg(&normalized_arguments, "limit", 20, 50);
                        let resolved =
                            interactive_runtime_shared::resolve_workspace_tool_path_for_session(
                                state, session_id, list_path,
                            )?;
                        if !resolved.is_dir() {
                            return Err(format!("not a directory: {}", resolved.display()));
                        }
                        Ok(json!({
                            "path": resolved.display().to_string(),
                            "entries": list_directory_entries(&resolved, limit)?
                        }))
                    }
                    "workspace.read" | "read" => {
                        if raw_path.trim().is_empty() {
                            return Err(
                                "path is required for Read(path=\"workspace://...\")".to_string()
                            );
                        }
                        let max_chars =
                            parse_usize_arg(&normalized_arguments, "maxChars", 4000, 20000);
                        let resolved =
                            interactive_runtime_shared::resolve_workspace_tool_path_for_session(
                                state, session_id, &raw_path,
                            )?;
                        if resolved.is_dir() {
                            let limit = parse_usize_arg(&normalized_arguments, "limit", 20, 50);
                            workspace_read_directory_response(&resolved, limit)
                        } else if !resolved.is_file() {
                            Err(format!("not a file: {}", resolved.display()))
                        } else {
                            let content =
                                fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
                            Ok(json!({
                                "path": resolved.display().to_string(),
                                "content": truncate_chars(&content, max_chars)
                            }))
                        }
                    }
                    "workspace.createDirectory" => {
                        if raw_path.trim().is_empty() {
                            return Err(
                                "path is required for workspace.createDirectory".to_string()
                            );
                        }
                        reject_parent_directory_traversal(&raw_path)?;
                        let resolved =
                            interactive_runtime_shared::resolve_workspace_tool_path_for_session(
                                state, session_id, &raw_path,
                            )?;
                        fs::create_dir_all(&resolved).map_err(|error| error.to_string())?;
                        Ok(json!({
                            "success": true,
                            "path": resolved.display().to_string(),
                            "kind": "directory"
                        }))
                    }
                    "workspace.write" => {
                        if raw_path.trim().is_empty() {
                            return Err("path is required for workspace.write".to_string());
                        }
                        reject_parent_directory_traversal(&raw_path)?;
                        let content = payload_string(&normalized_arguments, "content")
                            .ok_or_else(|| "content is required for workspace.write".to_string())?;
                        let resolved =
                            interactive_runtime_shared::resolve_workspace_tool_path_for_session(
                                state, session_id, &raw_path,
                            )?;
                        if resolved.exists() && resolved.is_dir() {
                            return Err(format!(
                                "cannot write file over directory: {}",
                                resolved.display()
                            ));
                        }
                        if let Some(parent) = resolved.parent() {
                            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                        }
                        fs::write(&resolved, content.as_bytes())
                            .map_err(|error| error.to_string())?;
                        Ok(json!({
                            "success": true,
                            "path": resolved.display().to_string(),
                            "bytes": content.len()
                        }))
                    }
                    _ => Err(format!("unsupported fs action: {action}")),
                }
            }
            other => Err(format!("unsupported interactive tool: {other}")),
        };

        raw_result
            .map(|value| {
                ensure_structured_tool_success(
                    &name,
                    action.as_deref(),
                    value,
                    Some(&tool_plan_fingerprint),
                )
            })
            .map_err(|error| {
                ensure_structured_tool_error(
                    &name,
                    action.as_deref(),
                    &error,
                    Some(&tool_plan_fingerprint),
                )
            })
    }));
    match execution {
        Ok(result) => result,
        Err(payload) => Err(interactive_tool_panic_message(name, payload)),
    }
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
    if runtime_mode == "manuscript-editor" {
        let file_path = payload_string(&metadata, "currentAuthoringProjectPath")
            .or_else(|| payload_string(&metadata, "associatedPackageFilePath"))
            .or_else(|| payload_string(&metadata, "associatedFilePath"))
            .or_else(|| payload_string(&metadata, "contextId"))
            .unwrap_or_default();
        let content_path = payload_string(&metadata, "currentAuthoringContentPath")
            .or_else(|| payload_string(&metadata, "currentAuthoringEntryPath"))
            .unwrap_or_default();
        let title = payload_string(&metadata, "currentAuthoringTitle")
            .or_else(|| payload_string(&metadata, "associatedPackageTitle"))
            .unwrap_or_default();
        let draft_type = payload_string(&metadata, "associatedPackageKind").unwrap_or_default();
        return format!(
            "\n\n## 当前稿件编辑绑定\n\
runtime_mode: {runtime_mode}\n\
title: {title}\n\
draftType: {draft_type}\n\
projectPath: {file_path}\n\
contentPath: {content_path}\n\
\n\
规则：当前会话只服务这个稿件；需要写入时只使用 `Write(path=\"manuscripts://current\", content=\"完整改稿正文\")`，不要创建新稿件，也不要扫描其他稿件来猜当前目标。工具成功后只是生成编辑器待审改稿提案，仍需用户在编辑器中接受。\n"
        );
    }
    if matches!(runtime_mode, "team" | "chatroom") {
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
trackUi: {track_ui_path}\n\
sceneUi: {scene_ui_path}\n\
assets: {assets_path}\n\
\n\
## 工程理解规则\n\
- 视频稿件当前以 `manifest.json` + entry 脚本 + `editor.project.json` 为主。脚本确认状态存放在 `manifest.json.videoAi.scriptApproval`。\n\
- AI 剪辑完成后，应把基础视频产物写回当前视频工程状态。\n\
- `timeline.otio.json` 在视频稿件里只作为 legacy 兼容输入，不再是新的写入目标；音频稿件仍可继续使用旧编辑路径。\n\
- `track-ui.json` / `scene-ui.json` 不是视频 AI 工作流的主真相，不要把它们误当成正文内容。\n\
\n\
工具规则：使用 `editor` 读取和修改当前工程，但必须遵守 script-first 协议。先调用 `script_read` 读取当前脚本与确认状态；如果用户要求改节奏、改镜头、做剪辑或导出，先用 `script_update` 把新的完整脚本草案写回脚本区，让用户阅读；只有用户明确确认后，才能调用 `script_confirm`。视频稿件确认后，先用 `project_read` 读取最新 `videoProject`，再用 `ffmpeg_edit` 执行受控剪辑，最后按需 `export`。不要再使用 `timeline_read`、`track_add`、`clip_*`、`marker_*`、`undo`、`redo` 这些旧时间轴动作编辑视频。修改脚本或基础剪辑后，最终回答要简要说明改动与脚本确认状态。",
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

const INTERACTIVE_DIRECT_IMAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const INTERACTIVE_DIRECT_FILE_MAX_BYTES: u64 = 20 * 1024 * 1024;

fn interactive_attachment_string_field(attachment: &Value, key: &str) -> Option<String> {
    attachment
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn interactive_attachment_delivery_mode(attachment: &Value) -> String {
    interactive_attachment_string_field(attachment, "deliveryMode")
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn interactive_attachment_kind(attachment: &Value) -> String {
    interactive_attachment_string_field(attachment, "kind")
        .unwrap_or_else(|| "binary".to_string())
        .to_ascii_lowercase()
}

fn interactive_attachment_inline_data_url(attachment: &Value) -> Option<(String, String)> {
    let data_url = interactive_attachment_string_field(attachment, "inlineDataUrl")?;
    let (metadata, payload) = data_url.split_once(',')?;
    let metadata = metadata.strip_prefix("data:")?;
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    let mime_type = metadata
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let base64_data = payload.trim().to_string();
    if base64_data.is_empty() {
        return None;
    }
    Some((mime_type, base64_data))
}

fn interactive_base64_payload_size(base64_data: &str) -> u64 {
    let trimmed = base64_data.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let padding = if trimmed.ends_with("==") {
        2
    } else if trimmed.ends_with('=') {
        1
    } else {
        0
    };
    ((trimmed.len() * 3) / 4).saturating_sub(padding) as u64
}

fn interactive_transport_supports_direct_attachment(protocol: &str, attachment_kind: &str) -> bool {
    match protocol {
        "openai" | "anthropic" => attachment_kind == "image",
        "gemini" => matches!(
            attachment_kind,
            "image" | "audio" | "video" | "text" | "document" | "binary"
        ),
        _ => false,
    }
}

fn interactive_model_supports_direct_attachment(
    protocol: &str,
    model_name: &str,
    attachment_kind: &str,
    mime_type: &str,
) -> bool {
    if !interactive_transport_supports_direct_attachment(protocol, attachment_kind) {
        return false;
    }
    let model = model_name.trim().to_ascii_lowercase();
    let mime = mime_type.trim().to_ascii_lowercase();
    if model.is_empty() {
        return false;
    }
    match protocol {
        "gemini" => matches!(
            attachment_kind,
            "image" | "audio" | "video" | "text" | "document" | "binary"
        ),
        "anthropic" => {
            attachment_kind == "image"
                && matches!(
                    mime.as_str(),
                    "image/jpeg" | "image/jpg" | "image/png" | "image/gif" | "image/webp"
                )
                && (model.contains("claude-3")
                    || model.contains("claude-4")
                    || model.contains("sonnet")
                    || model.contains("opus")
                    || model.contains("haiku"))
        }
        "openai" => {
            attachment_kind == "image"
                && matches!(
                    mime.as_str(),
                    "image/jpeg" | "image/jpg" | "image/png" | "image/gif" | "image/webp"
                )
                && (model.contains("gpt-4o")
                    || model.contains("gpt-4.1")
                    || model.contains("gpt-4.5")
                    || model.contains("gpt-5")
                    || model.contains("vision")
                    || model.contains("-vl")
                    || model.contains("qwen3.5")
                    || model.contains("qwen-3.5")
                    || model.contains("qwen-vl")
                    || model.contains("omni"))
        }
        _ => false,
    }
}

fn interactive_direct_attachment_max_bytes(protocol: &str, attachment_kind: &str) -> u64 {
    match (protocol, attachment_kind) {
        ("openai", "image") | ("anthropic", "image") => INTERACTIVE_DIRECT_IMAGE_MAX_BYTES,
        ("gemini", "image") => INTERACTIVE_DIRECT_IMAGE_MAX_BYTES,
        ("gemini", _) => INTERACTIVE_DIRECT_FILE_MAX_BYTES,
        _ => 0,
    }
}

fn interactive_attachment_direct_input_payload(
    attachment: &Value,
    protocol: &str,
    model_name: &str,
) -> Result<Option<Value>, String> {
    if interactive_attachment_delivery_mode(attachment) != "direct-input" {
        return Ok(None);
    }
    let attachment_kind = interactive_attachment_kind(attachment);
    let inline_data = interactive_attachment_inline_data_url(attachment);
    let base64_data = inline_data
        .as_ref()
        .map(|(_, data)| data.clone())
        .or_else(|| interactive_attachment_string_field(attachment, "base64Data"));
    let mime_type = interactive_attachment_string_field(attachment, "mimeType")
        .or_else(|| inline_data.as_ref().map(|(mime_type, _)| mime_type.clone()))
        .unwrap_or_else(|| "application/octet-stream".to_string());
    if !interactive_model_supports_direct_attachment(
        protocol,
        model_name,
        &attachment_kind,
        &mime_type,
    ) {
        return Ok(None);
    }
    let max_bytes = interactive_direct_attachment_max_bytes(protocol, &attachment_kind);
    if let Some(base64_data) = base64_data {
        let size = interactive_base64_payload_size(&base64_data);
        if max_bytes == 0 || size == 0 || size > max_bytes {
            return Ok(None);
        }
        return Ok(Some(json!({
            "kind": attachment_kind,
            "mimeType": mime_type,
            "name": interactive_attachment_string_field(attachment, "name").unwrap_or_else(|| "attachment".to_string()),
            "base64Data": base64_data,
        })));
    }
    let absolute_path = interactive_attachment_string_field(attachment, "absolutePath")
        .or_else(|| interactive_attachment_string_field(attachment, "originalAbsolutePath"));
    let Some(absolute_path) = absolute_path else {
        return Ok(None);
    };
    let metadata = fs::metadata(&absolute_path).map_err(|error| error.to_string())?;
    if max_bytes == 0 || metadata.len() == 0 || metadata.len() > max_bytes {
        return Ok(None);
    }
    let bytes = fs::read(&absolute_path).map_err(|error| error.to_string())?;
    Ok(Some(json!({
        "kind": attachment_kind,
        "mimeType": mime_type,
        "name": interactive_attachment_string_field(attachment, "name").unwrap_or_else(|| "attachment".to_string()),
        "base64Data": base64::engine::general_purpose::STANDARD.encode(bytes),
    })))
}

fn interactive_attachment_fallback_note(
    attachment: &Value,
    protocol: &str,
    model_name: &str,
) -> Option<String> {
    let explicit_reason =
        interactive_attachment_string_field(attachment, "multimodalFallbackReason");
    let kind = interactive_attachment_kind(attachment);
    let is_multimodal = matches!(kind.as_str(), "image" | "audio" | "video")
        || attachment
            .get("requiresMultimodal")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !is_multimodal {
        return None;
    }
    let mime_type = interactive_attachment_string_field(attachment, "mimeType")
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let requested_direct = interactive_attachment_delivery_mode(attachment) == "direct-input";
    let unsupported = requested_direct
        && !interactive_model_supports_direct_attachment(protocol, model_name, &kind, &mime_type);
    if !unsupported && explicit_reason.is_none() {
        return None;
    }
    let model_label = if model_name.trim().is_empty() {
        "当前模型".to_string()
    } else {
        format!("当前模型 `{}`", model_name.trim())
    };
    let media_label = match kind.as_str() {
        "image" => "图片",
        "audio" => "音频",
        "video" => "视频",
        _ => "媒体",
    };
    Some(format!(
        "{model_label} 不支持直接接收{media_label}多模态输入，本轮已自动降级为普通文字消息。不要声称已经看过该{media_label}的真实视觉/音视频内容；如果任务必须基于原始{media_label}分析，请明确告诉用户切换到支持该媒体类型输入的多模态模型。"
    ))
}

fn interactive_attachment_tool_read_note(
    attachment: &Value,
    fallback_note: Option<&str>,
) -> Option<String> {
    let name = interactive_attachment_string_field(attachment, "name")
        .unwrap_or_else(|| "attachment".to_string());
    let kind = interactive_attachment_kind(attachment);
    let prefix = fallback_note
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("{value}\n\n"))
        .unwrap_or_default();
    if let Some(relative_path) =
        interactive_attachment_string_field(attachment, "workspaceRelativePath")
    {
        let delivery_mode = attachment
            .get("deliveryPlan")
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("workspace-tool");
        let tool_hint = match delivery_mode {
            "document-tool" => {
                "优先使用文档解析/知识库导入工具抽取正文；如果只能使用 workspace.read，先读取并如实说明无法解析的格式边界。"
            }
            "media-tool" if kind == "video" => {
                "如果用户要求识别字幕、提取字幕、转录、SRT、VTT、口播文字或字幕文件，第一次工具调用必须是 `Operate(resource=\"media\", operation=\"transcribe\", input={\"sourcePath\":\"该路径\",\"format\":\"srt\"})`；附件路径已由宿主解析，不要先用 `Read`、`List`、`Search`、`bash`、`shell`、`cli_runtime`、目录列表、`meta.json` 或文案元数据确认文件。不要用 `video.analyze` 或 `speech_extract` 代替字幕/ASR。只有当任务需要理解画面、镜头、视觉内容、精彩片段或智能剪辑策略时，才调用 `Operate(resource=\"video\", operation=\"analyze\", input={\"toolPath\":\"该路径\",\"mode\":\"summary\",\"instruction\":\"按用户要求分析视频\"})`。若用户要求剪辑、切片、拼接、静音、变速、裁切或导出该视频，应调用 `Operate(resource=\"media\", operation=\"edit\", input={\"sourcePath\":\"该路径\",\"operations\":[...]})` 直接产出剪辑文件，不要只生成 ffmpeg 命令或声称无法本地剪辑。"
            }
            "media-tool" => {
                "优先使用对应的媒体、转写或视频处理工具读取真实媒体内容；如果当前工具面没有这类能力，必须先说明无法直接分析原始媒体。"
            }
            _ => "先调用 `Read(path=\"workspace://...\")` 或相关 workspace 工具读取。",
        };
        let concrete_video_call = if delivery_mode == "media-tool" && kind == "video" {
            format!(
                " 字幕/转录具体调用：`Operate(resource=\"media\", operation=\"transcribe\", input={{\"sourcePath\":\"{relative_path}\",\"format\":\"srt\"}})`；画面分析具体调用：`Operate(resource=\"video\", operation=\"analyze\", input={{\"toolPath\":\"{relative_path}\",\"mode\":\"summary\",\"instruction\":\"按用户要求分析视频\"}})`。"
            )
        } else {
            String::new()
        };
        return Some(format!(
            "{prefix}本轮还附带了一个未直接嵌入模型的附件：文件名 `{name}`，类型 `{kind}`，工作区路径 `{relative_path}`，处理方式 `{delivery_mode}`。如果任务依赖它的真实内容，{tool_hint}{concrete_video_call} 不要假装已经看过文件内容。"
        ));
    }
    interactive_attachment_string_field(attachment, "absolutePath").map(|absolute_path| {
        format!(
            "{prefix}本轮还附带了一个未直接嵌入模型的附件：文件名 `{name}`，类型 `{kind}`，本地路径 `{absolute_path}`。当前 runtime 若不能直接访问该路径，必须先明确说明需要把文件纳入工作区或改用支持直传的输入链路；不要假装已经读取内容。"
        )
    })
}

fn interactive_attachment_tool_reference_note(attachment: &Value) -> Option<String> {
    let name = interactive_attachment_string_field(attachment, "name")
        .unwrap_or_else(|| "attachment".to_string());
    let kind = interactive_attachment_kind(attachment);
    let reference = interactive_attachment_string_field(attachment, "absolutePath")
        .or_else(|| interactive_attachment_string_field(attachment, "originalAbsolutePath"))
        .or_else(|| interactive_attachment_string_field(attachment, "workspaceRelativePath"))
        .or_else(|| interactive_attachment_string_field(attachment, "toolPath"))
        .or_else(|| interactive_attachment_string_field(attachment, "relativePath"))
        .or_else(|| interactive_attachment_string_field(attachment, "localUrl"))
        .or_else(|| interactive_attachment_string_field(attachment, "inlineDataUrl"))
        .or_else(|| interactive_attachment_string_field(attachment, "attachmentId"));
    let reference = reference?;
    let usage = if kind == "image" {
        "如果后续调用 image.generate/video.generate/media.edit 且任务需要参考这张图，必须在对应工具 input 里显式传 `referenceImages`，例如 `referenceImages:[\"该引用\"]`。如果用户目标不需要该附件，不要传；如果有多个附件，按用户目标选择。"
    } else if kind == "video" {
        "如果后续调用 video.analyze/media.transcribe/media.edit 且任务需要这个视频，必须在对应工具 input 里显式传 `sourcePath` 或 `toolPath`。如果用户目标不需要该附件，不要传；如果有多个附件，按用户目标选择。"
    } else {
        "如果后续工具调用需要这个附件，必须在对应工具 input 里显式传该引用。不要只在自然语言里提到附件。"
    };
    Some(format!(
        "可用附件资源：文件名 `{name}`，类型 `{kind}`，工具引用 `{reference}`。{usage}"
    ))
}

fn interactive_history_attachment_note(
    attachment: &Value,
    embedded_directly: bool,
) -> Option<String> {
    let name = interactive_attachment_string_field(attachment, "name")
        .unwrap_or_else(|| "attachment".to_string());
    let kind = interactive_attachment_kind(attachment);
    let relative_path = interactive_attachment_string_field(attachment, "workspaceRelativePath")
        .or_else(|| interactive_attachment_string_field(attachment, "toolPath"))
        .or_else(|| interactive_attachment_string_field(attachment, "relativePath"));
    let mode_label = if embedded_directly {
        "已直接输入给模型"
    } else {
        "需通过工具读取"
    };
    if kind == "image" {
        if let Some(reference_note) = interactive_attachment_tool_reference_note(attachment) {
            return Some(format!(
                "附件：`{name}`（image，{mode_label}）。{reference_note}"
            ));
        }
    }
    if !embedded_directly && kind == "video" {
        if let Some(relative_path) = relative_path {
            return Some(format!(
                "附件：`{name}`（video，字幕/SRT/转录的第一次工具调用必须是 `Operate(resource=\"media\", operation=\"transcribe\", input={{\"sourcePath\":\"{relative_path}\",\"format\":\"srt\"}})`；附件路径已解析，不要先用 Read/List/Search/bash/shell/cli_runtime/meta.json/目录列表确认文件；只有画面/镜头/视觉分析才调用 `Operate(resource=\"video\", operation=\"analyze\", input={{\"toolPath\":\"{relative_path}\",\"mode\":\"summary\",\"instruction\":\"按用户要求分析视频\"}})`；剪辑调用 `Operate(resource=\"media\", operation=\"edit\", input={{\"sourcePath\":\"{relative_path}\",\"operations\":[...]}})`）"
            ));
        }
    }
    Some(format!("附件：`{name}`（{kind}，{mode_label}）"))
}

fn interactive_attachment_items(attachment: Option<&Value>) -> Vec<&Value> {
    match attachment {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(value) => vec![value],
        None => Vec::new(),
    }
}

fn compose_user_message_text(base_message: &str, note: Option<&str>) -> String {
    let trimmed = base_message.trim();
    match note.map(str::trim).filter(|value| !value.is_empty()) {
        Some(note) if trimmed.is_empty() => note.to_string(),
        Some(note) => format!("{trimmed}\n\n{note}"),
        None => trimmed.to_string(),
    }
}

fn build_interactive_user_turn_messages(
    message: &str,
    attachment: Option<&Value>,
    protocol: &str,
    model_name: &str,
) -> Result<(Value, Value), String> {
    let attachments = interactive_attachment_items(attachment);
    if attachments.is_empty() {
        let text = message.trim().to_string();
        let user_message = canonical_text_message("user", text);
        return Ok((user_message.clone(), user_message));
    };

    let mut direct_inputs = Vec::<Value>::new();
    let mut notes = Vec::<String>::new();
    let mut history_notes = Vec::<String>::new();
    for attachment in attachments {
        if let Some(note) = interactive_attachment_tool_reference_note(attachment) {
            notes.push(note);
        }
        if let Some(direct_input) =
            interactive_attachment_direct_input_payload(attachment, protocol, model_name)?
        {
            direct_inputs.push(direct_input);
            if let Some(note) = interactive_history_attachment_note(attachment, true) {
                history_notes.push(note);
            }
            continue;
        }
        let fallback_note = interactive_attachment_fallback_note(attachment, protocol, model_name);
        if let Some(note) =
            interactive_attachment_tool_read_note(attachment, fallback_note.as_deref())
        {
            notes.push(note);
        }
        if let Some(note) = interactive_history_attachment_note(attachment, false) {
            history_notes.push(note);
        }
    }
    if !direct_inputs.is_empty() {
        let prompt_content = if notes.is_empty() {
            message.trim().to_string()
        } else {
            compose_user_message_text(message, Some(&notes.join("\n\n")))
        };
        let prompt_message = json!({
            "role": "user",
            "content": prompt_content,
            "input_attachments": direct_inputs,
        });
        let history_note = history_notes.join("\n");
        let history_text = compose_user_message_text(message, Some(&history_note));
        return Ok((prompt_message, canonical_text_message("user", history_text)));
    }

    let tool_read_note = notes.join("\n\n");
    let history_note = history_notes.join("\n");
    let prompt_text = compose_user_message_text(message, Some(&tool_read_note));
    let history_text = compose_user_message_text(message, Some(&history_note));
    Ok((
        canonical_text_message("user", prompt_text),
        canonical_text_message("user", history_text),
    ))
}

fn interactive_runtime_message_bundle(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    message: &str,
    attachment: Option<&Value>,
    protocol: &str,
    model_name: &str,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let history_messages = load_runtime_history_messages(state, session_id)?;
    let mut prompt_messages = collect_recent_chat_messages(state, session_id, 10);
    let (prompt_user_message, history_user_message) =
        build_interactive_user_turn_messages(message, attachment, protocol, model_name)?;
    prompt_messages.push(prompt_user_message);
    let mut full_history_messages = history_messages;
    full_history_messages.push(history_user_message);
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
    if let Some(current_session_id) = session_id {
        if let Ok(Some(resources_prompt)) = with_store(state, |store| {
            Ok(runtime::session_resources_prompt_for_session(
                &store,
                current_session_id,
                8,
            ))
        }) {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(&resources_prompt);
        }
    }
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
    let sanitized_bundle_messages = runtime::sanitize_runtime_history_messages(&bundle_messages);
    if !sanitized_bundle_messages.is_empty() {
        return Ok(sanitized_bundle_messages);
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
const TOOL_BUDGET_EXHAUSTED_MESSAGE: &str = "你已经用完本次会话允许的工具轮次预算。不要继续调用工具；基于已有上下文和工具结果直接完成最终答复，如果仍有缺口，请明确指出缺口。";

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

fn validate_runtime_tool_message_sequence(messages: &[Value]) -> Result<(), String> {
    let mut seen_tool_calls = std::collections::HashSet::<String>::new();
    for (index, message) in messages.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match role {
            "assistant" => {
                if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for tool_call in tool_calls {
                        let Some(call_id) = tool_call.get("id").and_then(Value::as_str) else {
                            continue;
                        };
                        let trimmed = call_id.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        seen_tool_calls.insert(trimmed.to_string());
                    }
                }
            }
            "tool" => {
                let call_id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                if call_id.is_empty() {
                    return Err(format!(
                        "runtime protocol validation failed: tool message at index {index} is missing tool_call_id"
                    ));
                }
                if !seen_tool_calls.contains(call_id) {
                    return Err(format!(
                        "runtime protocol validation failed: orphan tool result references unknown call_id {call_id}"
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn canonical_messages_to_openai_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => {
                    let attachments = input_attachments_for_message(message);
                    if !attachments.is_empty() {
                        let text = message.get("content").and_then(Value::as_str).unwrap_or("").trim();
                        let mut parts = Vec::<Value>::new();
                        if !text.is_empty() {
                            parts.push(json!({
                                "type": "text",
                                "text": text,
                            }));
                        }
                        for attachment in attachments {
                            let mime_type = attachment
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .unwrap_or("application/octet-stream");
                            let base64_data = attachment
                                .get("base64Data")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if !base64_data.trim().is_empty() {
                                parts.push(json!({
                                    "type": "image_url",
                                    "image_url": {
                                        "url": format!("data:{mime_type};base64,{base64_data}")
                                    }
                                }));
                            }
                        }
                        Some(json!({
                            "role": "user",
                            "content": Value::Array(parts),
                        }))
                    } else {
                        Some(json!({
                            "role": "user",
                            "content": message.get("content").and_then(Value::as_str).unwrap_or("")
                        }))
                    }
                }
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

fn input_attachments_for_message(message: &Value) -> Vec<Value> {
    if let Some(items) = message
        .get("input_attachments")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        return items.clone();
    }
    message
        .get("input_attachment")
        .cloned()
        .map(|value| vec![value])
        .unwrap_or_default()
}

fn canonical_messages_to_anthropic_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => {
                    let attachments = input_attachments_for_message(message);
                    if !attachments.is_empty() {
                        let mut blocks = Vec::<Value>::new();
                        let text = message
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !text.is_empty() {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        for attachment in attachments {
                            let mime_type = attachment
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .unwrap_or("application/octet-stream");
                            let base64_data = attachment
                                .get("base64Data")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if !base64_data.trim().is_empty() {
                                blocks.push(json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": mime_type,
                                        "data": base64_data,
                                    }
                                }));
                            }
                        }
                        Some(json!({
                            "role": "user",
                            "content": blocks
                        }))
                    } else {
                        Some(json!({
                            "role": "user",
                            "content": message.get("content").and_then(Value::as_str).unwrap_or("").to_string()
                        }))
                    }
                }
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
                    let mut parts = Vec::<Value>::new();
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                    for attachment in input_attachments_for_message(message) {
                        let mime_type = attachment
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream");
                        let base64_data = attachment
                            .get("base64Data")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if !base64_data.trim().is_empty() {
                            parts.push(json!({
                                "inlineData": {
                                    "mimeType": mime_type,
                                    "data": base64_data,
                                }
                            }));
                        }
                    }
                    if parts.is_empty() {
                        None
                    } else {
                        Some(json!({
                            "role": "user",
                            "parts": parts
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

fn ensure_interactive_runtime_not_cancelled(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Result<(), String> {
    if session_id
        .map(|value| is_chat_runtime_cancel_requested(state, value))
        .unwrap_or(false)
    {
        finalize_interactive_runtime_state(state, session_id, "", Some("cancelled"));
        return Err("chat generation cancelled".to_string());
    }
    Ok(())
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

fn llm_input_attachments_from_tool_result(result: &Value) -> Vec<Value> {
    let mut attachments = Vec::<Value>::new();
    for candidate in [
        result.get("llmInputAttachments"),
        result
            .get("data")
            .and_then(|value| value.get("llmInputAttachments")),
    ] {
        if let Some(items) = candidate.and_then(Value::as_array) {
            attachments.extend(items.iter().cloned());
        }
    }
    attachments
}

fn append_runtime_tool_media_attachments(
    prompt_messages: &mut Vec<Value>,
    canonical_messages: &mut Vec<Value>,
    result: &Value,
    protocol: &str,
    model_name: &str,
) {
    for attachment in llm_input_attachments_from_tool_result(result) {
        let name = interactive_attachment_string_field(&attachment, "name")
            .unwrap_or_else(|| "knowledge-attachment".to_string());
        let kind = interactive_attachment_kind(&attachment);
        let path = interactive_attachment_string_field(&attachment, "workspaceRelativePath")
            .or_else(|| interactive_attachment_string_field(&attachment, "path"))
            .or_else(|| interactive_attachment_string_field(&attachment, "absolutePath"))
            .unwrap_or_else(|| "<unknown>".to_string());
        match interactive_attachment_direct_input_payload(&attachment, protocol, model_name) {
            Ok(Some(direct_input)) => {
                prompt_messages.push(json!({
                    "role": "user",
                    "content": format!(
                        "上一个工具结果提供了知识库媒体附件 `{name}`（{kind}，路径 `{path}`）。请直接分析这个附件的真实内容，并结合已有上下文回答。"
                    ),
                    "input_attachment": direct_input,
                }));
                canonical_messages.push(canonical_text_message(
                    "user",
                    format!("知识库媒体附件：`{name}`（{kind}，已直接输入给模型，路径 `{path}`）"),
                ));
            }
            Ok(None) | Err(_) => {
                let media_label = match kind.as_str() {
                    "image" => "图片",
                    "audio" => "音频",
                    "video" => "视频",
                    _ => "媒体",
                };
                append_internal_runtime_user_message(
                    prompt_messages,
                    canonical_messages,
                    format!(
                        "工具结果包含知识库媒体附件 `{name}`（{kind}，路径 `{path}`），但当前模型 `{}` 不支持直接接收该{media_label}多模态输入，已降级为普通文字上下文。不要声称已经看过该{media_label}的真实内容；如果用户的问题必须基于原始{media_label}分析，请明确说明需要切换到支持该媒体类型输入的多模态模型。",
                        model_name.trim()
                    ),
                );
            }
        }
    }
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

fn tool_action_name(arguments: &Value) -> Option<String> {
    payload_string(arguments, "action")
        .or_else(|| {
            payload_field(arguments, "__compat")
                .and_then(|value| value.get("translatedAction"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .filter(|value| !value.trim().is_empty())
}

fn ensure_structured_tool_success(
    tool_name: &str,
    action: Option<&str>,
    result: Value,
    tool_plan_fingerprint: Option<&str>,
) -> Value {
    let Some(mut object) = result.as_object().cloned() else {
        return structured_tool_success_payload(tool_name, action, result, tool_plan_fingerprint);
    };
    if object.get("ok").and_then(Value::as_bool) == Some(true) {
        object
            .entry("tool".to_string())
            .or_insert_with(|| json!(tool_name));
        if let Some(action) = action.filter(|value| !value.trim().is_empty()) {
            object
                .entry("action".to_string())
                .or_insert_with(|| json!(action));
        }
        insert_tool_plan_meta(&mut object, tool_plan_fingerprint);
        return Value::Object(object);
    }
    structured_tool_success_payload(
        tool_name,
        action,
        Value::Object(object),
        tool_plan_fingerprint,
    )
}

fn structured_tool_success_payload(
    tool_name: &str,
    action: Option<&str>,
    data: Value,
    tool_plan_fingerprint: Option<&str>,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("ok".to_string(), json!(true));
    object.insert("tool".to_string(), json!(tool_name));
    if let Some(action) = action.filter(|value| !value.trim().is_empty()) {
        object.insert("action".to_string(), json!(action));
    }
    object.insert("data".to_string(), data);
    insert_tool_plan_meta(&mut object, tool_plan_fingerprint);
    Value::Object(object)
}

fn ensure_structured_tool_error(
    tool_name: &str,
    action: Option<&str>,
    error: &str,
    tool_plan_fingerprint: Option<&str>,
) -> String {
    if let Some(Value::Object(mut object)) = structured_tool_payload_from_text(error) {
        object
            .entry("tool".to_string())
            .or_insert_with(|| json!(tool_name));
        if let Some(action) = action.filter(|value| !value.trim().is_empty()) {
            object
                .entry("action".to_string())
                .or_insert_with(|| json!(action));
        }
        insert_tool_plan_meta(&mut object, tool_plan_fingerprint);
        return serde_json::to_string_pretty(&Value::Object(object))
            .unwrap_or_else(|_| error.to_string());
    }
    let mut object = serde_json::Map::new();
    object.insert("ok".to_string(), json!(false));
    object.insert("tool".to_string(), json!(tool_name));
    if let Some(action) = action.filter(|value| !value.trim().is_empty()) {
        object.insert("action".to_string(), json!(action));
    }
    object.insert(
        "error".to_string(),
        json!({
            "code": "ACTION_FAILED",
            "message": error,
            "retryable": false
        }),
    );
    insert_tool_plan_meta(&mut object, tool_plan_fingerprint);
    serde_json::to_string_pretty(&Value::Object(object)).unwrap_or_else(|_| error.to_string())
}

fn insert_tool_plan_meta(
    object: &mut serde_json::Map<String, Value>,
    tool_plan_fingerprint: Option<&str>,
) {
    let Some(fingerprint) = tool_plan_fingerprint.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let meta = object
        .entry("meta".to_string())
        .or_insert_with(|| json!({}));
    if let Some(meta_object) = meta.as_object_mut() {
        meta_object
            .entry("toolPlanFingerprint".to_string())
            .or_insert_with(|| json!(fingerprint));
    }
}

fn interactive_tool_call_description(tool_name: &str, arguments: &Value) -> String {
    match tool_action_name(arguments) {
        Some(action) => format!("Interactive tool call: {tool_name} · {action}"),
        None => format!("Interactive tool call: {tool_name}"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InteractiveSkillActivation {
    name: String,
    description: Option<String>,
    persisted_to_session: bool,
}

fn interactive_skill_activations(
    tool_name: &str,
    result: &Value,
) -> Vec<InteractiveSkillActivation> {
    if tool_name != "workflow" {
        return Vec::new();
    }
    let data = tool_result_data(result);
    let Some(transition) = data.get("activationTransition") else {
        return Vec::new();
    };
    if !transition
        .get("continueWithUpdatedContext")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Vec::new();
    }
    let description = data
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let persisted_to_session = data
        .get("persistedToSession")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut activated = transition
        .get("activatedSkillNames")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(|name| InteractiveSkillActivation {
                    name: name.to_string(),
                    description: description.clone(),
                    persisted_to_session,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    activated.sort_by_key(|item| item.name.to_ascii_lowercase());
    activated.dedup_by(|left, right| left.name.eq_ignore_ascii_case(&right.name));
    activated
}

fn tool_result_data<'a>(result: &'a Value) -> &'a Value {
    result.get("data").unwrap_or(result)
}

fn structured_tool_payload_from_text(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(|value| value.is_object())
}

fn structured_tool_error_code(text: &str) -> Option<String> {
    structured_tool_payload_from_text(text)
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn interactive_skill_activation_continuation(
    activations: &[InteractiveSkillActivation],
) -> Option<String> {
    if activations.is_empty() {
        return None;
    }
    let mut session_scoped = Vec::<String>::new();
    let mut turn_scoped = Vec::<String>::new();
    for activation in activations {
        if activation.persisted_to_session {
            session_scoped.push(activation.name.clone());
        } else {
            turn_scoped.push(activation.name.clone());
        }
    }
    let scope_text = match (session_scoped.is_empty(), turn_scoped.is_empty()) {
        (false, true) => format!(
            "以下技能已激活并写入当前会话：{}",
            session_scoped.join(", ")
        ),
        (true, false) => format!(
            "以下技能已激活并加入当前轮上下文：{}",
            turn_scoped.join(", ")
        ),
        (false, false) => format!(
            "以下技能已激活：会话级 {}；当前轮 {}",
            session_scoped.join(", "),
            turn_scoped.join(", ")
        ),
        (true, true) => return None,
    };
    Some(format!(
        "系统状态更新：{}。技能激活只会更新当前上下文，不会返回加工结果、中间产物或额外工具输出；你必须基于已激活技能的规则自行完成下一步内容构造。不要向用户复述技能激活过程，不要输出 `<tool_call>`、`<activated_skill>` 或其他协议标签，也不要再次激活相同技能。基于更新后的技能上下文继续当前任务；如果下一步需要工具，直接发起真实工具调用。",
        scope_text
    ))
}

#[derive(Debug, Clone, Default)]
struct InteractiveExecutionContract {
    require_source_read: bool,
    require_profile_read: bool,
    require_save: bool,
    require_voice_speech: bool,
    save_artifact: Option<String>,
}

impl InteractiveExecutionContract {
    fn requires_tool_turn(&self) -> bool {
        self.require_source_read
            || self.require_profile_read
            || self.require_save
            || self.require_voice_speech
    }

    fn missing_steps(&self, progress: &InteractiveExecutionProgress) -> Vec<&'static str> {
        let mut missing = Vec::<&'static str>::new();
        if self.require_source_read && !progress.source_read_completed {
            missing.push("读取素材真实文件");
        }
        if self.require_profile_read && !progress.profile_read_completed {
            missing.push("读取 AI 用户档案");
        }
        if self.require_save && !progress.save_completed {
            missing.push("调用 Write(manuscripts://current) 保存稿件");
        }
        if self.require_voice_speech && !progress.voice_speech_completed {
            missing.push("调用 voice.speech 生成音频");
        }
        missing
    }
}

#[derive(Debug, Clone, Default)]
struct InteractiveExecutionProgress {
    source_read_completed: bool,
    profile_read_completed: bool,
    save_completed: bool,
    voice_speech_completed: bool,
    saved_project_path: Option<String>,
    saved_content: Option<String>,
}

fn redbox_fs_profile_read_completed(arguments: &Value) -> bool {
    let action = tool_action_name(arguments)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if action != "workspace.read" && action != "read" {
        return false;
    }
    let path = payload_string(arguments, "path")
        .unwrap_or_default()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if path.is_empty() {
        return false;
    }
    path.starts_with("redclaw/profile/")
        || path == "redclaw/profile"
        || matches!(
            path.as_str(),
            "redclaw/profile/agent.md"
                | "redclaw/profile/user.md"
                | "redclaw/profile/creatorprofile.md"
                | "redclaw/profile/soul.md"
        )
}

fn manuscript_save_result_path(result: &Value) -> Option<&str> {
    let data = tool_result_data(result);
    ["filePath", "newPath", "path", "projectPath", "contentPath"]
        .into_iter()
        .find_map(|key| {
            data.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
}

fn manuscript_save_result_content(result: &Value) -> Option<&str> {
    let data = tool_result_data(result);
    let string_paths = [
        &["content"][..],
        &["body"][..],
        &["markdown"][..],
        &["result", "content"][..],
        &["result", "body"][..],
        &["result", "markdown"][..],
        &["result", "script", "body"][..],
        &["result", "script", "content"][..],
    ];
    string_paths.iter().find_map(|path| {
        let mut value = data;
        for key in *path {
            value = value.get(*key)?;
        }
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    })
}

fn manuscript_save_result_has_content(result: &Value) -> bool {
    let data = tool_result_data(result);
    let saved_bytes = data
        .get("savedBytes")
        .and_then(Value::as_i64)
        .or_else(|| data.get("saved_bytes").and_then(Value::as_i64))
        .unwrap_or(0);
    if saved_bytes > 0 {
        return true;
    }
    manuscript_save_result_content(result).is_some()
}

fn normalized_app_cli_action_key(arguments: &Value) -> String {
    payload_string(arguments, "action")
        .unwrap_or_default()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn metadata_requires_voice_speech(metadata: &Value) -> bool {
    let context_type = metadata
        .get("contextType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let generation_target = metadata
        .get("generationTarget")
        .and_then(Value::as_str)
        .unwrap_or_default();
    context_type == "generation-agent" && generation_target == "audio"
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
        let metadata = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|session| session.metadata.as_ref());
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
            require_voice_speech: task_hints
                .and_then(|value| value.get("requireVoiceSpeech"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || metadata
                    .map(metadata_requires_voice_speech)
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

fn clear_interactive_execution_contract_metadata(
    metadata_object: &mut serde_json::Map<String, Value>,
) -> bool {
    let task_scoped_fields = [
        "taskHints",
        "intent",
        "platform",
        "taskType",
        "formatTarget",
        "executionProfile",
        "artifactType",
        "writeTarget",
        "requiredSkill",
        "allowedTools",
        "allowedAppCliActions",
        "allowedOperateActions",
        "allowedWriteTargets",
        "saveSubdir",
        "deferredDiscovery",
        "teamEscalation",
        "sourcePlatform",
        "sourceNoteId",
        "sourceMode",
        "sourceTitle",
        "sourceManuscriptPath",
        "forceMultiAgent",
        "forceLongRunningTask",
    ];
    let mut changed = false;
    for field in task_scoped_fields {
        changed |= metadata_object.remove(field).is_some();
    }
    changed
}

fn clear_completed_interactive_execution_contract(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    contract: &InteractiveExecutionContract,
    progress: &InteractiveExecutionProgress,
) {
    let Some(session_id) = session_id else {
        return;
    };
    if !contract.requires_tool_turn() || !contract.missing_steps(progress).is_empty() {
        return;
    }
    let _ = with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(());
        };
        let Some(mut metadata_object) = session
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
        else {
            return Ok(());
        };
        if !metadata_object.contains_key("taskHints") {
            return Ok(());
        }
        if clear_interactive_execution_contract_metadata(&mut metadata_object) {
            session.metadata = Some(Value::Object(metadata_object));
            session.updated_at = now_iso();
        }
        Ok(())
    });
}

fn metadata_has_interactive_execution_contract(metadata: &Value) -> bool {
    let task_hints = metadata.get("taskHints");
    task_hints
        .and_then(|value| value.get("requireSourceRead"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || task_hints
            .and_then(|value| value.get("requireProfileRead"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || task_hints
            .and_then(|value| value.get("requireSave"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || task_hints
            .and_then(|value| value.get("requireVoiceSpeech"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || metadata_requires_voice_speech(metadata)
}

fn message_is_successful_manuscript_write_tool_result(message: &Value) -> bool {
    if message.get("role").and_then(Value::as_str) != Some("tool") {
        return false;
    }
    if message.get("tool_name").and_then(Value::as_str) != Some("workflow") {
        return false;
    }
    let Some(content) = message.get("content").and_then(Value::as_str) else {
        return false;
    };
    let Some(payload) = structured_tool_payload_from_text(content) else {
        return false;
    };
    payload.get("ok").and_then(Value::as_bool) == Some(true)
        && payload_string(&payload, "action").as_deref() == Some("manuscripts.writeCurrent")
        && manuscript_save_result_has_content(&payload)
}

fn session_history_has_successful_manuscript_write(
    state: &State<'_, AppState>,
    session_id: &str,
) -> bool {
    runtime::load_session_bundle_messages(state, session_id)
        .map(|messages| {
            messages
                .iter()
                .any(message_is_successful_manuscript_write_tool_result)
        })
        .unwrap_or(false)
}

fn clear_stale_completed_interactive_execution_contract(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) {
    let Some(session_id) = session_id else {
        return;
    };
    let should_check_history = with_store(state, |store| {
        Ok(store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|session| session.metadata.as_ref())
            .map(metadata_has_interactive_execution_contract)
            .unwrap_or(false))
    })
    .unwrap_or(false);
    if !should_check_history || !session_history_has_successful_manuscript_write(state, session_id)
    {
        return;
    }
    let _ = with_store_mut(state, |store| {
        let Some(session) = store
            .chat_sessions
            .iter_mut()
            .find(|item| item.id == session_id)
        else {
            return Ok(());
        };
        let Some(mut metadata_object) = session
            .metadata
            .clone()
            .and_then(|value| value.as_object().cloned())
        else {
            return Ok(());
        };
        if clear_interactive_execution_contract_metadata(&mut metadata_object) {
            session.metadata = Some(Value::Object(metadata_object));
            session.updated_at = now_iso();
        }
        Ok(())
    });
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
        lines.push("必须先读取 AI 用户档案。".to_string());
    }
    if contract.require_save {
        let save_target = contract
            .save_artifact
            .as_deref()
            .map(|value| {
                if value == "folder" {
                    "文件夹稿件".to_string()
                } else {
                    value.to_string()
                }
            })
            .unwrap_or_else(|| "目标稿件".to_string());
        lines.push(format!(
            "必须先调用 `Write(path=\"manuscripts://current\", content=\"完整正文\")` 把完整内容保存到 {save_target}，再汇报结果。"
        ));
        lines.push(
            "正文只能作为 Write 工具参数提交，不要把整篇正文作为最终可见回复打印出来；保存成功后的最终回复只给运行总结和稿件链接。"
                .to_string(),
        );
    }
    if contract.require_voice_speech {
        lines.push(
            "当前是音频生成任务，最终必须调用 `voice.speech` 并确认成功生成音频后再给最终回复。若当前模型、语气设计或输入格式需要技能、资源或配置，请先调用相应工具完成准备，再调用 `voice.speech`。"
                .to_string(),
        );
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
    if contract.require_voice_speech && voice_speech_completed(tool_name, arguments, result) {
        progress.voice_speech_completed = true;
    }

    if contract.require_save && manuscript_write_current_completed(tool_name, arguments, result) {
        progress.save_completed = true;
        progress.saved_project_path = manuscript_save_result_path(result)
            .map(normalize_relative_path)
            .filter(|path| !path.is_empty())
            .or_else(|| progress.saved_project_path.clone());
        progress.saved_content = manuscript_save_result_content(result)
            .map(ToString::to_string)
            .or_else(|| progress.saved_content.clone());
    }

    match tool_name {
        "resource" => {
            let action = tool_action_name(arguments)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if contract.require_source_read
                && matches!(
                    action.as_str(),
                    "workspace.read" | "knowledge.read" | "read"
                )
            {
                progress.source_read_completed = true;
            }
            if contract.require_profile_read && redbox_fs_profile_read_completed(arguments) {
                progress.profile_read_completed = true;
            }
        }
        "workflow" => {
            let command = payload_string(arguments, "command")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            let action_key = normalized_app_cli_action_key(arguments);
            if contract.require_profile_read
                && (action_key == "redclawprofileread"
                    || action_key == "redclawprofilebundle"
                    || command.starts_with("redclaw profile-read")
                    || command.starts_with("redclaw profile-bundle"))
            {
                progress.profile_read_completed = true;
            }
            if contract.require_save
                && (command.starts_with("manuscripts write")
                    || action_key == "manuscriptswritecurrent")
                && manuscript_save_result_has_content(result)
            {
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
                        manuscript_save_result_path(result).map(|path| path.ends_with(suffix))
                    })
                    .unwrap_or(command_matches);
                if command_matches || result_matches {
                    progress.save_completed = true;
                    progress.saved_project_path = manuscript_save_result_path(result)
                        .map(normalize_relative_path)
                        .filter(|path| !path.is_empty())
                        .or_else(|| progress.saved_project_path.clone());
                    progress.saved_content = manuscript_save_result_content(result)
                        .map(ToString::to_string)
                        .or_else(|| progress.saved_content.clone());
                }
            }
        }
        _ => {}
    }
}

fn voice_speech_completed(tool_name: &str, arguments: &Value, result: &Value) -> bool {
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    if normalized_app_cli_action_key(arguments) == "voicespeech" {
        return true;
    }
    if payload_string(result, "action").as_deref() == Some("voice.speech") {
        return true;
    }
    tool_name == "voice.speech"
}

fn manuscript_write_current_completed(tool_name: &str, arguments: &Value, result: &Value) -> bool {
    if !manuscript_save_result_has_content(result) {
        return false;
    }
    if normalized_app_cli_action_key(arguments) == "manuscriptswritecurrent" {
        return true;
    }
    if tool_name == "Write" {
        return payload_string(arguments, "path")
            .map(|path| path.trim().eq_ignore_ascii_case("manuscripts://current"))
            .unwrap_or(false);
    }
    false
}

#[derive(Debug, Clone)]
struct InteractiveAuthoringSessionTarget {
    project_path: String,
}

fn interactive_authoring_session_target(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
) -> Option<InteractiveAuthoringSessionTarget> {
    let session_id = session_id?;
    with_store(state, |store| {
        let metadata = store
            .chat_sessions
            .iter()
            .find(|item| item.id == session_id)
            .and_then(|session| session.metadata.as_ref());
        let Some(metadata) = metadata else {
            return Ok(None);
        };
        let intent = payload_string(metadata, "intent")
            .or_else(|| {
                metadata
                    .get("taskHints")
                    .and_then(|value| payload_string(value, "intent"))
            })
            .unwrap_or_default();
        if intent != "manuscript_creation" {
            return Ok(None);
        }
        let project_path =
            payload_string(metadata, "currentAuthoringProjectPath").unwrap_or_default();
        let content_path =
            payload_string(metadata, "currentAuthoringContentPath").unwrap_or_default();
        if project_path.trim().is_empty() || content_path.trim().is_empty() {
            return Ok(None);
        }
        Ok(Some(InteractiveAuthoringSessionTarget { project_path }))
    })
    .ok()
    .flatten()
}

fn interactive_authoring_continuation_instruction(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    tool_name: &str,
    arguments: &Value,
    result: &Value,
) -> Option<String> {
    if tool_name != "workflow" {
        return None;
    }
    let command = payload_string(arguments, "command")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let action_key = normalized_app_cli_action_key(arguments);
    if !command.starts_with("manuscripts create-project")
        && action_key != "manuscriptscreateproject"
    {
        return None;
    }
    let target = interactive_authoring_session_target(state, session_id)?;
    let result_data = tool_result_data(result);
    let project_path = result_data
        .get("projectPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(target.project_path.as_str());
    Some(format!(
        "当前写稿工程已创建并绑定为 `{project_path}`。下一步直接调用 `Write(path=\"manuscripts://current\", content=\"<最终标题和完整正文>\")` 保存可直接发布的内容。不要重新创建工程，不要重复传 path，不要展开描述工程内部文件结构，也不要把整篇正文作为普通回复打印出来；保存成功后的最终回复只给运行总结和稿件链接。如果这次仍然无法形成有效的 tool payload，只能明确说明“内容已生成但尚未保存”。"
    ))
}

fn interactive_authoring_error_correction_instruction(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    tool_name: &str,
    error: &str,
) -> Option<String> {
    if tool_name != "workflow" {
        return None;
    }
    let error_code = structured_tool_error_code(error);
    if !matches!(
        error_code.as_deref(),
        Some("ACTION_REQUIRED")
            | Some("MISSING_OPERATE_FIELDS")
            | Some("MANUSCRIPT_WRITE_REQUIRES_WRITE")
    ) {
        return None;
    }
    let target = interactive_authoring_session_target(state, session_id)?;
    Some(format!(
        "你刚才没有完成有效保存。当前写稿工程已经绑定为 `{}`。下一步直接调用 `Write(path=\"manuscripts://current\", content=\"<最终标题和完整正文>\")` 保存内容；不要再次发送空的 Operate，也不要用 Operate 写正文，不要重新创建工程，不要把整篇正文作为普通回复打印出来。如果仍然无法调用成功，只能明确说明“内容已生成但尚未保存”。",
        target.project_path
    ))
}

fn auto_save_interactive_authoring_content(
    app: &AppHandle,
    state: &State<'_, AppState>,
    runtime_mode: &str,
    session_id: Option<&str>,
    content: &str,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    execute_interactive_tool_call(
        app,
        state,
        runtime_mode,
        session_id,
        None,
        "Write",
        &json!({
            "path": "manuscripts://current",
            "content": content,
        }),
        model_config,
    )
}

fn append_authoring_saved_path_link(
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    content: &str,
) -> String {
    let Some(target) = interactive_authoring_session_target(state, session_id) else {
        return content.to_string();
    };
    let project_path = normalize_relative_path(&target.project_path);
    if project_path.is_empty() || !is_authoring_project_link_target(&project_path) {
        return content.to_string();
    }
    let canonical_link = format!("manuscripts://{project_path}");
    if content.contains(&canonical_link) {
        return content.to_string();
    }
    let markdown_href = markdown_angle_link_href(&canonical_link);
    let label = std::path::Path::new(&project_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(project_path.as_str());
    format!("{content}\n\n保存路径：[{label}]({markdown_href})")
}

fn is_authoring_project_link_target(project_path: &str) -> bool {
    let normalized = normalize_relative_path(project_path);
    !normalized.is_empty()
        && !normalized.ends_with(".md")
        && normalized
            .rsplit('/')
            .next()
            .map(|name| !name.contains('.'))
            .unwrap_or(false)
}

fn authoring_title_from_content(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        let title = trimmed.trim_start_matches('#').trim();
        (!title.is_empty()).then(|| title.to_string())
    })
}

fn should_replace_authoring_final_content_with_summary(content: &str) -> bool {
    content.chars().count() > 600 || content.trim_start().starts_with('#')
}

fn looks_like_authoring_status_summary(content: &str) -> bool {
    let normalized = content.trim();
    if normalized.is_empty() {
        return false;
    }
    let lowered = normalized.to_ascii_lowercase();
    normalized.contains("运行总结")
        && normalized.contains("稿件链接")
        && (normalized.contains("稿件已保存")
            || normalized.contains("已完成创作并保存")
            || lowered.contains("manuscripts://current"))
}

fn markdown_angle_link_href(href: &str) -> String {
    format!("<{}>", href.trim().replace('>', "%3E"))
}

fn authoring_saved_final_summary(project_path: &str, saved_content: &str) -> String {
    let normalized = normalize_relative_path(project_path);
    let label = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(normalized.as_str());
    let title = authoring_title_from_content(saved_content).unwrap_or_else(|| label.to_string());
    let href = markdown_angle_link_href(&format!("manuscripts://{normalized}"));
    format!("已完成创作并保存为稿件。\n\n- 标题：{title}\n- 稿件：[{label}]({href})")
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
    if tool_name != "workflow" {
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
    let action_key = normalized_app_cli_action_key(tool_arguments);
    if action_key == "imagegenerate" {
        return Some("image");
    }
    if action_key == "videogenerate" {
        return Some("video");
    }
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
    let normalize_preview_url = |value: &str| {
        if value.starts_with("file://") {
            return value.to_string();
        }
        if Path::new(value).is_absolute()
            || value.starts_with("\\\\")
            || value.as_bytes().get(1).copied() == Some(b':')
        {
            return file_url_for_path(Path::new(value));
        }
        value.to_string()
    };

    let preview_url = asset
        .get("previewUrl")
        .or_else(|| asset.get("preview_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(url) = preview_url.filter(|value| media_preview_matches_kind(value, media_kind)) {
        return Some(normalize_preview_url(url));
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
            .map(|(index, item)| format!("![generated-{}](<{}>)", index + 1, item.preview_url))
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

fn interactive_tool_round_fallback_response(
    outcomes: &[InteractiveToolOutcomeDigest],
) -> Option<String> {
    let successful = outcomes
        .iter()
        .filter(|item| item.success)
        .collect::<Vec<_>>();
    if successful.is_empty() {
        return None;
    }
    let summary = successful
        .iter()
        .take(3)
        .map(|item| match tool_action_name(&item.arguments) {
            Some(action) => format!("- {} · {}：{}", item.name, action, item.summary),
            None => format!("- {}：{}", item.name, item.summary),
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "已完成工具执行，但本轮模型没有补充最终说明。最近结果：\n{}",
        summary
    ))
}

#[derive(Debug, Clone)]
struct PendingInteractiveToolCall {
    call_id: String,
    tool_name: String,
}

fn interactive_tool_abort_message() -> &'static str {
    "工具调用已中止：本轮运行在返回结果前结束。"
}

fn append_aborted_interactive_tool_result(
    state: &State<'_, AppState>,
    session_id: &str,
    call_id: &str,
    tool_name: &str,
    failure_text: &str,
) {
    let _ = with_store_mut(state, |store| {
        let (runtime_id, parent_runtime_id, source_task_id) =
            session_lineage_fields(store, session_id);
        store.session_tool_results.push(SessionToolResultRecord {
            id: make_id("tool-result"),
            session_id: session_id.to_string(),
            runtime_id,
            parent_runtime_id,
            source_task_id,
            call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            command: None,
            success: false,
            result_text: None,
            summary_text: Some(failure_text.to_string()),
            prompt_text: None,
            original_chars: None,
            prompt_chars: None,
            truncated: false,
            payload: Some(json!({
                "aborted": true,
                "toolName": tool_name,
                "callId": call_id,
            })),
            created_at: now_i64(),
            updated_at: now_i64(),
        });
        append_session_transcript(
            store,
            session_id,
            "tool.result",
            "tool",
            failure_text.to_string(),
            Some(json!({
                "callId": call_id,
                "toolName": tool_name,
                "success": false,
                "aborted": true,
            })),
        );
        append_session_checkpoint(
            store,
            session_id,
            "tool.call",
            format!("tool {tool_name} aborted"),
            Some(json!({
                "callId": call_id,
                "toolName": tool_name,
                "error": failure_text,
                "aborted": true,
            })),
        );
        Ok(())
    });
}

struct InteractiveToolCallGuard<'a> {
    app: &'a AppHandle,
    state: &'a State<'a, AppState>,
    session_id: Option<&'a str>,
    pending: Vec<PendingInteractiveToolCall>,
}

impl<'a> InteractiveToolCallGuard<'a> {
    fn new(
        app: &'a AppHandle,
        state: &'a State<'a, AppState>,
        session_id: Option<&'a str>,
    ) -> Self {
        Self {
            app,
            state,
            session_id,
            pending: Vec::new(),
        }
    }

    fn start(&mut self, call_id: &str, tool_name: &str) {
        if self.pending.iter().any(|item| item.call_id == call_id) {
            return;
        }
        self.pending.push(PendingInteractiveToolCall {
            call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
        });
    }

    fn finish(&mut self, call_id: &str) {
        self.pending.retain(|item| item.call_id != call_id);
    }
}

impl Drop for InteractiveToolCallGuard<'_> {
    fn drop(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let failure_text = interactive_tool_abort_message();
        for pending in self.pending.drain(..) {
            emit_runtime_tool_result(
                self.app,
                self.session_id,
                &pending.call_id,
                &pending.tool_name,
                false,
                failure_text,
            );
            if let Some(session_id) = self.session_id {
                append_aborted_interactive_tool_result(
                    self.state,
                    session_id,
                    &pending.call_id,
                    &pending.tool_name,
                    failure_text,
                );
            }
        }
    }
}

fn interactive_tool_panic_message(
    tool_name: &str,
    payload: Box<dyn std::any::Any + Send>,
) -> String {
    let detail = if let Some(message) = payload.downcast_ref::<String>() {
        message.trim().to_string()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        message.trim().to_string()
    } else {
        String::new()
    };
    if detail.is_empty() {
        format!("工具 {tool_name} 执行时发生 panic")
    } else {
        format!("工具 {tool_name} 执行时发生 panic：{detail}")
    }
}

fn run_anthropic_interactive_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    attachment: Option<&Value>,
    runtime_mode: &str,
) -> Result<String, String> {
    use std::process::Stdio;

    if let Some(current_session_id) = session_id {
        let _ = begin_chat_runtime_state(state, current_session_id);
    }
    let (mut prompt_messages, mut canonical_messages) = interactive_runtime_message_bundle(
        state,
        session_id,
        message,
        attachment,
        "anthropic",
        &config.model_name,
    )?;
    let is_wander = runtime_mode == "wander";
    let trace_id = session_id.unwrap_or(runtime_mode);
    let mut generated_images = Vec::<GeneratedMediaPreview>::new();
    let mut generated_videos = Vec::<GeneratedMediaPreview>::new();
    let mut latest_successful_tool_round = Vec::<InteractiveToolOutcomeDigest>::new();
    let mut loop_guard = InteractiveLoopGuard::default();
    let mut in_flight_tool_calls = InteractiveToolCallGuard::new(app, state, session_id);
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
        validate_runtime_tool_message_sequence(&prompt_messages)?;
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
            .arg(format!(
                "{}/messages",
                normalize_anthropic_base_url(&config.base_url)
            ))
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
                        &format!(
                            "{}/messages",
                            normalize_anthropic_base_url(&config.base_url)
                        ),
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
            let mut final_content = if final_content.trim().is_empty() {
                interactive_tool_round_fallback_response(&latest_successful_tool_round)
                    .unwrap_or(final_content)
            } else {
                final_content
            };
            final_content = append_authoring_saved_path_link(state, session_id, &final_content);
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
        let mut skill_activations = Vec::<InteractiveSkillActivation>::new();
        let mut tool_round_digests = Vec::<InteractiveToolOutcomeDigest>::new();
        for call in tool_calls {
            ensure_interactive_runtime_not_cancelled(state, session_id)?;
            let description = interactive_tool_call_description(&call.name, &call.arguments);
            in_flight_tool_calls.start(&call.id, &call.name);
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
                    let activated_skills = interactive_skill_activations(&call.name, &result_value);
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
                    in_flight_tool_calls.finish(&call.id);
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
                    append_runtime_tool_media_attachments(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        &result_value,
                        "anthropic",
                        &config.model_name,
                    );
                    for activation in &activated_skills {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            session_id,
                            "chat.skill_activated",
                            "skill activated",
                            Some(json!({
                                "name": activation.name.clone(),
                                "description": activation.description.clone(),
                            })),
                        );
                    }
                    skill_activations.extend(activated_skills);
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        &call.name,
                        &call.arguments,
                        true,
                        &result_text,
                    ));
                }
                Err(error) => {
                    emit_runtime_tool_result(app, session_id, &call.id, &call.name, false, &error);
                    in_flight_tool_calls.finish(&call.id);
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
            ensure_interactive_runtime_not_cancelled(state, session_id)?;
        }
        ensure_interactive_runtime_not_cancelled(state, session_id)?;
        if let Some(instruction) = interactive_skill_activation_continuation(&skill_activations) {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        latest_successful_tool_round = tool_round_digests
            .iter()
            .filter(|item| item.success)
            .cloned()
            .collect();
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
    attachment: Option<&Value>,
    runtime_mode: &str,
) -> Result<String, String> {
    use std::process::Stdio;

    if let Some(current_session_id) = session_id {
        let _ = begin_chat_runtime_state(state, current_session_id);
    }
    let (mut prompt_messages, mut canonical_messages) = interactive_runtime_message_bundle(
        state,
        session_id,
        message,
        attachment,
        "gemini",
        &config.model_name,
    )?;
    let is_wander = runtime_mode == "wander";
    let trace_id = session_id.unwrap_or(runtime_mode);
    let mut generated_images = Vec::<GeneratedMediaPreview>::new();
    let mut generated_videos = Vec::<GeneratedMediaPreview>::new();
    let mut latest_successful_tool_round = Vec::<InteractiveToolOutcomeDigest>::new();
    let mut loop_guard = InteractiveLoopGuard::default();
    let mut in_flight_tool_calls = InteractiveToolCallGuard::new(app, state, session_id);
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
        validate_runtime_tool_message_sequence(&prompt_messages)?;
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
            let mut final_content = if final_content.trim().is_empty() {
                interactive_tool_round_fallback_response(&latest_successful_tool_round)
                    .unwrap_or(final_content)
            } else {
                final_content
            };
            final_content = append_authoring_saved_path_link(state, session_id, &final_content);
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
        let mut skill_activations = Vec::<InteractiveSkillActivation>::new();
        for call in tool_calls {
            ensure_interactive_runtime_not_cancelled(state, session_id)?;
            let description = interactive_tool_call_description(&call.name, &call.arguments);
            in_flight_tool_calls.start(&call.id, &call.name);
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
                    let activated_skills = interactive_skill_activations(&call.name, &result_value);
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
                    in_flight_tool_calls.finish(&call.id);
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
                    append_runtime_tool_media_attachments(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        &result_value,
                        "gemini",
                        &config.model_name,
                    );
                    for activation in &activated_skills {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            session_id,
                            "chat.skill_activated",
                            "skill activated",
                            Some(json!({
                                "name": activation.name.clone(),
                                "description": activation.description.clone(),
                            })),
                        );
                    }
                    skill_activations.extend(activated_skills);
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        &call.name,
                        &call.arguments,
                        true,
                        &result_text,
                    ));
                }
                Err(error) => {
                    emit_runtime_tool_result(app, session_id, &call.id, &call.name, false, &error);
                    in_flight_tool_calls.finish(&call.id);
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
            ensure_interactive_runtime_not_cancelled(state, session_id)?;
        }
        ensure_interactive_runtime_not_cancelled(state, session_id)?;
        if let Some(instruction) = interactive_skill_activation_continuation(&skill_activations) {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        latest_successful_tool_round = tool_round_digests
            .iter()
            .filter(|item| item.success)
            .cloned()
            .collect();
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
    attachment: Option<&Value>,
    runtime_mode: &str,
) -> Result<String, String> {
    if let Some(current_session_id) = session_id {
        let _ = begin_chat_runtime_state(state, current_session_id);
    }
    let (mut prompt_messages, mut canonical_messages) = interactive_runtime_message_bundle(
        state,
        session_id,
        message,
        attachment,
        "openai",
        &config.model_name,
    )?;
    let is_wander = runtime_mode == "wander";
    let provider_profile = provider_profile_from_config(config);
    let trace_id = session_id.unwrap_or(runtime_mode);
    let mut wander_saw_tool_call = false;
    let mut generated_images = Vec::<GeneratedMediaPreview>::new();
    let mut generated_videos = Vec::<GeneratedMediaPreview>::new();
    let mut latest_successful_tool_round = Vec::<InteractiveToolOutcomeDigest>::new();
    let mut loop_guard = InteractiveLoopGuard::default();
    let mut in_flight_tool_calls = InteractiveToolCallGuard::new(app, state, session_id);
    let mut tool_turn = 0usize;
    clear_stale_completed_interactive_execution_contract(state, session_id);
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
        let tool_choice = if forcing_toolless_turn {
            crate::provider_compat::InteractiveToolChoice::None
        } else if (is_wander && tool_turn == 1) || must_force_first_tool_turn {
            crate::provider_compat::InteractiveToolChoice::Required
        } else if tool_turn_limit_reached {
            crate::provider_compat::InteractiveToolChoice::None
        } else {
            crate::provider_compat::InteractiveToolChoice::Auto
        };
        let turn_policy =
            provider_profile.turn_policy(runtime_mode, tool_choice, wander_saw_tool_call);
        let streaming_enabled =
            !is_wander && !should_prefer_non_streaming_openai_turn(runtime_mode, config);
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
                "[timing][wander-runtime][{}] turn-{}-request elapsed=0ms | toolChoice={} thinkingDisabled={} stream={}",
                trace_id,
                turn_index,
                tool_choice.as_api_value(),
                turn_policy.disable_thinking,
                streaming_enabled
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
        validate_runtime_tool_message_sequence(&prompt_messages)?;
        let mut messages = canonical_messages_to_openai_messages(&prompt_messages);
        messages.insert(
            0,
            json!({
                "role": "system",
                "content": system_prompt
            }),
        );
        let include_tools = !forcing_toolless_turn && !tool_turn_limit_reached;
        let mut body = json!({
            "model": config.model_name,
            "messages": messages,
            "stream": streaming_enabled
        });
        apply_openai_reasoning_effort(config, &mut body);
        if let Some(api_tool_choice) = provider_profile.api_tool_choice_value(tool_choice) {
            body["tool_choice"] = json!(api_tool_choice);
        }
        if include_tools {
            body["tools"] = interactive_runtime_tools_for_mode(state, runtime_mode, session_id);
        }
        if turn_policy.disable_thinking {
            provider_profile.apply_disable_thinking_parameter(&mut body);
        }
        if provider_profile.supports_reasoning_split()
            && !turn_policy.disable_thinking
            && !is_wander
        {
            body["reasoning_split"] = json!(true);
        }
        if is_wander {
            body["temperature"] = json!(0.4);
            body["max_tokens"] = json!(900);
        }
        let turn_result = match run_openai_provider_turn(
            app,
            state,
            session_id,
            runtime_mode,
            config,
            &body,
            None,
            true,
            turn_policy.allow_text_fallback,
        ) {
            Ok(value) => value,
            Err(error) => {
                let error_message = error.to_string();
                finalize_interactive_runtime_state(state, session_id, "", Some(&error_message));
                return Err(error_message);
            }
        };
        let used_non_streaming_delivery = !streaming_enabled
            || matches!(turn_result.delivery, ProviderTurnDelivery::JsonFallback);
        let assistant_content = turn_result.content;
        let assistant_reasoning_content = turn_result.reasoning_content;
        let tool_calls = turn_result.tool_calls;
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
            let mut final_content = append_generated_media_sections(
                &assistant_content,
                &generated_images,
                &generated_videos,
            );
            if used_non_streaming_delivery && !assistant_reasoning_content.trim().is_empty() {
                if let Some(current_session_id) = session_id {
                    emit_runtime_text_delta(
                        app,
                        current_session_id,
                        "thought",
                        assistant_reasoning_content.trim(),
                    );
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
            final_content = if final_content.trim().is_empty() {
                interactive_tool_round_fallback_response(&latest_successful_tool_round)
                    .unwrap_or(final_content)
            } else {
                final_content
            };
            let bound_authoring_target = interactive_authoring_session_target(state, session_id);
            let auto_save_model_config = model_config_value_from_resolved(config);
            let mut auto_save_failed = false;
            if execution_contract.require_save
                && !execution_progress.save_completed
                && bound_authoring_target.is_some()
                && !final_content.trim().is_empty()
                && !looks_like_authoring_status_summary(&final_content)
            {
                match auto_save_interactive_authoring_content(
                    app,
                    state,
                    runtime_mode,
                    session_id,
                    &final_content,
                    Some(&auto_save_model_config),
                ) {
                    Ok(_) => {
                        execution_progress.save_completed = true;
                        if let Some(target) = bound_authoring_target.as_ref() {
                            execution_progress.saved_project_path =
                                Some(target.project_path.clone());
                            execution_progress.saved_content = Some(final_content.clone());
                            final_content =
                                authoring_saved_final_summary(&target.project_path, &final_content);
                        }
                    }
                    Err(error) => {
                        auto_save_failed = true;
                        append_debug_log_state(
                            state,
                            format!(
                                "[runtime][authoring][{}] auto-save failed: {}",
                                session_id.unwrap_or(runtime_mode),
                                text_snippet(&error, 240),
                            ),
                        );
                        if !final_content.contains("内容已生成但尚未保存") {
                            final_content.push_str(&format!(
                                "\n\n内容已生成但尚未保存（自动保存失败：{}）。",
                                text_snippet(&error, 120)
                            ));
                        }
                    }
                }
            }
            if let Some(correction) = (!auto_save_failed)
                .then(|| {
                    interactive_execution_contract_followup(
                        &execution_contract,
                        &execution_progress,
                    )
                })
                .flatten()
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
            if execution_contract.require_save && execution_progress.save_completed {
                let saved_content = execution_progress
                    .saved_content
                    .as_deref()
                    .unwrap_or(&final_content);
                let saved_project_path = bound_authoring_target
                    .as_ref()
                    .map(|target| target.project_path.as_str())
                    .or(execution_progress.saved_project_path.as_deref());
                if let Some(project_path) = saved_project_path {
                    final_content = authoring_saved_final_summary(project_path, saved_content);
                } else if should_replace_authoring_final_content_with_summary(&final_content) {
                    final_content = final_content.trim().to_string();
                }
            }
            final_content = append_authoring_saved_path_link(state, session_id, &final_content);
            clear_completed_interactive_execution_contract(
                state,
                session_id,
                &execution_contract,
                &execution_progress,
            );
            if is_wander && !wander_saw_tool_call && tool_turn < INTERACTIVE_MAX_TOOL_TURNS {
                let correction = "你上一轮没有完成任何有效文件读取。现在必须先调用 resource 读取给定素材路径中的真实文件，再输出最终 JSON。禁止继续给出泛化标题或空泛方向。";
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
        let non_streaming_thought = if assistant_reasoning_content.trim().is_empty() {
            assistant_content.as_str()
        } else {
            assistant_reasoning_content.as_str()
        };
        if used_non_streaming_delivery && !non_streaming_thought.trim().is_empty() {
            emit_runtime_text_delta(
                app,
                session_id.unwrap_or_default(),
                "thought",
                non_streaming_thought,
            );
        }
        if used_non_streaming_delivery {
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
        let mut skill_activations = Vec::<InteractiveSkillActivation>::new();
        let mut authoring_continuation_instruction = None::<String>;
        let mut authoring_error_correction_instruction = None::<String>;
        for call in tool_calls {
            ensure_interactive_runtime_not_cancelled(state, session_id)?;
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
            let description =
                interactive_tool_call_description(effective_tool_name, &effective_arguments);
            in_flight_tool_calls.start(&call.id, effective_tool_name);
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
                        interactive_skill_activations(effective_tool_name, &result_value);
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
                    in_flight_tool_calls.finish(&call.id);
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
                                "result": result_value.clone(),
                                "action": payload_string(&effective_arguments, "action"),
                                "compat": payload_field(&effective_arguments, "__compat").cloned(),
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
                    append_runtime_tool_media_attachments(
                        &mut prompt_messages,
                        &mut canonical_messages,
                        &result_value,
                        "openai",
                        &config.model_name,
                    );
                    interactive_execution_progress_observe_success(
                        &mut execution_progress,
                        &execution_contract,
                        effective_tool_name,
                        &effective_arguments,
                        &result_value,
                    );
                    execution_contract_nudge_count = 0;
                    for activation in &activated_skills {
                        emit_runtime_task_checkpoint_saved(
                            app,
                            None,
                            session_id,
                            "chat.skill_activated",
                            "skill activated",
                            Some(json!({
                                "name": activation.name.clone(),
                                "description": activation.description.clone(),
                            })),
                        );
                    }
                    skill_activations.extend(activated_skills);
                    if authoring_continuation_instruction.is_none() {
                        authoring_continuation_instruction =
                            interactive_authoring_continuation_instruction(
                                state,
                                session_id,
                                effective_tool_name,
                                &effective_arguments,
                                &result_value,
                            );
                    }
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
                    in_flight_tool_calls.finish(&call.id);
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
                                "requestedToolName": call.name,
                                "structuredError": structured_tool_payload_from_text(&failure_text),
                                "action": payload_string(&effective_arguments, "action"),
                                "compat": payload_field(&effective_arguments, "__compat").cloned(),
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
                    if authoring_error_correction_instruction.is_none() {
                        authoring_error_correction_instruction =
                            interactive_authoring_error_correction_instruction(
                                state,
                                session_id,
                                effective_tool_name,
                                &failure_text,
                            );
                    }
                    tool_round_digests.push(build_interactive_tool_outcome_digest(
                        effective_tool_name,
                        &effective_arguments,
                        false,
                        &failure_text,
                    ));
                }
            }
            ensure_interactive_runtime_not_cancelled(state, session_id)?;
        }
        ensure_interactive_runtime_not_cancelled(state, session_id)?;
        if let Some(instruction) = interactive_skill_activation_continuation(&skill_activations) {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        latest_successful_tool_round = tool_round_digests
            .iter()
            .filter(|item| item.success)
            .cloned()
            .collect();
        if let Some(instruction) = authoring_continuation_instruction {
            append_internal_runtime_user_message(
                &mut prompt_messages,
                &mut canonical_messages,
                instruction,
            );
        }
        if let Some(instruction) = authoring_error_correction_instruction {
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

pub(crate) fn resolve_local_path(source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized_scheme = trimmed.to_ascii_lowercase();
    if normalized_scheme.starts_with("file://")
        || normalized_scheme.starts_with("local-file://")
        || normalized_scheme.starts_with("redbox-asset://asset/")
    {
        if normalized_scheme.starts_with("redbox-asset://asset/") {
            let encoded = &trimmed["redbox-asset://asset/".len()..];
            return Some(PathBuf::from(decode_local_path_segment(encoded)));
        }

        let parse_target = if normalized_scheme.starts_with("local-file://") {
            format!("file://{}", &trimmed["local-file://".len()..])
        } else {
            trimmed.to_string()
        };
        if let Ok(parsed) = url::Url::parse(&parse_target) {
            if let Some(path) = file_url_to_local_path(&parsed) {
                return Some(path);
            }
        }
        let rest = parse_target
            .strip_prefix("file://")
            .unwrap_or(&parse_target);
        return Some(PathBuf::from(decode_local_path_segment(rest)));
    }
    Some(PathBuf::from(trimmed))
}

fn decode_local_path_segment(raw: &str) -> String {
    let decoded = urlencoding::decode(raw)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    trim_windows_drive_url_prefix(&decoded).replace(['/', '\\'], std::path::MAIN_SEPARATOR_STR)
}

fn trim_windows_drive_url_prefix(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 3
        && matches!(bytes[0], b'/' | b'\\')
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
    {
        &value[1..]
    } else {
        value
    }
}

fn file_url_to_local_path(parsed: &url::Url) -> Option<PathBuf> {
    if parsed.scheme() != "file" {
        return None;
    }
    let host = parsed.host_str().unwrap_or("").trim();
    let decoded_path = decode_local_path_segment(parsed.path());
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return Some(PathBuf::from(format!(
            "{}{}{}",
            std::path::MAIN_SEPARATOR_STR.repeat(2),
            host,
            if decoded_path.starts_with(std::path::MAIN_SEPARATOR) {
                decoded_path
            } else {
                format!("{}{}", std::path::MAIN_SEPARATOR, decoded_path)
            }
        )));
    }
    Some(PathBuf::from(decoded_path))
}

fn subjects_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let workspace = workspace_root(state)?;
    let root = workspace.join("assets");
    let legacy_root = workspace.join("subjects");
    let root_has_catalog = root.join("catalog.json").exists();
    let legacy_has_catalog = legacy_root.join("catalog.json").exists();
    if !root_has_catalog && legacy_has_catalog && root.exists() {
        let is_empty = fs::read_dir(&root)
            .map_err(|error| error.to_string())?
            .next()
            .is_none();
        if is_empty {
            fs::remove_dir(&root).map_err(|error| error.to_string())?;
        }
    }
    if !root.exists() && legacy_root.exists() {
        fs::rename(&legacy_root, &root).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn subject_data_url_extension(meta: &str, fallback: &str) -> String {
    let mime = meta
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        _ => fallback,
    }
    .to_string()
}

fn subject_input_file_extension(name: Option<&str>, fallback: &str) -> String {
    name.and_then(|value| Path::new(value).extension())
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn safe_subject_relative_path(raw: &str) -> Option<String> {
    let normalized = normalize_relative_path(raw);
    if normalized.is_empty()
        || normalized
            .split('/')
            .any(|segment| segment == ".." || segment.contains(':') || segment.contains('\\'))
    {
        None
    } else {
        Some(normalized)
    }
}

fn subject_asset_file_name(
    prefix: &str,
    index: usize,
    name: Option<&str>,
    extension: &str,
) -> String {
    let stem = name
        .and_then(|value| Path::new(value).file_stem())
        .and_then(|value| value.to_str())
        .map(storage_safe_file_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{prefix}-{}", index + 1));
    format!("{prefix}-{}-{}.{}", index + 1, stem, extension)
}

fn materialize_subject_data_url(
    subject_dir: &Path,
    data_url: &str,
    file_name: &str,
) -> Result<String, String> {
    let data = data_url
        .trim()
        .strip_prefix("data:")
        .ok_or_else(|| "资产素材 data URL 无效".to_string())?;
    let (meta, encoded) = data
        .split_once(',')
        .ok_or_else(|| "资产素材 data URL 无效".to_string())?;
    if !meta
        .split(';')
        .any(|part| part.trim().eq_ignore_ascii_case("base64"))
    {
        return Err("资产素材 data URL 必须是 base64".to_string());
    }
    let bytes = decode_base64_bytes(encoded)?;
    fs::create_dir_all(subject_dir).map_err(|error| error.to_string())?;
    let relative_path = safe_subject_relative_path(file_name)
        .ok_or_else(|| format!("资产素材文件名无效: {file_name}"))?;
    fs::write(subject_dir.join(&relative_path), bytes).map_err(|error| error.to_string())?;
    Ok(relative_path)
}

fn materialize_subject_image_paths(
    subject_dir: &Path,
    images: &[SubjectMediaInput],
) -> Result<Vec<String>, String> {
    if images.len() > 5 {
        return Err("资产最多只能保存 5 张图片".to_string());
    }
    let mut paths = Vec::new();
    for (index, image) in images.iter().enumerate() {
        if let Some(relative_path) = image
            .relative_path
            .as_deref()
            .and_then(safe_subject_relative_path)
        {
            paths.push(relative_path);
            continue;
        }
        let Some(data_url) = image
            .data_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let meta = data_url
            .trim()
            .strip_prefix("data:")
            .and_then(|value| value.split_once(',').map(|(meta, _)| meta))
            .unwrap_or("");
        let fallback_extension = subject_input_file_extension(image.name.as_deref(), "png");
        let extension = subject_data_url_extension(meta, &fallback_extension);
        let file_name = subject_asset_file_name("image", index, image.name.as_deref(), &extension);
        paths.push(materialize_subject_data_url(
            subject_dir,
            data_url,
            &file_name,
        )?);
    }
    Ok(paths)
}

fn materialize_subject_voice_path(
    subject_dir: &Path,
    voice: Option<&SubjectVoiceInput>,
) -> Result<Option<String>, String> {
    let Some(voice) = voice else {
        return Ok(None);
    };
    if let Some(relative_path) = voice
        .relative_path
        .as_deref()
        .and_then(safe_subject_relative_path)
    {
        return Ok(Some(relative_path));
    }
    let Some(data_url) = voice
        .data_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    let meta = data_url
        .trim()
        .strip_prefix("data:")
        .and_then(|value| value.split_once(',').map(|(meta, _)| meta))
        .unwrap_or("");
    let fallback_extension = subject_input_file_extension(voice.name.as_deref(), "webm");
    let extension = subject_data_url_extension(meta, &fallback_extension);
    let file_name = subject_asset_file_name("voice", 0, voice.name.as_deref(), &extension);
    materialize_subject_data_url(subject_dir, data_url, &file_name).map(Some)
}

fn materialize_subject_video_path(
    subject_dir: &Path,
    video: Option<&SubjectMediaInput>,
) -> Result<Option<String>, String> {
    let Some(video) = video else {
        return Ok(None);
    };
    if let Some(relative_path) = video
        .relative_path
        .as_deref()
        .and_then(safe_subject_relative_path)
    {
        return Ok(Some(relative_path));
    }
    let Some(data_url) = video
        .data_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    let meta = data_url
        .trim()
        .strip_prefix("data:")
        .and_then(|value| value.split_once(',').map(|(meta, _)| meta))
        .unwrap_or("");
    let fallback_extension = subject_input_file_extension(video.name.as_deref(), "mp4");
    let extension = subject_data_url_extension(meta, &fallback_extension);
    let file_name = subject_asset_file_name("video", 0, video.name.as_deref(), &extension);
    materialize_subject_data_url(subject_dir, data_url, &file_name).map(Some)
}

fn hydrated_subject_record(subjects_root: &Path, mut record: SubjectRecord) -> SubjectRecord {
    let subject_dir = subjects_root.join(&record.id);
    record.absolute_image_paths = record
        .image_paths
        .iter()
        .map(|relative| {
            normalize_legacy_workspace_path(&subject_dir.join(relative))
                .display()
                .to_string()
        })
        .collect();
    record.preview_urls = record
        .absolute_image_paths
        .iter()
        .map(|absolute| file_url_for_path(Path::new(absolute)))
        .collect();
    record.primary_preview_url = record.preview_urls.first().cloned();
    record.absolute_voice_path = record.voice_path.as_ref().map(|relative| {
        normalize_legacy_workspace_path(&subject_dir.join(relative))
            .display()
            .to_string()
    });
    record.voice_preview_url = record
        .absolute_voice_path
        .as_ref()
        .map(|absolute| file_url_for_path(Path::new(absolute)));
    record.absolute_video_path = record.video_path.as_ref().map(|relative| {
        normalize_legacy_workspace_path(&subject_dir.join(relative))
            .display()
            .to_string()
    });
    record.video_preview_url = record
        .absolute_video_path
        .as_ref()
        .map(|absolute| file_url_for_path(Path::new(absolute)));
    record
}

fn subject_catalog_item(record: &SubjectRecord) -> Value {
    json!({
        "id": record.id,
        "name": record.name,
        "categoryId": record.category_id,
        "description": record.description,
        "tags": record.tags,
        "attributes": record.attributes,
        "imagePaths": record.image_paths,
        "voicePath": record.voice_path,
        "videoPath": record.video_path,
        "voiceScript": record.voice_script,
        "voice": record.voice,
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
    })
}

fn persist_subjects_workspace(
    subjects_root: &Path,
    categories: &[SubjectCategory],
    subjects: &[SubjectRecord],
) -> Result<(), String> {
    fs::create_dir_all(subjects_root).map_err(|error| error.to_string())?;
    for subject in subjects {
        fs::create_dir_all(subjects_root.join(&subject.id)).map_err(|error| error.to_string())?;
    }
    write_json_value(
        &subjects_root.join("categories.json"),
        &json!({ "categories": categories }),
    )?;
    let catalog_subjects = subjects
        .iter()
        .map(subject_catalog_item)
        .collect::<Vec<_>>();
    write_json_value(
        &subjects_root.join("catalog.json"),
        &json!({ "subjects": catalog_subjects }),
    )
}

fn build_subject_record_for_workspace(
    subjects_root: &Path,
    input: SubjectMutationInput,
    existing: Option<SubjectRecord>,
) -> Result<SubjectRecord, String> {
    let subject_id = input.id.clone().unwrap_or_else(|| make_id("subject"));
    let subject_dir = subjects_root.join(&subject_id);
    let images = input.images.as_deref().unwrap_or(&[]);
    let image_paths = materialize_subject_image_paths(&subject_dir, images)?;
    let voice_path = materialize_subject_voice_path(&subject_dir, input.voice.as_ref())?;
    let video_path = materialize_subject_video_path(&subject_dir, input.video.as_ref())?;
    let voice_script = input
        .voice
        .as_ref()
        .and_then(|voice| voice.script_text.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let incoming_voice = input.voice.as_ref().and_then(|voice| voice.voice.clone());
    let voice = match voice_path.as_deref() {
        Some(sample_path) => incoming_voice
            .or_else(|| {
                existing.as_ref().and_then(|record| {
                    if record.voice_path.as_deref() == Some(sample_path) {
                        record.voice.clone()
                    } else {
                        None
                    }
                })
            })
            .or_else(|| {
                Some(json!({
                    "status": "queued",
                    "sampleFilePath": sample_path,
                    "updatedAt": now_iso(),
                }))
            }),
        None => None,
    };
    let created_at = existing
        .as_ref()
        .map(|item| item.created_at.clone())
        .unwrap_or_else(now_iso);
    let record = SubjectRecord {
        id: subject_id,
        name: input.name.trim().to_string(),
        category_id: input.category_id.filter(|item| !item.trim().is_empty()),
        description: input
            .description
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty()),
        tags: input
            .tags
            .unwrap_or_default()
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        attributes: input
            .attributes
            .unwrap_or_default()
            .into_iter()
            .filter(|item| !item.key.trim().is_empty() || !item.value.trim().is_empty())
            .map(|item| SubjectAttribute {
                key: item.key.trim().to_string(),
                value: item.value.trim().to_string(),
            })
            .collect(),
        image_paths,
        voice_path,
        video_path,
        voice_script,
        voice,
        created_at,
        updated_at: now_iso(),
        absolute_image_paths: Vec::new(),
        preview_urls: Vec::new(),
        primary_preview_url: None,
        absolute_voice_path: None,
        voice_preview_url: None,
        absolute_video_path: None,
        video_preview_url: None,
    };
    Ok(hydrated_subject_record(subjects_root, record))
}

fn handle_subject_category_create(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    persistence::ensure_store_hydrated_for_subjects(state)?;
    let input: SubjectCategoryMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("分类参数无效: {error}"))?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Ok(json!({ "success": false, "error": "分类名称不能为空" }));
    }
    let subjects_root = subjects_root(state)?;
    let (mut categories, subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    if categories
        .iter()
        .any(|item| item.name.eq_ignore_ascii_case(&name))
    {
        return Ok(json!({ "success": false, "error": "分类名称已存在" }));
    }
    let timestamp = now_iso();
    let category = SubjectCategory {
        id: make_id("category"),
        name,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    categories.push(category.clone());
    persist_subjects_workspace(&subjects_root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(json!({ "success": true, "category": category }))
    })
}

fn handle_subject_category_update(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    persistence::ensure_store_hydrated_for_subjects(state)?;
    let input: SubjectCategoryMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("分类参数无效: {error}"))?;
    let Some(id) = input.id else {
        return Ok(json!({ "success": false, "error": "缺少分类 id" }));
    };
    let next_name = input.name.trim().to_string();
    if next_name.is_empty() {
        return Ok(json!({ "success": false, "error": "分类名称不能为空" }));
    }
    let subjects_root = subjects_root(state)?;
    let (mut categories, subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    if categories
        .iter()
        .any(|item| item.id != id && item.name.eq_ignore_ascii_case(&next_name))
    {
        return Ok(json!({ "success": false, "error": "分类名称已存在" }));
    }
    let Some(index) = categories.iter().position(|item| item.id == id) else {
        return Ok(json!({ "success": false, "error": "分类不存在" }));
    };
    categories[index].name = next_name;
    categories[index].updated_at = now_iso();
    let category = categories[index].clone();
    persist_subjects_workspace(&subjects_root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(json!({ "success": true, "category": category }))
    })
}

fn handle_subject_category_delete(
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    persistence::ensure_store_hydrated_for_subjects(state)?;
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少分类 id" }));
    };
    let subjects_root = subjects_root(state)?;
    let (mut categories, subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    if subjects
        .iter()
        .any(|subject| subject.category_id.as_deref() == Some(id.as_str()))
    {
        return Ok(json!({ "success": false, "error": "仍有资产使用该分类，无法删除" }));
    }
    let before = categories.len();
    categories.retain(|item| item.id != id);
    if categories.len() == before {
        return Ok(json!({ "success": false, "error": "分类不存在" }));
    }
    persist_subjects_workspace(&subjects_root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(json!({ "success": true }))
    })
}

fn handle_subject_create(
    payload: Value,
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    persistence::ensure_store_hydrated_for_subjects(state)?;
    let input: SubjectMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("资产参数无效: {error}"))?;
    if input.name.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "资产名称不能为空" }));
    }
    let subjects_root = subjects_root(state)?;
    let (categories, mut subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    if let Some(id) = input.id.as_deref() {
        if subjects.iter().any(|item| item.id == id) {
            return Ok(json!({ "success": false, "error": "资产已存在" }));
        }
    }
    if let Some(category_id) = input
        .category_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if !categories.iter().any(|item| item.id == category_id) {
            return Ok(json!({ "success": false, "error": "分类不存在" }));
        }
    }
    let record = build_subject_record_for_workspace(&subjects_root, input, None)?;
    subjects.push(record.clone());
    persist_subjects_workspace(&subjects_root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(())
    })?;
    let _ = voice_service::spawn_subject_voice_clone_if_needed(app, &record);
    Ok(json!({ "success": true, "subject": record }))
}

fn handle_subject_update(
    payload: Value,
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    persistence::ensure_store_hydrated_for_subjects(state)?;
    let input: SubjectMutationInput =
        serde_json::from_value(payload).map_err(|error| format!("资产参数无效: {error}"))?;
    let Some(id) = input.id.clone() else {
        return Ok(json!({ "success": false, "error": "缺少资产 id" }));
    };
    if input.name.trim().is_empty() {
        return Ok(json!({ "success": false, "error": "资产名称不能为空" }));
    }
    let subjects_root = subjects_root(state)?;
    let (categories, mut subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    if let Some(category_id) = input
        .category_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if !categories.iter().any(|item| item.id == category_id) {
            return Ok(json!({ "success": false, "error": "分类不存在" }));
        }
    }
    let Some(index) = subjects.iter().position(|item| item.id == id) else {
        return Ok(json!({ "success": false, "error": "资产不存在" }));
    };
    let existing = subjects.get(index).cloned();
    let record = build_subject_record_for_workspace(&subjects_root, input, existing)?;
    subjects[index] = record.clone();
    persist_subjects_workspace(&subjects_root, &categories, &subjects)?;
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
        Ok(())
    })?;
    let _ = voice_service::spawn_subject_voice_clone_if_needed(app, &record);
    Ok(json!({ "success": true, "subject": record }))
}

fn handle_subject_delete(payload: Value, state: &State<'_, AppState>) -> Result<Value, String> {
    persistence::ensure_store_hydrated_for_subjects(state)?;
    let Some(id) = payload_string(&payload, "id") else {
        return Ok(json!({ "success": false, "error": "缺少资产 id" }));
    };
    let subjects_root = subjects_root(state)?;
    let (categories, mut subjects) = with_store(state, |store| {
        Ok((store.categories.clone(), store.subjects.clone()))
    })?;
    let before = subjects.len();
    subjects.retain(|item| item.id != id);
    if subjects.len() == before {
        return Ok(json!({ "success": false, "error": "资产不存在" }));
    }
    persist_subjects_workspace(&subjects_root, &categories, &subjects)?;
    let subject_dir = subjects_root.join(&id);
    if subject_dir.exists() {
        fs::remove_dir_all(&subject_dir).map_err(|error| error.to_string())?;
    }
    with_store_mut(state, |store| {
        store.categories = categories;
        store.subjects = subjects;
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
    if let Some(result) = commands::audio::handle_audio_channel(app, state, channel, &payload) {
        return result;
    }
    if let Some(result) = commands::voice::handle_voice_channel(app, state, channel, &payload) {
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
    if let Some(result) = accounts::handle_accounts_channel(state, channel, &payload) {
        return result;
    }
    if let Some(result) =
        commands::advisor_ops::handle_advisor_channel(app, state, channel, &payload)
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
        commands::llm_readiness::handle_llm_readiness_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::generation::handle_generation_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) =
        commands::media_jobs::handle_media_jobs_channel(app, state, channel, &payload)
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
    if let Some(result) =
        commands::video_editor_v2::handle_video_editor_v2_channel(app, state, channel, &payload)
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
    if let Some(result) =
        commands::cli_runtime::handle_cli_runtime_channel(app, state, channel, &payload)
    {
        return result;
    }
    if let Some(result) = commands::runtime::handle_runtime_channel(app, state, channel, &payload) {
        return result;
    }
    match channel {
        _ => Err(format!(
            "{} host does not recognize channel `{channel}`.",
            app_brand_display_name()
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
                                "error": result.get("error").cloned().unwrap_or(Value::Null),
                                "result": result.get("result").cloned().unwrap_or(Value::Null),
                                "historyId": result.get("historyId").cloned().unwrap_or(Value::Null),
                                "items": result.get("items").cloned().unwrap_or(Value::Null),
                                "validationIssues": result.get("validationIssues").cloned().unwrap_or(Value::Null),
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

fn run_official_auth_bootstrap_once(app: AppHandle) {
    let state = app.state::<AppState>();
    if let Err(error) =
        commands::official::bootstrap_official_auth_session(&app, &state, "app-setup")
    {
        if error != "官方账号未登录" {
            logging::emit_legacy_line(
                logging::event::LogSource::Host,
                logging::event::LogLevel::Warn,
                "auth",
                "startup.official_auth_bootstrap_failed",
                format!(
                    "[{} official auth bootstrap] {error}",
                    app_brand_display_name()
                ),
                json!({ "error": error }),
                None,
            );
        }
    }
}

fn run_startup_background_housekeeping(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let bootstrap_app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            run_official_auth_bootstrap_once(bootstrap_app);
        })
        .await;

        let pricing_app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let state = pricing_app.state::<AppState>();
            if let Err(error) =
                commands::official::refresh_official_pricing_cache(&pricing_app, &state)
            {
                eprintln!("[{} official pricing] {error}", app_brand_display_name());
            }
        })
        .await;

        let mut interval = tokio::time::interval(OFFICIAL_CACHE_REFRESH_INTERVAL);
        loop {
            interval.tick().await;
            let state = app.state::<AppState>();
            if auth::should_run_background_refresh(&state) {
                let _ = commands::official::trigger_official_cached_data_refresh(app.clone());
            }
        }
    });
}

fn main() {
    let store_path = build_store_path();
    let mut store = load_store(&store_path);
    if let Err(error) = normalize_workspace_dir_setting(&mut store) {
        logging::emit_legacy_line(
            logging::event::LogSource::Host,
            logging::event::LogLevel::Warn,
            "workspace",
            "startup.workspace_compatibility_failed",
            format!(
                "[{} workspace compatibility] {error}",
                app_brand_display_name()
            ),
            json!({ "error": error }),
            None,
        );
    }
    if let Err(error) = auth::migrate_legacy_auth_store(&store_path, &mut store) {
        logging::emit_legacy_line(
            logging::event::LogSource::Host,
            logging::event::LogLevel::Warn,
            "auth",
            "startup.auth_migrate_failed",
            format!("[{} auth migrate] {error}", app_brand_display_name()),
            json!({ "error": error }),
            None,
        );
    }
    let model_config_existed_at_startup = model_config::model_config_path(&store_path).exists();
    if !model_config_existed_at_startup {
        match official_support::fetch_official_default_model_slots_for_settings(&store.settings) {
            Ok(default_slots) => {
                let catalog_models =
                    official_support::fetch_official_models_for_settings(&store.settings);
                if official_support::seed_official_default_models_into_settings(
                    &mut store.settings,
                    &default_slots,
                    &catalog_models,
                ) {
                    if let Err(error) =
                        model_config::sync_model_config_file(&store_path, &store.settings)
                    {
                        logging::emit_legacy_line(
                            logging::event::LogSource::Host,
                            logging::event::LogLevel::Warn,
                            "model_config",
                            "startup.model_config_first_run_seed_failed",
                            format!("[{} model config] {error}", app_brand_display_name()),
                            json!({ "error": error }),
                            None,
                        );
                    }
                }
            }
            Err(error) => {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "model_config",
                    "startup.model_config_default_models_fetch_failed",
                    format!("[{} model config] {error}", app_brand_display_name()),
                    json!({ "error": error }),
                    None,
                );
            }
        }
    }
    if let Err(error) =
        model_config::load_model_config_into_settings(&store_path, &mut store.settings)
    {
        logging::emit_legacy_line(
            logging::event::LogSource::Host,
            logging::event::LogLevel::Warn,
            "model_config",
            "startup.model_config_load_failed",
            format!("[{} model config] {error}", app_brand_display_name()),
            json!({ "error": error }),
            None,
        );
    }
    let synced_cached_official_models =
        official_support::sync_official_cached_models_into_settings(&mut store.settings);
    let startup_migration_status = probe_startup_migration(&store, &store_path);
    sync_redclaw_job_definitions(&mut store);
    if let Err(error) = persist_store(&store_path, &store) {
        logging::emit_legacy_line(
            logging::event::LogSource::Host,
            logging::event::LogLevel::Warn,
            "app.lifecycle",
            "startup.persist_store_failed",
            format!("[{} store persist] {error}", app_brand_display_name()),
            json!({ "error": error }),
            None,
        );
    }
    if synced_cached_official_models && model_config::model_config_path(&store_path).exists() {
        if let Err(error) = model_config::sync_model_config_file(&store_path, &store.settings) {
            logging::emit_legacy_line(
                logging::event::LogSource::Host,
                logging::event::LogLevel::Warn,
                "model_config",
                "startup.model_config_cached_models_sync_failed",
                format!("[{} model config] {error}", app_brand_display_name()),
                json!({ "error": error }),
                None,
            );
        }
    }
    let initial_workspace_root =
        workspace_root_from_snapshot(&store.settings, &store.active_space_id, &store_path)
            .unwrap_or_else(|_| preferred_workspace_dir());
    let store_root = store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let _ = logging::initialize_logging(store_root, &store.settings);
    let shared_store = Arc::new(Mutex::new(store));
    register_global_debug_store(Arc::clone(&shared_store));

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            store_path,
            store: shared_store,
            workspace_root_cache: Mutex::new(initial_workspace_root),
            startup_migration: Mutex::new(startup_migration_status),
            store_persist_version: Arc::new(AtomicU64::new(0)),
            store_persist_scheduled: Arc::new(AtomicBool::new(false)),
            auth_runtime: Mutex::new(AuthRuntimeState::default()),
            official_auth_refresh_lock: Mutex::new(()),
            official_wechat_status_lock: Mutex::new(()),
            official_cache_refresh_inflight: AtomicBool::new(false),
            mcp_manager: mcp::McpManager::default(),
            chat_runtime_states: Mutex::new(std::collections::HashMap::new()),
            editor_runtime_states: Mutex::new(std::collections::HashMap::new()),
            active_chat_requests: Mutex::new(HashMap::new()),
            assistant_runtime: Mutex::new(None),
            assistant_sidecar: Mutex::new(None),
            redclaw_runtime: Mutex::new(None),
            media_generation_runtime: Mutex::new(None),
            runtime_warm: Mutex::new(RuntimeWarmState::default()),
            approval_runtime: Mutex::new(ApprovalRuntimeState::default()),
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
            commands::library::knowledge_get_file_index_dashboard,
            commands::library::knowledge_rebuild_catalog,
            commands::library::knowledge_open_index_root,
            commands::notifications::notifications_permission_state,
            commands::notifications::notifications_request_permission,
            commands::notifications::notifications_show_system,
            commands::notifications::notifications_sync_remote,
            commands::notifications::notifications_list_remote,
            commands::notifications::notifications_mark_remote_read,
            commands::notifications::notifications_mark_all_remote_read,
            commands::redclaw::redclaw_runner_status
        ])
        .setup(|app| {
            register_global_app_handle(app.handle().clone());
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.set_decorations(false) {
                    logging::emit_legacy_line(
                        logging::event::LogSource::Host,
                        logging::event::LogLevel::Warn,
                        "window",
                        "startup.disable_windows_native_titlebar_failed",
                        format!(
                            "[{} window init] failed to disable Windows native titlebar: {error}",
                            app_brand_display_name()
                        ),
                        json!({ "error": error.to_string() }),
                        None,
                    );
                }
            }
            let _ = app.emit("indexing:status", default_indexing_stats());
            let state = app.state::<AppState>();
            if let Ok(Some(report)) = logging::create_startup_recovery_report_if_needed(&state) {
                let _ = app.emit("diagnostics:report-pending", json!(report));
            }
            if let Err(error) = knowledge_index::initialize(app.handle(), &state) {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "workspace",
                    "startup.knowledge_index_init_failed",
                    format!(
                        "[{} knowledge index init] {error}",
                        app_brand_display_name()
                    ),
                    json!({ "error": error }),
                    None,
                );
            }
            match auth::initialize_auth_runtime(app.handle(), &state) {
                Ok(snapshot) => {
                    if snapshot.logged_in {
                        let _ = commands::official::trigger_official_cached_data_refresh(
                            app.handle().clone(),
                        );
                    }
                }
                Err(error) => {
                    logging::emit_legacy_line(
                        logging::event::LogSource::Host,
                        logging::event::LogLevel::Warn,
                        "auth",
                        "startup.auth_init_failed",
                        format!("[{} auth init] {error}", app_brand_display_name()),
                        json!({ "error": error }),
                        None,
                    );
                }
            }
            if let Err(error) = ensure_redclaw_profile_files(&state) {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "daemon",
                    "startup.redclaw_profile_init_failed",
                    format!("[{} AI profile init] {error}", app_brand_display_name()),
                    json!({ "error": error }),
                    None,
                );
            }
            if let Err(error) =
                commands::redclaw::ensure_redclaw_runtime_running(app.handle(), &state)
            {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "daemon",
                    "startup.redclaw_runtime_restore_failed",
                    format!("[{} AI runtime restore] {error}", app_brand_display_name()),
                    json!({ "error": error }),
                    None,
                );
            }
            if let Err(error) =
                media_runtime::ensure_media_generation_runtime_running(app.handle(), &state)
            {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "daemon",
                    "startup.media_generation_runtime_restore_failed",
                    format!(
                        "[{} media generation runtime restore] {error}",
                        app_brand_display_name()
                    ),
                    json!({ "error": error }),
                    None,
                );
            }
            if let Err(error) = commands::assistant_daemon::ensure_assistant_daemon_running(
                app.handle(),
                &state,
                true,
            ) {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "daemon",
                    "startup.assistant_daemon_restore_failed",
                    format!(
                        "[{} assistant daemon restore] {error}",
                        app_brand_display_name()
                    ),
                    json!({ "error": error }),
                    None,
                );
            }
            if let Err(error) = skills::refresh_skill_store_catalog(&state) {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "runtime.task",
                    "startup.skill_catalog_refresh_failed",
                    format!(
                        "[{} skill catalog refresh] {error}",
                        app_brand_display_name()
                    ),
                    json!({ "error": error }),
                    None,
                );
            }
            if let Err(error) = refresh_runtime_warm_state(&state, &["wander", "redclaw", "team"]) {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "runtime.task",
                    "startup.runtime_warmup_failed",
                    format!("[{} runtime warmup] {error}", app_brand_display_name()),
                    json!({ "error": error }),
                    None,
                );
            }
            run_startup_background_housekeeping(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop app")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let state = app.state::<AppState>();
                if let Ok(mut guard) = state.media_generation_runtime.lock() {
                    if let Some(mut runtime) = guard.take() {
                        media_runtime::stop_media_generation_runtime(&mut runtime);
                    }
                }
                logging::mark_clean_shutdown_global();
            }
        });
}
