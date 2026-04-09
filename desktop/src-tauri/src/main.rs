#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;

use arboard::Clipboard;
use base64::Engine;
use dirs::config_dir;
use runtime::{
    build_runtime_task_artifact_content, infer_protocol, next_memory_maintenance_at_ms,
    normalize_runtime_intent_name, normalize_runtime_role_id, resolve_chat_config,
    resolve_runtime_mode_from_context_type, role_sequence_for_route, runtime_direct_route,
    runtime_graph_for_route, runtime_required_capabilities, runtime_subagent_role_spec,
    runtime_task_value, runtime_warm_settings_fingerprint, session_title_from_message,
    set_runtime_graph_node, ChatExecutionResult, InteractiveToolCall, McpServerRecord,
    RedclawLongCycleTaskRecord, RedclawProjectRecord, RedclawRuntime,
    RedclawScheduledTaskRecord, RedclawStateRecord, RuntimeHookRecord, RuntimeTaskRecord,
    RuntimeTaskTraceRecord, RuntimeWarmEntry, RuntimeWarmState, SessionCheckpointRecord,
    SessionToolResultRecord, SessionTranscriptRecord, SkillRecord, RUNTIME_INTENT_NAMES,
    RUNTIME_ROLE_IDS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

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
}

struct AppState {
    store_path: PathBuf,
    store: Mutex<AppStore>,
    chat_runtime_states: Mutex<std::collections::HashMap<String, ChatRuntimeStateRecord>>,
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

fn build_store_path() -> PathBuf {
    let base = config_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let redbox_dir = base.join("RedBox");
    let lexbox_dir = base.join("LexBox");
    let redbox_path = redbox_dir.join("redbox-state.json");
    let lexbox_path = lexbox_dir.join("lexbox-state.json");

    if redbox_path.exists() {
        let _ = fs::create_dir_all(&redbox_dir);
        return redbox_path;
    }
    if lexbox_path.exists() {
        let _ = fs::create_dir_all(&lexbox_dir);
        return lexbox_path;
    }

    let _ = fs::create_dir_all(&redbox_dir);
    redbox_path
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

fn default_store() -> AppStore {
    let timestamp = now_iso();
    AppStore {
        settings: json!({}),
        spaces: vec![SpaceRecord {
            id: "default".to_string(),
            name: "默认空间".to_string(),
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }],
        active_space_id: "default".to_string(),
        subjects: Vec::new(),
        categories: Vec::new(),
        advisors: Vec::new(),
        advisor_videos: Vec::new(),
        chat_rooms: Vec::new(),
        chatroom_messages: Vec::new(),
        wechat_official_bindings: Vec::new(),
        embedding_cache: Vec::new(),
        similarity_cache: Vec::new(),
        wander_history: Vec::new(),
        chat_sessions: Vec::new(),
        chat_messages: Vec::new(),
        youtube_videos: Vec::new(),
        knowledge_notes: Vec::new(),
        document_sources: Vec::new(),
        session_transcript_records: Vec::new(),
        session_checkpoints: Vec::new(),
        session_tool_results: Vec::new(),
        runtime_tasks: Vec::new(),
        runtime_task_traces: Vec::new(),
        debug_logs: Vec::new(),
        archive_profiles: Vec::new(),
        archive_samples: Vec::new(),
        memories: Vec::new(),
        memory_history: Vec::new(),
        mcp_servers: Vec::new(),
        runtime_hooks: Vec::new(),
        skills: vec![
            SkillRecord {
                name: "redclaw-project".to_string(),
                description: "RedClaw 项目编排技能".to_string(),
                location: "redbox://skills/redclaw-project".to_string(),
                body: "# RedClaw Project\n\n用于推进内容项目的内置技能。\n\n## 工作流\n\n1. 明确目标、平台和受众。\n2. 生成选题、文案、配图提示和复盘。\n3. 将产物保存到 RedClaw workspace，并同步生成 Workboard 工作项。\n4. 遇到 `save-copy`、`save-image`、`save-retro` 意图时，应优先落地对应文件。".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
            SkillRecord {
                name: "cover-builder".to_string(),
                description: "封面生成辅助技能".to_string(),
                location: "redbox://skills/cover-builder".to_string(),
                body: "# Cover Builder\n\n用于把标题、平台调性和参考素材转成封面方案的内置技能。\n\n## 输出要求\n\n- 提供 3-5 个封面标题方案。\n- 标注主视觉、构图、色彩、字体建议。\n- 如果配置了图片生成 endpoint，优先生成真实封面资产；否则输出可执行的封面提示词。".to_string(),
                source_scope: Some("builtin".to_string()),
                is_builtin: Some(true),
                disabled: Some(false),
            },
        ],
        assistant_state: AssistantStateRecord {
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
        },
        redclaw_state: RedclawStateRecord {
            enabled: false,
            lock_state: "owner".to_string(),
            blocked_by: None,
            interval_minutes: 20,
            keep_alive_when_no_window: true,
            max_projects_per_tick: 1,
            max_automation_per_tick: 2,
            is_ticking: false,
            current_project_id: None,
            current_automation_task_id: None,
            next_automation_fire_at: None,
            in_flight_task_ids: Vec::new(),
            in_flight_long_cycle_task_ids: Vec::new(),
            heartbeat_in_flight: false,
            last_tick_at: None,
            next_tick_at: None,
            next_maintenance_at: None,
            last_error: Some("RedClaw runner is idle.".to_string()),
            heartbeat: json!({
                "enabled": true,
                "intervalMinutes": 30,
                "suppressEmptyReport": true,
                "reportToMainSession": true
            }),
            scheduled_tasks: Vec::new(),
            long_cycle_tasks: Vec::new(),
            projects: Vec::new(),
        },
        media_assets: Vec::new(),
        cover_assets: Vec::new(),
        work_items: Vec::new(),
        legacy_imported_at: None,
        legacy_import_source: None,
    }
}

fn load_store(path: &PathBuf) -> AppStore {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_store(),
    };
    serde_json::from_str(&content).unwrap_or_else(|_| default_store())
}

fn persist_store(path: &PathBuf, store: &AppStore) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn with_store_mut<T>(
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut AppStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    let result = mutator(&mut store)?;
    persist_store(&state.store_path, &store)?;
    Ok(result)
}

fn with_store<T>(
    state: &State<'_, AppState>,
    reader: impl FnOnce(MutexGuard<'_, AppStore>) -> Result<T, String>,
) -> Result<T, String> {
    let store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    reader(store)
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

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

fn list_files_relative(root: &Path, limit: usize) -> Vec<String> {
    let mut items = Vec::new();
    if !root.exists() {
        return items;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                items.push(format!("{name}/"));
            } else {
                items.push(name);
            }
            if items.len() >= limit {
                break;
            }
        }
    }
    items
}

fn load_subject_categories_from_fs(subjects_root: &Path) -> Vec<SubjectCategory> {
    read_json_file(&subjects_root.join("categories.json"))
        .and_then(|value| {
            value
                .get("categories")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            Some(SubjectCategory {
                id: item.get("id")?.as_str()?.to_string(),
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名分类")
                    .to_string(),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            })
        })
        .collect()
}

fn load_subjects_from_fs(subjects_root: &Path) -> Vec<SubjectRecord> {
    let catalog_items = read_json_file(&subjects_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("subjects")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default();
    catalog_items
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let subject_dir = subjects_root.join(&id);
            let image_paths = item
                .get("imagePaths")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|x| x.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let absolute_image_paths = image_paths
                .iter()
                .map(|rel| {
                    normalize_legacy_workspace_path(&subject_dir.join(rel))
                        .display()
                        .to_string()
                })
                .collect::<Vec<_>>();
            let preview_urls = absolute_image_paths
                .iter()
                .map(|abs| file_url_for_path(Path::new(abs)))
                .collect::<Vec<_>>();
            let voice_path = item
                .get("voicePath")
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let absolute_voice_path = voice_path.as_ref().map(|rel| {
                normalize_legacy_workspace_path(&subject_dir.join(rel))
                    .display()
                    .to_string()
            });
            Some(SubjectRecord {
                id,
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名主体")
                    .to_string(),
                category_id: item
                    .get("categoryId")
                    .or_else(|| item.get("category_id"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                tags: item
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                attributes: item
                    .get("attributes")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| {
                                Some(SubjectAttribute {
                                    key: x.get("key")?.as_str()?.to_string(),
                                    value: x
                                        .get("value")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                image_paths,
                voice_path,
                voice_script: item
                    .get("voiceScript")
                    .or_else(|| item.get("voice_script"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                absolute_image_paths: absolute_image_paths.clone(),
                preview_urls: preview_urls.clone(),
                primary_preview_url: preview_urls.first().cloned(),
                absolute_voice_path: absolute_voice_path.clone(),
                voice_preview_url: absolute_voice_path
                    .as_ref()
                    .map(|abs| file_url_for_path(Path::new(abs))),
            })
        })
        .collect()
}

fn load_advisors_from_fs(advisors_root: &Path) -> Vec<AdvisorRecord> {
    let mut advisors = Vec::new();
    let Ok(entries) = fs::read_dir(advisors_root) else {
        return advisors;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(config) = read_json_file(&path.join("config.json")) else {
            continue;
        };
        let advisor_id = entry.file_name().to_string_lossy().to_string();
        let avatar_value = config
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("🤖");
        let avatar_path = normalize_legacy_workspace_path(&path.join(avatar_value));
        let avatar = if avatar_value.contains('/') || avatar_path.exists() {
            file_url_for_path(&avatar_path)
        } else {
            avatar_value.to_string()
        };
        let knowledge_dir = path.join("knowledge");
        advisors.push(AdvisorRecord {
            id: advisor_id,
            name: config
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名智囊")
                .to_string(),
            avatar,
            personality: config
                .get("personality")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            system_prompt: config
                .get("systemPrompt")
                .or_else(|| config.get("system_prompt"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            knowledge_language: config
                .get("knowledgeLanguage")
                .or_else(|| config.get("knowledge_language"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
            knowledge_files: list_files_relative(&knowledge_dir, 20),
            youtube_channel: config
                .get("youtubeChannel")
                .or_else(|| config.get("youtube_channel"))
                .cloned(),
            created_at: config
                .get("createdAt")
                .or_else(|| config.get("created_at"))
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string(),
            updated_at: config
                .get("updatedAt")
                .or_else(|| config.get("updated_at"))
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string(),
        });
    }
    advisors.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    advisors
}

fn load_media_assets_from_fs(media_root: &Path) -> Vec<MediaAssetRecord> {
    read_json_file(&media_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("assets")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let relative_path = item
                .get("relativePath")
                .or_else(|| item.get("relative_path"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let absolute_path = relative_path.as_ref().map(|rel| {
                normalize_legacy_workspace_path(&media_root.join(rel))
                    .display()
                    .to_string()
            });
            Some(MediaAssetRecord {
                id: item.get("id")?.as_str()?.to_string(),
                source: item
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("imported")
                    .to_string(),
                project_id: item
                    .get("projectId")
                    .or_else(|| item.get("project_id"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                prompt: item
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider: item
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider_template: item
                    .get("providerTemplate")
                    .or_else(|| item.get("provider_template"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                model: item
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                aspect_ratio: item
                    .get("aspectRatio")
                    .or_else(|| item.get("aspect_ratio"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                size: item
                    .get("size")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                quality: item
                    .get("quality")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                mime_type: item
                    .get("mimeType")
                    .or_else(|| item.get("mime_type"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                relative_path: relative_path.clone(),
                bound_manuscript_path: item
                    .get("boundManuscriptPath")
                    .or_else(|| item.get("bound_manuscript_path"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                absolute_path: absolute_path.clone(),
                preview_url: absolute_path
                    .as_ref()
                    .map(|abs| file_url_for_path(Path::new(abs))),
                exists: absolute_path
                    .as_ref()
                    .is_some_and(|abs| Path::new(abs).exists()),
            })
        })
        .collect()
}

fn load_cover_assets_from_fs(cover_root: &Path) -> Vec<CoverAssetRecord> {
    read_json_file(&cover_root.join("catalog.json"))
        .and_then(|value| {
            value
                .get("assets")
                .and_then(|item| item.as_array())
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let relative_path = item
                .get("relativePath")
                .or_else(|| item.get("relative_path"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let absolute_path = relative_path.as_ref().map(|rel| {
                normalize_legacy_workspace_path(&cover_root.join(rel))
                    .display()
                    .to_string()
            });
            Some(CoverAssetRecord {
                id: item.get("id")?.as_str()?.to_string(),
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                template_name: item
                    .get("templateName")
                    .or_else(|| item.get("template_name"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                prompt: item
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider: item
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                provider_template: item
                    .get("providerTemplate")
                    .or_else(|| item.get("provider_template"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                model: item
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                aspect_ratio: item
                    .get("aspectRatio")
                    .or_else(|| item.get("aspect_ratio"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                size: item
                    .get("size")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                quality: item
                    .get("quality")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                relative_path: relative_path.clone(),
                preview_url: absolute_path
                    .as_ref()
                    .map(|abs| file_url_for_path(Path::new(abs))),
                exists: absolute_path
                    .as_ref()
                    .is_some_and(|abs| Path::new(abs).exists()),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            })
        })
        .collect()
}

fn load_knowledge_notes_from_fs(knowledge_root: &Path) -> Vec<KnowledgeNoteRecord> {
    let mut notes = Vec::new();
    let redbook_root = knowledge_root.join("redbook");
    if let Ok(entries) = fs::read_dir(&redbook_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(meta) = read_json_file(&path.join("meta.json")) else {
                continue;
            };
            let entry_name = entry.file_name().to_string_lossy().to_string();
            let note_id = meta
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry_name)
                .to_string();
            let content_path = path.join("content.md");
            let html_path = path.join("content.html");
            let content_text = meta
                .get("content")
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| read_text_file_or_empty(&content_path));
            let image_urls = meta
                .get("images")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| optional_asset_url_from_note_path(&path, Some(item)))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let cover_url = optional_asset_url_from_note_path(&path, meta.get("cover"))
                .or_else(|| {
                    let candidate = path.join("images").join("cover.jpg");
                    if candidate.exists() {
                        Some(file_url_for_path(&candidate))
                    } else {
                        None
                    }
                })
                .or_else(|| image_urls.first().cloned());
            let tags = meta
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .filter(|arr| !arr.is_empty())
                .or_else(|| {
                    let extracted = extract_tags_from_text(&content_text);
                    if extracted.is_empty() {
                        None
                    } else {
                        Some(extracted)
                    }
                });
            let note_type = meta
                .get("type")
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let capture_kind = meta
                .get("captureKind")
                .or_else(|| meta.get("capture_kind"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string)
                .or_else(|| {
                    if note_type.as_deref() == Some("link-article") {
                        Some("link-article".to_string())
                    } else if !image_urls.is_empty() {
                        Some("xhs-image".to_string())
                    } else {
                        None
                    }
                });
            notes.push(KnowledgeNoteRecord {
                id: note_id.clone(),
                r#type: note_type,
                source_url: meta
                    .get("sourceUrl")
                    .or_else(|| meta.get("source_url"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                title: meta
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&note_id)
                    .to_string(),
                author: meta
                    .get("author")
                    .and_then(|v| v.as_str())
                    .unwrap_or("原文链接")
                    .to_string(),
                content: content_text,
                excerpt: meta
                    .get("excerpt")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                site_name: meta
                    .get("siteName")
                    .or_else(|| meta.get("site_name"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                capture_kind,
                html_file: if html_path.exists() {
                    Some(html_path.display().to_string())
                } else {
                    None
                },
                html_file_url: if html_path.exists() {
                    Some(file_url_for_path(&html_path))
                } else {
                    None
                },
                images: image_urls,
                tags,
                cover: cover_url,
                video: None,
                video_url: None,
                transcript: meta
                    .get("transcript")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                transcription_status: meta
                    .get("transcriptionStatus")
                    .or_else(|| meta.get("transcription_status"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                stats: KnowledgeNoteStatsRecord {
                    likes: meta.get("likes").and_then(|v| v.as_i64()).unwrap_or(0),
                    collects: meta.get("collects").and_then(|v| v.as_i64()),
                },
                created_at: meta
                    .get("createdAt")
                    .or_else(|| meta.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                folder_path: Some(path.display().to_string()),
            });
        }
    }
    notes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    notes
}

fn load_youtube_videos_from_fs(knowledge_root: &Path) -> Vec<YoutubeVideoRecord> {
    let mut videos = Vec::new();
    let youtube_root = knowledge_root.join("youtube");
    if let Ok(entries) = fs::read_dir(&youtube_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(meta) = read_json_file(&path.join("meta.json")) else {
                continue;
            };
            let subtitle_file = meta
                .get("subtitleFile")
                .or_else(|| meta.get("subtitle_file"))
                .and_then(|v| v.as_str())
                .map(ToString::to_string);
            let subtitle_content = subtitle_file
                .as_ref()
                .map(|rel| read_text_file_or_empty(&path.join(rel)))
                .filter(|text| !text.trim().is_empty());
            videos.push(YoutubeVideoRecord {
                id: {
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    meta.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&entry_name)
                        .to_string()
                },
                video_id: meta
                    .get("videoId")
                    .or_else(|| meta.get("video_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                video_url: meta
                    .get("videoUrl")
                    .or_else(|| meta.get("video_url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: meta
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("YouTube 视频")
                    .to_string(),
                original_title: meta
                    .get("originalTitle")
                    .or_else(|| meta.get("original_title"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                description: meta
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                summary: meta
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                thumbnail_url: meta
                    .get("thumbnailUrl")
                    .or_else(|| meta.get("thumbnail_url"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| {
                        let thumb = path.join("thumbnail.jpg");
                        if thumb.exists() {
                            file_url_for_path(&thumb)
                        } else {
                            String::new()
                        }
                    }),
                has_subtitle: meta
                    .get("hasSubtitle")
                    .or_else(|| meta.get("has_subtitle"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(subtitle_content.is_some()),
                subtitle_content,
                status: meta
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                created_at: meta
                    .get("createdAt")
                    .or_else(|| meta.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                folder_path: Some(path.display().to_string()),
            });
        }
    }
    videos.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    videos
}

fn load_document_sources_from_fs(knowledge_root: &Path) -> Vec<DocumentKnowledgeSourceRecord> {
    let docs_root = knowledge_root.join("docs");
    let from_index = read_json_file(&docs_root.join("sources.json"))
        .and_then(|value| {
            value
                .as_array()
                .cloned()
                .or_else(|| value.get("sources").and_then(|v| v.as_array()).cloned())
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            Some(DocumentKnowledgeSourceRecord {
                id: item.get("id")?.as_str()?.to_string(),
                kind: item
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("docs")
                    .to_string(),
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("文档源")
                    .to_string(),
                root_path: item
                    .get("rootPath")
                    .or_else(|| item.get("root_path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                locked: item
                    .get("locked")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                indexing: item
                    .get("indexing")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                index_error: item
                    .get("indexError")
                    .or_else(|| item.get("index_error"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                file_count: item
                    .get("fileCount")
                    .or_else(|| item.get("file_count"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                sample_files: item
                    .get("sampleFiles")
                    .or_else(|| item.get("sample_files"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            })
        })
        .collect::<Vec<_>>();
    if !from_index.is_empty() {
        return from_index;
    }
    let imported_root = docs_root.join("imported");
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&imported_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            items.push(DocumentKnowledgeSourceRecord {
                id: slug_from_relative_path(&name),
                kind: "docs".to_string(),
                name: name.clone(),
                root_path: path.display().to_string(),
                locked: false,
                indexing: false,
                index_error: None,
                file_count: fs::read_dir(&path)
                    .ok()
                    .map(|it| it.count() as i64)
                    .unwrap_or(0),
                sample_files: list_files_relative(&path, 8),
                created_at: now_iso(),
                updated_at: now_iso(),
            });
        }
    }
    items
}

fn load_redclaw_state_from_fs(redclaw_root: &Path) -> RedclawStateRecord {
    let mut state = RedclawStateRecord::default();
    if let Some(config) = read_json_file(&redclaw_root.join("background-runner.json")) {
        state.enabled = config
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(state.enabled);
        state.interval_minutes = config
            .get("intervalMinutes")
            .or_else(|| config.get("interval_minutes"))
            .and_then(|v| v.as_i64())
            .unwrap_or(state.interval_minutes);
        state.keep_alive_when_no_window = config
            .get("keepAliveWhenNoWindow")
            .or_else(|| config.get("keep_alive_when_no_window"))
            .and_then(|v| v.as_bool())
            .unwrap_or(state.keep_alive_when_no_window);
        state.max_projects_per_tick = config
            .get("maxProjectsPerTick")
            .or_else(|| config.get("max_projects_per_tick"))
            .and_then(|v| v.as_i64())
            .unwrap_or(state.max_projects_per_tick);
        state.max_automation_per_tick = config
            .get("maxAutomationPerTick")
            .or_else(|| config.get("max_automation_per_tick"))
            .and_then(|v| v.as_i64())
            .unwrap_or(state.max_automation_per_tick);
        state.heartbeat = config
            .get("heartbeat")
            .cloned()
            .unwrap_or_else(|| state.heartbeat.clone());
        state.last_tick_at = config
            .get("lastTickAt")
            .or_else(|| config.get("last_tick_at"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
        state.next_tick_at = config
            .get("nextTickAt")
            .or_else(|| config.get("next_tick_at"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string);
        state.scheduled_tasks = config
            .get("scheduledTasks")
            .or_else(|| config.get("scheduled_tasks"))
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.values()
                    .filter_map(|item| {
                        Some(RedclawScheduledTaskRecord {
                            id: item.get("id")?.as_str()?.to_string(),
                            name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("未命名任务")
                                .to_string(),
                            enabled: item
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true),
                            mode: item
                                .get("mode")
                                .and_then(|v| v.as_str())
                                .unwrap_or("interval")
                                .to_string(),
                            prompt: item
                                .get("prompt")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            project_id: item
                                .get("projectId")
                                .or_else(|| item.get("project_id"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            interval_minutes: item
                                .get("intervalMinutes")
                                .or_else(|| item.get("interval_minutes"))
                                .and_then(|v| v.as_i64()),
                            time: item
                                .get("time")
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            weekdays: item
                                .get("weekdays")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect()),
                            run_at: item
                                .get("runAt")
                                .or_else(|| item.get("run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            created_at: item
                                .get("createdAt")
                                .or_else(|| item.get("created_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            updated_at: item
                                .get("updatedAt")
                                .or_else(|| item.get("updated_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            last_run_at: item
                                .get("lastRunAt")
                                .or_else(|| item.get("last_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_result: item
                                .get("lastResult")
                                .or_else(|| item.get("last_result"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_error: item
                                .get("lastError")
                                .or_else(|| item.get("last_error"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            next_run_at: item
                                .get("nextRunAt")
                                .or_else(|| item.get("next_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        state.long_cycle_tasks = config
            .get("longCycleTasks")
            .or_else(|| config.get("long_cycle_tasks"))
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.values()
                    .filter_map(|item| {
                        Some(RedclawLongCycleTaskRecord {
                            id: item.get("id")?.as_str()?.to_string(),
                            name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("未命名长周期任务")
                                .to_string(),
                            enabled: item
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true),
                            status: item
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("paused")
                                .to_string(),
                            objective: item
                                .get("objective")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            step_prompt: item
                                .get("stepPrompt")
                                .or_else(|| item.get("step_prompt"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            project_id: item
                                .get("projectId")
                                .or_else(|| item.get("project_id"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            interval_minutes: item
                                .get("intervalMinutes")
                                .or_else(|| item.get("interval_minutes"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(1440),
                            total_rounds: item
                                .get("totalRounds")
                                .or_else(|| item.get("total_rounds"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(1),
                            completed_rounds: item
                                .get("completedRounds")
                                .or_else(|| item.get("completed_rounds"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0),
                            created_at: item
                                .get("createdAt")
                                .or_else(|| item.get("created_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            updated_at: item
                                .get("updatedAt")
                                .or_else(|| item.get("updated_at"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("0")
                                .to_string(),
                            last_run_at: item
                                .get("lastRunAt")
                                .or_else(|| item.get("last_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_result: item
                                .get("lastResult")
                                .or_else(|| item.get("last_result"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            last_error: item
                                .get("lastError")
                                .or_else(|| item.get("last_error"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                            next_run_at: item
                                .get("nextRunAt")
                                .or_else(|| item.get("next_run_at"))
                                .and_then(|v| v.as_str())
                                .map(ToString::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    let projects_root = redclaw_root.join("projects");
    let mut projects = Vec::new();
    if let Ok(entries) = fs::read_dir(&projects_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(project) = read_json_file(&path.join("project.json")) else {
                continue;
            };
            projects.push(RedclawProjectRecord {
                id: {
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    project
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&entry_name)
                        .to_string()
                },
                goal: project
                    .get("goal")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名项目")
                    .to_string(),
                platform: project
                    .get("platform")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                task_type: project
                    .get("taskType")
                    .or_else(|| project.get("task_type"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                status: project
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("planning")
                    .to_string(),
                updated_at: project
                    .get("updatedAt")
                    .or_else(|| project.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
            });
        }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    state.projects = projects;
    state
}

fn load_work_items_from_fs(redclaw_root: &Path) -> Vec<WorkItemRecord> {
    let mut items = Vec::new();
    let work_root = redclaw_root.join("work-items");
    if let Ok(entries) = fs::read_dir(&work_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Some(item) = read_json_file(&path) else {
                continue;
            };
            items.push(WorkItemRecord {
                id: {
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    item.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&entry_name)
                        .to_string()
                },
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名工作项")
                    .to_string(),
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                summary: item
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
                status: item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("pending")
                    .to_string(),
                effective_status: item
                    .get("effectiveStatus")
                    .or_else(|| item.get("effective_status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| {
                        item.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("pending")
                    })
                    .to_string(),
                priority: item.get("priority").and_then(|v| v.as_i64()).unwrap_or(0),
                r#type: item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("task")
                    .to_string(),
                blocked_by: item
                    .get("dependsOn")
                    .or_else(|| item.get("blockedBy"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                refs: WorkRefsRecord {
                    project_ids: item
                        .pointer("/refs/projectIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    session_ids: item
                        .pointer("/refs/sessionIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    task_ids: item
                        .pointer("/refs/taskIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                },
                metadata: item.get("metadata").cloned(),
                schedule: WorkScheduleRecord {
                    mode: item
                        .pointer("/schedule/mode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("none")
                        .to_string(),
                    interval_minutes: item
                        .pointer("/schedule/intervalMinutes")
                        .or_else(|| item.pointer("/schedule/interval_minutes"))
                        .and_then(|v| v.as_i64()),
                    time: item
                        .pointer("/schedule/time")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    weekdays: item
                        .pointer("/schedule/weekdays")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect()),
                    run_at: item
                        .pointer("/schedule/runAt")
                        .or_else(|| item.pointer("/schedule/run_at"))
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    next_run_at: item
                        .pointer("/schedule/nextRunAt")
                        .or_else(|| item.pointer("/schedule/next_run_at"))
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    completed_rounds: item
                        .pointer("/schedule/completedRounds")
                        .or_else(|| item.pointer("/schedule/completed_rounds"))
                        .and_then(|v| v.as_i64()),
                    total_rounds: item
                        .pointer("/schedule/totalRounds")
                        .or_else(|| item.pointer("/schedule/total_rounds"))
                        .and_then(|v| v.as_i64()),
                },
                created_at: item
                    .get("createdAt")
                    .or_else(|| item.get("created_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                updated_at: item
                    .get("updatedAt")
                    .or_else(|| item.get("updated_at"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string(),
                completed_at: item
                    .get("completedAt")
                    .or_else(|| item.get("completed_at"))
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string),
            });
        }
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items
}

fn hydrate_store_from_workspace_files(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<(), String> {
    let root = active_space_workspace_root_from_store(store, &store.active_space_id, store_path)?;
    store.categories = load_subject_categories_from_fs(&root.join("subjects"));
    store.subjects = load_subjects_from_fs(&root.join("subjects"));
    store.advisors = load_advisors_from_fs(&root.join("advisors"));
    store.media_assets = load_media_assets_from_fs(&root.join("media"));
    store.cover_assets = load_cover_assets_from_fs(&root.join("cover"));
    store.knowledge_notes = load_knowledge_notes_from_fs(&root.join("knowledge"));
    store.youtube_videos = load_youtube_videos_from_fs(&root.join("knowledge"));
    store.document_sources = load_document_sources_from_fs(&root.join("knowledge"));
    store.redclaw_state = load_redclaw_state_from_fs(&root.join("redclaw"));
    store.work_items = load_work_items_from_fs(&root.join("redclaw"));
    Ok(())
}

fn ensure_store_hydrated_for_knowledge(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.knowledge_notes.is_empty()
            || store.youtube_videos.is_empty()
            || store.document_sources.is_empty()
        {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

fn ensure_store_hydrated_for_subjects(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.subjects.is_empty() || store.categories.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

fn ensure_store_hydrated_for_media(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.media_assets.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

fn ensure_store_hydrated_for_cover(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.cover_assets.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

fn ensure_store_hydrated_for_work(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.work_items.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

fn ensure_store_hydrated_for_advisors(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.advisors.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

fn ensure_store_hydrated_for_redclaw(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.redclaw_state.projects.is_empty()
            || store.redclaw_state.scheduled_tasks.is_empty()
                && store.redclaw_state.long_cycle_tasks.is_empty()
        {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
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
    let encoded_path = std::env::temp_dir().join(format!("lexbox-audio-{}.b64", now_ms()));
    fs::write(&encoded_path, encoded).map_err(|error| error.to_string())?;
    let output = std::process::Command::new("base64")
        .arg("-D")
        .arg("-i")
        .arg(&encoded_path)
        .arg("-o")
        .arg(output_path)
        .output()
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&encoded_path);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "base64 decode failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

fn normalize_transcription_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/audio/transcriptions") {
        normalized
    } else {
        format!("{normalized}/audio/transcriptions")
    }
}

fn run_curl_transcription(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    let mut command = std::process::Command::new("curl");
    command
        .arg("-sS")
        .arg("-X")
        .arg("POST")
        .arg(normalize_transcription_url(endpoint))
        .arg("-F")
        .arg(format!("model={model_name}"))
        .arg("-F")
        .arg(format!("file=@{};type={mime_type}", file_path.display()));
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let value: Value =
        serde_json::from_str(&stdout).map_err(|error| format!("Invalid JSON response: {error}"))?;
    let text = value
        .get("text")
        .and_then(|item| item.as_str())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .ok_or_else(|| "转写接口返回了空结果".to_string())?;
    Ok(text)
}

fn resolve_transcription_settings(settings: &Value) -> Option<(String, Option<String>, String)> {
    let endpoint = payload_string(settings, "transcription_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let model_name = payload_string(settings, "transcription_model")
        .or_else(|| Some("whisper-1".to_string()))?;
    let api_key = payload_string(settings, "transcription_key")
        .or_else(|| payload_string(settings, "api_key"));
    Some((endpoint, api_key, model_name))
}

fn detect_ytdlp() -> Option<(String, String)> {
    let output = std::process::Command::new("yt-dlp")
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some(("yt-dlp".to_string(), version))
}

fn ensure_ytdlp_installed(update: bool) -> Result<(String, String), String> {
    if let Some(found) = detect_ytdlp() {
        if !update {
            return Ok(found);
        }
    }
    let pip_commands = [
        (
            "python3",
            vec!["-m", "pip", "install", "--user", "-U", "yt-dlp"],
        ),
        (
            "python",
            vec!["-m", "pip", "install", "--user", "-U", "yt-dlp"],
        ),
    ];
    for (binary, args) in pip_commands {
        let output = std::process::Command::new(binary).args(args).output();
        if let Ok(output) = output {
            if output.status.success() {
                if let Some(found) = detect_ytdlp() {
                    return Ok(found);
                }
            }
        }
    }
    Err("未检测到可用的 yt-dlp，且自动安装失败。请先确保 python3/pip 可用。".to_string())
}

fn run_ytdlp_json(args: &[&str]) -> Result<Value, String> {
    let output = std::process::Command::new("yt-dlp")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("yt-dlp failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid yt-dlp JSON: {error}"))
}

fn fetch_ytdlp_channel_info(channel_url: &str, limit: i64) -> Result<Value, String> {
    run_ytdlp_json(&[
        "-J",
        "--flat-playlist",
        "--playlist-end",
        &limit.max(1).to_string(),
        channel_url,
    ])
}

fn parse_ytdlp_videos(
    advisor_id: &str,
    channel_id: Option<&str>,
    value: &Value,
) -> Vec<AdvisorVideoRecord> {
    value
        .get("entries")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())?;
            let title = entry
                .get("title")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string())
                .unwrap_or_else(|| format!("Video {}", id));
            let published_at = entry
                .get("release_timestamp")
                .or_else(|| entry.get("timestamp"))
                .and_then(|item| item.as_i64())
                .map(|item| item.to_string())
                .or_else(|| {
                    entry
                        .get("upload_date")
                        .and_then(|item| item.as_str())
                        .map(|item| item.to_string())
                })
                .unwrap_or_else(now_iso);
            let video_url = entry
                .get("url")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string())
                .filter(|item| item.starts_with("http"))
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
            Some(AdvisorVideoRecord {
                id,
                advisor_id: advisor_id.to_string(),
                title,
                published_at,
                status: "pending".to_string(),
                retry_count: 0,
                error_message: None,
                subtitle_file: None,
                video_url: Some(video_url),
                channel_id: channel_id.map(|item| item.to_string()),
                created_at: now_iso(),
                updated_at: now_iso(),
            })
        })
        .collect()
}

fn download_ytdlp_subtitle(
    video_url: &str,
    target_dir: &Path,
    file_prefix: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let template = target_dir.join(format!("{file_prefix}.%(ext)s"));
    let output = std::process::Command::new("yt-dlp")
        .args([
            "--skip-download",
            "--write-auto-sub",
            "--write-sub",
            "--sub-langs",
            "zh.*,zh-Hans,zh-Hant,en.*",
            "--convert-subs",
            "srt",
            "-o",
        ])
        .arg(&template)
        .arg(video_url)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "yt-dlp subtitle download failed with status {}",
                output.status
            )
        } else {
            stderr
        });
    }
    let mut candidates = fs::read_dir(target_dir)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.starts_with(file_prefix))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
        .into_iter()
        .find(|path| {
            path.extension()
                .and_then(|v| v.to_str())
                .map(|ext| {
                    ext.eq_ignore_ascii_case("srt")
                        || ext.eq_ignore_ascii_case("vtt")
                        || ext.eq_ignore_ascii_case("txt")
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| "yt-dlp completed but no subtitle file was produced".to_string())
}

fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let image_class = match ext.as_str() {
        "png" => Some("PNG picture"),
        "jpg" | "jpeg" => Some("JPEG picture"),
        "gif" => Some("GIF picture"),
        _ => None,
    };
    if let Some(image_class) = image_class {
        let script = format!(
            "set the clipboard to (read (POSIX file {}) as {})",
            format!("{:?}", path.display().to_string()),
            image_class
        );
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(());
        }
    }
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(file_url_for_path(path)))
        .map_err(|error| error.to_string())
}

fn now_i64() -> i64 {
    now_ms() as i64
}

fn legacy_db_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home_dir) = dirs::home_dir() {
        let mac_base = home_dir.join("Library").join("Application Support");
        candidates.extend([
            mac_base.join("red-convert-desktop").join("redconvert.db"),
            mac_base.join("redbox-desktop").join("redconvert.db"),
            mac_base.join("Electron").join("redconvert.db"),
        ]);
    }
    if let Some(data_dir) = dirs::data_dir() {
        candidates.extend([
            data_dir.join("red-convert-desktop").join("redconvert.db"),
            data_dir.join("redbox-desktop").join("redconvert.db"),
            data_dir.join("Electron").join("redconvert.db"),
        ]);
    }
    candidates
}

fn run_sqlite_json_lines(db_path: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let output = std::process::Command::new("sqlite3")
        .arg(db_path)
        .arg(sql)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("sqlite3 failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rows = Vec::new();
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            rows.push(value);
        }
    }
    Ok(rows)
}

fn sqlite_count(db_path: &Path, table: &str) -> i64 {
    let sql = format!("select json_object('count', count(*)) from {table};");
    run_sqlite_json_lines(db_path, &sql)
        .ok()
        .and_then(|rows| rows.into_iter().next())
        .and_then(|value| value.get("count").and_then(|v| v.as_i64()))
        .unwrap_or(0)
}

fn detect_best_legacy_db() -> Option<PathBuf> {
    let mut best: Option<(PathBuf, i64)> = None;
    for path in legacy_db_candidates()
        .into_iter()
        .filter(|path| path.exists())
    {
        let score = sqlite_count(&path, "chat_sessions")
            + sqlite_count(&path, "chat_messages")
            + sqlite_count(&path, "archive_profiles")
            + sqlite_count(&path, "archive_samples")
            + sqlite_count(&path, "settings");
        if score <= 0 {
            continue;
        }
        match &best {
            Some((_, current_score)) if *current_score >= score => {}
            _ => best = Some((path, score)),
        }
    }
    best.map(|(path, _)| path)
}

fn legacy_workspace_dir_from_store(store: &AppStore, db_path: &Path) -> Option<PathBuf> {
    let direct = store
        .settings
        .get("workspace_dir")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if direct.as_ref().is_some_and(|path| path.exists()) {
        return direct;
    }
    let rows = run_sqlite_json_lines(
        db_path,
        "select json_object('workspace_dir', workspace_dir) from settings limit 1;",
    )
    .ok()?;
    rows.into_iter()
        .next()
        .and_then(|value| {
            value
                .get("workspace_dir")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .map(ToString::to_string)
        })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn legacy_workspace_root_candidates(store: &AppStore, db_path: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();
    if let Some(db_path) = db_path {
        if let Some(path) = legacy_workspace_dir_from_store(store, db_path) {
            candidates.push(path);
        }
    }
    if let Some(legacy) = legacy_workspace_dir() {
        candidates.push(legacy);
    }
    let app_support = dirs::data_dir().or_else(dirs::config_dir);
    if let Some(app_support) = app_support {
        candidates.push(app_support.join("red-convert-desktop"));
        candidates.push(app_support.join("redbox-desktop"));
    }
    let mut deduped = Vec::new();
    for path in candidates {
        if path.exists() && !deduped.iter().any(|existing: &PathBuf| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

fn normalize_legacy_workspace_path(path: &Path) -> PathBuf {
    let raw = path.display().to_string();
    if raw.contains("/.redconvert/") || raw.ends_with("/.redconvert") {
        return PathBuf::from(raw.replace("/.redconvert", "/.redbox"));
    }
    path.to_path_buf()
}

fn optional_asset_url_from_note_path(base_dir: &Path, raw: Option<&Value>) -> Option<String> {
    let raw = raw
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())?;
    let candidate = PathBuf::from(raw);
    let absolute = if candidate.is_absolute() {
        normalize_legacy_workspace_path(&candidate)
    } else {
        normalize_legacy_workspace_path(&base_dir.join(candidate))
    };
    if absolute.exists() {
        Some(file_url_for_path(&absolute))
    } else {
        None
    }
}

fn extract_tags_from_text(text: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for token in text.split('#').skip(1) {
        let candidate = token
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| {
                c == '#'
                    || c == '，'
                    || c == ','
                    || c == '。'
                    || c == '.'
                    || c == '！'
                    || c == '!'
                    || c == '？'
                    || c == '?'
            })
            .trim();
        if !candidate.is_empty() {
            let normalized = candidate.to_string();
            if !tags.iter().any(|item| item == &normalized) {
                tags.push(normalized);
            }
        }
    }
    tags
}

fn migrate_legacy_workspace_dirs(target_root: &Path, legacy_root: &Path) -> Result<(), String> {
    for name in [
        "manuscripts",
        "knowledge",
        "media",
        "cover",
        "redclaw",
        "subjects",
        "chatrooms",
        "advisors",
        "archives",
        "memory",
        "skills",
    ] {
        let source = legacy_root.join(name);
        if !source.exists() {
            continue;
        }
        let target = target_root.join(name);
        if directory_has_entries(&target) {
            continue;
        }
        copy_dir_recursive(&source, &target)?;
    }
    for extra_file in ["manuscript-layouts.json"] {
        let source = legacy_root.join(extra_file);
        let target = target_root.join(extra_file);
        if source.is_file() && !target.exists() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_preferred_workspace_dir(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<PathBuf, String> {
    let preferred = preferred_workspace_dir();
    if let Some(parent) = preferred.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if !preferred.exists() {
        if let Some(legacy) = legacy_workspace_dir().filter(|path| path.exists()) {
            if fs::rename(&legacy, &preferred).is_err() {
                copy_dir_recursive(&legacy, &preferred)?;
            }
        }
    }

    let configured = configured_workspace_dir(&store.settings);
    let chosen = if should_force_preferred_workspace_dir(configured.as_deref(), store_path) {
        preferred
    } else {
        configured.unwrap_or_else(preferred_workspace_dir)
    };

    if let Some(parent) = chosen.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&chosen).map_err(|error| error.to_string())?;

    let settings_obj = store
        .settings
        .as_object_mut()
        .ok_or_else(|| "settings should be a JSON object".to_string())?;
    settings_obj.insert(
        "workspace_dir".to_string(),
        json!(chosen.display().to_string()),
    );
    Ok(chosen)
}

fn maybe_import_legacy_store(store: &mut AppStore, store_path: &Path) -> Result<(), String> {
    let db_path = detect_best_legacy_db();

    if let Some(db_path) = db_path.as_ref() {
        if store.settings == json!({}) {
            let rows = run_sqlite_json_lines(
                db_path,
                "select json_object('api_endpoint', api_endpoint, 'api_key', api_key, 'model_name', model_name, 'role_mapping', role_mapping, 'workspace_dir', workspace_dir, 'transcription_model', transcription_model, 'transcription_endpoint', transcription_endpoint, 'transcription_key', transcription_key, 'embedding_endpoint', embedding_endpoint, 'embedding_key', embedding_key, 'embedding_model', embedding_model) from settings limit 1;",
            )?;
            if let Some(first) = rows.into_iter().next() {
                store.settings = first;
            }
        }

        if store.chat_sessions.is_empty() {
            let rows = run_sqlite_json_lines(
                db_path,
                "select json_object('id', id, 'title', coalesce(title, 'New Chat'), 'created_at', cast(created_at as text), 'updated_at', cast(updated_at as text), 'metadata', json(metadata)) from chat_sessions order by updated_at desc;",
            )?;
            for value in rows {
                let metadata = value.get("metadata").cloned().filter(|v| !v.is_null());
                store.chat_sessions.push(ChatSessionRecord {
                    id: value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    title: value
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("New Chat")
                        .to_string(),
                    created_at: value
                        .get("created_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0")
                        .to_string(),
                    updated_at: value
                        .get("updated_at")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0")
                        .to_string(),
                    metadata,
                });
            }
        }

        if store.chat_messages.is_empty() {
            let rows = run_sqlite_json_lines(
                db_path,
                "select json_object('id', id, 'session_id', session_id, 'role', role, 'content', content, 'timestamp', timestamp) from chat_messages order by timestamp asc;",
            )?;
            for value in rows {
                let session_id = value
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let role = value
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("assistant")
                    .to_string();
                let content = value
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let ts = value.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
                store.chat_messages.push(ChatMessageRecord {
                    id: value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    session_id: session_id.clone(),
                    role: role.clone(),
                    content: content.clone(),
                    display_content: None,
                    attachment: None,
                    created_at: ts.to_string(),
                });
                store
                    .session_transcript_records
                    .push(SessionTranscriptRecord {
                        id: format!(
                            "legacy-transcript-{}",
                            value.get("id").and_then(|v| v.as_str()).unwrap_or_default()
                        ),
                        session_id,
                        record_type: "message".to_string(),
                        role,
                        content,
                        payload: None,
                        created_at: ts,
                    });
            }
        }

        if store.archive_profiles.is_empty() {
            let rows = run_sqlite_json_lines(
                db_path,
                "select json_object('id', id, 'name', name, 'platform', platform, 'goal', goal, 'domain', domain, 'audience', audience, 'tone_tags', coalesce(tone_tags, '[]'), 'created_at', created_at, 'updated_at', updated_at) from archive_profiles order by updated_at desc;",
            )?;
            for value in rows {
                let tags = value
                    .get("tone_tags")
                    .and_then(|v| v.as_str())
                    .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                    .unwrap_or_default();
                store.archive_profiles.push(ArchiveProfileRecord {
                    id: value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    name: value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未命名档案")
                        .to_string(),
                    platform: value
                        .get("platform")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    goal: value
                        .get("goal")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    domain: value
                        .get("domain")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    audience: value
                        .get("audience")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    tone_tags: tags,
                    created_at: value
                        .get("created_at")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    updated_at: value
                        .get("updated_at")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                });
            }
        }

        if store.archive_samples.is_empty() {
            let rows = run_sqlite_json_lines(
                db_path,
                "select json_object('id', id, 'profile_id', profile_id, 'title', title, 'content', content, 'excerpt', excerpt, 'tags', coalesce(tags, '[]'), 'images', coalesce(images, '[]'), 'platform', platform, 'source_url', source_url, 'sample_date', sample_date, 'is_featured', is_featured, 'created_at', created_at) from archive_samples order by created_at desc;",
            )?;
            for value in rows {
                let tags = value
                    .get("tags")
                    .and_then(|v| v.as_str())
                    .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                    .unwrap_or_default();
                let images = value
                    .get("images")
                    .and_then(|v| v.as_str())
                    .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
                    .unwrap_or_default();
                store.archive_samples.push(ArchiveSampleRecord {
                    id: value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    profile_id: value
                        .get("profile_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    title: value
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    content: value
                        .get("content")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    excerpt: value
                        .get("excerpt")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    tags,
                    images,
                    platform: value
                        .get("platform")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    source_url: value
                        .get("source_url")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    sample_date: value
                        .get("sample_date")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string),
                    is_featured: value
                        .get("is_featured")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    created_at: value
                        .get("created_at")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                });
            }
        }
    }

    let workspace_base = ensure_preferred_workspace_dir(store, store_path)?;
    let store_root = store_path
        .parent()
        .ok_or_else(|| "RedBox store root is unavailable".to_string())?;
    let default_space_root = workspace_base.clone();
    ensure_workspace_dirs(&default_space_root)?;

    for managed_root in managed_workspace_dir_candidates(store_path) {
        if managed_root.exists() {
            let _ = migrate_legacy_workspace_dirs(&default_space_root, &managed_root);
        }
    }

    for legacy_workspace_root in legacy_workspace_root_candidates(store, db_path.as_deref()) {
        let _ = migrate_legacy_workspace_dirs(&default_space_root, &legacy_workspace_root);

        let legacy_spaces_root = legacy_workspace_root.join("spaces");
        if !legacy_spaces_root.exists() {
            continue;
        }
        for entry in fs::read_dir(&legacy_spaces_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.trim().is_empty() {
                continue;
            }
            let id = format!("legacy-{}", slug_from_relative_path(&name));
            if !store.spaces.iter().any(|space| space.id == id) {
                let timestamp = now_iso();
                store.spaces.push(SpaceRecord {
                    id: id.clone(),
                    name: name.clone(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                });
            }
            let target_root = workspace_base.join("spaces").join(&id);
            ensure_workspace_dirs(&target_root)?;
            let _ = migrate_legacy_workspace_dirs(&target_root, &path);
        }
    }

    for space in store.spaces.clone() {
        if space.id == "default" {
            continue;
        }
        let source = store_root.join("spaces").join(&space.id);
        let target = workspace_base.join("spaces").join(&space.id);
        if source.exists() {
            ensure_workspace_dirs(&target)?;
            let _ = migrate_legacy_workspace_dirs(&target, &source);
        }
    }

    store.legacy_imported_at = Some(now_iso());
    if let Some(db_path) = db_path {
        store.legacy_import_source = Some(db_path.display().to_string());
    }
    let _ = hydrate_store_from_workspace_files(store, store_path);
    Ok(())
}

fn extract_mcp_servers_from_json(value: &Value) -> Vec<McpServerRecord> {
    let object = value
        .get("mcpServers")
        .and_then(|item| item.as_object())
        .cloned()
        .unwrap_or_default();
    object
        .into_iter()
        .map(|(name, config)| McpServerRecord {
            id: format!("mcp-{}", slug_from_relative_path(&name)),
            name: name.clone(),
            enabled: config
                .get("enabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
            transport: if config.get("url").is_some() {
                "streamable-http".to_string()
            } else {
                "stdio".to_string()
            },
            command: config
                .get("command")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            args: config.get("args").and_then(|value| {
                value.as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
            }),
            env: config.get("env").and_then(|value| {
                value.as_object().map(|items| {
                    items
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                })
            }),
            url: config
                .get("url")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            oauth: config.get("oauth").cloned(),
        })
        .collect()
}

fn discover_local_mcp_configs() -> Vec<(String, Vec<McpServerRecord>)> {
    let mut sources = Vec::new();
    let mut candidates = vec![PathBuf::from(".mcp.json"), PathBuf::from("mcp.json")];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".codex").join("mcp.json"));
        candidates.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
    }
    for path in candidates {
        if !path.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let servers = extract_mcp_servers_from_json(&value);
        if !servers.is_empty() {
            sources.push((path.display().to_string(), servers));
        }
    }
    sources
}

fn read_stdio_mcp_message(
    reader: &mut BufReader<std::process::ChildStdout>,
) -> Result<Value, String> {
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|error| error.to_string())?;
        }
    }
    if content_length == 0 {
        return Err("MCP stdio server returned no framed response".to_string());
    }
    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

fn run_stdio_mcp_initialize_and_tools(
    command: &str,
    args: &[String],
) -> Result<(Value, Option<Value>), String> {
    let mut child = std::process::Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "stdio server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdio server stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    let initialize_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "RedBox",
                "version": "0.1.0"
            }
        }
    });
    let payload = serde_json::to_string(&initialize_request).map_err(|error| error.to_string())?;
    let wire = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    stdin
        .write_all(wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let initialize_response = read_stdio_mcp_message(&mut reader)?;

    let initialized_notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let initialized_payload =
        serde_json::to_string(&initialized_notification).map_err(|error| error.to_string())?;
    let initialized_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        initialized_payload.len(),
        initialized_payload
    );
    stdin
        .write_all(initialized_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let tools_request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let tools_payload = serde_json::to_string(&tools_request).map_err(|error| error.to_string())?;
    let tools_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        tools_payload.len(),
        tools_payload
    );
    stdin
        .write_all(tools_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let tools_response = read_stdio_mcp_message(&mut reader).ok();
    let _ = child.kill();
    let _ = child.wait();
    Ok((initialize_response, tools_response))
}

fn run_stdio_mcp_method(
    command: &str,
    args: &[String],
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut child = std::process::Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "stdio server stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdio server stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    let initialize_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "RedBox",
                "version": "0.1.0"
            }
        }
    });
    let init_payload =
        serde_json::to_string(&initialize_request).map_err(|error| error.to_string())?;
    let init_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        init_payload.len(),
        init_payload
    );
    stdin
        .write_all(init_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    let _ = read_stdio_mcp_message(&mut reader)?;

    let initialized_notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let initialized_payload =
        serde_json::to_string(&initialized_notification).map_err(|error| error.to_string())?;
    let initialized_wire = format!(
        "Content-Length: {}\r\n\r\n{}",
        initialized_payload.len(),
        initialized_payload
    );
    stdin
        .write_all(initialized_wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": method,
        "params": params
    });
    let payload = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let wire = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    stdin
        .write_all(wire.as_bytes())
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;

    let response = read_stdio_mcp_message(&mut reader)?;
    let _ = child.kill();
    let _ = child.wait();
    Ok(response)
}

fn invoke_mcp_server(
    server: &McpServerRecord,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 stdio command".to_string())?;
            run_stdio_mcp_method(
                command,
                &server.args.clone().unwrap_or_default(),
                method,
                params,
            )
        }
        "streamable-http" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 MCP URL".to_string())?;
            run_curl_json(
                "POST",
                url,
                None,
                &[],
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": params
                })),
            )
        }
        "sse" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 MCP URL".to_string())?;
            run_sse_mcp_method(url, method, params)
        }
        other => Err(format!("不支持的 transport: {}", other)),
    }
}

fn test_mcp_server(server: &McpServerRecord) -> Result<(String, String), String> {
    match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 stdio command".to_string())?;
            let (initialize_response, tools_response) = run_stdio_mcp_initialize_and_tools(
                command,
                &server.args.clone().unwrap_or_default(),
            )?;
            let server_name = initialize_response
                .pointer("/result/serverInfo/name")
                .and_then(|value| value.as_str())
                .unwrap_or(command);
            let protocol = initialize_response
                .pointer("/result/protocolVersion")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let tool_count = tools_response
                .as_ref()
                .and_then(|value| value.pointer("/result/tools"))
                .and_then(|value| value.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            Ok((
                "连接成功".to_string(),
                format!(
                    "initialized {} ({}) · tools {}",
                    server_name, protocol, tool_count
                ),
            ))
        }
        "sse" | "streamable-http" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "缺少 MCP URL".to_string())?;
            if server.transport == "streamable-http" {
                let init_response = run_curl_json(
                    "POST",
                    url,
                    None,
                    &[],
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {},
                            "clientInfo": {
                                "name": "RedBox",
                                "version": "0.1.0"
                            }
                        }
                    })),
                )?;
                let server_name = init_response
                    .pointer("/result/serverInfo/name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let tools_response = run_curl_json(
                    "POST",
                    url,
                    None,
                    &[],
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {}
                    })),
                )?;
                let tool_count = tools_response
                    .pointer("/result/tools")
                    .and_then(|value| value.as_array())
                    .map(|items| items.len())
                    .unwrap_or(0);
                return Ok((
                    "连接成功".to_string(),
                    format!("initialized {} · tools {}", server_name, tool_count),
                ));
            }

            let init_response = run_sse_mcp_method(
                url,
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "RedBox",
                        "version": "0.1.0"
                    }
                }),
            )?;
            let server_name = init_response
                .pointer("/result/serverInfo/name")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let tools_response = run_sse_mcp_method(url, "tools/list", json!({}))?;
            let tool_count = tools_response
                .pointer("/result/tools")
                .and_then(|value| value.as_array())
                .map(|items| items.len())
                .unwrap_or(0);
            Ok((
                "连接成功".to_string(),
                format!("initialized {} · tools {}", server_name, tool_count),
            ))
        }
        other => Err(format!("不支持的 transport: {}", other)),
    }
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

fn append_session_checkpoint(
    store: &mut AppStore,
    session_id: &str,
    checkpoint_type: &str,
    summary: String,
    payload: Option<Value>,
) {
    store.session_checkpoints.push(SessionCheckpointRecord {
        id: make_id("checkpoint"),
        session_id: session_id.to_string(),
        checkpoint_type: checkpoint_type.to_string(),
        summary,
        payload,
        created_at: now_i64(),
    });
}

fn append_runtime_task_trace(
    store: &mut AppStore,
    task_id: &str,
    event_type: &str,
    payload: Option<Value>,
) {
    store.runtime_task_traces.push(RuntimeTaskTraceRecord {
        id: now_i64(),
        task_id: task_id.to_string(),
        node_id: None,
        event_type: event_type.to_string(),
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

fn build_memory_maintenance_prompt(store: &AppStore) -> String {
    let template =
        load_redbox_prompt("runtime/memory/maintenance_manager.txt").unwrap_or_else(|| {
            "You are a memory maintenance manager. Output strict JSON only.".to_string()
        });
    let active_memories: Vec<Value> = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
        .cloned()
        .map(|item| json!(item))
        .collect();
    let archived_memories: Vec<Value> = store
        .memories
        .iter()
        .filter(|item| item.status.as_deref() == Some("archived"))
        .cloned()
        .map(|item| json!(item))
        .collect();
    let history: Vec<Value> = store
        .memory_history
        .iter()
        .cloned()
        .map(|item| json!(item))
        .collect();
    let recent_conversations: Vec<Value> = store
        .chat_sessions
        .iter()
        .take(5)
        .map(|session| {
            let metadata = session.metadata.clone().unwrap_or_else(|| json!({}));
            let messages = store
                .chat_messages
                .iter()
                .filter(|item| item.session_id == session.id)
                .take(12)
                .map(|item| {
                    json!({
                        "role": item.role,
                        "content": truncate_chars(&item.content, 280),
                        "timestamp": item.created_at,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "sessionId": session.id,
                "title": session.title,
                "updatedAt": session.updated_at,
                "contextType": metadata.get("contextType").cloned().unwrap_or_else(|| json!("unknown")),
                "messageCount": messages.len(),
                "messages": messages,
            })
        })
        .collect();
    render_redbox_prompt(
        &template,
        &[
            ("trigger_reason", "manual".to_string()),
            ("current_date", now_iso()),
            ("pending_mutation_count", "0".to_string()),
            ("active_memory_count", active_memories.len().to_string()),
            ("archived_memory_count", archived_memories.len().to_string()),
            ("history_count", history.len().to_string()),
            ("recent_conversations_count", "0".to_string()),
            (
                "active_memories_json",
                serde_json::to_string_pretty(&active_memories).unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "archived_memories_json",
                serde_json::to_string_pretty(&archived_memories)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "history_json",
                serde_json::to_string_pretty(&history).unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                "recent_conversations_json",
                serde_json::to_string_pretty(&recent_conversations)
                    .unwrap_or_else(|_| "[]".to_string()),
            ),
        ],
    )
}

fn bump_memory_maintenance_mutation(store: &mut AppStore, reason: &str) {
    let current = memory_maintenance_status_from_settings(&store.settings)
        .unwrap_or_else(default_memory_maintenance_status);
    let pending = current
        .get("pendingMutations")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        + 1;
    let next_delay_ms = if pending >= 5 {
        15 * 60 * 1000
    } else {
        90 * 60 * 1000
    };
    let status = json!({
        "started": true,
        "running": false,
        "lockState": current.get("lockState").cloned().unwrap_or_else(|| json!("owner")),
        "blockedBy": current.get("blockedBy").cloned().unwrap_or(Value::Null),
        "pendingMutations": pending,
        "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
        "lastScanAt": current.get("lastScanAt").cloned().unwrap_or(Value::Null),
        "lastReason": reason,
        "lastSummary": current.get("lastSummary").cloned().unwrap_or_else(|| json!("RedBox memory maintenance has not run yet.")),
        "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
        "nextScheduledAt": now_i64() + next_delay_ms,
    });
    let mut settings = store.settings.clone();
    write_memory_maintenance_status(&mut settings, &status);
    store.settings = settings;
    store.redclaw_state.next_maintenance_at = value_to_i64_string(status.get("nextScheduledAt"));
}

fn run_memory_maintenance_with_reason(
    state: &State<'_, AppState>,
    reason: &str,
) -> Result<Value, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let prompt = with_store(state, |store| Ok(build_memory_maintenance_prompt(&store)))?;
    let system_prompt =
        "You are the background long-term memory maintenance manager for RedBox. Output strict JSON only.";
    let raw = generate_structured_response_with_settings(
        &settings_snapshot,
        None,
        system_prompt,
        &prompt,
        true,
    )?;
    let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
        json!({
            "summary": "memory-maintenance:no-parse",
            "actions": [{ "type": "noop", "reason": "parse-failed" }]
        })
    });
    let actions = parsed
        .get("actions")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut applied = 0_i64;
    let mut archived = 0_i64;
    let mut deleted = 0_i64;
    with_store_mut(state, |store| {
        for action in actions {
            let action_type = payload_string(&action, "type").unwrap_or_default();
            match action_type.as_str() {
                "create" => {
                    let content = payload_string(&action, "content").unwrap_or_default();
                    if content.trim().is_empty() {
                        continue;
                    }
                    let memory_type = payload_string(&action, "memoryType")
                        .unwrap_or_else(|| "general".to_string());
                    let tags = action
                        .get("tags")
                        .and_then(|value| value.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(ToString::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let record = UserMemoryRecord {
                        id: make_id("memory"),
                        content,
                        r#type: memory_type,
                        tags,
                        created_at: now_i64(),
                        updated_at: Some(now_i64()),
                        last_accessed: None,
                        status: Some("active".to_string()),
                        archived_at: None,
                        archive_reason: None,
                        origin_id: None,
                        canonical_key: None,
                        revision: Some(1),
                        last_conflict_at: None,
                    };
                    store.memories.push(record.clone());
                    store.memory_history.push(MemoryHistoryRecord {
                        id: make_id("memory-history"),
                        memory_id: record.id.clone(),
                        origin_id: record.id.clone(),
                        action: "create".to_string(),
                        reason: payload_string(&action, "reason"),
                        timestamp: now_i64(),
                        before: None,
                        after: Some(json!(record)),
                        archived_memory_id: None,
                    });
                    applied += 1;
                }
                "update" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    let content = payload_string(&action, "content").unwrap_or_default();
                    if let Some(item) = store
                        .memories
                        .iter_mut()
                        .find(|entry| entry.id == target_id)
                    {
                        let before = json!(item.clone());
                        if !content.trim().is_empty() {
                            item.content = content;
                        }
                        if let Some(memory_type) = payload_string(&action, "memoryType") {
                            item.r#type = memory_type;
                        }
                        if let Some(tags) = action.get("tags").and_then(|value| value.as_array()) {
                            item.tags = tags
                                .iter()
                                .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                .collect();
                        }
                        item.updated_at = Some(now_i64());
                        let after = json!(item.clone());
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: item.id.clone(),
                            origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                            action: "update".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: Some(after),
                            archived_memory_id: None,
                        });
                        applied += 1;
                    }
                }
                "archive" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    if let Some(item) = store
                        .memories
                        .iter_mut()
                        .find(|entry| entry.id == target_id)
                    {
                        let before = json!(item.clone());
                        item.status = Some("archived".to_string());
                        item.archived_at = Some(now_i64());
                        item.archive_reason = payload_string(&action, "reason");
                        let after = json!(item.clone());
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: item.id.clone(),
                            origin_id: item.origin_id.clone().unwrap_or_else(|| item.id.clone()),
                            action: "archive".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: Some(after),
                            archived_memory_id: Some(item.id.clone()),
                        });
                        archived += 1;
                    }
                }
                "delete" => {
                    let target_id = payload_string(&action, "targetMemoryId").unwrap_or_default();
                    if let Some(index) = store
                        .memories
                        .iter()
                        .position(|entry| entry.id == target_id)
                    {
                        let before = json!(store.memories[index].clone());
                        let removed = store.memories.remove(index);
                        store.memory_history.push(MemoryHistoryRecord {
                            id: make_id("memory-history"),
                            memory_id: target_id.clone(),
                            origin_id: removed
                                .origin_id
                                .clone()
                                .unwrap_or_else(|| removed.id.clone()),
                            action: "delete".to_string(),
                            reason: payload_string(&action, "reason"),
                            timestamp: now_i64(),
                            before: Some(before),
                            after: None,
                            archived_memory_id: None,
                        });
                        deleted += 1;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    })?;
    let next_scheduled = match reason {
        "query-after" => now_i64() + 5 * 60 * 1000,
        "periodic" => now_i64() + 30 * 60 * 1000,
        _ => now_i64() + 20 * 60 * 1000,
    };
    let status = json!({
        "started": true,
        "running": false,
        "lockState": "owner",
        "blockedBy": Value::Null,
        "pendingMutations": 0,
        "lastRunAt": now_i64(),
        "lastScanAt": now_i64(),
        "lastReason": reason,
        "lastSummary": parsed.get("summary").and_then(|value| value.as_str()).unwrap_or("RedBox memory maintenance completed."),
        "lastError": Value::Null,
        "nextScheduledAt": next_scheduled,
        "raw": parsed,
        "applied": applied,
        "archived": archived,
        "deleted": deleted
    });
    let _ = with_store_mut(state, |store| {
        let mut settings = store.settings.clone();
        write_memory_maintenance_status(&mut settings, &status);
        store.settings = settings;
        store.redclaw_state.next_maintenance_at =
            value_to_i64_string(status.get("nextScheduledAt"));
        Ok(())
    });
    Ok(status)
}

fn url_encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

fn normalize_search_provider(value: Option<&str>) -> &'static str {
    match value.unwrap_or("duckduckgo").trim().to_lowercase().as_str() {
        "tavily" => "tavily",
        "searxng" => "searxng",
        _ => "duckduckgo",
    }
}

fn parse_duckduckgo_results(html: &str, count: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut rest = html;
    while results.len() < count {
        let Some(anchor_idx) = rest.find("result__a") else {
            break;
        };
        let anchor_slice = &rest[anchor_idx..];
        let Some(href_idx) = anchor_slice.find("href=\"") else {
            rest = &anchor_slice["result__a".len()..];
            continue;
        };
        let href_slice = &anchor_slice[href_idx + 6..];
        let Some(href_end) = href_slice.find('"') else {
            break;
        };
        let url = href_slice[..href_end].trim().to_string();
        let Some(tag_close) = href_slice[href_end..].find('>') else {
            break;
        };
        let title_slice = &href_slice[href_end + tag_close + 1..];
        let Some(title_end) = title_slice.find("</a>") else {
            break;
        };
        let title = title_slice[..title_end]
            .replace("<b>", "")
            .replace("</b>", "")
            .replace("&amp;", "&")
            .replace("&#x27;", "'")
            .trim()
            .to_string();
        let snippet = if let Some(snippet_idx) = title_slice.find("result__snippet") {
            let snippet_slice = &title_slice[snippet_idx..];
            if let Some(start) = snippet_slice.find('>') {
                if let Some(end) = snippet_slice[start + 1..].find("</a>") {
                    snippet_slice[start + 1..start + 1 + end]
                        .replace("<b>", "")
                        .replace("</b>", "")
                        .replace("&amp;", "&")
                        .replace("&#x27;", "'")
                        .replace('\n', " ")
                        .trim()
                        .to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        if !title.is_empty() && !url.is_empty() && !url.contains("duckduckgo.com") {
            results.push(json!({
                "title": title,
                "url": url,
                "snippet": snippet,
            }));
        }
        rest = &title_slice[title_end..];
    }
    results
}

fn search_web_with_settings(
    settings: &Value,
    query: &str,
    count: usize,
) -> Result<Vec<Value>, String> {
    let provider =
        normalize_search_provider(payload_string(settings, "search_provider").as_deref());
    let endpoint = payload_string(settings, "search_endpoint").unwrap_or_default();
    let api_key = payload_string(settings, "search_api_key").unwrap_or_default();
    match provider {
        "tavily" => {
            if api_key.trim().is_empty() {
                return Err("Tavily 搜索需要先配置 API Key".to_string());
            }
            let base = if endpoint.trim().is_empty() {
                "https://api.tavily.com".to_string()
            } else {
                normalize_base_url(&endpoint)
            };
            let response = run_curl_json(
                "POST",
                &format!("{}/search", base),
                None,
                &[("Content-Type", "application/json".to_string())],
                Some(json!({
                    "api_key": api_key,
                    "query": query,
                    "max_results": count,
                    "search_depth": "basic",
                    "include_answer": false,
                    "include_images": false
                })),
            )?;
            Ok(response
                .get("results")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default())
        }
        "searxng" => {
            let base = normalize_base_url(&endpoint);
            if base.is_empty() {
                return Err("SearXNG 搜索需要先配置 endpoint".to_string());
            }
            let url = format!(
                "{}/search?q={}&format=json&language=zh-CN",
                base,
                url_encode_component(query)
            );
            let mut headers = Vec::new();
            if !api_key.trim().is_empty() {
                headers.push(("Authorization", format!("Bearer {}", api_key.trim())));
            }
            let response = run_curl_json("GET", &url, None, &headers, None)?;
            Ok(response
                .get("results")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default())
        }
        _ => {
            let url = format!(
                "https://html.duckduckgo.com/html/?q={}",
                url_encode_component(query)
            );
            let html = run_curl_text(
                "GET",
                &url,
                &[(
                    "User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36".to_string(),
                )],
                None,
            )?;
            Ok(parse_duckduckgo_results(&html, count))
        }
    }
}

fn memory_maintenance_status_from_settings(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_memory_maintenance_status_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

fn write_memory_maintenance_status(settings: &mut Value, status: &Value) {
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "redbox_memory_maintenance_status_json".to_string(),
            json!(serde_json::to_string(status).unwrap_or_else(|_| "{}".to_string())),
        );
    }
}

fn default_memory_maintenance_status() -> Value {
    json!({
        "started": true,
        "running": false,
        "lockState": "owner",
        "blockedBy": Value::Null,
        "pendingMutations": 0,
        "lastRunAt": Value::Null,
        "lastScanAt": Value::Null,
        "lastReason": Value::Null,
        "lastSummary": "RedBox memory maintenance has not run yet.",
        "lastError": Value::Null,
        "nextScheduledAt": Value::Null,
    })
}

fn value_to_i64_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|item| {
        item.as_i64()
            .map(|number| number.to_string())
            .or_else(|| item.as_str().map(ToString::to_string))
    })
}

fn assistant_state_value(state: &AssistantStateRecord) -> Value {
    json!({
        "enabled": state.enabled,
        "autoStart": state.auto_start,
        "keepAliveWhenNoWindow": state.keep_alive_when_no_window,
        "host": state.host,
        "port": state.port,
        "listening": state.listening,
        "lockState": state.lock_state,
        "blockedBy": state.blocked_by,
        "lastError": state.last_error,
        "activeTaskCount": state.active_task_count,
        "queuedPeerCount": state.queued_peer_count,
        "inFlightKeys": state.in_flight_keys,
        "feishu": state.feishu,
        "relay": state.relay,
        "weixin": state.weixin,
    })
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

fn emit_assistant_log(app: &AppHandle, line: &str) {
    let _ = app.emit(
        "assistant:daemon-log",
        json!({
            "at": now_iso(),
            "level": "info",
            "message": line,
        }),
    );
}

fn emit_assistant_status(app: &AppHandle, state: &AssistantStateRecord) {
    let _ = app.emit("assistant:daemon-status", assistant_state_value(state));
}

fn http_ok_json(stream: &mut TcpStream, body: Value) -> Result<(), String> {
    let payload = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())
}

fn parse_http_request_parts(raw: &str) -> (String, String) {
    let normalized = raw.replace("\r\n", "\n");
    let mut parts = normalized.splitn(2, "\n\n");
    let headers = parts.next().unwrap_or_default().to_string();
    let body = parts.next().unwrap_or_default().to_string();
    (headers, body)
}

fn parse_http_request_meta(
    raw_headers: &str,
) -> (String, String, std::collections::HashMap<String, String>) {
    let mut lines = raw_headers.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("GET").to_string();
    let path = request_parts.next().unwrap_or("/").to_string();
    let mut headers = std::collections::HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }
    (method, path, headers)
}

fn assistant_session_id_for_route(route_kind: &str) -> String {
    format!("assistant-session:{}", slug_from_relative_path(route_kind))
}

fn extract_assistant_prompt(route_kind: &str, body: &str) -> Result<Option<String>, String> {
    let parsed = serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({}));

    if let Some(challenge) = parsed.get("challenge").and_then(|value| value.as_str()) {
        return Ok(Some(challenge.to_string()));
    }

    let text = match route_kind {
        "feishu" => parsed
            .pointer("/event/text")
            .and_then(|value| value.as_str())
            .or_else(|| {
                parsed
                    .pointer("/event/message/content")
                    .and_then(|value| value.as_str())
            })
            .or_else(|| parsed.get("text").and_then(|value| value.as_str())),
        "weixin" => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("content").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("message").and_then(|value| value.as_str())),
        "relay" => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("message").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("prompt").and_then(|value| value.as_str())),
        _ => parsed
            .get("text")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("message").and_then(|value| value.as_str())),
    };

    Ok(text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn validate_assistant_request(
    route_kind: &str,
    headers: &std::collections::HashMap<String, String>,
    body: &Value,
    assistant_state: &AssistantStateRecord,
) -> Result<Option<Value>, String> {
    match route_kind {
        "feishu" => {
            if let Some(expected) = assistant_state
                .feishu
                .get("verificationToken")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                let provided = body
                    .get("token")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if provided != expected {
                    return Err("Feishu verification token mismatch".to_string());
                }
            }
            if body.get("type").and_then(|value| value.as_str()) == Some("url_verification") {
                let challenge = body
                    .get("challenge")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                return Ok(Some(json!({ "challenge": challenge })));
            }
        }
        "relay" => {
            if let Some(expected) = assistant_state
                .relay
                .get("authToken")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                let auth = headers
                    .get("authorization")
                    .or_else(|| headers.get("x-auth-token"))
                    .cloned()
                    .unwrap_or_default();
                let normalized = auth.strip_prefix("Bearer ").unwrap_or(&auth);
                if normalized.trim() != expected {
                    return Err("Relay auth token mismatch".to_string());
                }
            }
        }
        "weixin" => {
            if let Some(expected) = assistant_state
                .weixin
                .get("authToken")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                let auth = headers
                    .get("authorization")
                    .or_else(|| headers.get("x-auth-token"))
                    .cloned()
                    .unwrap_or_default();
                let normalized = auth.strip_prefix("Bearer ").unwrap_or(&auth);
                if normalized.trim() != expected {
                    return Err("Weixin auth token mismatch".to_string());
                }
            }
        }
        _ => {}
    }
    Ok(None)
}

fn execute_assistant_message(
    app: &AppHandle,
    route_kind: &str,
    headers: &std::collections::HashMap<String, String>,
    body: &str,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let settings_snapshot = with_store(&state, |store| Ok(store.settings.clone()))?;
    let assistant_snapshot = with_store(&state, |store| Ok(store.assistant_state.clone()))?;
    let parsed_body = serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({}));
    if let Some(response) =
        validate_assistant_request(route_kind, headers, &parsed_body, &assistant_snapshot)?
    {
        return Ok(response);
    }
    let prompt = extract_assistant_prompt(route_kind, body)?;
    let Some(prompt) = prompt else {
        return Ok(json!({
            "success": true,
            "message": "No actionable text found in request body.",
            "routeKind": route_kind
        }));
    };

    let response = if let Some((protocol, base_url, api_key, model_name)) =
        resolve_default_model_config(&settings_snapshot)
    {
        invoke_chat_by_protocol(
            &protocol,
            &base_url,
            api_key.as_deref(),
            &model_name,
            &prompt,
        )
        .unwrap_or_else(|_| build_placeholder_assistant_response(&prompt))
    } else {
        build_placeholder_assistant_response(&prompt)
    };

    let session_id = assistant_session_id_for_route(route_kind);
    with_store_mut(&state, |store| {
        let (session, _) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(session_id.clone()),
            Some(format!("Assistant · {}", route_kind)),
        );
        session.updated_at = now_iso();

        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session_id.clone(),
            role: "user".to_string(),
            content: prompt.clone(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session_id.clone(),
            role: "assistant".to_string(),
            content: response.clone(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        append_session_transcript(
            store,
            &session_id,
            "message",
            "user",
            prompt.clone(),
            Some(json!({ "routeKind": route_kind })),
        );
        append_session_transcript(
            store,
            &session_id,
            "message",
            "assistant",
            response.clone(),
            Some(json!({ "routeKind": route_kind })),
        );
        append_session_checkpoint(
            store,
            &session_id,
            "assistant-daemon",
            format!("Assistant daemon handled {}", route_kind),
            Some(json!({ "responsePreview": response.chars().take(120).collect::<String>() })),
        );
        Ok(())
    })?;
    emit_assistant_log(
        app,
        &format!("assistant daemon completed {} request", route_kind),
    );
    Ok(json!({
        "success": true,
        "routeKind": route_kind,
        "reply": response,
        "sessionId": session_id
    }))
}

fn run_assistant_listener(
    app: AppHandle,
    host: String,
    port: i64,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    let listener =
        TcpListener::bind(format!("{}:{}", host, port)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    emit_assistant_log(
        &app,
        &format!("assistant daemon listening on http://{}:{}", host, port),
    );
    let join = thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, addr)) => {
                    let mut buffer = [0_u8; 4096];
                    let _ = stream.read(&mut buffer);
                    let request = String::from_utf8_lossy(&buffer);
                    let first_line = request.lines().next().unwrap_or_default().to_string();
                    let path = first_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon request from {}: {}", addr, first_line),
                    );
                    let route_kind = if path.contains("/hooks/feishu/") {
                        "feishu"
                    } else if path.contains("/hooks/weixin/") {
                        "weixin"
                    } else if path.contains("/hooks/channel/relay") {
                        "relay"
                    } else {
                        "generic"
                    };
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon matched route kind: {}", route_kind),
                    );
                    let (raw_headers, body) = parse_http_request_parts(&request);
                    let (_method, _path, headers) = parse_http_request_meta(&raw_headers);
                    let result = execute_assistant_message(&app, route_kind, &headers, &body)
                        .unwrap_or_else(|error| {
                            json!({
                                "success": false,
                                "routeKind": route_kind,
                                "error": error
                            })
                        });
                    let _ = http_ok_json(
                        &mut stream,
                        json!({
                            "endpoint": first_line,
                            "path": path,
                            "routeKind": route_kind,
                            "result": result
                        }),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(error) => {
                    emit_assistant_log(
                        &app,
                        &format!("assistant daemon listener error: {}", error),
                    );
                    thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
        emit_assistant_log(&app, "assistant daemon stopped");
    });
    Ok(join)
}

fn spawn_weixin_sidecar(weixin: &Value) -> Result<Option<AssistantSidecarRuntime>, String> {
    let enabled = weixin
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let auto_start = weixin
        .get("autoStartSidecar")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let command = weixin
        .get("sidecarCommand")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if !enabled || !auto_start || command.is_none() {
        return Ok(None);
    }
    let command = command.unwrap();
    let args = weixin
        .get("sidecarArgs")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut child_command = std::process::Command::new(command);
    child_command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = weixin
        .get("sidecarCwd")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        child_command.current_dir(cwd);
    }
    if let Some(env) = weixin.get("sidecarEnv").and_then(|value| value.as_object()) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                child_command.env(key, value);
            }
        }
    }
    let child = child_command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    Ok(Some(AssistantSidecarRuntime { child, pid }))
}

fn stop_assistant_sidecar(state: &State<'_, AppState>) -> Result<Option<u32>, String> {
    let mut guard = state
        .assistant_sidecar
        .lock()
        .map_err(|_| "assistant sidecar lock 已损坏".to_string())?;
    if let Some(mut runtime) = guard.take() {
        let pid = runtime.pid;
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
        return Ok(Some(pid));
    }
    Ok(None)
}

fn collect_json_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || !root.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_json_files(&path, depth - 1, out);
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

fn read_weixin_sidecar_state(state_dir: &Path) -> Option<Value> {
    let mut files = Vec::new();
    collect_json_files(state_dir, 4, &mut files);
    files.sort();
    for path in files {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let account_id = payload_string(&value, "accountId")
            .or_else(|| payload_string(&value, "account_id"))
            .or_else(|| payload_string(&value, "botId"))
            .or_else(|| payload_string(&value, "uin"));
        let user_id = payload_string(&value, "userId")
            .or_else(|| payload_string(&value, "user_id"))
            .or_else(|| payload_string(&value, "wxid"));
        let token = payload_string(&value, "token")
            .or_else(|| payload_string(&value, "botToken"))
            .or_else(|| payload_string(&value, "accessToken"));
        let connected = value
            .get("connected")
            .and_then(|item| item.as_bool())
            .unwrap_or(false)
            || account_id.is_some()
            || token.is_some();
        if connected {
            return Some(json!({
                "connected": true,
                "accountId": account_id,
                "userId": user_id,
                "token": token,
                "sourcePath": path.display().to_string()
            }));
        }
    }
    None
}

fn read_text_file_or_empty(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn route_runtime_intent_with_settings(
    settings: &Value,
    runtime_mode: &str,
    user_input: &str,
    metadata: Option<&Value>,
) -> Value {
    let fallback = runtime_direct_route(runtime_mode, user_input, metadata);
    let Some(system_template) = load_redbox_prompt("runtime/ai/route_intent_system.txt") else {
        return fallback;
    };
    let Some(user_template) = load_redbox_prompt("runtime/ai/route_intent_user.txt") else {
        return fallback;
    };
    let user_prompt = render_redbox_prompt(
        &user_template,
        &[
            ("runtime_mode", runtime_mode.to_string()),
            ("user_input", user_input.to_string()),
            (
                "context_type",
                metadata
                    .and_then(|value| payload_field(value, "contextType"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "context_id",
                metadata
                    .and_then(|value| payload_field(value, "contextId"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "associated_file_path",
                metadata
                    .and_then(|value| payload_field(value, "associatedFilePath"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "fallback_intent",
                payload_string(&fallback, "intent").unwrap_or_default(),
            ),
            (
                "fallback_role",
                payload_string(&fallback, "recommendedRole").unwrap_or_default(),
            ),
            (
                "fallback_reasoning",
                payload_string(&fallback, "reasoning").unwrap_or_default(),
            ),
            ("intent_names", RUNTIME_INTENT_NAMES.join(", ")),
            ("role_ids", RUNTIME_ROLE_IDS.join(", ")),
        ],
    );
    let raw = generate_structured_response_with_settings(
        settings,
        None,
        &system_template,
        &user_prompt,
        true,
    );
    let Ok(content) = raw else {
        return fallback;
    };
    let Some(parsed) = parse_json_value_from_text(&content) else {
        return fallback;
    };
    let intent = normalize_runtime_intent_name(
        parsed
            .get("primary_intent")
            .or_else(|| parsed.get("intent"))
            .and_then(|value| value.as_str()),
    );
    let recommended_role = normalize_runtime_role_id(
        parsed
            .get("recommended_role")
            .or_else(|| parsed.get("role_id"))
            .and_then(|value| value.as_str()),
    );
    let (Some(intent), Some(role)) = (intent, recommended_role) else {
        return fallback;
    };
    json!({
        "intent": intent,
        "secondaryIntents": parsed.get("secondary_intents").cloned().unwrap_or_else(|| json!([])),
        "goal": parsed.get("goal").and_then(|value| value.as_str()).unwrap_or(user_input).to_string(),
        "deliverables": parsed.get("deliverables").cloned().unwrap_or_else(|| json!([])),
        "requiredCapabilities": parsed
            .get("required_capabilities")
            .cloned()
            .unwrap_or_else(|| json!(runtime_required_capabilities(&intent))),
        "recommendedRole": role,
        "requiresLongRunningTask": parsed.get("requires_long_running_task").and_then(|value| value.as_bool()).unwrap_or_else(|| fallback.get("requiresLongRunningTask").and_then(|v| v.as_bool()).unwrap_or(false)),
        "requiresMultiAgent": parsed.get("requires_multi_agent").and_then(|value| value.as_bool()).unwrap_or_else(|| fallback.get("requiresMultiAgent").and_then(|v| v.as_bool()).unwrap_or(false)),
        "requiresHumanApproval": parsed.get("requires_human_approval").and_then(|value| value.as_bool()).unwrap_or_else(|| fallback.get("requiresHumanApproval").and_then(|v| v.as_bool()).unwrap_or(false)),
        "confidence": parsed.get("confidence").and_then(|value| value.as_f64()).unwrap_or_else(|| fallback.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.82)),
        "reasoning": parsed.get("reasoning").and_then(|value| value.as_str()).unwrap_or("llm-route").to_string(),
        "source": "llm",
    })
}

fn session_bridge_summary(session: &ChatSessionRecord, store: &AppStore) -> Value {
    let updated_at = session.updated_at.parse::<i64>().unwrap_or(0);
    let created_at = session.created_at.parse::<i64>().unwrap_or(0);
    let owner_task_count = store
        .runtime_tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(session.id.as_str()))
        .count() as i64;
    json!({
        "id": session.id,
        "title": session.title,
        "updatedAt": updated_at,
        "createdAt": created_at,
        "contextType": "chat",
        "runtimeMode": "default",
        "isBackgroundSession": false,
        "ownerTaskCount": owner_task_count,
        "backgroundTaskCount": 0,
    })
}

fn derived_background_tasks(store: &AppStore) -> Vec<Value> {
    let mut tasks = Vec::new();
    for task in &store.redclaw_state.scheduled_tasks {
        tasks.push(json!({
            "id": task.id,
            "kind": "scheduled-task",
            "title": task.name,
            "status": if task.enabled { "running" } else { "cancelled" },
            "phase": if task.enabled { "thinking" } else { "cancelled" },
            "sessionId": Value::Null,
            "contextId": task.project_id,
            "error": task.last_error,
            "summary": task.prompt,
            "latestText": task.prompt,
            "attemptCount": 0,
            "workerState": "idle",
            "workerMode": "main-process",
            "rollbackState": "not_required",
            "createdAt": task.created_at,
            "updatedAt": task.updated_at,
            "completedAt": Value::Null,
            "turns": []
        }));
    }
    for task in &store.redclaw_state.long_cycle_tasks {
        tasks.push(json!({
            "id": task.id,
            "kind": "long-cycle",
            "title": task.name,
            "status": task.status,
            "phase": if task.status == "completed" { "completed" } else { "thinking" },
            "sessionId": Value::Null,
            "contextId": task.project_id,
            "error": task.last_error,
            "summary": task.objective,
            "latestText": task.step_prompt,
            "attemptCount": task.completed_rounds,
            "workerState": "idle",
            "workerMode": "main-process",
            "rollbackState": "not_required",
            "createdAt": task.created_at,
            "updatedAt": task.updated_at,
            "completedAt": Value::Null,
            "turns": []
        }));
    }
    tasks
}

fn manuscript_layouts_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(workspace_root(state)?.join("manuscript-layouts.json"))
}

fn default_indexing_stats() -> Value {
    json!({
        "isIndexing": false,
        "totalQueueLength": 0,
        "activeItems": [],
        "queuedItems": [],
        "processedCount": 0,
        "totalStats": {
            "vectors": 0,
            "documents": 0
        }
    })
}

fn emit_space_changed(app: &AppHandle, active_space_id: &str) {
    let _ = app.emit(
        "space:changed",
        json!({ "spaceId": active_space_id, "activeSpaceId": active_space_id }),
    );
}

fn subject_record_from_input(
    input: SubjectMutationInput,
    existing: Option<SubjectRecord>,
) -> SubjectRecord {
    let created_at = existing
        .as_ref()
        .map(|item| item.created_at.clone())
        .unwrap_or_else(now_iso);
    let images = input.images.unwrap_or_default();
    let image_paths: Vec<String> = images
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.relative_path
                .clone()
                .or_else(|| {
                    item.name
                        .clone()
                        .map(|name| format!("inline:{index}:{name}"))
                })
                .unwrap_or_else(|| format!("inline:{index}"))
        })
        .collect();
    let preview_urls: Vec<String> = images
        .iter()
        .map(|item| {
            item.data_url
                .clone()
                .or_else(|| item.relative_path.clone())
                .unwrap_or_default()
        })
        .collect();
    let voice_preview_url = input.voice.as_ref().and_then(|voice| {
        voice
            .data_url
            .clone()
            .or_else(|| voice.relative_path.clone())
            .filter(|item| !item.is_empty())
    });
    let voice_path = input.voice.as_ref().and_then(|voice| {
        voice.relative_path.clone().or_else(|| {
            voice
                .name
                .clone()
                .map(|name| format!("inline-voice:{name}"))
        })
    });
    let voice_script = input
        .voice
        .as_ref()
        .and_then(|voice| voice.script_text.clone());

    SubjectRecord {
        id: input.id.unwrap_or_else(|| make_id("subject")),
        name: input.name,
        category_id: input.category_id.filter(|item| !item.is_empty()),
        description: input.description.filter(|item| !item.trim().is_empty()),
        tags: input.tags.unwrap_or_default(),
        attributes: input.attributes.unwrap_or_default(),
        image_paths: image_paths.clone(),
        voice_path: voice_path.clone(),
        voice_script,
        created_at,
        updated_at: now_iso(),
        absolute_image_paths: image_paths.clone(),
        preview_urls: preview_urls.clone(),
        primary_preview_url: preview_urls.first().cloned(),
        absolute_voice_path: voice_path,
        voice_preview_url,
    }
}

fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn ensure_markdown_extension(value: &str) -> String {
    let normalized = normalize_relative_path(value);
    if normalized.ends_with(".md") {
        normalized
    } else if normalized.is_empty() {
        "Untitled.md".to_string()
    } else {
        format!("{normalized}.md")
    }
}

const ARTICLE_DRAFT_EXTENSION: &str = ".redarticle";
const POST_DRAFT_EXTENSION: &str = ".redpost";
const VIDEO_DRAFT_EXTENSION: &str = ".redvideo";
const AUDIO_DRAFT_EXTENSION: &str = ".redaudio";

fn is_manuscript_package_name(file_name: &str) -> bool {
    file_name.ends_with(ARTICLE_DRAFT_EXTENSION)
        || file_name.ends_with(POST_DRAFT_EXTENSION)
        || file_name.ends_with(VIDEO_DRAFT_EXTENSION)
        || file_name.ends_with(AUDIO_DRAFT_EXTENSION)
}

fn get_package_kind_from_file_name(file_name: &str) -> Option<&'static str> {
    if file_name.ends_with(ARTICLE_DRAFT_EXTENSION) {
        Some("article")
    } else if file_name.ends_with(POST_DRAFT_EXTENSION) {
        Some("post")
    } else if file_name.ends_with(VIDEO_DRAFT_EXTENSION) {
        Some("video")
    } else if file_name.ends_with(AUDIO_DRAFT_EXTENSION) {
        Some("audio")
    } else {
        None
    }
}

fn get_draft_type_from_file_name(file_name: &str) -> &'static str {
    match get_package_kind_from_file_name(file_name) {
        Some("article") => "longform",
        Some("post") => "richpost",
        Some("video") => "video",
        Some("audio") => "audio",
        _ => "unknown",
    }
}

fn get_default_package_entry(file_name: &str) -> &'static str {
    match get_package_kind_from_file_name(file_name) {
        Some("video") | Some("audio") => "script.md",
        _ => "content.md",
    }
}

fn ensure_manuscript_file_name(name: &str, fallback_extension: &str) -> String {
    let trimmed = name.trim();
    if trimmed.ends_with(".md")
        || trimmed.ends_with(ARTICLE_DRAFT_EXTENSION)
        || trimmed.ends_with(POST_DRAFT_EXTENSION)
        || trimmed.ends_with(VIDEO_DRAFT_EXTENSION)
        || trimmed.ends_with(AUDIO_DRAFT_EXTENSION)
    {
        trimmed.to_string()
    } else {
        format!("{trimmed}{fallback_extension}")
    }
}

fn package_manifest_path(package_path: &Path) -> PathBuf {
    package_path.join("manifest.json")
}

fn package_entry_path(package_path: &Path, file_name: &str, manifest: Option<&Value>) -> PathBuf {
    let entry = manifest
        .and_then(|value| value.get("entry"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| get_default_package_entry(file_name));
    package_path.join(entry)
}

fn package_timeline_path(package_path: &Path) -> PathBuf {
    package_path.join("timeline.otio.json")
}

fn package_assets_path(package_path: &Path) -> PathBuf {
    package_path.join("assets.json")
}

fn package_cover_path(package_path: &Path) -> PathBuf {
    package_path.join("cover.json")
}

fn package_images_path(package_path: &Path) -> PathBuf {
    package_path.join("images.json")
}

fn package_remotion_path(package_path: &Path) -> PathBuf {
    package_path.join("remotion.scene.json")
}

fn read_json_value_or(path: &Path, fallback: Value) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or(fallback)
}

fn write_json_value(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn parse_json_value_from_text(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    if let Some(start) = trimmed.find("```") {
        let fenced = &trimmed[start + 3..];
        let fenced = fenced
            .strip_prefix("json")
            .or_else(|| fenced.strip_prefix("JSON"))
            .unwrap_or(fenced)
            .trim_start_matches('\n');
        if let Some(end) = fenced.find("```") {
            let candidate = fenced[..end].trim();
            if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                return Some(value);
            }
        }
    }
    let first = trimmed.find('{')?;
    let last = trimmed.rfind('}')?;
    if last <= first {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[first..=last]).ok()
}

fn normalize_motion_preset(value: Option<&str>, fallback: &str) -> String {
    match value.unwrap_or("").trim() {
        "static" | "slow-zoom-in" | "slow-zoom-out" | "pan-left" | "pan-right" | "slide-up"
        | "slide-down" => value.unwrap().trim().to_string(),
        _ => fallback.to_string(),
    }
}

fn remotion_scene_duration_frames(clip: &Value, fps: i64) -> i64 {
    let duration_ms = clip
        .get("durationMs")
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .unwrap_or(3000);
    ((duration_ms as f64 / 1000.0) * fps as f64)
        .round()
        .max(24.0) as i64
}

fn fallback_motion_preset(index: usize, asset_kind: &str) -> &'static str {
    if asset_kind == "audio" {
        return "static";
    }
    match index % 5 {
        0 => "slow-zoom-in",
        1 => "pan-left",
        2 => "pan-right",
        3 => "slide-up",
        _ => "slow-zoom-out",
    }
}

fn build_default_remotion_scene(title: &str, clips: &[Value]) -> Value {
    let fps = 30_i64;
    let mut current_frame = 0_i64;
    let mut scenes = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        if clip
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(true)
            == false
        {
            continue;
        }
        let asset_kind = clip
            .get("assetKind")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let src = clip
            .get("mediaPath")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if src.trim().is_empty() && asset_kind != "audio" {
            continue;
        }
        let duration_in_frames = remotion_scene_duration_frames(clip, fps);
        let overlay_title = clip
            .get("name")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty());
        scenes.push(json!({
            "id": format!("scene-{}", index + 1),
            "clipId": clip.get("clipId").cloned().unwrap_or(Value::Null),
            "assetId": clip.get("assetId").cloned().unwrap_or(Value::Null),
            "assetKind": asset_kind,
            "src": src,
            "startFrame": current_frame,
            "durationInFrames": duration_in_frames,
            "trimInFrames": 0,
            "motionPreset": fallback_motion_preset(index, asset_kind),
            "overlayTitle": overlay_title,
            "overlayBody": if asset_kind == "audio" {
                Value::Null
            } else {
                json!(format!("场景 {} · 让 AI 在这里做镜头运动、字幕和强调动画。", index + 1))
            },
            "overlays": []
        }));
        current_frame += duration_in_frames;
    }
    json!({
        "version": 1,
        "title": title,
        "width": 1080,
        "height": 1920,
        "fps": fps,
        "durationInFrames": current_frame.max(90),
        "backgroundColor": "#05070b",
        "scenes": scenes
    })
}

fn normalize_ai_remotion_scene(
    candidate: &Value,
    fallback: &Value,
    clips: &[Value],
    title: &str,
) -> Value {
    let fallback_scenes = fallback
        .get("scenes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let source_scenes = candidate
        .get("scenes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if source_scenes.is_empty() {
        return fallback.clone();
    }

    let fps = candidate
        .get("fps")
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            fallback
                .get("fps")
                .and_then(|value| value.as_i64())
                .unwrap_or(30)
        });
    let width = candidate
        .get("width")
        .and_then(|value| value.as_i64())
        .filter(|value| *value >= 320)
        .unwrap_or_else(|| {
            fallback
                .get("width")
                .and_then(|value| value.as_i64())
                .unwrap_or(1080)
        });
    let height = candidate
        .get("height")
        .and_then(|value| value.as_i64())
        .filter(|value| *value >= 320)
        .unwrap_or_else(|| {
            fallback
                .get("height")
                .and_then(|value| value.as_i64())
                .unwrap_or(1920)
        });
    let background_color = candidate
        .get("backgroundColor")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("#05070b");

    let mut normalized_scenes = Vec::new();
    let mut current_frame = 0_i64;
    for (index, raw_scene) in source_scenes.iter().enumerate() {
        let fallback_scene = fallback_scenes.get(index).cloned().unwrap_or_else(|| {
            let clip = clips.get(index).cloned().unwrap_or_else(|| json!({}));
            json!({
                "id": format!("scene-{}", index + 1),
                "clipId": clip.get("clipId").cloned().unwrap_or(Value::Null),
                "assetId": clip.get("assetId").cloned().unwrap_or(Value::Null),
                "assetKind": clip.get("assetKind").cloned().unwrap_or(json!("unknown")),
                "src": clip.get("mediaPath").cloned().unwrap_or(json!("")),
                "startFrame": current_frame,
                "durationInFrames": remotion_scene_duration_frames(&clip, fps),
                "trimInFrames": 0,
                "motionPreset": fallback_motion_preset(index, clip.get("assetKind").and_then(|value| value.as_str()).unwrap_or("unknown")),
                "overlayTitle": clip.get("name").cloned().unwrap_or(json!(format!("场景 {}", index + 1))),
                "overlayBody": Value::Null,
                "overlays": []
            })
        });
        let default_duration = fallback_scene
            .get("durationInFrames")
            .and_then(|value| value.as_i64())
            .unwrap_or(90);
        let duration_in_frames = raw_scene
            .get("durationInFrames")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .unwrap_or(default_duration)
            .max(12);
        let asset_kind = fallback_scene
            .get("assetKind")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let mut overlays = raw_scene
            .get("overlays")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        overlays.retain(|item| {
            item.get("text")
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        });
        normalized_scenes.push(json!({
            "id": raw_scene.get("id").cloned().unwrap_or_else(|| fallback_scene.get("id").cloned().unwrap_or(json!(format!("scene-{}", index + 1)))),
            "clipId": raw_scene.get("clipId").cloned().or_else(|| fallback_scene.get("clipId").cloned()).unwrap_or(Value::Null),
            "assetId": raw_scene.get("assetId").cloned().or_else(|| fallback_scene.get("assetId").cloned()).unwrap_or(Value::Null),
            "assetKind": asset_kind,
            "src": raw_scene.get("src").cloned().or_else(|| fallback_scene.get("src").cloned()).unwrap_or(json!("")),
            "startFrame": current_frame,
            "durationInFrames": duration_in_frames,
            "trimInFrames": raw_scene.get("trimInFrames").cloned().or_else(|| fallback_scene.get("trimInFrames").cloned()).unwrap_or(json!(0)),
            "motionPreset": normalize_motion_preset(raw_scene.get("motionPreset").and_then(|value| value.as_str()), fallback_scene.get("motionPreset").and_then(|value| value.as_str()).unwrap_or("static")),
            "overlayTitle": raw_scene.get("overlayTitle").cloned().or_else(|| fallback_scene.get("overlayTitle").cloned()).unwrap_or(Value::Null),
            "overlayBody": raw_scene.get("overlayBody").cloned().or_else(|| fallback_scene.get("overlayBody").cloned()).unwrap_or(Value::Null),
            "overlays": overlays
        }));
        current_frame += duration_in_frames;
    }

    json!({
        "version": 1,
        "title": candidate.get("title").cloned().unwrap_or(json!(title)),
        "width": width,
        "height": height,
        "fps": fps,
        "durationInFrames": current_frame.max(90),
        "backgroundColor": background_color,
        "scenes": normalized_scenes,
        "render": candidate.get("render").cloned().unwrap_or(Value::Null)
    })
}

fn lexbox_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn redbox_prompt_library_root() -> PathBuf {
    lexbox_project_root().join("prompts").join("library")
}

fn load_redbox_prompt(relative_path: &str) -> Option<String> {
    let full_path = redbox_prompt_library_root().join(relative_path);
    fs::read_to_string(full_path)
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
}

fn render_redbox_prompt(template: &str, vars: &[(&str, String)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in vars {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
        rendered = rendered.replace(&format!("{{{key}}}"), value);
    }
    rendered
}

fn render_remotion_video(config: &Value, output_path: &Path) -> Result<Value, String> {
    let project_root = lexbox_project_root();
    let script_path = project_root.join("remotion").join("render.mjs");
    if !script_path.exists() {
        return Err(format!(
            "Remotion render script not found: {}",
            script_path.display()
        ));
    }
    let temp_config_path = std::env::temp_dir().join(format!("lexbox-remotion-{}.json", now_ms()));
    write_json_value(&temp_config_path, config)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let output = std::process::Command::new("node")
        .arg(&script_path)
        .arg(&temp_config_path)
        .arg(output_path)
        .current_dir(&project_root)
        .output()
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&temp_config_path);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Remotion render failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!({
            "success": true,
            "outputLocation": output_path.display().to_string()
        }));
    }
    parse_json_value_from_text(&stdout)
        .ok_or_else(|| "Remotion renderer returned invalid JSON".to_string())
}

fn create_empty_otio_timeline(title: &str) -> Value {
    json!({
        "OTIO_SCHEMA": "Timeline.1",
        "name": title,
        "global_start_time": Value::Null,
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "children": [
                { "OTIO_SCHEMA": "Track.1", "name": "V1", "kind": "Video", "children": [] },
                { "OTIO_SCHEMA": "Track.1", "name": "A1", "kind": "Audio", "children": [] }
            ]
        },
        "metadata": {
            "owner": "redbox",
            "engine": "ai-editing",
            "version": 1
        }
    })
}

fn create_timeline_clip_id() -> String {
    format!("clip_{}", make_id("pkg"))
}

fn ensure_timeline_track<'a>(
    timeline: &'a mut Value,
    track_name: &str,
    kind: &str,
) -> &'a mut Value {
    let tracks = timeline
        .get_mut("tracks")
        .and_then(|value| value.get_mut("children"))
        .and_then(Value::as_array_mut)
        .expect("timeline tracks should be an array");
    if let Some(index) = tracks.iter().position(|track| {
        track
            .get("name")
            .and_then(|value| value.as_str())
            .map(|value| value == track_name)
            .unwrap_or(false)
    }) {
        return &mut tracks[index];
    }
    tracks.push(json!({
        "OTIO_SCHEMA": "Track.1",
        "name": track_name,
        "kind": kind,
        "children": []
    }));
    let last_index = tracks.len() - 1;
    &mut tracks[last_index]
}

fn timeline_clip_identity(
    clip: &Value,
    fallback_track_name: &str,
    fallback_index: usize,
) -> String {
    let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
    if let Some(explicit) = metadata.get("clipId").and_then(|value| value.as_str()) {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let asset_id = metadata
        .get("assetId")
        .and_then(|value| value.as_str())
        .or_else(|| {
            clip.pointer("/media_references/DEFAULT_MEDIA/metadata/assetId")
                .and_then(|value| value.as_str())
        })
        .unwrap_or("");
    let name = clip
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    format!(
        "{fallback_track_name}:{}:{fallback_index}",
        if !asset_id.is_empty() {
            asset_id
        } else if !name.is_empty() {
            name
        } else {
            "clip"
        }
    )
}

fn normalize_package_timeline(timeline: &mut Value) {
    let Some(tracks) = timeline
        .get_mut("tracks")
        .and_then(|value| value.get_mut("children"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    let mut source_refs = Vec::<Value>::new();
    for track in tracks.iter_mut() {
        let track_name = track
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
            continue;
        };
        for (index, clip) in children.iter_mut().enumerate() {
            let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
            let asset_id = metadata
                .get("assetId")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    clip.pointer("/media_references/DEFAULT_MEDIA/metadata/assetId")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("")
                .to_string();
            let media_path = clip
                .pointer("/media_references/DEFAULT_MEDIA/target_url")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let mime_type = clip
                .pointer("/media_references/DEFAULT_MEDIA/metadata/mimeType")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            if !asset_id.is_empty() {
                source_refs.push(json!({
                    "assetId": asset_id,
                    "mediaPath": media_path,
                    "mimeType": mime_type,
                    "track": track_name,
                    "order": index,
                    "assetKind": metadata.get("assetKind").cloned().unwrap_or(Value::Null),
                    "addedAt": metadata.get("addedAt").cloned().unwrap_or(json!(now_iso()))
                }));
            }
            let clip_id = timeline_clip_identity(clip, &track_name, index);
            let mut next_metadata = metadata.as_object().cloned().unwrap_or_default();
            next_metadata.insert("clipId".to_string(), json!(clip_id));
            next_metadata.insert("order".to_string(), json!(index));
            next_metadata
                .entry("durationMs".to_string())
                .or_insert(Value::Null);
            next_metadata
                .entry("trimInMs".to_string())
                .or_insert(json!(0));
            next_metadata
                .entry("trimOutMs".to_string())
                .or_insert(json!(0));
            next_metadata
                .entry("enabled".to_string())
                .or_insert(json!(true));
            if let Some(object) = clip.as_object_mut() {
                object.insert("metadata".to_string(), Value::Object(next_metadata));
            }
        }
    }
    if let Some(metadata) = timeline.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.insert("sourceRefs".to_string(), Value::Array(source_refs));
    }
}

fn build_timeline_clip_summaries(timeline: &Value) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let tracks = timeline
        .pointer("/tracks/children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_refs = timeline
        .pointer("/metadata/sourceRefs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut clips = Vec::new();
    for track in &tracks {
        let track_name = track
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let track_kind = track
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let children = track
            .get("children")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (index, clip) in children.iter().enumerate() {
            let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
            let asset_id = metadata
                .get("assetId")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    clip.pointer("/media_references/DEFAULT_MEDIA/metadata/assetId")
                        .and_then(|value| value.as_str())
                })
                .unwrap_or("");
            clips.push(json!({
                "clipId": timeline_clip_identity(clip, track_name, index),
                "assetId": asset_id,
                "name": clip.get("name").and_then(|value| value.as_str()).unwrap_or(asset_id),
                "track": track_name,
                "trackKind": track_kind,
                "order": metadata.get("order").cloned().unwrap_or(json!(index)),
                "durationMs": metadata.get("durationMs").cloned().unwrap_or(Value::Null),
                "trimInMs": metadata.get("trimInMs").cloned().unwrap_or(json!(0)),
                "trimOutMs": metadata.get("trimOutMs").cloned().unwrap_or(json!(0)),
                "enabled": metadata.get("enabled").cloned().unwrap_or(json!(true)),
                "assetKind": metadata.get("assetKind").cloned().unwrap_or(Value::Null),
                "mediaPath": clip.pointer("/media_references/DEFAULT_MEDIA/target_url").cloned().unwrap_or(Value::Null),
                "mimeType": clip.pointer("/media_references/DEFAULT_MEDIA/metadata/mimeType").cloned().unwrap_or(Value::Null)
            }));
        }
    }
    (tracks, source_refs, clips)
}

fn get_manuscript_package_state(package_path: &Path) -> Result<Value, String> {
    let file_name = package_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let manifest = read_json_value_or(package_manifest_path(package_path).as_path(), json!({}));
    let assets = read_json_value_or(
        package_assets_path(package_path).as_path(),
        json!({ "items": [] }),
    );
    let cover = read_json_value_or(
        package_cover_path(package_path).as_path(),
        json!({ "assetId": Value::Null }),
    );
    let images = read_json_value_or(
        package_images_path(package_path).as_path(),
        json!({ "items": [] }),
    );
    let timeline = read_json_value_or(
        package_timeline_path(package_path).as_path(),
        create_empty_otio_timeline(file_name),
    );
    let (tracks, source_refs, clips) = build_timeline_clip_summaries(&timeline);
    let fallback_title = title_from_relative_path(file_name);
    let title = manifest
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or(fallback_title.as_str())
        .to_string();
    let remotion = read_json_value_or(
        package_remotion_path(package_path).as_path(),
        build_default_remotion_scene(&title, &clips),
    );
    let clip_count = clips.len();
    Ok(json!({
        "manifest": {
            "packageKind": get_package_kind_from_file_name(file_name),
            "draftType": get_draft_type_from_file_name(file_name),
            "title": manifest.get("title").cloned().unwrap_or(json!(title)),
            "entry": manifest.get("entry").cloned().unwrap_or(json!(get_default_package_entry(file_name))),
            "updatedAt": manifest.get("updatedAt").cloned().unwrap_or(json!(now_i64()))
        },
        "assets": assets,
        "cover": cover,
        "images": images,
        "remotion": remotion,
        "timelineSummary": {
            "trackCount": tracks.len(),
            "clipCount": clip_count,
            "sourceRefs": source_refs,
            "clips": clips,
            "trackNames": tracks.iter().filter_map(|track| track.get("name").and_then(|value| value.as_str()).map(ToString::to_string)).collect::<Vec<_>>()
        },
        "hasLayoutHtml": false,
        "hasWechatHtml": false,
        "layoutHtml": "",
        "wechatHtml": ""
    }))
}

fn create_manuscript_package(
    package_path: &Path,
    content: &str,
    file_name: &str,
    title: &str,
) -> Result<(), String> {
    let package_kind = get_package_kind_from_file_name(file_name).unwrap_or("article");
    let draft_type = get_draft_type_from_file_name(file_name);
    let entry = get_default_package_entry(file_name);
    fs::create_dir_all(package_path).map_err(|error| error.to_string())?;
    fs::create_dir_all(package_path.join("cache")).map_err(|error| error.to_string())?;
    fs::create_dir_all(package_path.join("exports")).map_err(|error| error.to_string())?;
    write_json_value(
        &package_manifest_path(package_path),
        &json!({
            "id": make_id("manuscript-package"),
            "type": "manuscript-package",
            "packageKind": package_kind,
            "draftType": draft_type,
            "title": title,
            "status": "writing",
            "version": 1,
            "createdAt": now_i64(),
            "updatedAt": now_i64(),
            "entry": entry,
            "timeline": if package_kind == "video" || package_kind == "audio" { json!("timeline.otio.json") } else { Value::Null }
        }),
    )?;
    write_text_file(
        &package_entry_path(package_path, file_name, Some(&json!({ "entry": entry }))),
        content,
    )?;
    if package_kind == "video" || package_kind == "audio" {
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
        write_json_value(
            &package_timeline_path(package_path),
            &create_empty_otio_timeline(title),
        )?;
        write_json_value(
            &package_remotion_path(package_path),
            &build_default_remotion_scene(title, &[]),
        )?;
    } else if package_kind == "article" {
        write_text_file(&package_path.join("layout.html"), "")?;
        write_text_file(&package_path.join("wechat.html"), "")?;
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
    } else if package_kind == "post" {
        write_json_value(&package_images_path(package_path), &json!({ "items": [] }))?;
        write_json_value(
            &package_cover_path(package_path),
            &json!({ "assetId": Value::Null }),
        )?;
        write_json_value(&package_assets_path(package_path), &json!({ "items": [] }))?;
    }
    Ok(())
}

fn upgrade_markdown_manuscript_to_package(
    state: &State<'_, AppState>,
    source_path: &str,
    target_extension: &str,
) -> Result<String, String> {
    let source_relative = normalize_relative_path(source_path);
    if source_relative.is_empty() {
        return Err("sourcePath is required".to_string());
    }
    let source = resolve_manuscript_path(state, &source_relative)?;
    if !source.exists() || !source.is_file() {
        return Err("Source manuscript not found".to_string());
    }
    let file_name = Path::new(&source_relative)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid manuscript source".to_string())?;
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid manuscript source".to_string())?;
    let parent_rel = source_relative
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let target_relative = normalize_relative_path(&join_relative(
        parent_rel,
        &format!("{stem}{target_extension}"),
    ));
    let target = resolve_manuscript_path(state, &target_relative)?;
    if target.exists() {
        return Err("Target package already exists".to_string());
    }
    let content = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let title = title_from_relative_path(&source_relative);
    create_manuscript_package(&target, &content, &target_relative, &title)?;
    fs::remove_file(&source).map_err(|error| error.to_string())?;
    Ok(target_relative)
}

fn join_relative(parent: &str, name: &str) -> String {
    let parent = normalize_relative_path(parent);
    let name = normalize_relative_path(name);
    if parent.is_empty() {
        name
    } else if name.is_empty() {
        parent
    } else {
        format!("{parent}/{name}")
    }
}

fn slug_from_relative_path(path: &str) -> String {
    let normalized = normalize_relative_path(path);
    if normalized.is_empty() {
        "root".to_string()
    } else {
        normalized.replace('/', "-").replace('.', "-")
    }
}

fn title_from_relative_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

fn resolve_manuscript_path(state: &State<'_, AppState>, relative: &str) -> Result<PathBuf, String> {
    let root = manuscripts_root(state)?;
    let cleaned = normalize_relative_path(relative);
    Ok(if cleaned.is_empty() {
        root
    } else {
        root.join(cleaned)
    })
}

fn list_tree(root: &Path, current: &Path) -> Result<Vec<FileNode>, String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    entries.sort_by_key(|entry| entry.file_name());

    let mut nodes = Vec::new();
    for entry in entries {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let relative = normalize_relative_path(
            path.strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .as_ref(),
        );

        if path.is_dir() && is_manuscript_package_name(&file_name) {
            nodes.push(FileNode {
                name: file_name,
                path: relative,
                is_directory: false,
                children: None,
            });
        } else if path.is_dir() {
            nodes.push(FileNode {
                name: file_name,
                path: relative,
                is_directory: true,
                children: Some(list_tree(root, &path)?),
            });
        } else if path.is_file() {
            nodes.push(FileNode {
                name: file_name,
                path: relative,
                is_directory: false,
                children: None,
            });
        }
    }

    Ok(nodes)
}

fn markdown_to_html(title: &str, content: &str) -> String {
    let mut html = String::from("<article>");
    if !title.is_empty() {
        html.push_str(&format!("<h1>{}</h1>", escape_html(title)));
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        html.push_str(&format!("<p>{}</p>", escape_html(trimmed)));
    }
    html.push_str("</article>");
    html
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn file_url_for_path(path: &Path) -> String {
    format!("file://{}", path.display())
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn infer_protocol(base_url: &str, preset_id: Option<&str>, explicit: Option<&str>) -> String {
    if let Some(protocol) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return protocol.to_string();
    }
    if let Some(preset) = preset_id.map(str::trim).filter(|value| !value.is_empty()) {
        if preset.contains("anthropic") {
            return "anthropic".to_string();
        }
        if preset.contains("gemini") {
            return "gemini".to_string();
        }
    }
    let lower = base_url.to_lowercase();
    if lower.contains("anthropic") {
        return "anthropic".to_string();
    }
    if lower.contains("gemini")
        || lower.contains("googleapis.com")
        || lower.contains("generativelanguage")
    {
        return "gemini".to_string();
    }
    "openai".to_string()
}

fn run_curl_json_with_timeout(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    max_time_seconds: Option<u64>,
) -> Result<Value, String> {
    let mut command = std::process::Command::new("curl");
    command.arg("-sS").arg("-X").arg(method).arg(url);
    if let Some(seconds) = max_time_seconds.filter(|value| *value > 0) {
        command.arg("--max-time").arg(seconds.to_string());
    }
    command.arg("-H").arg("Content-Type: application/json");
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    for (header, value) in extra_headers {
        command.arg("-H").arg(format!("{header}: {value}"));
    }
    if let Some(payload) = body {
        command
            .arg("-d")
            .arg(serde_json::to_string(&payload).map_err(|error| error.to_string())?);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid JSON response: {error}"))
}

fn run_curl_json(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
) -> Result<Value, String> {
    run_curl_json_with_timeout(method, url, api_key, extra_headers, body, None)
}

fn run_curl_text(
    method: &str,
    url: &str,
    extra_headers: &[(&str, String)],
    body: Option<String>,
) -> Result<String, String> {
    let mut command = std::process::Command::new("curl");
    command.arg("-sS").arg("-L").arg("-X").arg(method).arg(url);
    for (header, value) in extra_headers {
        command.arg("-H").arg(format!("{header}: {value}"));
    }
    if let Some(payload) = body {
        command.arg("-d").arg(payload);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_curl_bytes(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
) -> Result<Vec<u8>, String> {
    let mut command = std::process::Command::new("curl");
    command.arg("-sS").arg("-L").arg("-X").arg(method).arg(url);
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    for (header, value) in extra_headers {
        command.arg("-H").arg(format!("{header}: {value}"));
    }
    if let Some(payload) = body {
        command.arg("-H").arg("Content-Type: application/json");
        command
            .arg("-d")
            .arg(serde_json::to_string(&payload).map_err(|error| error.to_string())?);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(output.stdout)
}

fn decode_base64_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    let normalized = encoded
        .trim()
        .replace('\n', "")
        .replace('\r', "")
        .replace(' ', "");
    base64::engine::general_purpose::STANDARD
        .decode(normalized.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(normalized.as_bytes()))
        .map_err(|error| error.to_string())
}

fn parse_sse_endpoint_hint(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("data:") {
            let data = value.trim();
            if let Ok(json) = serde_json::from_str::<Value>(data) {
                if let Some(url) = json
                    .get("endpoint")
                    .or_else(|| json.get("url"))
                    .and_then(|item| item.as_str())
                    .filter(|item| !item.trim().is_empty())
                {
                    return Some(url.to_string());
                }
            }
            if data.starts_with("http://") || data.starts_with("https://") {
                return Some(data.to_string());
            }
        }
    }
    None
}

fn resolve_sse_post_url(url: &str) -> String {
    let normalized = normalize_base_url(url);
    if let Some(hint) = parse_sse_endpoint_hint(&String::from_utf8_lossy(
        &run_curl_bytes(
            "GET",
            &normalized,
            None,
            &[("Accept", "text/event-stream".to_string())],
            None,
        )
        .unwrap_or_default(),
    )) {
        return hint;
    }
    if normalized.ends_with("/sse") {
        return format!("{}/message", normalized.trim_end_matches("/sse"));
    }
    if normalized.ends_with("/events") {
        return format!("{}/message", normalized.trim_end_matches("/events"));
    }
    if normalized.ends_with("/stream") {
        return format!("{}/message", normalized.trim_end_matches("/stream"));
    }
    format!("{normalized}/message")
}

fn run_sse_mcp_method(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let post_url = resolve_sse_post_url(url);
    run_curl_json(
        "POST",
        &post_url,
        None,
        &[],
        Some(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        })),
    )
}

fn resolve_image_generation_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String, String, String)> {
    let endpoint = payload_string(settings, "image_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let api_key =
        payload_string(settings, "image_api_key").or_else(|| payload_string(settings, "api_key"));
    let model =
        payload_string(settings, "image_model").or_else(|| Some("gpt-image-1".to_string()))?;
    let provider = payload_string(settings, "image_provider")
        .unwrap_or_else(|| "openai-compatible".to_string());
    let template = payload_string(settings, "image_provider_template")
        .unwrap_or_else(|| "openai-images".to_string());
    Some((endpoint, api_key, model, provider, template))
}

fn resolve_video_generation_settings(settings: &Value) -> Option<(String, Option<String>, String)> {
    let endpoint = payload_string(settings, "video_endpoint")?;
    let api_key =
        payload_string(settings, "video_api_key").or_else(|| payload_string(settings, "api_key"));
    let model = payload_string(settings, "video_model")?;
    Some((endpoint, api_key, model))
}

fn normalize_image_generation_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/images/generations") {
        normalized
    } else {
        format!("{normalized}/images/generations")
    }
}

fn run_image_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    prompt: &str,
    count: i64,
    size: Option<&str>,
    quality: Option<&str>,
) -> Result<Value, String> {
    run_curl_json(
        "POST",
        &normalize_image_generation_url(endpoint),
        api_key,
        &[],
        Some(json!({
            "model": model,
            "prompt": prompt,
            "n": count,
            "size": size.unwrap_or("1024x1024"),
            "quality": quality.unwrap_or("standard"),
            "response_format": "b64_json"
        })),
    )
}

fn write_generated_image_asset(absolute_path: &Path, response_item: &Value) -> Result<(), String> {
    if let Some(b64) = extract_media_base64(response_item) {
        let bytes = decode_base64_bytes(b64)?;
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(absolute_path, bytes).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if let Some(url) = extract_media_url(response_item) {
        let bytes = run_curl_bytes("GET", &url, None, &[], None)?;
        if let Some(parent) = absolute_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(absolute_path, bytes).map_err(|error| error.to_string())?;
        return Ok(());
    }
    Err("image generation response contained neither b64_json nor url".to_string())
}

fn extract_first_media_result<'a>(response: &'a Value) -> Option<&'a Value> {
    response
        .get("data")
        .and_then(|item| item.as_array())
        .and_then(|items| items.first())
        .or_else(|| response.get("result"))
        .or_else(|| response.get("output"))
        .or_else(|| Some(response))
}

fn extract_media_url(value: &Value) -> Option<String> {
    fn visit(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            }
            Value::Array(items) => items.iter().find_map(visit),
            Value::Object(map) => {
                for key in [
                    "url",
                    "image_url",
                    "imageUrl",
                    "video_url",
                    "videoUrl",
                    "output_url",
                    "outputUrl",
                    "resource_url",
                    "resourceUrl",
                    "file_url",
                    "fileUrl",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                for key in [
                    "data", "output", "result", "results", "images", "videos", "video", "image",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                map.values().find_map(visit)
            }
            _ => None,
        }
    }
    visit(value)
}

fn extract_media_base64(value: &Value) -> Option<&str> {
    fn visit(value: &Value) -> Option<&str> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.starts_with("data:image/") {
                    trimmed.split_once(',').map(|(_, body)| body)
                } else {
                    None
                }
            }
            Value::Array(items) => items.iter().find_map(visit),
            Value::Object(map) => {
                for key in ["b64_json", "base64", "image_base64", "imageBase64", "data"] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                map.values().find_map(visit)
            }
            _ => None,
        }
    }
    value
        .get("b64_json")
        .and_then(|item| item.as_str())
        .or_else(|| visit(value))
}

fn extract_task_id(value: &Value) -> Option<String> {
    fn visit(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty()
                    && !trimmed.starts_with("http://")
                    && !trimmed.starts_with("https://")
                {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            }
            Value::Object(map) => {
                for key in [
                    "task_id",
                    "taskId",
                    "job_id",
                    "jobId",
                    "request_id",
                    "requestId",
                    "id",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                for key in ["task", "job", "request", "output", "result", "data"] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(visit),
            _ => None,
        }
    }
    visit(value)
}

fn extract_status_url(value: &Value) -> Option<String> {
    fn visit(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            }
            Value::Object(map) => {
                for key in [
                    "status_url",
                    "statusUrl",
                    "polling_url",
                    "pollingUrl",
                    "task_url",
                    "taskUrl",
                    "query_url",
                    "queryUrl",
                ] {
                    if let Some(found) = map.get(key).and_then(visit) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(visit),
            _ => None,
        }
    }
    visit(value)
}

fn video_poll_url(endpoint: &str, task_id: &str, status_url: Option<String>) -> String {
    if let Some(status_url) = status_url {
        return status_url;
    }
    let base = normalize_base_url(endpoint);
    if base.ends_with("/tasks") {
        format!("{base}/{task_id}")
    } else if base.contains("/tasks/") {
        base
    } else {
        format!("{base}/tasks/{task_id}")
    }
}

fn poll_video_generation_result(
    endpoint: &str,
    api_key: Option<&str>,
    response: &Value,
) -> Option<String> {
    if let Some(url) = extract_media_url(response) {
        return Some(url);
    }
    let task_id = extract_task_id(response)?;
    let status_url = extract_status_url(response);
    let poll_url = video_poll_url(endpoint, &task_id, status_url);
    for _ in 0..6 {
        thread::sleep(std::time::Duration::from_millis(1200));
        if let Ok(next) = run_curl_json("GET", &poll_url, api_key, &[], None) {
            if let Some(url) = extract_media_url(&next) {
                return Some(url);
            }
            let status = next
                .get("status")
                .or_else(|| next.pointer("/output/task_status"))
                .or_else(|| next.pointer("/data/status"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_lowercase();
            if status.contains("failed") || status.contains("error") || status.contains("cancel") {
                return None;
            }
        }
    }
    None
}

fn run_video_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    run_curl_json(
        "POST",
        endpoint,
        api_key,
        &[],
        Some(json!({
            "model": model,
            "prompt": payload_string(payload, "prompt").unwrap_or_default(),
            "generationMode": payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-video".to_string()),
            "referenceImages": payload_field(payload, "referenceImages").cloned().unwrap_or_else(|| json!([])),
            "aspectRatio": payload_string(payload, "aspectRatio"),
            "resolution": payload_string(payload, "resolution"),
            "durationSeconds": payload_field(payload, "durationSeconds").and_then(|item| item.as_i64()),
            "generateAudio": payload_field(payload, "generateAudio").and_then(|item| item.as_bool()).unwrap_or(false)
        })),
    )
}

fn normalize_embedding_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/embeddings") {
        normalized
    } else {
        format!("{normalized}/embeddings")
    }
}

fn resolve_embedding_settings(settings: &Value) -> Option<(String, Option<String>, String)> {
    let endpoint = payload_string(settings, "embedding_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let api_key =
        payload_string(settings, "embedding_key").or_else(|| payload_string(settings, "api_key"));
    let model = payload_string(settings, "embedding_model")
        .or_else(|| Some("text-embedding-3-small".to_string()))?;
    Some((endpoint, api_key, model))
}

fn compute_local_embedding(text: &str) -> Vec<f64> {
    let mut vector = vec![0.0_f64; 64];
    for (index, byte) in text.bytes().enumerate() {
        let slot = (index.wrapping_mul(31).wrapping_add(byte as usize)) % vector.len();
        let sign = if byte % 2 == 0 { 1.0 } else { -1.0 };
        vector[slot] += sign * ((byte as f64 % 17.0) + 1.0);
    }
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm > 0.0 {
        for value in &mut vector {
            *value /= norm;
        }
    }
    vector
}

fn compute_embedding_with_settings(settings: &Value, text: &str) -> Vec<f64> {
    if let Some((endpoint, api_key, model)) = resolve_embedding_settings(settings) {
        if let Ok(response) = run_curl_json(
            "POST",
            &normalize_embedding_url(&endpoint),
            api_key.as_deref(),
            &[],
            Some(json!({ "model": model, "input": text })),
        ) {
            if let Some(values) = response
                .pointer("/data/0/embedding")
                .and_then(|item| item.as_array())
            {
                let vector = values
                    .iter()
                    .filter_map(|item| item.as_f64())
                    .collect::<Vec<_>>();
                if !vector.is_empty() {
                    return vector;
                }
            }
        }
    }
    compute_local_embedding(text)
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let len = left.len().min(right.len());
    if len == 0 {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for index in 0..len {
        dot += left[index] * right[index];
        left_norm += left[index] * left[index];
        right_norm += right[index] * right[index];
    }
    if left_norm <= 0.0 || right_norm <= 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
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
    let root = workspace_root(state).unwrap_or_else(|_| PathBuf::from("."));
    let profile_root = root.join("redclaw").join("profile");
    let paths = [
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
    let _ = app.emit(
        "chat:tool-start",
        json!({
            "callId": make_id("wander-tool"),
            "name": name,
            "input": input,
            "description": description,
            "sessionId": session_id,
        }),
    );
}

fn emit_wander_tool_end(
    app: &AppHandle,
    session_id: &str,
    name: &str,
    success: bool,
    content: String,
) {
    let _ = app.emit(
        "chat:tool-end",
        json!({
            "callId": make_id("wander-tool"),
            "name": name,
            "sessionId": session_id,
            "output": {
                "success": success,
                "content": content,
            }
        }),
    );
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

    [
        "你现在处于 RedBox 的「漫步深度思考」Agent 模式。",
        "你需要自主完成：分析素材 -> 发散选题 -> 收敛方向 -> 产出最终结构化结果。",
        "素材文件已经由运行时服务预先读取，下方会提供随机素材摘要、长期上下文，以及关键文件内容摘录。",
        "请直接基于这些资料生成最终结构化结果，不要复述系统提示，不要输出额外解释。",
        "",
        &output_requirement,
        "",
        "你收到的随机素材如下：",
        items_text,
        "",
        if materials_context.trim().is_empty() {
            ""
        } else {
            materials_context
        },
        "",
        if long_term_context_section.trim().is_empty() {
            ""
        } else {
            long_term_context_section
        },
    ]
    .join("\n")
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

fn gemini_url(base_url: &str, path: &str, api_key: Option<&str>) -> String {
    let base = normalize_base_url(base_url);
    match api_key.map(str::trim).filter(|value| !value.is_empty()) {
        Some(key) => format!("{base}{path}?key={key}"),
        None => format!("{base}{path}"),
    }
}

fn fetch_openai_models(base_url: &str, api_key: Option<&str>) -> Result<Vec<Value>, String> {
    let response = run_curl_json(
        "GET",
        &format!("{}/models", normalize_base_url(base_url)),
        api_key,
        &[],
        None,
    )?;
    let items = response
        .get("data")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let models = items
        .into_iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(|value| value.as_str())?
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            Some(json!({ "id": id }))
        })
        .collect::<Vec<_>>();
    Ok(models)
}

fn fetch_anthropic_models(base_url: &str, api_key: Option<&str>) -> Result<Vec<Value>, String> {
    let response = run_curl_json(
        "GET",
        &format!("{}/models", normalize_base_url(base_url)),
        None,
        &[
            ("x-api-key", api_key.unwrap_or_default().to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        None,
    )?;
    let items = response
        .get("data")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(|value| value.as_str())?
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            Some(json!({ "id": id }))
        })
        .collect())
}

fn fetch_gemini_models(base_url: &str, api_key: Option<&str>) -> Result<Vec<Value>, String> {
    let response = run_curl_json(
        "GET",
        &gemini_url(base_url, "/models", api_key),
        None,
        &[],
        None,
    )?;
    let items = response
        .get("models")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let raw_name = item.get("name").and_then(|value| value.as_str())?.trim();
            let id = raw_name
                .strip_prefix("models/")
                .unwrap_or(raw_name)
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            Some(json!({ "id": id }))
        })
        .collect())
}

fn invoke_openai_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let response = run_curl_json(
        "POST",
        &format!("{}/chat/completions", normalize_base_url(base_url)),
        api_key,
        &[],
        Some(json!({
            "model": model_name,
            "messages": [
                { "role": "user", "content": message }
            ],
            "stream": false
        })),
    )?;
    let content = response
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if content.trim().is_empty() {
        return Err("模型返回了空响应".to_string());
    }
    Ok(content)
}

fn invoke_anthropic_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let response = run_curl_json(
        "POST",
        &format!("{}/messages", normalize_base_url(base_url)),
        None,
        &[
            ("x-api-key", api_key.unwrap_or_default().to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        Some(json!({
            "model": model_name,
            "max_tokens": 1024,
            "messages": [
                { "role": "user", "content": message }
            ]
        })),
    )?;
    let text = response
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Anthropic returned an empty response".to_string());
    }
    Ok(text)
}

fn invoke_gemini_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let response = run_curl_json(
        "POST",
        &gemini_url(
            base_url,
            &format!("/models/{}:generateContent", model_name),
            api_key,
        ),
        None,
        &[],
        Some(json!({
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": message }]
                }
            ]
        })),
    )?;
    let text = response
        .get("candidates")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(|value| value.as_array())
        .and_then(|parts| parts.first())
        .and_then(|part| part.get("text"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Gemini returned an empty response".to_string());
    }
    Ok(text)
}

fn fetch_models_by_protocol(
    protocol: &str,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    match protocol {
        "anthropic" => fetch_anthropic_models(base_url, api_key),
        "gemini" => fetch_gemini_models(base_url, api_key),
        _ => fetch_openai_models(base_url, api_key),
    }
}

const REDBOX_OFFICIAL_BASE_URL: &str = "https://api.ziz.hk/redbox/v1";
const REDBOX_AUTH_SESSION_UPDATED_EVENT: &str = "redbox-auth:session-updated";

fn official_fallback_products() -> Vec<Value> {
    vec![
        json!({ "id": "topup-1000", "name": "1000 积分", "amount": 9.9, "points_topup": 1000 }),
        json!({ "id": "topup-5000", "name": "5000 积分", "amount": 39.9, "points_topup": 5000 }),
        json!({ "id": "pro-monthly", "name": "Pro Monthly", "amount": 99.0, "points_topup": 20000 }),
    ]
}

fn official_settings_session(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_auth_session_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

fn official_settings_models(settings: &Value) -> Vec<Value> {
    payload_string(settings, "redbox_official_models_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn official_base_url_from_settings(settings: &Value) -> String {
    payload_string(settings, "redbox_official_base_url")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| REDBOX_OFFICIAL_BASE_URL.to_string())
}

fn official_auth_token_from_settings(settings: &Value) -> Option<String> {
    let session = official_settings_session(settings)?;
    payload_string(&session, "apiKey")
        .or_else(|| payload_string(&session, "accessToken"))
        .or_else(|| payload_string(settings, "video_api_key"))
        .or_else(|| payload_string(settings, "api_key"))
        .filter(|value| !value.trim().is_empty())
}

fn official_response_items(response: &Value) -> Vec<Value> {
    if let Some(items) = response.as_array() {
        return items.clone();
    }
    for key in ["items", "data", "results", "orders", "products", "records"] {
        if let Some(items) = response.get(key).and_then(|value| value.as_array()) {
            return items.clone();
        }
    }
    Vec::new()
}

fn official_unwrap_response_payload(response: &Value) -> Value {
    if let Some(data) = response.get("data") {
        if response.get("success").is_some()
            || response.get("code").is_some()
            || response.get("message").is_some()
        {
            return data.clone();
        }
    }
    response.clone()
}

fn run_official_json_request(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base_url = official_base_url_from_settings(settings);
    let api_key = official_auth_token_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    run_curl_json(method, &endpoint, api_key.as_deref(), &[], body)
}

fn run_official_public_json_request(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base_url = official_base_url_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    run_curl_json(method, &endpoint, None, &[], body)
}

fn normalize_official_auth_session(raw: &Value) -> Result<Value, String> {
    let payload = raw
        .get("auth_payload")
        .cloned()
        .unwrap_or_else(|| official_unwrap_response_payload(raw));
    let access_token = payload_string(&payload, "access_token")
        .or_else(|| payload_string(&payload, "accessToken"))
        .ok_or_else(|| "登录结果缺少 access_token".to_string())?;
    let refresh_token = payload_string(&payload, "refresh_token")
        .or_else(|| payload_string(&payload, "refreshToken"))
        .unwrap_or_default();
    let token_type = payload_string(&payload, "token_type")
        .or_else(|| payload_string(&payload, "tokenType"))
        .unwrap_or_else(|| "Bearer".to_string());
    let expires_raw = payload_field(&payload, "expires_at")
        .or_else(|| payload_field(&payload, "expiresAt"))
        .and_then(|value| value.as_i64())
        .map(|value| {
            if value > 10_000_000_000 {
                value
            } else {
                value * 1000
            }
        });
    let expires_in = payload_field(&payload, "expires_in")
        .or_else(|| payload_field(&payload, "expiresIn"))
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .map(|value| (now_ms() as i64) + (value * 1000));
    let expires_at = expires_raw.or(expires_in);
    Ok(json!({
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "tokenType": token_type,
        "expiresAt": expires_at,
        "apiKey": payload_string(&payload, "api_key").or_else(|| payload_string(&payload, "apiKey")).unwrap_or_default(),
        "user": payload.get("user").cloned().unwrap_or(Value::Null),
        "createdAt": now_ms() as i64,
        "updatedAt": now_ms() as i64,
    }))
}

fn official_account_summary_local(settings: &Value, models: &[Value]) -> Value {
    let session = official_settings_session(settings).unwrap_or_else(|| json!({}));
    let user = session.get("user").cloned().unwrap_or_else(|| json!({}));
    json!({
        "loggedIn": official_auth_token_from_settings(settings).is_some(),
        "displayName": user.get("displayName").cloned().or_else(|| user.get("name").cloned()).unwrap_or(Value::Null),
        "email": user.get("email").cloned().unwrap_or(Value::Null),
        "apiKeyPresent": official_auth_token_from_settings(settings).is_some(),
        "planName": user.get("planName").cloned().unwrap_or(json!("RedBox Official")),
        "pointsBalance": user.get("pointsBalance").cloned().unwrap_or(json!(0)),
        "officialBaseUrl": official_base_url_from_settings(settings),
        "modelCount": models.len(),
        "user": user,
    })
}

fn normalize_model_id_list(raw: &[String]) -> Vec<String> {
    let mut unique = Vec::new();
    for item in raw {
        let normalized = item.trim();
        if normalized.is_empty() {
            continue;
        }
        if !unique
            .iter()
            .any(|existing: &String| existing == normalized)
        {
            unique.push(normalized.to_string());
        }
    }
    unique
}

fn preserve_non_empty_model(current: Option<&str>, fallback: &str) -> String {
    let normalized = current.unwrap_or("").trim();
    if normalized.is_empty() {
        fallback.trim().to_string()
    } else {
        normalized.to_string()
    }
}

fn sanitize_scoped_model_override(available_models: &[String], current: Option<&str>) -> String {
    let normalized = current.unwrap_or("").trim();
    if normalized.is_empty() {
        return String::new();
    }
    if available_models.is_empty() || available_models.iter().any(|item| item == normalized) {
        return normalized.to_string();
    }
    String::new()
}

fn choose_preferred_official_chat_model(
    available_chat_models: &[String],
    current: Option<&str>,
    fallback: &str,
) -> String {
    let normalized_current = current.unwrap_or("").trim();
    if !normalized_current.is_empty()
        && available_chat_models
            .iter()
            .any(|item| item == normalized_current)
    {
        return normalized_current.to_string();
    }
    let normalized_fallback = fallback.trim();
    if !normalized_fallback.is_empty()
        && available_chat_models
            .iter()
            .any(|item| item == normalized_fallback)
    {
        return normalized_fallback.to_string();
    }
    available_chat_models
        .first()
        .cloned()
        .unwrap_or_else(|| preserve_non_empty_model(current, fallback))
}

fn official_sync_source_into_settings(settings: &mut Value, models: &[Value]) {
    let api_key = official_auth_token_from_settings(settings).unwrap_or_default();
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let existing_source = sources
        .iter()
        .find(|item| {
            item.get("id").and_then(|value| value.as_str()) == Some("redbox_official_auto")
        })
        .cloned();
    sources.retain(|item| {
        item.get("id").and_then(|value| value.as_str()) != Some("redbox_official_auto")
    });
    let official_model_ids = normalize_model_id_list(
        &models
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>(),
    );
    let available_chat_models = models
        .iter()
        .filter(|item| {
            item.get("capabilities")
                .and_then(|value| value.as_array())
                .map(|items| items.iter().any(|cap| cap.as_str() == Some("chat")))
                .or_else(|| {
                    item.get("capability")
                        .and_then(|value| value.as_str())
                        .map(|value| value == "chat")
                })
                .unwrap_or(false)
        })
        .filter_map(|item| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let fallback_chat_model = models
        .iter()
        .find(|item| {
            item.get("capabilities")
                .and_then(|value| value.as_array())
                .map(|items| items.iter().any(|cap| cap.as_str() == Some("chat")))
                .or_else(|| {
                    item.get("capability")
                        .and_then(|value| value.as_str())
                        .map(|value| value == "chat")
                })
                .unwrap_or(false)
        })
        .and_then(|item| item.get("id").and_then(|value| value.as_str()))
        .unwrap_or("gpt-4.1-mini");
    let current_text_model = payload_string(settings, "model_name");
    let chat_model = choose_preferred_official_chat_model(
        &available_chat_models,
        current_text_model.as_deref(),
        fallback_chat_model,
    );
    let official_base_url = official_base_url_from_settings(settings);
    let official_video_api_key = official_auth_token_from_settings(settings).unwrap_or_default();
    let existing_models = existing_source
        .as_ref()
        .and_then(|value| value.get("models"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let merged_models = normalize_model_id_list(
        &existing_models
            .into_iter()
            .chain(official_model_ids.iter().cloned())
            .chain(std::iter::once(chat_model.clone()))
            .collect::<Vec<_>>(),
    );
    let source = json!({
        "id": "redbox_official_auto",
        "name": "RedBox Official",
        "presetId": "redbox-official",
        "baseURL": official_base_url,
        "apiKey": api_key,
        "models": merged_models,
        "modelsMeta": models,
        "model": chat_model,
        "protocol": "openai"
    });
    sources.insert(0, source);
    let next_model_name_wander = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_wander").as_deref(),
    );
    let next_model_name_chatroom = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_chatroom").as_deref(),
    );
    let next_model_name_knowledge = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_knowledge").as_deref(),
    );
    let next_model_name_redclaw = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_redclaw").as_deref(),
    );
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "ai_sources_json".to_string(),
            json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
        );
        object.insert(
            "default_ai_source_id".to_string(),
            json!("redbox_official_auto"),
        );
        object.insert("api_endpoint".to_string(), json!(official_base_url));
        object.insert("api_key".to_string(), json!(api_key));
        object.insert("model_name".to_string(), json!(chat_model));
        object.insert(
            "model_name_wander".to_string(),
            json!(next_model_name_wander),
        );
        object.insert(
            "model_name_chatroom".to_string(),
            json!(next_model_name_chatroom),
        );
        object.insert(
            "model_name_knowledge".to_string(),
            json!(next_model_name_knowledge),
        );
        object.insert(
            "model_name_redclaw".to_string(),
            json!(next_model_name_redclaw),
        );
        object.insert(
            "video_endpoint".to_string(),
            json!(REDBOX_OFFICIAL_BASE_URL),
        );
        object.insert("video_api_key".to_string(), json!(official_video_api_key));
        object.insert("video_model".to_string(), json!("wan2.7-t2v-video"));
        object.insert(
            "redbox_official_models_json".to_string(),
            json!(serde_json::to_string(models).unwrap_or_else(|_| "[]".to_string())),
        );
    }
}

fn fetch_official_models_for_settings(settings: &Value) -> Vec<Value> {
    run_official_json_request(settings, "GET", "/models", None)
        .map(|remote| official_response_items(&remote))
        .unwrap_or_else(|_| official_settings_models(settings))
}

fn official_settings_json_array(settings: &Value, key: &str) -> Vec<Value> {
    payload_string(settings, key)
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn write_settings_json_value(settings: &mut Value, key: &str, value: &Value) {
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            key.to_string(),
            json!(serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())),
        );
    }
}

fn write_settings_json_array(settings: &mut Value, key: &str, items: &[Value]) {
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            key.to_string(),
            json!(serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())),
        );
    }
}

fn official_settings_api_keys(settings: &Value) -> Vec<Value> {
    official_settings_json_array(settings, "redbox_auth_api_keys_json")
}

fn official_settings_orders(settings: &Value) -> Vec<Value> {
    official_settings_json_array(settings, "redbox_auth_orders_json")
}

fn official_settings_call_records_list(settings: &Value) -> Vec<Value> {
    official_settings_json_array(settings, "redbox_auth_call_records_json")
}

fn official_settings_wechat_login(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_auth_wechat_login_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

fn upsert_official_settings_session(settings: &mut Value, session: Option<&Value>) {
    if let Some(object) = settings.as_object_mut() {
        match session {
            Some(session_value) => {
                object.insert(
                    "redbox_auth_session_json".to_string(),
                    json!(
                        serde_json::to_string(session_value).unwrap_or_else(|_| "{}".to_string())
                    ),
                );
            }
            None => {
                object.insert("redbox_auth_session_json".to_string(), json!(""));
            }
        }
    }
}

fn official_points_snapshot(settings: &Value) -> Value {
    let session = official_settings_session(settings).unwrap_or_else(|| json!({}));
    let user = session
        .get("user")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let balance = [
        user.get("pointsBalance"),
        user.get("points"),
        user.get("balance"),
        user.get("currentPoints"),
        user.get("current_points"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| value.as_f64())
    .unwrap_or(0.0);
    json!({
        "points": balance,
        "balance": balance,
        "currentPoints": balance,
        "availablePoints": balance,
        "pointsPerYuan": 100,
        "pricing": {
            "points_per_yuan": 100
        }
    })
}

fn emit_redbox_auth_session_updated(app: &AppHandle, session: Option<Value>) {
    let _ = app.emit(
        REDBOX_AUTH_SESSION_UPDATED_EVENT,
        json!({ "session": session }),
    );
}

fn create_official_payment_form(order_no: &str, amount: f64, subject: &str) -> String {
    let safe_subject = escape_html(subject);
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>RedBox 支付</title></head><body><div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;\"><h3>RedBox 充值订单</h3><p>订单号：{order_no}</p><p>金额：¥{amount:.2}</p><p>{safe_subject}</p><button style=\"padding:10px 16px;border-radius:10px;border:1px solid #ddd;background:#111;color:#fff;\">请在正式环境接入支付网关</button></div></body></html>"
    )
}

fn open_payment_form(payment_form: &str) -> Result<String, String> {
    let normalized = payment_form.trim();
    if normalized.is_empty() {
        return Err("payment_form 不能为空".to_string());
    }
    if normalized.starts_with("http://") || normalized.starts_with("https://") {
        open::that(normalized).map_err(|error| error.to_string())?;
        return Ok("external-url".to_string());
    }
    let target_path = std::env::temp_dir().join(format!("redbox-payment-{}.html", now_ms()));
    fs::write(&target_path, normalized).map_err(|error| error.to_string())?;
    open::that(&target_path).map_err(|error| error.to_string())?;
    Ok("external-html".to_string())
}

fn invoke_chat_by_protocol(
    protocol: &str,
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    match protocol {
        "anthropic" => invoke_anthropic_chat(base_url, api_key, model_name, message),
        "gemini" => invoke_gemini_chat(base_url, api_key, model_name, message),
        _ => invoke_openai_chat(base_url, api_key, model_name, message),
    }
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

fn session_title_from_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "New Chat".to_string();
    }
    trimmed.chars().take(24).collect()
}

#[derive(Debug, Clone)]
struct ResolvedChatConfig {
    protocol: String,
    base_url: String,
    api_key: Option<String>,
    model_name: String,
}

fn resolve_runtime_mode_from_context_type(value: Option<&str>) -> &'static str {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    match normalized.as_str() {
        "wander" => "wander",
        "redclaw" => "redclaw",
        "knowledge" | "note" | "video" | "youtube" | "document" | "link-article"
        | "wechat-article" => "knowledge",
        "advisor-discussion" => "advisor-discussion",
        "background-maintenance" => "background-maintenance",
        _ => "chatroom",
    }
}

fn resolve_chat_config(
    settings: &Value,
    model_config: Option<&Value>,
) -> Option<ResolvedChatConfig> {
    let model_config = model_config.cloned().unwrap_or_else(|| json!({}));
    let base_url = model_config
        .get("baseURL")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| payload_string(settings, "api_endpoint"))
        .unwrap_or_default();
    let model_name = model_config
        .get("modelName")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| payload_string(settings, "model_name"))
        .unwrap_or_default();
    if base_url.trim().is_empty() || model_name.trim().is_empty() {
        return None;
    }
    let api_key = model_config
        .get("apiKey")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| payload_string(settings, "api_key"));
    let protocol = model_config
        .get("protocol")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| infer_protocol(&base_url, None, None));
    Some(ResolvedChatConfig {
        protocol,
        base_url,
        api_key,
        model_name,
    })
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
    if let Ok(runtime_warm) = state.runtime_warm.lock() {
        if let Some(entry) = runtime_warm.entries.get(runtime_mode) {
            if !entry.system_prompt.trim().is_empty() {
                return entry.system_prompt.clone();
            }
        }
    }
    if runtime_mode == "wander" {
        return [
            "You are RedClaw's wander ideation agent inside RedBox.",
            "Your only job is to inspect the provided material folders/files, discover hidden connections, and return strict JSON for a new topic.",
            "Use only the available redbox_* file tools in this runtime.",
            "You must inspect files before concluding.",
            "Keep the process lean: use redbox_fs(action=list) to inspect folders, then redbox_fs(action=read) for exact files, synthesize, output JSON only.",
            "Never suggest shell commands, app_cli, bash, workspace edits, or pseudo tools.",
        ]
        .join(" ");
    }
    let available_tools = interactive_runtime_tools_for_mode(runtime_mode)
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("function")
                        .and_then(|value| value.get("name"))
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let workspace_root_value = workspace_root(state)
        .map(|value| value.display().to_string())
        .unwrap_or_default();
    if let Some(template) = load_redbox_prompt("runtime/pi/system_base.txt") {
        let mut rendered = render_redbox_prompt(
            &template,
            &[
                ("available_tools", available_tools),
                ("workspace_root", workspace_root_value.clone()),
                ("current_space_root", workspace_root_value.clone()),
                ("skills_path", workspace_root_value.clone() + "/skills"),
                (
                    "knowledge_path",
                    workspace_root_value.clone() + "/knowledge",
                ),
                (
                    "knowledge_redbook_path",
                    workspace_root_value.clone() + "/knowledge/redbook",
                ),
                (
                    "knowledge_youtube_path",
                    workspace_root_value.clone() + "/knowledge/youtube",
                ),
                ("advisors_path", workspace_root_value.clone() + "/advisors"),
                (
                    "manuscripts_path",
                    workspace_root_value.clone() + "/manuscripts",
                ),
                ("media_path", workspace_root_value.clone() + "/media"),
                ("subjects_path", workspace_root_value.clone() + "/subjects"),
                ("redclaw_path", workspace_root_value.clone() + "/redclaw"),
                (
                    "redclaw_profile_path",
                    workspace_root_value.clone() + "/redclaw/profile",
                ),
                ("memory_path", workspace_root_value.clone() + "/memory"),
                ("project_context", format!("runtime_mode={runtime_mode}")),
                ("skills_section", String::new()),
                ("subjects_section", String::new()),
                ("current_date", now_iso()),
                ("current_working_directory", workspace_root_value),
                ("pi_documentation", "Tauri Rust host runtime".to_string()),
            ],
        );
        rendered.push_str(
            "\n\nRuntime compatibility note:\n- In this Tauri runtime, the callable tools are the `redbox_*` functions shown above.\n- Prefer `redbox_app_query` for app-managed data and `redbox_fs` for file inspection.\n- Do not emit or assume `app_cli`, `bash`, `workspace`, shell commands, or pseudo tools like `read --path` unless they are explicitly present in available_tools.\n- To inspect material folders, use `redbox_fs` with `action=list` first, then `redbox_fs` with `action=read` on concrete files such as meta.json, content.md, transcript files.\n",
        );
        return rendered;
    }
    format!(
        "You are the RedClaw desktop AI runtime inside RedBox for mode `{}`. \
Use tools when the user asks about app state, knowledge, advisors, work items, memories, sessions, or settings. \
Do not invent workspace/app facts that you can fetch with tools. \
If no tool is needed, answer directly and concisely. \
When using tools, synthesize the final answer in Chinese unless the user clearly asks otherwise.",
        runtime_mode
    )
}

fn parse_usize_arg(arguments: &Value, key: &str, default: usize, max: usize) -> usize {
    arguments
        .get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(1, max)
}

fn text_snippet(value: &str, limit: usize) -> String {
    let text = value.replace('\n', " ").trim().to_string();
    if text.chars().count() <= limit {
        return text;
    }
    text.chars().take(limit).collect::<String>()
}

fn collect_recent_chat_messages(
    store: &AppStore,
    session_id: Option<&str>,
    limit: usize,
) -> Vec<Value> {
    let Some(session_id) = session_id else {
        return Vec::new();
    };
    let mut items = store
        .chat_messages
        .iter()
        .filter(|item| item.session_id == session_id)
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let start = items.len().saturating_sub(limit);
    items[start..]
        .iter()
        .filter(|item| item.role == "user" || item.role == "assistant")
        .map(|item| {
            json!({
                "role": item.role,
                "content": item.content
            })
        })
        .collect()
}

fn resolve_workspace_tool_path(
    state: &State<'_, AppState>,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    let workspace = workspace_root(state)?;
    let candidate = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        workspace.join(trimmed)
    };
    let normalized = candidate.canonicalize().unwrap_or(candidate.clone());
    let workspace_normalized = workspace.canonicalize().unwrap_or(workspace);
    if !normalized.starts_with(&workspace_normalized) {
        return Err("path is outside currentSpaceRoot".to_string());
    }
    Ok(normalized)
}

fn list_directory_entries(path: &Path, limit: usize) -> Result<Vec<Value>, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| {
            let entry_path = entry.path();
            json!({
                "name": entry.file_name().to_string_lossy().to_string(),
                "path": entry_path.display().to_string(),
                "kind": if entry_path.is_dir() { "dir" } else { "file" }
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    if entries.len() > limit {
        entries.truncate(limit);
    }
    Ok(entries)
}

fn interactive_runtime_tools_for_mode(runtime_mode: &str) -> Value {
    if runtime_mode == "wander" {
        return json!([
            {
                "type": "function",
                "function": {
                    "name": "redbox_fs",
                    "description": "Inspect files inside currentSpaceRoot with a single generic file tool. Use action=list before action=read for folder-based assets.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "action": { "type": "string", "enum": ["list", "read"] },
                            "path": { "type": "string" },
                            "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                            "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000 }
                        },
                        "required": ["action", "path"],
                        "additionalProperties": false
                    }
                }
            }
        ]);
    }
    json!([
        {
            "type": "function",
            "function": {
                "name": "redbox_app_query",
                "description": "Query app-managed RedBox data with one generic app tool. Prefer this over many specialized list/search tools.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operation": {
                            "type": "string",
                            "enum": [
                                "spaces.list",
                                "advisors.list",
                                "knowledge.search",
                                "work.list",
                                "memory.search",
                                "chat.sessions.list",
                                "settings.summary",
                                "redclaw.projects.list"
                            ]
                        },
                        "query": { "type": "string" },
                        "status": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                    },
                    "required": ["operation"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "redbox_fs",
                "description": "Inspect files inside currentSpaceRoot with a single generic file tool. Use action=list before action=read.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": { "type": "string", "enum": ["list", "read"] },
                        "path": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "maxChars": { "type": "integer", "minimum": 200, "maximum": 20000 }
                    },
                    "required": ["action", "path"],
                    "additionalProperties": false
                }
            }
        }
    ])
}

fn execute_interactive_tool_call(
    state: &State<'_, AppState>,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    match name {
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
                _ => Err(format!("unsupported app query operation: {operation}")),
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
        "redbox_list_spaces" => with_store(state, |store| {
            Ok(json!({
                "spaces": store.spaces.iter().map(|item| json!({
                    "id": item.id,
                    "name": item.name,
                    "isActive": item.id == store.active_space_id,
                    "updatedAt": item.updated_at
                })).collect::<Vec<_>>()
            }))
        }),
        "redbox_list_advisors" => {
            let _ = ensure_store_hydrated_for_advisors(state);
            let limit = parse_usize_arg(arguments, "limit", 8, 20);
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
        "redbox_search_knowledge" => {
            let _ = ensure_store_hydrated_for_knowledge(state);
            let query = payload_string(arguments, "query")
                .unwrap_or_default()
                .to_lowercase();
            let limit = parse_usize_arg(arguments, "limit", 6, 20);
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
        "redbox_list_work_items" => {
            let _ = ensure_store_hydrated_for_work(state);
            let status_filter = payload_string(arguments, "status");
            let limit = parse_usize_arg(arguments, "limit", 8, 20);
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
        "redbox_search_memory" => {
            let query = payload_string(arguments, "query")
                .unwrap_or_default()
                .to_lowercase();
            let limit = parse_usize_arg(arguments, "limit", 6, 20);
            with_store(state, |store| {
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
            })
        }
        "redbox_list_directory" => {
            let raw_path = payload_string(arguments, "path").unwrap_or_default();
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
        "redbox_read_path" => {
            let raw_path = payload_string(arguments, "path").unwrap_or_default();
            let max_chars = parse_usize_arg(arguments, "maxChars", 4000, 20000);
            let resolved = resolve_workspace_tool_path(state, &raw_path)?;
            if !resolved.is_file() {
                return Err(format!("not a file: {}", resolved.display()));
            }
            let content = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
            Ok(json!({
                "path": resolved.display().to_string(),
                "content": truncate_chars(&content, max_chars)
            }))
        }
        "redbox_list_chat_sessions" => {
            let limit = parse_usize_arg(arguments, "limit", 8, 20);
            with_store(state, |store| {
                let mut items = store.chat_sessions.clone();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!({
                    "sessions": items.into_iter().take(limit).map(|item| json!({
                        "id": item.id,
                        "title": item.title,
                        "updatedAt": item.updated_at
                    })).collect::<Vec<_>>()
                }))
            })
        }
        "redbox_get_settings_summary" => with_store(state, |store| {
            let default_ai_source_id = payload_string(&store.settings, "default_ai_source_id");
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
        "redbox_list_redclaw_projects" => {
            let _ = ensure_store_hydrated_for_redclaw(state);
            let limit = parse_usize_arg(arguments, "limit", 8, 20);
            with_store(state, |store| {
                Ok(json!({
                    "runner": {
                        "enabled": store.redclaw_state.enabled,
                        "isTicking": store.redclaw_state.is_ticking,
                        "lastError": store.redclaw_state.last_error
                    },
                    "projects": store.redclaw_state.projects
                        .iter()
                        .take(limit)
                        .map(|item| json!({
                            "id": item.id,
                            "goal": item.goal,
                            "status": item.status,
                            "platform": item.platform,
                            "taskType": item.task_type,
                            "updatedAt": item.updated_at
                        }))
                        .collect::<Vec<_>>()
                }))
            })
        }
        other => Err(format!("unsupported interactive tool: {other}")),
    }
}

fn run_openai_interactive_chat_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    config: &ResolvedChatConfig,
    message: &str,
    runtime_mode: &str,
) -> Result<String, String> {
    let mut messages = with_store(state, |store| {
        Ok(collect_recent_chat_messages(&store, session_id, 10))
    })?;
    messages.insert(
        0,
        json!({
            "role": "system",
            "content": interactive_runtime_system_prompt(state, runtime_mode)
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

    for turn in 0..max_turns {
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
            "stream": false
        });
        if disable_qwen_thinking {
            body["enable_thinking"] = json!(false);
        }
        if is_wander {
            body["temperature"] = json!(0.4);
            body["max_tokens"] = json!(900);
        }
        let response = run_curl_json_with_timeout(
            "POST",
            &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
            config.api_key.as_deref(),
            &[],
            Some(body),
            Some(if is_wander { 45 } else { 90 }),
        )?;
        append_debug_log_state(
            state,
            format!(
                "[timing][wander-runtime][{}] turn-{}-response elapsed={}ms",
                trace_id,
                turn + 1,
                now_ms().saturating_sub(turn_started_at)
            ),
        );
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

        if tool_calls.is_empty() {
            if assistant_content.trim().is_empty() {
                return Err("interactive runtime returned an empty final response".to_string());
            }
            return Ok(assistant_content);
        }

        if !assistant_content.trim().is_empty() {
            let _ = app.emit(
                "chat:thought-delta",
                json!({ "content": assistant_content, "sessionId": session_id }),
            );
            let _ = app.emit(
                "chat:thinking",
                json!({ "content": assistant_content, "sessionId": session_id }),
            );
        }
        messages.push(json!({
            "role": "assistant",
            "content": assistant_content,
            "tool_calls": tool_calls.iter().map(|call| call.raw.clone()).collect::<Vec<_>>()
        }));

        for call in tool_calls {
            let tool_started_at = now_ms();
            let description = format!("Interactive tool call: {}", call.name);
            let _ = app.emit(
                "chat:tool-start",
                json!({
                    "callId": call.id,
                    "name": call.name,
                    "input": call.arguments,
                    "description": description,
                    "sessionId": session_id,
                }),
            );
            let result = execute_interactive_tool_call(state, &call.name, &call.arguments);
            match result {
                Ok(result_value) => {
                    let result_text = serde_json::to_string_pretty(&result_value)
                        .unwrap_or_else(|_| result_value.to_string());
                    let _ = app.emit(
                        "chat:tool-update",
                        json!({
                            "callId": call.id,
                            "name": call.name,
                            "partial": text_snippet(&result_text, 1200),
                            "sessionId": session_id,
                        }),
                    );
                    let _ = app.emit(
                        "chat:tool-end",
                        json!({
                            "callId": call.id,
                            "name": call.name,
                            "sessionId": session_id,
                            "output": {
                                "success": true,
                                "content": result_text
                            }
                        }),
                    );
                    append_debug_log_state(
                        state,
                        format!(
                            "[timing][wander-runtime][{}] turn-{}-tool-{} elapsed={}ms | success=true",
                            trace_id,
                            turn + 1,
                            call.name,
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
                            tool_name: call.name.clone(),
                            command: None,
                            success: true,
                            result_text: Some(result_text.clone()),
                            summary_text: Some(format!("{} succeeded", call.name)),
                            prompt_text: None,
                            original_chars: None,
                            prompt_chars: None,
                            truncated: false,
                            payload: Some(
                                json!({ "arguments": call.arguments, "result": result_value }),
                            ),
                            created_at: now_i64(),
                            updated_at: now_i64(),
                        });
                        append_session_transcript(
                            store,
                            &target_session_id,
                            "tool.result",
                            "tool",
                            result_text.clone(),
                            Some(json!({ "callId": call.id, "toolName": call.name })),
                        );
                        append_session_checkpoint(
                            store,
                            &target_session_id,
                            "tool.call",
                            format!("tool {} completed", call.name),
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
                    let _ = app.emit(
                        "chat:tool-end",
                        json!({
                            "callId": call.id,
                            "name": call.name,
                            "sessionId": session_id,
                            "output": {
                                "success": false,
                                "content": failure_text
                            }
                        }),
                    );
                    append_debug_log_state(
                        state,
                        format!(
                            "[timing][wander-runtime][{}] turn-{}-tool-{} elapsed={}ms | success=false",
                            trace_id,
                            turn + 1,
                            call.name,
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
                            tool_name: call.name.clone(),
                            command: None,
                            success: false,
                            result_text: None,
                            summary_text: Some(failure_text.clone()),
                            prompt_text: None,
                            original_chars: None,
                            prompt_chars: None,
                            truncated: false,
                            payload: Some(json!({ "arguments": call.arguments })),
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

fn update_chat_runtime_state(
    state: &State<'_, AppState>,
    session_id: &str,
    is_processing: bool,
    partial_response: String,
    error: Option<String>,
) -> Result<(), String> {
    let mut guard = state
        .chat_runtime_states
        .lock()
        .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
    guard.insert(
        session_id.to_string(),
        ChatRuntimeStateRecord {
            session_id: session_id.to_string(),
            is_processing,
            partial_response,
            updated_at: now_ms(),
            error,
        },
    );
    Ok(())
}

fn execute_chat_exchange(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    session_id: Option<String>,
    message: String,
    display_content: String,
    model_config: Option<&Value>,
    attachment: Option<Value>,
    checkpoint_type: &str,
    checkpoint_summary: &str,
) -> Result<ChatExecutionResult, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let working_session_id = session_id.unwrap_or_else(|| make_id("session"));
    let _ = update_chat_runtime_state(state, &working_session_id, true, String::new(), None);
    let runtime_mode = with_store(state, |store| {
        Ok(Some(working_session_id.as_str())
            .as_ref()
            .and_then(|current_session_id| {
                store
                    .chat_sessions
                    .iter()
                    .find(|item| &item.id == current_session_id)
                    .and_then(|session| {
                        session
                            .metadata
                            .as_ref()
                            .and_then(|metadata| metadata.get("contextType"))
                            .and_then(|value| value.as_str())
                    })
            })
            .map(|value| resolve_runtime_mode_from_context_type(Some(value)))
            .unwrap_or("chatroom")
            .to_string())
    })?;
    let response = if let (Some(app), Some(config)) =
        (app, resolve_chat_config(&settings_snapshot, model_config))
    {
        if config.protocol == "openai" {
            match run_openai_interactive_chat_runtime(
                app,
                state,
                Some(working_session_id.as_str()),
                &config,
                &message,
                &runtime_mode,
            ) {
                Ok(response) => response,
                Err(error) => {
                    append_debug_log_state(
                        state,
                        format!(
                            "[runtime][{}][{}] interactive-runtime-failed | {}",
                            runtime_mode, working_session_id, error
                        ),
                    );
                    if runtime_mode == "wander" {
                        return Err(error);
                    }
                    generate_chat_response(&settings_snapshot, model_config, &message)
                }
            }
        } else {
            generate_chat_response(&settings_snapshot, model_config, &message)
        }
    } else {
        generate_chat_response(&settings_snapshot, model_config, &message)
    };
    let title_hint = Some(session_title_from_message(&display_content));
    let mut title_update: Option<(String, String)> = None;
    let mut final_session_id = String::new();

    with_store_mut(state, |store| {
        let (session, is_new) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(working_session_id.clone()),
            title_hint.clone(),
        );
        final_session_id = session.id.clone();
        let next_title = title_hint.clone().unwrap_or_else(|| "New Chat".to_string());
        if is_new || session.title == "New Chat" || session.title.trim().is_empty() {
            session.title = next_title.clone();
            title_update = Some((session.id.clone(), next_title));
        }
        session.updated_at = now_iso();
        let runtime_mode = resolve_runtime_mode_from_context_type(
            session
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("contextType"))
                .and_then(|value| value.as_str()),
        );

        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "user".to_string(),
            content: message.clone(),
            display_content: if display_content.trim().is_empty()
                || display_content.trim() == message.trim()
            {
                None
            } else {
                Some(display_content.clone())
            },
            attachment: attachment.clone(),
            created_at: now_iso(),
        });
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session.id.clone(),
            role: "assistant".to_string(),
            content: response.clone(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "user",
            message.clone(),
            Some(json!({
                "displayContent": display_content,
                "attachment": attachment,
                "runtimeMode": runtime_mode,
            })),
        );
        append_session_transcript(
            store,
            &final_session_id,
            "message",
            "assistant",
            response.clone(),
            Some(json!({ "runtimeMode": runtime_mode })),
        );
        append_session_checkpoint(
            store,
            &final_session_id,
            checkpoint_type,
            checkpoint_summary.to_string(),
            Some(json!({
                "responsePreview": response.chars().take(80).collect::<String>(),
                "runtimeMode": runtime_mode,
            })),
        );
        Ok(())
    })?;
    let _ = update_chat_runtime_state(state, &final_session_id, false, response.clone(), None);
    let _ = with_store_mut(state, |store| {
        let next_scheduled_at = if response.chars().count() > 1200 {
            (now_i64() + 5 * 60 * 1000).to_string()
        } else {
            (now_i64() + 20 * 60 * 1000).to_string()
        };
        let current = memory_maintenance_status_from_settings(&store.settings)
            .unwrap_or_else(default_memory_maintenance_status);
        let status = json!({
            "started": true,
            "running": false,
            "lockState": current.get("lockState").cloned().unwrap_or_else(|| json!("owner")),
            "blockedBy": current.get("blockedBy").cloned().unwrap_or(Value::Null),
            "pendingMutations": current.get("pendingMutations").cloned().unwrap_or_else(|| json!(0)),
            "lastRunAt": current.get("lastRunAt").cloned().unwrap_or(Value::Null),
            "lastScanAt": now_i64(),
            "lastReason": "query-after",
            "lastSummary": current.get("lastSummary").cloned().unwrap_or_else(|| json!("RedBox memory maintenance has not run yet.")),
            "lastError": current.get("lastError").cloned().unwrap_or(Value::Null),
            "nextScheduledAt": next_scheduled_at.parse::<i64>().unwrap_or(now_i64()),
        });
        let mut settings = store.settings.clone();
        write_memory_maintenance_status(&mut settings, &status);
        store.settings = settings;
        store.redclaw_state.next_maintenance_at =
            value_to_i64_string(status.get("nextScheduledAt"));
        Ok(())
    });

    Ok(ChatExecutionResult {
        session_id: final_session_id,
        response,
        title_update,
    })
}

fn run_subagent_orchestration_for_task(
    settings: &Value,
    runtime_mode: &str,
    task_id: &str,
    route: &Value,
    user_input: &str,
) -> Result<Value, String> {
    let Some(template) = load_redbox_prompt("runtime/ai/subagent_orchestrator.txt") else {
        return Ok(json!({
            "outputs": [],
            "promptSection": "subagent prompt unavailable"
        }));
    };
    let role_sequence = role_sequence_for_route(route);
    let mut outputs = Vec::<Value>::new();
    for role_id in role_sequence {
        let role_spec = runtime_subagent_role_spec(&role_id);
        let system_prompt = render_redbox_prompt(
            &template,
            &[
                ("role_id", role_spec.role_id.clone()),
                ("role_purpose", role_spec.purpose.clone()),
                ("role_handoff", role_spec.handoff_contract.clone()),
                ("role_output_schema", role_spec.output_schema.clone()),
                ("role_directive", role_spec.system_prompt.clone()),
                ("runtime_mode", runtime_mode.to_string()),
                ("task_id", task_id.to_string()),
                (
                    "intent",
                    payload_string(route, "intent").unwrap_or_default(),
                ),
                ("goal", payload_string(route, "goal").unwrap_or_default()),
                (
                    "required_capabilities",
                    route
                        .get("requiredCapabilities")
                        .cloned()
                        .unwrap_or_else(|| json!([]))
                        .to_string(),
                ),
                ("previous_outputs_json", json!(outputs).to_string()),
            ],
        );
        let user_prompt = format!(
            "用户请求：{}\n任务目标：{}",
            user_input,
            payload_string(route, "goal").unwrap_or_default()
        );
        let raw = generate_structured_response_with_settings(
            settings,
            None,
            &system_prompt,
            &user_prompt,
            true,
        )?;
        let parsed = parse_json_value_from_text(&raw).unwrap_or_else(|| {
            json!({
                "summary": raw,
                "artifact": "",
                "handoff": "",
                "risks": []
            })
        });
        outputs.push(json!({
            "roleId": role_spec.role_id,
            "summary": payload_string(&parsed, "summary").unwrap_or_else(|| raw.clone()),
            "artifact": payload_string(&parsed, "artifact"),
            "handoff": payload_string(&parsed, "handoff"),
            "risks": parsed.get("risks").cloned().unwrap_or_else(|| json!([])),
            "issues": parsed.get("issues").cloned().unwrap_or_else(|| json!([])),
            "approved": parsed.get("approved").cloned().unwrap_or_else(|| json!(true)),
        }));
    }
    Ok(json!({
        "outputs": outputs,
        "promptSection": "subagent orchestration completed"
    }))
}

fn save_runtime_task_artifact(
    state: &State<'_, AppState>,
    task_id: &str,
    route: &Value,
    goal: &str,
    orchestration: Option<&Value>,
) -> Result<Value, String> {
    let intent = payload_string(route, "intent").unwrap_or_else(|| "direct_answer".to_string());
    let root = workspace_root(state)?;
    let (dir, extension) = match intent.as_str() {
        "manuscript_creation" | "advisor_persona" | "discussion" | "direct_answer" => {
            (root.join("manuscripts").join("runtime-tasks"), "md")
        }
        "image_creation" | "cover_generation" => (root.join("cover").join("runtime-tasks"), "md"),
        _ => (root.join("redclaw").join("runtime-artifacts"), "md"),
    };
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!(
        "{}-artifact.{}",
        slug_from_relative_path(task_id),
        extension
    ));
    let content = build_runtime_task_artifact_content(task_id, route, goal, orchestration)?;
    write_text_file(&path, &content)?;
    Ok(json!({
        "type": "saved-artifact",
        "path": path.display().to_string(),
        "intent": intent,
    }))
}

fn run_reviewer_repair_for_task(
    settings: &Value,
    task_id: &str,
    route: &Value,
    goal: &str,
    orchestration: &Value,
) -> Result<Value, String> {
    let reviewer = orchestration
        .get("outputs")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("roleId").and_then(|value| value.as_str()) == Some("reviewer")
            })
        })
        .cloned()
        .unwrap_or_else(|| json!({}));
    let issues = reviewer
        .get("issues")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let prompt = format!(
        "Task ID: {}\nGoal: {}\nRoute: {}\nReviewer issues: {}\n\nReturn strict JSON with fields summary, artifact, handoff, risks. Focus on concrete repair steps needed before the task can be considered complete.",
        task_id,
        goal,
        route.to_string(),
        issues
    );
    let raw = generate_structured_response_with_settings(
        settings,
        None,
        "You are a runtime repair planner for RedBox. Output strict JSON only.",
        &prompt,
        true,
    )?;
    Ok(parse_json_value_from_text(&raw).unwrap_or_else(|| {
        json!({
            "summary": raw,
            "artifact": "",
            "handoff": "",
            "risks": []
        })
    }))
}

fn resolve_default_model_config(
    settings: &Value,
) -> Option<(String, String, Option<String>, String)> {
    if let Some(ai_sources_json) = payload_string(settings, "ai_sources_json") {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(&ai_sources_json) {
            let default_id = payload_string(settings, "default_ai_source_id");
            let selected = items
                .iter()
                .find(|item| {
                    item.get("id").and_then(|value| value.as_str()) == default_id.as_deref()
                })
                .or_else(|| items.first())?;
            let base_url = selected
                .get("baseURL")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let api_key = selected
                .get("apiKey")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let model_name = selected
                .get("model")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let protocol = selected
                .get("protocol")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| infer_protocol(&base_url, None, None));
            if !base_url.is_empty() && !model_name.is_empty() {
                return Some((protocol, base_url, api_key, model_name));
            }
        }
    }

    let base_url = payload_string(settings, "api_endpoint").unwrap_or_default();
    let model_name = payload_string(settings, "model_name").unwrap_or_default();
    if base_url.trim().is_empty() || model_name.trim().is_empty() {
        return None;
    }
    let api_key = payload_string(settings, "api_key");
    let protocol = infer_protocol(&base_url, None, None);
    Some((protocol, base_url, api_key, model_name))
}

fn redclaw_session_id_for_space(space_id: &str) -> String {
    let context_id = format!("redclaw-singleton:{space_id}");
    format!(
        "context-session:redclaw:{}",
        slug_from_relative_path(&context_id)
    )
}

fn execute_redclaw_run(
    app: &AppHandle,
    state: &State<'_, AppState>,
    prompt: String,
    project_id: Option<String>,
    source_label: &str,
) -> Result<Value, String> {
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
    let active_space_id = with_store(state, |store| Ok(store.active_space_id.clone()))?;
    let session_id = redclaw_session_id_for_space(&active_space_id);

    let response = if let Some((protocol, base_url, api_key, model_name)) =
        resolve_default_model_config(&settings_snapshot)
    {
        invoke_chat_by_protocol(
            &protocol,
            &base_url,
            api_key.as_deref(),
            &model_name,
            &prompt,
        )
        .unwrap_or_else(|_| build_placeholder_assistant_response(&prompt))
    } else {
        build_placeholder_assistant_response(&prompt)
    };

    let target_project_id = with_store(state, |store| {
        Ok(project_id.unwrap_or_else(|| {
            store
                .redclaw_state
                .projects
                .first()
                .map(|item| item.id.clone())
                .unwrap_or_else(|| make_id("redclaw-project"))
        }))
    })?;
    let artifact_kind = detect_redclaw_artifact_kind(&prompt, source_label);
    let artifacts = save_redclaw_outputs(
        state,
        artifact_kind,
        &target_project_id,
        &session_id,
        &prompt,
        &response,
        source_label,
    )?;

    with_store_mut(state, |store| {
        let (session, _) = ensure_chat_session(
            &mut store.chat_sessions,
            Some(session_id.clone()),
            Some("RedClaw".to_string()),
        );
        session.updated_at = now_iso();

        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session_id.clone(),
            role: "user".to_string(),
            content: prompt.clone(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        store.chat_messages.push(ChatMessageRecord {
            id: make_id("message"),
            session_id: session_id.clone(),
            role: "assistant".to_string(),
            content: response.clone(),
            display_content: None,
            attachment: None,
            created_at: now_iso(),
        });
        append_session_transcript(
            store,
            &session_id,
            "message",
            "user",
            prompt.clone(),
            Some(json!({ "source": source_label })),
        );
        append_session_transcript(
            store,
            &session_id,
            "message",
            "assistant",
            response.clone(),
            Some(json!({ "source": source_label })),
        );
        append_session_checkpoint(
            store,
            &session_id,
            "redclaw-run",
            format!("RedClaw completed {source_label}"),
            Some(json!({
                "responsePreview": response.chars().take(120).collect::<String>(),
                "artifactKind": artifact_kind,
                "artifacts": artifacts,
            })),
        );

        if let Some(project) = store
            .redclaw_state
            .projects
            .iter_mut()
            .find(|item| item.id == target_project_id)
        {
            project.updated_at = now_iso();
            project.status = "active".to_string();
            if project.goal.trim().is_empty() {
                project.goal = prompt.chars().take(160).collect();
            }
        } else {
            store.redclaw_state.projects.push(RedclawProjectRecord {
                id: target_project_id.clone(),
                goal: prompt.chars().take(160).collect(),
                platform: Some("generic".to_string()),
                task_type: Some("manual".to_string()),
                status: "active".to_string(),
                updated_at: now_iso(),
            });
        }

        store.work_items.push(create_work_item(
            "automation",
            format!("RedClaw {}", source_label),
            Some("Rust host executed a RedClaw run.".to_string()),
            Some(prompt.clone()),
            Some(json!({
                "projectId": target_project_id,
                "sessionId": session_id,
                "source": source_label,
                "artifactKind": artifact_kind,
                "artifacts": artifacts,
            })),
            2,
        ));

        Ok(())
    })?;

    let _ = app.emit(
        "redclaw:runner-message",
        json!({
            "sessionId": session_id.clone(),
            "artifactKind": artifact_kind,
            "artifacts": artifacts,
        }),
    );
    Ok(json!({
        "success": true,
        "sessionId": session_id,
        "response": response,
        "artifactKind": artifact_kind,
        "artifacts": artifacts
    }))
}

fn ensure_chat_session<'a>(
    sessions: &'a mut Vec<ChatSessionRecord>,
    session_id: Option<String>,
    title_hint: Option<String>,
) -> (&'a mut ChatSessionRecord, bool) {
    let id = session_id.unwrap_or_else(|| make_id("session"));
    if let Some(index) = sessions.iter().position(|item| item.id == id) {
        return (&mut sessions[index], false);
    }

    let timestamp = now_iso();
    sessions.push(ChatSessionRecord {
        id: id.clone(),
        title: title_hint
            .filter(|item| !item.trim().is_empty())
            .unwrap_or_else(|| "New Chat".to_string()),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        metadata: None,
    });
    let last_index = sessions.len() - 1;
    (&mut sessions[last_index], true)
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn wechat_binding_public_value(binding: &WechatOfficialBindingRecord) -> Value {
    json!({
        "id": binding.id,
        "name": binding.name,
        "appId": binding.app_id,
        "createdAt": binding.created_at,
        "updatedAt": binding.updated_at,
        "verifiedAt": binding.verified_at,
        "isActive": binding.is_active,
    })
}

fn fetch_wechat_access_token(app_id: &str, secret: &str) -> Result<String, String> {
    let url = format!(
        "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={}&secret={}",
        url_encode_component(app_id),
        url_encode_component(secret)
    );
    let response = run_curl_json("GET", &url, None, &[], None)?;
    if let Some(token) = response
        .get("access_token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(token.to_string());
    }
    let errcode = response.get("errcode").cloned().unwrap_or(Value::Null);
    let errmsg = response
        .get("errmsg")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error");
    Err(format!("WeChat token error {errcode}: {errmsg}"))
}

fn create_wechat_remote_draft(
    access_token: &str,
    title: &str,
    content: &str,
    digest: &str,
    thumb_media_id: &str,
) -> Result<String, String> {
    let url = format!(
        "https://api.weixin.qq.com/cgi-bin/draft/add?access_token={}",
        url_encode_component(access_token)
    );
    let response = run_curl_json(
        "POST",
        &url,
        None,
        &[],
        Some(json!({
            "articles": [{
                "title": title,
                "author": "RedClaw",
                "digest": digest,
                "content": markdown_to_html(title, content),
                "content_source_url": "",
                "thumb_media_id": thumb_media_id,
                "need_open_comment": 0,
                "only_fans_can_comment": 0
            }]
        })),
    )?;
    if let Some(media_id) = response
        .get("media_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(media_id.to_string());
    }
    let errcode = response.get("errcode").cloned().unwrap_or(Value::Null);
    let errmsg = response
        .get("errmsg")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error");
    Err(format!("WeChat draft error {errcode}: {errmsg}"))
}

fn extract_cover_source(payload: &Value) -> Option<String> {
    let direct = payload_string(payload, "cover")
        .or_else(|| payload_string(payload, "coverUrl"))
        .or_else(|| payload_string(payload, "thumbUrl"))
        .or_else(|| payload_string(payload, "imageSource"));
    if direct.is_some() {
        return direct;
    }
    let metadata = payload_field(payload, "metadata")?;
    payload_string(metadata, "cover")
        .or_else(|| payload_string(metadata, "coverUrl"))
        .or_else(|| payload_string(metadata, "thumbUrl"))
        .or_else(|| payload_string(metadata, "imageSource"))
        .or_else(|| {
            payload_field(metadata, "images")
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
                .and_then(|first| {
                    first
                        .as_str()
                        .map(ToString::to_string)
                        .or_else(|| payload_string(first, "url"))
                        .or_else(|| payload_string(first, "src"))
                        .or_else(|| payload_string(first, "path"))
                        .or_else(|| payload_string(first, "dataUrl"))
                })
        })
}

fn materialize_image_source(source: &str, target_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let trimmed = source.trim();
    if let Some(data) = trimmed.strip_prefix("data:") {
        let extension = if data.starts_with("image/png") {
            "png"
        } else if data.starts_with("image/jpeg") || data.starts_with("image/jpg") {
            "jpg"
        } else if data.starts_with("image/gif") {
            "gif"
        } else {
            "png"
        };
        let encoded = data
            .split_once(',')
            .map(|(_, body)| body)
            .ok_or_else(|| "无效 data URL".to_string())?;
        let bytes = decode_base64_bytes(encoded)?;
        let path = target_dir.join(format!("cover-{}.{}", now_ms(), extension));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let bytes = run_curl_bytes("GET", trimmed, None, &[], None)?;
        let path = target_dir.join(format!("cover-{}.jpg", now_ms()));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        return Ok(path);
    }
    if let Some(path) = resolve_local_path(trimmed).filter(|path| path.exists()) {
        return Ok(path);
    }
    Err("未找到可用封面图".to_string())
}

fn upload_wechat_thumb_media(access_token: &str, image_path: &Path) -> Result<String, String> {
    let url = format!(
        "https://api.weixin.qq.com/cgi-bin/material/add_material?access_token={}&type=image",
        url_encode_component(access_token)
    );
    let output = std::process::Command::new("curl")
        .arg("-sS")
        .arg("-F")
        .arg(format!("media=@{}", image_path.display()))
        .arg(&url)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("WeChat media upload failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let value: Value =
        serde_json::from_str(&stdout).map_err(|error| format!("Invalid WeChat JSON: {error}"))?;
    if let Some(media_id) = value
        .get("media_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(media_id.to_string());
    }
    let errcode = value.get("errcode").cloned().unwrap_or(Value::Null);
    let errmsg = value
        .get("errmsg")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error");
    Err(format!("WeChat media upload error {errcode}: {errmsg}"))
}

fn detect_redclaw_artifact_kind(prompt: &str, source_label: &str) -> &'static str {
    let lower = prompt.to_lowercase();
    if lower.contains("save-copy") || lower.contains("文案包") {
        "copy"
    } else if lower.contains("save-image") || lower.contains("配图") || lower.contains("封面") {
        "image"
    } else if lower.contains("save-retro") || lower.contains("复盘") {
        "retro"
    } else if source_label.contains("scheduled") || source_label.contains("long-cycle") {
        "automation"
    } else {
        "run"
    }
}

fn save_redclaw_outputs(
    state: &State<'_, AppState>,
    kind: &str,
    project_id: &str,
    session_id: &str,
    prompt: &str,
    response: &str,
    source_label: &str,
) -> Result<Vec<Value>, String> {
    let mut artifacts = Vec::new();
    let timestamp = now_iso();
    let slug = slug_from_relative_path(&format!("{project_id}-{source_label}-{timestamp}"));

    let run_path = redclaw_root(state)?.join("runs").join(format!("{slug}.md"));
    let run_body = format!(
        "# RedClaw Run\n\n- Project: {}\n- Source: {}\n- Session: {}\n- Time: {}\n\n## Prompt\n\n{}\n\n## Response\n\n{}\n",
        project_id, source_label, session_id, timestamp, prompt, response
    );
    write_text_file(&run_path, &run_body)?;
    artifacts.push(json!({
        "kind": "run-log",
        "path": run_path.display().to_string(),
        "label": "RedClaw run log",
    }));

    match kind {
        "copy" => {
            let manuscript_relative = format!("redclaw/{}.md", slug);
            let manuscript_path = resolve_manuscript_path(state, &manuscript_relative)?;
            let manuscript_body = format!(
                "# RedClaw Copy Package\n\n> Project: {}\n> Generated by: {}\n\n{}",
                project_id, source_label, response
            );
            write_text_file(&manuscript_path, &manuscript_body)?;
            artifacts.push(json!({
                "kind": "manuscript",
                "path": manuscript_path.display().to_string(),
                "relativePath": manuscript_relative,
                "label": "Copy package manuscript",
            }));
        }
        "retro" => {
            let retro_path = redclaw_root(state)?
                .join("retro")
                .join(format!("{slug}.md"));
            let retro_body = format!(
                "# RedClaw Retro\n\n> Project: {}\n> Generated by: {}\n\n{}",
                project_id, source_label, response
            );
            write_text_file(&retro_path, &retro_body)?;
            artifacts.push(json!({
                "kind": "retro",
                "path": retro_path.display().to_string(),
                "label": "Retro note",
            }));
        }
        "image" => {
            let prompt_path = redclaw_root(state)?
                .join("images")
                .join(format!("{slug}.md"));
            let prompt_body = format!(
                "# RedClaw Image Prompt Pack\n\n> Project: {}\n> Generated by: {}\n\n{}",
                project_id, source_label, response
            );
            write_text_file(&prompt_path, &prompt_body)?;
            artifacts.push(json!({
                "kind": "image-prompts",
                "path": prompt_path.display().to_string(),
                "label": "Image prompt pack",
            }));
        }
        _ => {}
    }

    Ok(artifacts)
}

fn latest_session_id(store: &AppStore) -> String {
    store
        .chat_sessions
        .iter()
        .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
        .map(|item| item.id.clone())
        .unwrap_or_else(|| "tool-confirmation".to_string())
}

fn generate_response_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    prompt: &str,
) -> String {
    generate_chat_response(settings, model_config, prompt)
}

fn generate_structured_response_with_settings(
    settings: &Value,
    model_config: Option<&Value>,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    let config = resolve_chat_config(settings, model_config)
        .ok_or_else(|| "当前未配置可用模型".to_string())?;
    let mut body = json!({
        "model": config.model_name,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "stream": false
    });
    if require_json {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let response = run_curl_json(
        "POST",
        &format!("{}/chat/completions", normalize_base_url(&config.base_url)),
        config.api_key.as_deref(),
        &[],
        Some(body),
    )?;
    let content = response
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("模型未返回内容".to_string());
    }
    Ok(content)
}

fn find_advisor_name(advisors: &[AdvisorRecord], advisor_id: &str) -> String {
    advisors
        .iter()
        .find(|item| item.id == advisor_id)
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "成员".to_string())
}

fn find_advisor_avatar(advisors: &[AdvisorRecord], advisor_id: &str) -> String {
    advisors
        .iter()
        .find(|item| item.id == advisor_id)
        .map(|item| item.avatar.clone())
        .unwrap_or_else(|| "🤖".to_string())
}

fn build_advisor_prompt(
    advisor: Option<&AdvisorRecord>,
    message: &str,
    context: Option<&Value>,
) -> String {
    let mut prompt = String::new();
    if let Some(advisor) = advisor {
        prompt.push_str(&format!(
            "你正在扮演名为“{}”的智囊团成员。\n性格与职责：{}\n\n系统设定：{}\n\n",
            advisor.name, advisor.personality, advisor.system_prompt
        ));
    }
    if let Some(context) = context {
        prompt.push_str("补充上下文：\n");
        prompt.push_str(&context.to_string());
        prompt.push_str("\n\n");
    }
    prompt.push_str("请直接回复用户问题，保持信息密度高、可执行。\n\n用户消息：\n");
    prompt.push_str(message);
    prompt
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

fn split_stream_chunks(content: &str, max_chars: usize) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0usize;
    for ch in content.chars() {
        current.push(ch);
        count += 1;
        let boundary = ch == '\n' || ch == '。' || ch == '！' || ch == '？';
        if count >= max_chars && boundary {
            chunks.push(current.clone());
            current.clear();
            count = 0;
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn emit_chat_sequence(
    app: &AppHandle,
    session_id: &str,
    response: &str,
    thought: &str,
    title_update: Option<(String, String)>,
) {
    let _ = app.emit(
        "chat:plan-updated",
        json!({ "steps": [], "sessionId": session_id }),
    );
    let _ = app.emit(
        "chat:phase-start",
        json!({ "name": "thinking", "sessionId": session_id }),
    );
    let _ = app.emit("chat:thought-start", json!({ "sessionId": session_id }));
    if !thought.trim().is_empty() {
        let _ = app.emit(
            "chat:thought-delta",
            json!({ "content": thought, "sessionId": session_id }),
        );
        let _ = app.emit(
            "chat:thinking",
            json!({ "content": thought, "sessionId": session_id }),
        );
    }
    let _ = app.emit("chat:thought-end", json!({ "sessionId": session_id }));
    let _ = app.emit(
        "chat:phase-start",
        json!({ "name": "responding", "sessionId": session_id }),
    );
    for chunk in split_stream_chunks(response, 160) {
        let _ = app.emit(
            "chat:response-chunk",
            json!({ "content": chunk, "sessionId": session_id }),
        );
    }
    if let Some((sid, title)) = title_update {
        let _ = app.emit(
            "chat:session-title-updated",
            json!({ "sessionId": sid, "title": title }),
        );
    }
    let _ = app.emit(
        "chat:response-end",
        json!({ "content": response, "sessionId": session_id }),
    );
}

fn parse_millis_string(value: Option<&str>) -> Option<i64> {
    value.and_then(|item| item.trim().parse::<i64>().ok())
}

fn next_scheduled_timestamp(task: &RedclawScheduledTaskRecord, now: i64) -> Option<String> {
    let next_ms = match task.mode.as_str() {
        "interval" => now + task.interval_minutes.unwrap_or(60) * 60_000,
        "daily" => now + 24 * 60 * 60_000,
        "weekly" => now + 7 * 24 * 60 * 60_000,
        "once" => return None,
        _ => now + 60 * 60_000,
    };
    Some(next_ms.to_string())
}

fn next_long_cycle_timestamp(task: &RedclawLongCycleTaskRecord, now: i64) -> Option<String> {
    Some((now + task.interval_minutes * 60_000).to_string())
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
    match channel {
        "app:get-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "app:check-update" => Ok(json!({
            "success": true,
            "hasUpdate": false,
            "currentVersion": env!("CARGO_PKG_VERSION"),
        })),
        "app:open-release-page" => {
            let url = payload_string(&payload, "url")
                .or_else(|| payload_value_as_string(&payload))
                .unwrap_or_else(|| "https://github.com/Jamailar/RedBox/releases".to_string());
            open::that(&url).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "url": url }))
        }
        "app:open-path" => {
            let path = payload_string(&payload, "path")
                .or_else(|| payload_value_as_string(&payload))
                .ok_or_else(|| "path is required".to_string())?;
            open::that(&path).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": path }))
        }
        "redbox-auth:get-config" => Ok(json!({
            "success": true,
            "gatewayBase": "https://api.ziz.hk",
            "appSlug": "redbox",
            "defaultWechatState": "redconvert-desktop",
        })),
        "redbox-auth:get-session-cached" => with_store(state, |store| {
            Ok(json!({
                "success": true,
                "session": official_settings_session(&store.settings)
            }))
        }),
        "redbox-auth:get-session" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            let session = official_settings_session(&settings);
            let models = if session.is_some() {
                fetch_official_models_for_settings(&settings)
            } else {
                official_settings_models(&settings)
            };
            write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
            if session.is_some() && !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models);
            }
            store.settings = settings.clone();
            Ok(json!({
                "success": true,
                "session": official_settings_session(&settings),
                "routeSynced": session.is_some(),
            }))
        }),
        "redbox-auth:logout" => {
            let response = with_store_mut(state, |store| {
                let mut settings = store.settings.clone();
                upsert_official_settings_session(&mut settings, None);
                if let Some(object) = settings.as_object_mut() {
                    object.insert("api_key".to_string(), json!(""));
                }
                store.settings = settings;
                Ok(json!({ "success": true, "routing": { "cleared": true } }))
            })?;
            emit_redbox_auth_session_updated(app, None);
            Ok(response)
        }
        "redbox-auth:send-sms-code" => {
            let phone = payload_string(&payload, "phone").unwrap_or_default();
            if phone.trim().is_empty() {
                Ok(json!({ "success": false, "error": "请输入手机号" }))
            } else {
                let request = json!({ "phone": phone });
                let result = with_store(state, |store| {
                    run_official_public_json_request(
                        &store.settings,
                        "POST",
                        "/auth/send-sms-code",
                        Some(request.clone()),
                    )
                });
                match result {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
        }
        "redbox-auth:login-sms" | "redbox-auth:register-sms" => {
            let phone = payload_string(&payload, "phone").unwrap_or_default();
            let code = payload_string(&payload, "code").unwrap_or_default();
            let invite_code = payload_string(&payload, "inviteCode");
            if phone.trim().is_empty() || code.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "请输入手机号和验证码" }));
            }
            let response = with_store_mut(state, |store| {
                let mut settings = store.settings.clone();
                let response = run_official_public_json_request(
                    &settings,
                    "POST",
                    if channel == "redbox-auth:login-sms" {
                        "/auth/login/sms"
                    } else {
                        "/auth/register/sms"
                    },
                    Some(json!({
                        "phone": phone,
                        "code": code,
                        "invite_code": invite_code.clone().filter(|value| !value.trim().is_empty()),
                    })),
                )?;
                let session = normalize_official_auth_session(&response)?;
                upsert_official_settings_session(&mut settings, Some(&session));
                let models = fetch_official_models_for_settings(&settings);
                write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
                if !models.is_empty() {
                    official_sync_source_into_settings(&mut settings, &models);
                }
                store.settings = settings;
                Ok(json!({ "success": true, "session": session, "routeSynced": true }))
            })?;
            emit_redbox_auth_session_updated(app, response.get("session").cloned());
            Ok(response)
        }
        "redbox-auth:wechat-url" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            let state_text = payload_string(&payload, "state")
                .unwrap_or_else(|| "redconvert-desktop".to_string());
            let response = run_official_public_json_request(
                &settings,
                "GET",
                &format!(
                    "/auth/login/wechat/url?state={}",
                    state_text.replace(' ', "%20")
                ),
                None,
            )?;
            let payload = official_unwrap_response_payload(&response);
            let data = json!({
                "enabled": payload_field(&payload, "enabled").and_then(|value| value.as_bool()).unwrap_or(true),
                "sessionId": payload_string(&payload, "session_id").or_else(|| payload_string(&payload, "sessionId")).unwrap_or_default(),
                "qrContentUrl": payload_string(&payload, "qr_content_url").or_else(|| payload_string(&payload, "qrContentUrl")).or_else(|| payload_string(&payload, "url")).unwrap_or_default(),
                "url": payload_string(&payload, "url").unwrap_or_default(),
                "expiresIn": payload_field(&payload, "expires_in").or_else(|| payload_field(&payload, "expiresIn")).and_then(|value| value.as_i64()).unwrap_or(120),
                "status": payload_string(&payload, "status").unwrap_or_else(|| "PENDING".to_string()),
                "createdAt": now_ms(),
            });
            write_settings_json_value(&mut settings, "redbox_auth_wechat_login_json", &data);
            store.settings = settings;
            Ok(json!({ "success": true, "data": data }))
        }),
        "redbox-auth:wechat-status" => {
            let response = with_store_mut(state, |store| {
                let mut settings = store.settings.clone();
                let pending =
                    official_settings_wechat_login(&settings).unwrap_or_else(|| json!({}));
                let requested_session_id =
                    payload_string(&payload, "sessionId").unwrap_or_default();
                let pending_session_id = payload_string(&pending, "sessionId").unwrap_or_default();
                let session_id = if requested_session_id.is_empty() {
                    pending_session_id
                } else {
                    requested_session_id
                };
                if session_id.is_empty() {
                    return Ok(json!({ "success": false, "error": "sessionId 不能为空" }));
                }
                let response = run_official_public_json_request(
                    &settings,
                    "GET",
                    &format!(
                        "/auth/login/wechat/status?session_id={}",
                        session_id.replace(' ', "%20")
                    ),
                    None,
                )?;
                let payload = official_unwrap_response_payload(&response);
                let status = payload_string(&payload, "status")
                    .unwrap_or_else(|| "PENDING".to_string())
                    .to_uppercase();
                let session = if status == "CONFIRMED" {
                    payload
                        .get("auth_payload")
                        .map(normalize_official_auth_session)
                        .transpose()?
                } else {
                    None
                };
                if let Some(ref session_value) = session {
                    upsert_official_settings_session(&mut settings, Some(session_value));
                    let models = fetch_official_models_for_settings(&settings);
                    write_settings_json_array(
                        &mut settings,
                        "redbox_official_models_json",
                        &models,
                    );
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                }
                let result = json!({
                    "success": true,
                    "data": {
                        "status": status,
                        "sessionId": session_id,
                        "session": session,
                        "raw": payload,
                    }
                });
                store.settings = settings;
                Ok(result)
            })?;
            if response
                .pointer("/data/status")
                .and_then(|value| value.as_str())
                == Some("CONFIRMED")
            {
                emit_redbox_auth_session_updated(
                    app,
                    response
                        .pointer("/data/session")
                        .cloned()
                        .filter(|value| !value.is_null()),
                );
            }
            Ok(response)
        }
        "redbox-auth:login-wechat-code" => {
            let code = payload_string(&payload, "code").unwrap_or_default();
            if code.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少微信授权 code" }));
            }
            let response = with_store_mut(state, |store| {
                let mut settings = store.settings.clone();
                let response = run_official_public_json_request(
                    &settings,
                    "POST",
                    "/auth/login/wechat",
                    Some(json!({ "code": code })),
                )?;
                let session = normalize_official_auth_session(&response)?;
                upsert_official_settings_session(&mut settings, Some(&session));
                let models = fetch_official_models_for_settings(&settings);
                write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
                if !models.is_empty() {
                    official_sync_source_into_settings(&mut settings, &models);
                }
                store.settings = settings;
                Ok(json!({ "success": true, "session": session, "routeSynced": true }))
            })?;
            emit_redbox_auth_session_updated(app, response.get("session").cloned());
            Ok(response)
        }
        "redbox-auth:refresh" => {
            let response = with_store_mut(state, |store| {
                let mut settings = store.settings.clone();
                let session = official_settings_session(&settings).map(|mut session| {
                    if let Some(object) = session.as_object_mut() {
                        object.insert("updatedAt".to_string(), json!(now_ms() as i64));
                    }
                    session
                });
                if let Some(ref session_value) = session {
                    upsert_official_settings_session(&mut settings, Some(session_value));
                    let models = fetch_official_models_for_settings(&settings);
                    write_settings_json_array(
                        &mut settings,
                        "redbox_official_models_json",
                        &models,
                    );
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                }
                store.settings = settings;
                Ok(json!({ "success": true, "session": session, "routeSynced": session.is_some() }))
            })?;
            emit_redbox_auth_session_updated(
                app,
                response
                    .get("session")
                    .cloned()
                    .filter(|value| !value.is_null()),
            );
            Ok(response)
        }
        "redbox-auth:me" => with_store(state, |store| {
            let remote = run_official_json_request(&store.settings, "GET", "/users/me", None)
                .map(|response| official_unwrap_response_payload(&response));
            let user = remote.unwrap_or_else(|_| {
                let session =
                    official_settings_session(&store.settings).unwrap_or_else(|| json!({}));
                session.get("user").cloned().unwrap_or_else(|| json!({}))
            });
            Ok(json!({ "success": true, "user": user }))
        }),
        "redbox-auth:points" => with_store(state, |store| {
            let remote =
                run_official_json_request(&store.settings, "GET", "/users/me/points", None)
                    .map(|response| official_unwrap_response_payload(&response));
            Ok(json!({
                "success": true,
                "points": remote.unwrap_or_else(|_| official_points_snapshot(&store.settings))
            }))
        }),
        "redbox-auth:models" => with_store_mut(state, |store| {
            let mut models = official_settings_models(&store.settings);
            if models.is_empty() {
                if let Ok(remote) =
                    run_official_json_request(&store.settings, "GET", "/models", None)
                {
                    models = official_response_items(&remote);
                }
            }
            let mut settings = store.settings.clone();
            write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
            if !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models);
            }
            store.settings = settings;
            Ok(json!({ "success": true, "models": models }))
        }),
        "redbox-auth:api-keys:list" => with_store(state, |store| {
            Ok(json!({
                "success": true,
                "keys": official_settings_api_keys(&store.settings)
            }))
        }),
        "redbox-auth:api-keys:create" => with_store_mut(state, |store| {
            let name = payload_string(&payload, "name").unwrap_or_else(|| "默认 Key".to_string());
            let mut settings = store.settings.clone();
            let mut keys = official_settings_api_keys(&settings);
            let key_value = format!("rbx_{}", make_id("key"));
            let item = json!({
                "id": make_id("api-key"),
                "name": name,
                "apiKey": key_value,
                "createdAt": now_iso(),
                "isCurrent": keys.is_empty(),
            });
            if keys.is_empty() {
                if let Some(session) = official_settings_session(&settings).map(|mut session| {
                    if let Some(object) = session.as_object_mut() {
                        object.insert("apiKey".to_string(), json!(key_value));
                    }
                    session
                }) {
                    upsert_official_settings_session(&mut settings, Some(&session));
                }
            }
            keys.insert(0, item.clone());
            write_settings_json_array(&mut settings, "redbox_auth_api_keys_json", &keys);
            store.settings = settings;
            Ok(json!({ "success": true, "data": item }))
        }),
        "redbox-auth:api-keys:set-current" => {
            let api_key = payload_string(&payload, "apiKey").unwrap_or_default();
            if api_key.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少 API Key" }));
            }
            let response = with_store_mut(state, |store| {
                let mut settings = store.settings.clone();
                let mut keys = official_settings_api_keys(&settings);
                for item in &mut keys {
                    let is_match = payload_string(item, "apiKey")
                        .map(|value| value == api_key)
                        .unwrap_or(false);
                    if let Some(object) = item.as_object_mut() {
                        object.insert("isCurrent".to_string(), json!(is_match));
                    }
                }
                write_settings_json_array(&mut settings, "redbox_auth_api_keys_json", &keys);
                let session = official_settings_session(&settings).map(|mut session| {
                    if let Some(object) = session.as_object_mut() {
                        object.insert("apiKey".to_string(), json!(api_key));
                        object.insert("updatedAt".to_string(), json!(now_ms() as i64));
                    }
                    session
                });
                let models = fetch_official_models_for_settings(&settings);
                write_settings_json_array(&mut settings, "redbox_official_models_json", &models);
                if let Some(ref session_value) = session {
                    upsert_official_settings_session(&mut settings, Some(session_value));
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                }
                store.settings = settings;
                Ok(json!({ "success": true, "session": session, "routeSynced": session.is_some() }))
            })?;
            emit_redbox_auth_session_updated(
                app,
                response
                    .get("session")
                    .cloned()
                    .filter(|value| !value.is_null()),
            );
            Ok(response)
        }
        "redbox-auth:products" => with_store(state, |store| {
            let remote =
                run_official_json_request(&store.settings, "GET", "/payments/products", None)
                    .or_else(|_| {
                        run_official_json_request(&store.settings, "GET", "/billing/products", None)
                    })
                    .or_else(|_| {
                        run_official_json_request(&store.settings, "GET", "/products", None)
                    })
                    .ok();
            let products = remote
                .as_ref()
                .map(official_response_items)
                .filter(|items| !items.is_empty())
                .unwrap_or_else(official_fallback_products);
            Ok(json!({ "success": true, "products": products }))
        }),
        "redbox-auth:call-records" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            let remote = run_official_json_request(&settings, "GET", "/billing/calls", None)
                .or_else(|_| run_official_json_request(&settings, "GET", "/usage/records", None))
                .or_else(|_| run_official_json_request(&settings, "GET", "/calls", None))
                .ok();
            let records = remote
                .as_ref()
                .map(official_response_items)
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| official_settings_call_records_list(&settings));
            write_settings_json_array(&mut settings, "redbox_auth_call_records_json", &records);
            store.settings = settings;
            Ok(json!({ "success": true, "records": records }))
        }),
        "redbox-auth:create-page-pay-order" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            let amount = payload_field(&payload, "amount")
                .and_then(|value| value.as_f64())
                .unwrap_or(9.9);
            let subject = payload_string(&payload, "subject")
                .unwrap_or_else(|| format!("积分充值 ¥{amount:.2}"));
            let order = run_official_json_request(
                &settings,
                "POST",
                "/payments/orders/page-pay",
                Some(json!({
                    "product_id": payload_string(&payload, "productId").filter(|value| !value.trim().is_empty()),
                    "amount": amount,
                    "subject": subject,
                    "points_to_deduct": payload_field(&payload, "pointsToDeduct").and_then(|value| value.as_i64()).unwrap_or(0),
                })),
            )
            .map(|response| official_unwrap_response_payload(&response))
            .unwrap_or_else(|_| {
                let out_trade_no = make_id("order");
                let payment_form = create_official_payment_form(&out_trade_no, amount, &subject);
                json!({
                    "id": out_trade_no,
                    "out_trade_no": out_trade_no,
                    "outTradeNo": out_trade_no,
                    "status": "PENDING",
                    "trade_status": "PENDING",
                    "amount": amount,
                    "subject": subject,
                    "payment_form": payment_form,
                    "created_at": now_iso(),
                })
            });
            let mut orders = official_settings_orders(&settings);
            orders.insert(0, order.clone());
            write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
            store.settings = settings;
            Ok(json!({ "success": true, "order": order }))
        }),
        "redbox-auth:create-wechat-native-order" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            let amount = payload_field(&payload, "amount")
                .and_then(|value| value.as_f64())
                .unwrap_or(9.9);
            let out_trade_no = make_id("wxpay");
            let order = json!({
                "id": out_trade_no,
                "out_trade_no": out_trade_no,
                "outTradeNo": out_trade_no,
                "status": "PENDING",
                "trade_status": "PENDING",
                "amount": amount,
                "code_url": format!("weixin://wxpay/bizpayurl?pr={}", out_trade_no),
                "created_at": now_iso(),
            });
            let mut orders = official_settings_orders(&settings);
            orders.insert(0, order.clone());
            write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
            store.settings = settings;
            Ok(json!({ "success": true, "order": order }))
        }),
        "redbox-auth:order-status" => with_store(state, |store| {
            let out_trade_no = payload_string(&payload, "outTradeNo").unwrap_or_default();
            let order = official_settings_orders(&store.settings)
                .into_iter()
                .find(|item| {
                    payload_string(item, "out_trade_no")
                        .or_else(|| payload_string(item, "outTradeNo"))
                        .map(|value| value == out_trade_no)
                        .unwrap_or(false)
                })
                .unwrap_or_else(|| {
                    json!({
                        "out_trade_no": out_trade_no,
                        "outTradeNo": out_trade_no,
                        "status": "PENDING",
                        "trade_status": "PENDING",
                    })
                });
            Ok(json!({ "success": true, "order": order }))
        }),
        "redbox-auth:open-payment-form" => {
            let payment_form = payload_string(&payload, "paymentForm").unwrap_or_default();
            match open_payment_form(&payment_form) {
                Ok(opened) => Ok(json!({ "success": true, "opened": opened })),
                Err(error) => Ok(json!({ "success": false, "error": error })),
            }
        }
        "db:get-settings" => with_store(state, |store| Ok(store.settings.clone())),
        "db:save-settings" => {
            with_store_mut(state, |store| {
                store.settings = payload.clone();
                Ok(())
            })?;
            let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
            Ok(json!({ "success": true }))
        }
        "official:auth:get-session" => with_store(state, |store| {
            let session = official_settings_session(&store.settings);
            Ok(json!({ "success": true, "session": session }))
        }),
        "official:auth:set-session" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            let session = payload_field(&payload, "session")
                .cloned()
                .unwrap_or(payload.clone());
            if let Some(object) = settings.as_object_mut() {
                object.insert(
                    "redbox_auth_session_json".to_string(),
                    json!(serde_json::to_string(&session).unwrap_or_else(|_| "{}".to_string())),
                );
            }
            let models = official_settings_models(&settings);
            if !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models);
            }
            store.settings = settings;
            Ok(json!({ "success": true, "session": session }))
        }),
        "official:auth:clear-session" => with_store_mut(state, |store| {
            let mut settings = store.settings.clone();
            if let Some(object) = settings.as_object_mut() {
                object.insert("redbox_auth_session_json".to_string(), json!(""));
            }
            store.settings = settings;
            Ok(json!({ "success": true }))
        }),
        "official:models:list" => with_store_mut(state, |store| {
            let mut models = official_settings_models(&store.settings);
            if models.is_empty() {
                if let Ok(remote) =
                    run_official_json_request(&store.settings, "GET", "/models", None)
                {
                    models = official_response_items(&remote);
                }
            }
            let mut settings = store.settings.clone();
            if let Some(object) = settings.as_object_mut() {
                object.insert(
                    "redbox_official_models_json".to_string(),
                    json!(serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())),
                );
            }
            if !models.is_empty() {
                official_sync_source_into_settings(&mut settings, &models);
            }
            store.settings = settings;
            Ok(json!({ "success": true, "models": models }))
        }),
        "official:account:summary" => with_store(state, |store| {
            let models = official_settings_models(&store.settings);
            let remote = run_official_json_request(&store.settings, "GET", "/account", None)
                .or_else(|_| run_official_json_request(&store.settings, "GET", "/me", None))
                .ok();
            Ok(json!({
                "success": true,
                "summary": remote.unwrap_or_else(|| official_account_summary_local(&store.settings, &models))
            }))
        }),
        "official:billing:products" => with_store(state, |store| {
            let remote =
                run_official_json_request(&store.settings, "GET", "/billing/products", None)
                    .or_else(|_| {
                        run_official_json_request(&store.settings, "GET", "/products", None)
                    })
                    .ok();
            let products = remote
                .as_ref()
                .map(official_response_items)
                .filter(|items| !items.is_empty())
                .unwrap_or_else(official_fallback_products);
            Ok(json!({ "success": true, "products": products }))
        }),
        "official:billing:list-orders" => with_store(state, |store| {
            let remote = run_official_json_request(&store.settings, "GET", "/billing/orders", None)
                .or_else(|_| run_official_json_request(&store.settings, "GET", "/orders", None))
                .ok();
            let orders = remote
                .as_ref()
                .map(official_response_items)
                .unwrap_or_default();
            Ok(json!({ "success": true, "orders": orders }))
        }),
        "official:billing:create-order" => with_store(state, |store| {
            let product_id = payload_string(&payload, "productId").unwrap_or_default();
            let amount = payload_field(&payload, "amount").and_then(|value| value.as_f64());
            let body = json!({
                "product_id": product_id,
                "productId": payload_string(&payload, "productId"),
                "amount": amount,
                "currency": payload_string(&payload, "currency").unwrap_or_else(|| "CNY".to_string()),
            });
            let order = run_official_json_request(
                &store.settings,
                "POST",
                "/billing/orders",
                Some(body.clone()),
            )
            .or_else(|_| run_official_json_request(&store.settings, "POST", "/orders", Some(body)))
            .unwrap_or_else(|_| {
                json!({
                    "id": make_id("official-order"),
                    "status": "PENDING",
                    "trade_status": "PENDING",
                    "payment_url": REDBOX_OFFICIAL_BASE_URL,
                    "amount": amount.unwrap_or(0.0),
                    "product_id": product_id,
                    "created_at": now_iso(),
                })
            });
            Ok(json!({ "success": true, "order": order }))
        }),
        "official:billing:list-calls" => with_store(state, |store| {
            let remote = run_official_json_request(&store.settings, "GET", "/billing/calls", None)
                .or_else(|_| {
                    run_official_json_request(&store.settings, "GET", "/usage/records", None)
                })
                .or_else(|_| run_official_json_request(&store.settings, "GET", "/calls", None))
                .ok();
            let records = remote
                .as_ref()
                .map(official_response_items)
                .unwrap_or_default();
            Ok(json!({ "success": true, "records": records }))
        }),
        "debug:get-status" => Ok(json!({
            "enabled": true,
            "logDirectory": store_root(state)?.display().to_string(),
        })),
        "debug:get-recent" => {
            let limit = payload_field(&payload, "limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(50)
                .clamp(1, 200) as usize;
            with_store(state, |store| {
                let mut lines = store.debug_logs.clone();
                if lines.is_empty() {
                    lines.push(format!("{} | RedBox Rust host is active.", now_iso()));
                }
                lines.truncate(limit);
                Ok(json!({ "lines": lines }))
            })
        }
        "debug:open-log-dir" => {
            let path = store_root(state)?;
            open::that(&path).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": path.display().to_string() }))
        }
        "clipboard:read-text" => Ok(json!(Clipboard::new()
            .and_then(|mut clipboard| clipboard.get_text())
            .unwrap_or_default())),
        "clipboard:write-html" => {
            let text = payload_string(&payload, "text")
                .or_else(|| payload_string(&payload, "html"))
                .unwrap_or_default();
            Clipboard::new()
                .and_then(|mut clipboard| clipboard.set_text(text.clone()))
                .map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "text": text }))
        }
        "wechat-official:get-status" => with_store(state, |store| {
            let bindings = store
                .wechat_official_bindings
                .iter()
                .map(wechat_binding_public_value)
                .collect::<Vec<_>>();
            let active_binding = store
                .wechat_official_bindings
                .iter()
                .find(|item| item.is_active)
                .map(wechat_binding_public_value);
            Ok(json!({
                "success": true,
                "bindings": bindings,
                "activeBinding": active_binding
            }))
        }),
        "wechat-official:bind" => {
            let app_id = payload_string(&payload, "appId").unwrap_or_default();
            let secret = payload_string(&payload, "secret").unwrap_or_default();
            if app_id.trim().is_empty() || secret.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少 AppID 或 Secret" }));
            }
            let name = payload_string(&payload, "name").unwrap_or_else(|| {
                format!("微信公众号 {}", app_id.chars().take(6).collect::<String>())
            });
            let set_active = payload_field(&payload, "setActive")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            let verified_at = fetch_wechat_access_token(&app_id, &secret)
                .map(|_| now_iso())
                .ok();
            let binding = with_store_mut(state, |store| {
                if set_active {
                    for item in &mut store.wechat_official_bindings {
                        item.is_active = false;
                    }
                }
                if let Some(existing) = store
                    .wechat_official_bindings
                    .iter_mut()
                    .find(|item| item.app_id == app_id)
                {
                    existing.name = name.clone();
                    existing.secret = Some(secret.clone());
                    existing.updated_at = now_iso();
                    existing.verified_at = verified_at.clone();
                    existing.is_active = set_active || existing.is_active;
                    return Ok(existing.clone());
                }
                let timestamp = now_iso();
                let binding = WechatOfficialBindingRecord {
                    id: make_id("wechat-binding"),
                    name,
                    app_id,
                    secret: Some(secret),
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    verified_at: verified_at.or(Some(timestamp)),
                    is_active: set_active || store.wechat_official_bindings.is_empty(),
                };
                store.wechat_official_bindings.push(binding.clone());
                Ok(binding)
            })?;
            Ok(json!({ "success": true, "binding": wechat_binding_public_value(&binding) }))
        }
        "wechat-official:unbind" => {
            let binding_id = payload_string(&payload, "bindingId");
            with_store_mut(state, |store| {
                if let Some(binding_id) = binding_id {
                    store
                        .wechat_official_bindings
                        .retain(|item| item.id != binding_id);
                } else {
                    store.wechat_official_bindings.clear();
                }
                if !store
                    .wechat_official_bindings
                    .iter()
                    .any(|item| item.is_active)
                {
                    if let Some(first) = store.wechat_official_bindings.first_mut() {
                        first.is_active = true;
                    }
                }
                Ok(json!({ "success": true }))
            })
        }
        "wechat-official:create-draft" => {
            let content = payload_string(&payload, "content").unwrap_or_default();
            if content.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "稿件内容为空" }));
            }
            let binding_id = payload_string(&payload, "bindingId");
            let title = payload_string(&payload, "title").unwrap_or_else(|| "Untitled".to_string());
            let binding = with_store(state, |store| {
                Ok(binding_id
                    .as_deref()
                    .and_then(|id| {
                        store
                            .wechat_official_bindings
                            .iter()
                            .find(|item| item.id == id)
                    })
                    .or_else(|| {
                        store
                            .wechat_official_bindings
                            .iter()
                            .find(|item| item.is_active)
                    })
                    .cloned())
            })?;
            let Some(binding) = binding else {
                return Ok(json!({ "success": false, "error": "请先绑定公众号" }));
            };
            let digest = content.chars().take(120).collect::<String>();
            let thumb_media_id = payload_string(&payload, "thumbMediaId")
                .or_else(|| payload_string(&payload, "coverMediaId"))
                .or_else(|| {
                    payload_field(&payload, "metadata")
                        .and_then(|metadata| payload_string(metadata, "thumbMediaId"))
                })
                .or_else(|| {
                    payload_field(&payload, "metadata")
                        .and_then(|metadata| payload_string(metadata, "coverMediaId"))
                });
            let access_token = binding
                .secret
                .as_deref()
                .and_then(|secret| fetch_wechat_access_token(&binding.app_id, secret).ok());
            let mut resolved_thumb_media_id = thumb_media_id.clone();
            if resolved_thumb_media_id.is_none() {
                if let (Some(token), Some(cover_source)) =
                    (access_token.as_deref(), extract_cover_source(&payload))
                {
                    let cover_dir = wechat_drafts_dir(state)?.join("covers");
                    if let Ok(cover_path) = materialize_image_source(&cover_source, &cover_dir) {
                        resolved_thumb_media_id =
                            upload_wechat_thumb_media(token, &cover_path).ok();
                    }
                }
            }
            let remote_media_id = access_token.as_deref().and_then(|token| {
                resolved_thumb_media_id.as_deref().and_then(|thumb| {
                    create_wechat_remote_draft(&token, &title, &content, &digest, thumb).ok()
                })
            });
            let media_id = remote_media_id.unwrap_or_else(|| make_id("wechat-draft"));
            let draft_path = wechat_drafts_dir(state)?.join(format!(
                "{}-{}.md",
                slug_from_relative_path(&binding.name),
                slug_from_relative_path(&media_id)
            ));
            let body = format!(
                "# {}\n\n> Binding: {} ({})\n> Source: {}\n> Created: {}\n\n{}",
                title,
                binding.name,
                binding.app_id,
                payload_string(&payload, "sourcePath").unwrap_or_default(),
                now_iso(),
                content
            );
            write_text_file(&draft_path, &body)?;
            Ok(json!({
                "success": true,
                "title": title,
                "digest": digest,
                "mediaId": media_id,
                "path": draft_path.display().to_string(),
                "remote": resolved_thumb_media_id.is_some()
            }))
        }
        "plugin:browser-extension-status" => {
            let bundled_path = browser_plugin_bundled_root();
            let export_path = browser_plugin_export_root(state)?;
            let bundled = bundled_path.join("manifest.json").exists();
            let exported = export_path.join("manifest.json").exists();
            Ok(json!({
                "success": true,
                "bundled": bundled,
                "exported": exported,
                "exportPath": export_path.display().to_string(),
                "bundledPath": bundled_path.display().to_string(),
                "error": if bundled { Value::Null } else { json!("Plugin/manifest.json not found") }
            }))
        }
        "plugin:prepare-browser-extension" => {
            let bundled_path = browser_plugin_bundled_root();
            if !bundled_path.join("manifest.json").exists() {
                return Ok(json!({ "success": false, "error": "未找到仓库内置浏览器插件资源。" }));
            }
            let export_path = browser_plugin_export_root(state)?;
            if !export_path.join("manifest.json").exists() {
                copy_dir_recursive(&bundled_path, &export_path)?;
            }
            Ok(json!({
                "success": true,
                "path": export_path.display().to_string(),
                "alreadyPrepared": export_path.join("manifest.json").exists()
            }))
        }
        "plugin:open-browser-extension-dir" => {
            let export_path = browser_plugin_export_root(state)?;
            if !export_path.join("manifest.json").exists() {
                let bundled_path = browser_plugin_bundled_root();
                if bundled_path.join("manifest.json").exists() {
                    copy_dir_recursive(&bundled_path, &export_path)?;
                }
            }
            open::that(&export_path).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": export_path.display().to_string() }))
        }
        "spaces:list" => with_store(state, |store| {
            Ok(json!({
                "spaces": store.spaces.clone(),
                "activeSpaceId": store.active_space_id,
            }))
        }),
        "spaces:create" => {
            let name = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "name"))
                .unwrap_or_default();
            if name.is_empty() {
                return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
            }

            let result = with_store_mut(state, |store| {
                let timestamp = now_iso();
                let space = SpaceRecord {
                    id: make_id("space"),
                    name,
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                };
                store.active_space_id = space.id.clone();
                store.spaces.push(space.clone());
                Ok(
                    json!({ "success": true, "space": space, "activeSpaceId": store.active_space_id }),
                )
            })?;

            let _ = with_store_mut(state, |store| {
                hydrate_store_from_workspace_files(store, &state.store_path)?;
                Ok(())
            });

            if let Some(active_space_id) =
                result.get("activeSpaceId").and_then(|value| value.as_str())
            {
                let root = with_store(state, |store| {
                    active_space_workspace_root_from_store(
                        &store,
                        active_space_id,
                        &state.store_path,
                    )
                })?;
                ensure_workspace_dirs(&root)?;
                emit_space_changed(app, active_space_id);
            }

            Ok(result)
        }
        "spaces:rename" => {
            let Some(id) = payload_string(&payload, "id") else {
                return Ok(json!({ "success": false, "error": "缺少空间 id" }));
            };
            let Some(name) = payload_string(&payload, "name") else {
                return Ok(json!({ "success": false, "error": "空间名称不能为空" }));
            };
            with_store_mut(state, |store| {
                let Some(space) = store.spaces.iter_mut().find(|item| item.id == id) else {
                    return Ok(json!({ "success": false, "error": "空间不存在" }));
                };
                space.name = name;
                space.updated_at = now_iso();
                Ok(json!({ "success": true, "space": space.clone() }))
            })
        }
        "spaces:switch" => {
            let next_id =
                payload_value_as_string(&payload).or_else(|| payload_string(&payload, "spaceId"));
            let Some(space_id) = next_id else {
                return Ok(json!({ "success": false, "error": "缺少空间 id" }));
            };
            let result = with_store_mut(state, |store| {
                if !store.spaces.iter().any(|item| item.id == space_id) {
                    return Ok(json!({ "success": false, "error": "空间不存在" }));
                }
                store.active_space_id = space_id.clone();
                Ok(json!({ "success": true, "activeSpaceId": store.active_space_id }))
            })?;

            let _ = with_store_mut(state, |store| {
                hydrate_store_from_workspace_files(store, &state.store_path)?;
                Ok(())
            });

            if let Some(active_space_id) =
                result.get("activeSpaceId").and_then(|value| value.as_str())
            {
                let root = with_store(state, |store| {
                    active_space_workspace_root_from_store(
                        &store,
                        active_space_id,
                        &state.store_path,
                    )
                })?;
                ensure_workspace_dirs(&root)?;
                emit_space_changed(app, active_space_id);
            }

            Ok(result)
        }
        "indexing:get-stats" => Ok(default_indexing_stats()),
        "indexing:clear-queue"
        | "indexing:remove-item"
        | "indexing:rebuild-all"
        | "indexing:rebuild-advisor" => Ok(json!({ "success": true })),
        "embedding:compute" => {
            let text = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "text"))
                .unwrap_or_default();
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let embedding = compute_embedding_with_settings(&settings_snapshot, &text);
            Ok(json!({ "success": true, "embedding": embedding }))
        }
        "embedding:get-manuscript-cache" => {
            let file_path = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "filePath"))
                .unwrap_or_default();
            with_store(state, |store| {
                let cached = store
                    .embedding_cache
                    .iter()
                    .find(|item| item.file_path == file_path)
                    .cloned();
                Ok(json!({ "success": true, "cached": cached }))
            })
        }
        "embedding:save-manuscript-cache" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let content_hash = payload_string(&payload, "contentHash").unwrap_or_default();
            let embedding = payload_field(&payload, "embedding")
                .and_then(|item| item.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_f64())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            with_store_mut(state, |store| {
                if let Some(existing) = store
                    .embedding_cache
                    .iter_mut()
                    .find(|item| item.file_path == file_path)
                {
                    existing.content_hash = content_hash.clone();
                    existing.embedding = embedding.clone();
                    existing.updated_at = now_iso();
                } else {
                    store.embedding_cache.push(EmbeddingCacheRecord {
                        file_path,
                        content_hash,
                        embedding,
                        updated_at: now_iso(),
                    });
                }
                Ok(json!({ "success": true }))
            })
        }
        "embedding:get-sorted-sources" => {
            let input_embedding = payload
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_f64())
                        .collect::<Vec<_>>()
                })
                .or_else(|| {
                    payload_field(&payload, "embedding").and_then(|item| {
                        item.as_array().map(|items| {
                            items
                                .iter()
                                .filter_map(|value| value.as_f64())
                                .collect::<Vec<_>>()
                        })
                    })
                })
                .unwrap_or_default();
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            with_store(state, |store| {
                let mut sorted = knowledge_source_texts(&store)
                    .into_iter()
                    .map(|(source_id, text, meta)| {
                        let embedding = compute_embedding_with_settings(&settings_snapshot, &text);
                        let score = cosine_similarity(&input_embedding, &embedding);
                        json!({ "sourceId": source_id, "score": score, "meta": meta })
                    })
                    .collect::<Vec<_>>();
                sorted.sort_by(|a, b| {
                    let left = a.get("score").and_then(|item| item.as_f64()).unwrap_or(0.0);
                    let right = b.get("score").and_then(|item| item.as_f64()).unwrap_or(0.0);
                    right
                        .partial_cmp(&left)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                Ok(json!({ "success": true, "sorted": sorted }))
            })
        }
        "similarity:get-knowledge-version" => {
            with_store(state, |store| Ok(json!(knowledge_version(&store))))
        }
        "similarity:get-cache" => {
            let manuscript_id = payload_value_as_string(&payload)
                .or_else(|| payload_string(&payload, "manuscriptId"))
                .unwrap_or_default();
            with_store(state, |store| {
                let cache = store
                    .similarity_cache
                    .iter()
                    .find(|item| item.manuscript_id == manuscript_id)
                    .cloned();
                Ok(json!({
                    "success": true,
                    "cache": cache,
                    "currentKnowledgeVersion": knowledge_version(&store)
                }))
            })
        }
        "similarity:save-cache" => {
            let manuscript_id = payload_string(&payload, "manuscriptId").unwrap_or_default();
            let content_hash = payload_string(&payload, "contentHash").unwrap_or_default();
            let knowledge_version_value =
                payload_string(&payload, "knowledgeVersion").unwrap_or_default();
            let sorted_ids = payload_field(&payload, "sortedIds")
                .and_then(|item| item.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            with_store_mut(state, |store| {
                if let Some(existing) = store
                    .similarity_cache
                    .iter_mut()
                    .find(|item| item.manuscript_id == manuscript_id)
                {
                    existing.content_hash = content_hash.clone();
                    existing.knowledge_version = knowledge_version_value.clone();
                    existing.sorted_ids = sorted_ids.clone();
                    existing.updated_at = now_iso();
                } else {
                    store.similarity_cache.push(SimilarityCacheRecord {
                        manuscript_id,
                        content_hash,
                        knowledge_version: knowledge_version_value,
                        sorted_ids,
                        updated_at: now_iso(),
                    });
                }
                Ok(json!({ "success": true }))
            })
        }
        "subjects:list" => {
            let _ = ensure_store_hydrated_for_subjects(state);
            with_store(state, |store| {
                Ok(json!({ "success": true, "subjects": store.subjects.clone() }))
            })
        }
        "subjects:get" => {
            let Some(id) = payload_string(&payload, "id") else {
                return Ok(json!({ "success": false, "error": "缺少主体 id" }));
            };
            with_store(state, |store| {
                let subject = store.subjects.iter().find(|item| item.id == id).cloned();
                Ok(json!({ "success": true, "subject": subject }))
            })
        }
        "subjects:create" => handle_subject_create(payload, state),
        "subjects:update" => handle_subject_update(payload, state),
        "subjects:delete" => handle_subject_delete(payload, state),
        "subjects:search" => {
            let query = payload_string(&payload, "query")
                .unwrap_or_default()
                .to_lowercase();
            let category_id = payload_string(&payload, "categoryId");
            with_store(state, |store| {
                let subjects: Vec<SubjectRecord> = store
                    .subjects
                    .iter()
                    .filter(|subject| {
                        let matches_category = match category_id.as_deref() {
                            Some(category) => subject.category_id.as_deref() == Some(category),
                            None => true,
                        };
                        let matches_query = if query.is_empty() {
                            true
                        } else {
                            let haystack = format!(
                                "{}\n{}\n{}",
                                subject.name,
                                subject.description.clone().unwrap_or_default(),
                                subject.tags.join(" ")
                            )
                            .to_lowercase();
                            haystack.contains(&query)
                        };
                        matches_category && matches_query
                    })
                    .cloned()
                    .collect();
                Ok(json!({ "success": true, "subjects": subjects }))
            })
        }
        "subjects:categories:list" => with_store(state, |store| {
            Ok(json!({ "success": true, "categories": store.categories.clone() }))
        }),
        "subjects:categories:create" => handle_subject_category_create(payload, state),
        "subjects:categories:update" => handle_subject_category_update(payload, state),
        "subjects:categories:delete" => handle_subject_category_delete(payload, state),
        "manuscripts:list" => {
            let root = manuscripts_root(state)?;
            Ok(
                serde_json::to_value(list_tree(&root, &root)?)
                    .map_err(|error| error.to_string())?,
            )
        }
        "manuscripts:read" => {
            let relative = payload_value_as_string(&payload).unwrap_or_default();
            let path = resolve_manuscript_path(state, &relative)?;
            if path.is_dir()
                && is_manuscript_package_name(
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(""),
                )
            {
                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                let manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                let content =
                    fs::read_to_string(package_entry_path(&path, file_name, Some(&manifest)))
                        .unwrap_or_default();
                return Ok(json!({
                    "content": content,
                    "metadata": manifest
                }));
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            Ok(json!({
                "content": content,
                "metadata": {
                    "id": slug_from_relative_path(&relative),
                    "title": title_from_relative_path(&relative),
                    "draftType": get_draft_type_from_file_name(&relative),
                }
            }))
        }
        "manuscripts:save" => {
            let target = payload_string(&payload, "path").unwrap_or_default();
            let content = payload_string(&payload, "content").unwrap_or_default();
            let path = resolve_manuscript_path(state, &target)?;
            if path.is_dir()
                && is_manuscript_package_name(
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(""),
                )
            {
                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                let mut manifest = read_json_value_or(&package_manifest_path(&path), json!({}));
                if let Some(object) = manifest.as_object_mut() {
                    if let Some(metadata) =
                        payload_field(&payload, "metadata").and_then(Value::as_object)
                    {
                        for (key, value) in metadata {
                            object.insert(key.clone(), value.clone());
                        }
                    }
                    object.insert("updatedAt".to_string(), json!(now_i64()));
                    object
                        .entry("title".to_string())
                        .or_insert(json!(title_from_relative_path(file_name)));
                    object
                        .entry("entry".to_string())
                        .or_insert(json!(get_default_package_entry(file_name)));
                    object
                        .entry("draftType".to_string())
                        .or_insert(json!(get_draft_type_from_file_name(file_name)));
                    object
                        .entry("packageKind".to_string())
                        .or_insert(json!(get_package_kind_from_file_name(file_name)));
                }
                write_json_value(&package_manifest_path(&path), &manifest)?;
                write_text_file(
                    &package_entry_path(&path, file_name, Some(&manifest)),
                    &content,
                )?;
                return Ok(json!({ "success": true }));
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, content).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true }))
        }
        "manuscripts:create-folder" => {
            let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
            let name = payload_string(&payload, "name").unwrap_or_else(|| "New Folder".to_string());
            let relative = join_relative(&parent_path, &name);
            let path = resolve_manuscript_path(state, &relative)?;
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
        }
        "manuscripts:create-file" => {
            let parent_path = payload_string(&payload, "parentPath").unwrap_or_default();
            let name =
                payload_string(&payload, "name").unwrap_or_else(|| "Untitled.md".to_string());
            let content = payload_string(&payload, "content").unwrap_or_default();
            let fallback_extension = if is_manuscript_package_name(&name) {
                ""
            } else {
                ".md"
            };
            let relative = normalize_relative_path(&join_relative(
                &parent_path,
                &ensure_manuscript_file_name(&name, fallback_extension),
            ));
            let path = resolve_manuscript_path(state, &relative)?;
            if is_manuscript_package_name(&relative) {
                let title = payload_string(&payload, "title")
                    .unwrap_or_else(|| title_from_relative_path(&relative));
                create_manuscript_package(&path, &content, &relative, &title)?;
            } else {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&path, content).map_err(|error| error.to_string())?;
            }
            Ok(json!({ "success": true, "path": normalize_relative_path(&relative) }))
        }
        "manuscripts:upgrade-to-package" => {
            let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
            let target_kind =
                payload_string(&payload, "targetKind").unwrap_or_else(|| "article".to_string());
            let target_extension = if target_kind == "post" {
                POST_DRAFT_EXTENSION
            } else {
                ARTICLE_DRAFT_EXTENSION
            };
            let new_path =
                upgrade_markdown_manuscript_to_package(state, &source_path, target_extension)?;
            Ok(json!({ "success": true, "newPath": new_path }))
        }
        "manuscripts:delete" => {
            let relative = payload_value_as_string(&payload).unwrap_or_default();
            let path = resolve_manuscript_path(state, &relative)?;
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
            } else if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            Ok(json!({ "success": true }))
        }
        "manuscripts:rename" => {
            let old_path = payload_string(&payload, "oldPath").unwrap_or_default();
            let new_name = payload_string(&payload, "newName").unwrap_or_default();
            if new_name.is_empty() {
                return Ok(json!({ "success": false, "error": "缺少新名称" }));
            }
            let source = resolve_manuscript_path(state, &old_path)?;
            let parent_rel = normalize_relative_path(
                old_path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent)
                    .unwrap_or(""),
            );
            let mut target_relative = join_relative(&parent_rel, &new_name);
            if source.is_file() && !target_relative.contains('.') {
                target_relative = ensure_markdown_extension(&target_relative);
            } else {
                target_relative = normalize_relative_path(&target_relative);
            }
            let target = resolve_manuscript_path(state, &target_relative)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "newPath": target_relative }))
        }
        "manuscripts:move" => {
            let source_path = payload_string(&payload, "sourcePath").unwrap_or_default();
            let target_dir = payload_string(&payload, "targetDir").unwrap_or_default();
            let source = resolve_manuscript_path(state, &source_path)?;
            let file_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Invalid manuscript source".to_string())?;
            let target_relative = normalize_relative_path(&join_relative(&target_dir, file_name));
            let target = resolve_manuscript_path(state, &target_relative)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "newPath": target_relative }))
        }
        "manuscripts:get-package-state" => {
            let file_path = payload_value_as_string(&payload).unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir()
                || !is_manuscript_package_name(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(""),
                )
            {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:add-package-track" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let kind = payload_string(&payload, "kind").unwrap_or_else(|| "video".to_string());
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let prefix = if kind == "audio" { "A" } else { "V" };
            let kind_label = if kind == "audio" { "Audio" } else { "Video" };
            let existing_indexes = timeline
                .pointer("/tracks/children")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|track| {
                    track
                        .get("name")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .filter(|name| name.starts_with(prefix))
                .filter_map(|name| name[1..].parse::<i64>().ok())
                .collect::<Vec<_>>();
            let next_index = existing_indexes.into_iter().max().unwrap_or(0) + 1;
            let _ =
                ensure_timeline_track(&mut timeline, &format!("{prefix}{next_index}"), kind_label);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:add-package-clip" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            if file_path.is_empty() || asset_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and assetId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let asset = with_store(state, |store| {
                Ok(store
                    .media_assets
                    .iter()
                    .find(|item| item.id == asset_id)
                    .cloned())
            })?;
            let Some(asset) = asset else {
                return Ok(json!({ "success": false, "error": "Media asset not found" }));
            };
            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let preferred_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                if asset
                    .mime_type
                    .clone()
                    .unwrap_or_default()
                    .starts_with("audio/")
                {
                    "A1".to_string()
                } else {
                    "V1".to_string()
                }
            });
            let kind_label = if preferred_track_name.starts_with('A') {
                "Audio"
            } else {
                "Video"
            };
            let target_track =
                ensure_timeline_track(&mut timeline, &preferred_track_name, kind_label);
            let target_children = target_track
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline track children missing".to_string())?;
            let desired_order = payload_field(&payload, "order")
                .and_then(|value| value.as_i64())
                .unwrap_or(target_children.len() as i64)
                .clamp(0, target_children.len() as i64) as usize;
            let asset_kind = if asset
                .mime_type
                .clone()
                .unwrap_or_default()
                .starts_with("audio/")
            {
                "audio"
            } else if asset
                .mime_type
                .clone()
                .unwrap_or_default()
                .starts_with("video/")
            {
                "video"
            } else {
                "image"
            };
            let clip = json!({
                "OTIO_SCHEMA": "Clip.2",
                "name": asset.title.clone().unwrap_or_else(|| asset.id.clone()),
                "source_range": Value::Null,
                "media_references": {
                    "DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "target_url": asset.absolute_path.clone().or(asset.relative_path.clone()).unwrap_or_default(),
                        "available_range": Value::Null,
                        "metadata": {
                            "assetId": asset.id,
                            "mimeType": asset.mime_type
                        }
                    }
                },
                "active_media_reference_key": "DEFAULT_MEDIA",
                "metadata": {
                    "clipId": create_timeline_clip_id(),
                    "assetId": asset.id,
                    "assetKind": asset_kind,
                    "source": "media-library",
                    "order": desired_order,
                    "durationMs": payload_field(&payload, "durationMs").cloned().unwrap_or(json!(Value::Null)),
                    "trimInMs": 0,
                    "trimOutMs": 0,
                    "enabled": true,
                    "addedAt": now_iso()
                }
            });
            target_children.insert(desired_order, clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:attach-external-files" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            if file_path.is_empty() {
                return Ok(json!({ "success": false, "error": "filePath is required" }));
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir()
                || !is_manuscript_package_name(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(""),
                )
            {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let picked = pick_files_native("选择要导入的素材文件", false, true)?;
            if picked.is_empty() {
                return Ok(json!({ "success": true, "canceled": true, "imported": [] }));
            }
            let imports_root = media_root(state)?.join("imports");
            fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
            let mut imported = Vec::<Value>::new();
            for file in picked {
                let (relative_name, target) = copy_file_into_dir(&file, &imports_root)?;
                let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                let asset = with_store_mut(state, |store| {
                    let asset = MediaAssetRecord {
                        id: make_id("media"),
                        source: "imported".to_string(),
                        project_id: None,
                        title: file
                            .file_name()
                            .and_then(|value| value.to_str())
                            .map(ToString::to_string),
                        prompt: None,
                        provider: None,
                        provider_template: None,
                        model: None,
                        aspect_ratio: None,
                        size: None,
                        quality: None,
                        mime_type: Some(mime_type.clone()),
                        relative_path: Some(format!("imports/{}", relative_name)),
                        bound_manuscript_path: Some(file_path.clone()),
                        created_at: now_iso(),
                        updated_at: now_iso(),
                        absolute_path: Some(target.display().to_string()),
                        preview_url: Some(file_url_for_path(&target)),
                        exists: true,
                    };
                    store.media_assets.push(asset.clone());
                    Ok(asset)
                })?;
                let track = if mime_type.starts_with("audio/") {
                    "A1"
                } else {
                    "V1"
                };
                let _ = handle_channel(
                    app,
                    "manuscripts:add-package-clip",
                    json!({
                        "filePath": file_path,
                        "assetId": asset.id,
                        "track": track,
                    }),
                    state,
                );
                imported.push(json!({
                    "absolutePath": target.display().to_string(),
                    "title": asset.title,
                    "mimeType": mime_type,
                    "assetId": asset.id,
                }));
            }
            Ok(json!({
                "success": true,
                "canceled": false,
                "imported": imported,
                "state": get_manuscript_package_state(&full_path)?,
            }))
        }
        "manuscripts:update-package-clip" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            if file_path.is_empty() || clip_id.is_empty() {
                return Ok(
                    json!({ "success": false, "error": "filePath and clipId are required" }),
                );
            }
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let tracks = timeline
                .pointer_mut("/tracks/children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline tracks missing".to_string())?;
            let mut clip_to_move: Option<Value> = None;
            let mut current_track_index = 0usize;
            for (track_index, track) in tracks.iter_mut().enumerate() {
                let track_name = track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
                    continue;
                };
                if let Some(index) = children
                    .iter()
                    .position(|clip| timeline_clip_identity(clip, &track_name, 0) == clip_id)
                {
                    clip_to_move = Some(children.remove(index));
                    current_track_index = track_index;
                    break;
                }
            }
            let Some(mut clip) = clip_to_move else {
                return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
            };
            let target_track_name = payload_string(&payload, "track").unwrap_or_else(|| {
                tracks[current_track_index]
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("V1")
                    .to_string()
            });
            let target_track = ensure_timeline_track(
                &mut timeline,
                &target_track_name,
                if target_track_name.starts_with('A') {
                    "Audio"
                } else {
                    "Video"
                },
            );
            let target_children = target_track
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline target children missing".to_string())?;
            let desired_order = payload_field(&payload, "order")
                .and_then(|value| value.as_i64())
                .unwrap_or(target_children.len() as i64)
                .clamp(0, target_children.len() as i64) as usize;
            if let Some(metadata) = clip.get_mut("metadata").and_then(Value::as_object_mut) {
                metadata.insert("clipId".to_string(), json!(clip_id));
                if let Some(duration_ms) = payload_field(&payload, "durationMs") {
                    metadata.insert("durationMs".to_string(), duration_ms.clone());
                }
                if let Some(trim_in_ms) = payload_field(&payload, "trimInMs") {
                    metadata.insert("trimInMs".to_string(), trim_in_ms.clone());
                }
                if let Some(trim_out_ms) = payload_field(&payload, "trimOutMs") {
                    metadata.insert("trimOutMs".to_string(), trim_out_ms.clone());
                }
                if let Some(enabled) = payload_field(&payload, "enabled") {
                    metadata.insert("enabled".to_string(), enabled.clone());
                }
            }
            target_children.insert(desired_order, clip);
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:delete-package-clip" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let tracks = timeline
                .pointer_mut("/tracks/children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline tracks missing".to_string())?;
            let mut removed = false;
            for track in tracks.iter_mut() {
                let track_name = track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) {
                    let before = children.len();
                    children.retain(|clip| timeline_clip_identity(clip, &track_name, 0) != clip_id);
                    if before != children.len() {
                        removed = true;
                    }
                }
            }
            if !removed {
                return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
            }
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:split-package-clip" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let clip_id = payload_string(&payload, "clipId").unwrap_or_default();
            let split_ratio = payload_field(&payload, "splitRatio")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.5)
                .clamp(0.1, 0.9);
            let full_path = resolve_manuscript_path(state, &file_path)?;
            let mut timeline = read_json_value_or(
                &package_timeline_path(&full_path),
                create_empty_otio_timeline(
                    full_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Untitled"),
                ),
            );
            let tracks = timeline
                .pointer_mut("/tracks/children")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "Timeline tracks missing".to_string())?;
            let mut split_done = false;
            for track in tracks.iter_mut() {
                let track_name = track
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let Some(children) = track.get_mut("children").and_then(Value::as_array_mut) else {
                    continue;
                };
                let mut next_children = Vec::new();
                for clip in children.iter() {
                    let mut clip_value = clip.clone();
                    next_children.push(clip_value.clone());
                    if timeline_clip_identity(clip, &track_name, 0) != clip_id {
                        continue;
                    }
                    let metadata = clip.get("metadata").cloned().unwrap_or_else(|| json!({}));
                    let current_duration = metadata
                        .get("durationMs")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(4000)
                        .max(1000);
                    let first_duration = ((current_duration as f64) * split_ratio).round() as i64;
                    let first_duration = first_duration.max(1000);
                    let second_duration = (current_duration - first_duration).max(1000);
                    if let Some(obj) = clip_value
                        .get_mut("metadata")
                        .and_then(Value::as_object_mut)
                    {
                        obj.insert("clipId".to_string(), json!(clip_id.clone()));
                        obj.insert("durationMs".to_string(), json!(first_duration));
                    }
                    if let Some(last) = next_children.last_mut() {
                        *last = clip_value.clone();
                    }
                    let mut new_clip = clip.clone();
                    if let Some(obj) = new_clip.get_mut("metadata").and_then(Value::as_object_mut) {
                        let trim_in = obj.get("trimInMs").and_then(|v| v.as_i64()).unwrap_or(0);
                        obj.insert("clipId".to_string(), json!(create_timeline_clip_id()));
                        obj.insert("durationMs".to_string(), json!(second_duration));
                        obj.insert("trimInMs".to_string(), json!(trim_in + first_duration));
                    }
                    next_children.push(new_clip);
                    split_done = true;
                }
                *children = next_children;
                if split_done {
                    break;
                }
            }
            if !split_done {
                return Ok(json!({ "success": false, "error": "Clip not found in timeline" }));
            }
            normalize_package_timeline(&mut timeline);
            write_json_value(&package_timeline_path(&full_path), &timeline)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:save-remotion-scene" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_state = get_manuscript_package_state(&full_path)?;
            let title = package_state
                .pointer("/manifest/title")
                .and_then(|value| value.as_str())
                .unwrap_or("RedBox Motion")
                .to_string();
            let clips = package_state
                .pointer("/timelineSummary/clips")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let fallback = build_default_remotion_scene(&title, &clips);
            let raw_scene = payload_field(&payload, "scene")
                .cloned()
                .unwrap_or(Value::Null);
            let normalized = normalize_ai_remotion_scene(&raw_scene, &fallback, &clips, &title);
            write_json_value(&package_remotion_path(&full_path), &normalized)?;
            Ok(json!({ "success": true, "state": get_manuscript_package_state(&full_path)? }))
        }
        "manuscripts:generate-remotion-scene" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let instructions = payload_string(&payload, "instructions").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_state = get_manuscript_package_state(&full_path)?;
            let title = package_state
                .pointer("/manifest/title")
                .and_then(|value| value.as_str())
                .unwrap_or("RedBox Motion")
                .to_string();
            let clips = package_state
                .pointer("/timelineSummary/clips")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            if clips.is_empty() {
                return Ok(json!({ "success": false, "error": "当前视频工程还没有时间线片段" }));
            }
            let fallback = build_default_remotion_scene(&title, &clips);
            let prompt = format!(
                "你是 RedClaw 的视频动画导演。请基于当前视频脚本和时间线，为 RedBox 生成 Remotion JSON 动画方案。\n\
只输出 JSON，不要输出解释。\n\
允许的 motionPreset 只有：static, slow-zoom-in, slow-zoom-out, pan-left, pan-right, slide-up, slide-down。\n\
字段结构：{{\"title\":string,\"width\":1080,\"height\":1920,\"fps\":30,\"backgroundColor\":\"#05070b\",\"scenes\":[{{\"id\":string,\"clipId\":string,\"assetId\":string,\"durationInFrames\":number,\"motionPreset\":string,\"overlayTitle\":string,\"overlayBody\":string,\"overlays\":[{{\"id\":string,\"text\":string,\"startFrame\":number,\"durationInFrames\":number,\"position\":\"top|center|bottom\",\"animation\":\"fade-up|fade-in|slide-left|pop\",\"fontSize\":number}}]}}]}}\n\
要求：\n\
1. 每个场景必须对应现有片段。\n\
2. 先做成适合短视频的动画：慢推、慢拉、平移、标题、底部字幕卡。\n\
3. 不要修改 src / assetKind / trimInFrames，这些字段由宿主兜底。\n\
4. overlayTitle 用镜头标题，overlayBody 用屏幕文案或强调点。\n\
5. 如果脚本有明确节奏，请让前几个场景更强，后面更稳。\n\
\n\
工程标题：{}\n\
脚本：{}\n\
时间线片段 JSON：{}",
                title,
                instructions,
                serde_json::to_string(&clips).map_err(|error| error.to_string())?
            );
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let raw = generate_response_with_settings(&settings_snapshot, None, &prompt);
            let candidate = parse_json_value_from_text(&raw).unwrap_or(Value::Null);
            let normalized = normalize_ai_remotion_scene(&candidate, &fallback, &clips, &title);
            write_json_value(&package_remotion_path(&full_path), &normalized)?;
            Ok(json!({
                "success": true,
                "state": get_manuscript_package_state(&full_path)?,
                "raw": raw
            }))
        }
        "manuscripts:render-remotion-video" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let full_path = resolve_manuscript_path(state, &file_path)?;
            if !full_path.is_dir() {
                return Ok(json!({ "success": false, "error": "Not a manuscript package" }));
            }
            let package_state = get_manuscript_package_state(&full_path)?;
            let title = package_state
                .pointer("/manifest/title")
                .and_then(|value| value.as_str())
                .unwrap_or("RedBox Motion")
                .to_string();
            let clips = package_state
                .pointer("/timelineSummary/clips")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let mut scene = read_json_value_or(
                &package_remotion_path(&full_path),
                build_default_remotion_scene(&title, &clips),
            );
            let export_dir = full_path.join("exports");
            fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
            let file_stem = full_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(slug_from_relative_path)
                .unwrap_or_else(|| "redbox-video".to_string());
            let output_path = export_dir.join(format!("{file_stem}-remotion-{}.mp4", now_ms()));
            let render_result = render_remotion_video(&scene, &output_path)?;
            if let Some(object) = scene.as_object_mut() {
                object.insert(
                    "render".to_string(),
                    json!({
                        "outputPath": output_path.display().to_string(),
                        "renderedAt": now_i64(),
                        "durationInFrames": render_result.get("durationInFrames").cloned().unwrap_or(Value::Null)
                    }),
                );
            }
            write_json_value(&package_remotion_path(&full_path), &scene)?;
            Ok(json!({
                "success": true,
                "outputPath": output_path.display().to_string(),
                "state": get_manuscript_package_state(&full_path)?
            }))
        }
        "manuscripts:get-layout" => {
            let path = manuscript_layouts_path(state)?;
            if path.exists() {
                let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                let layout: Value =
                    serde_json::from_str(&content).map_err(|error| error.to_string())?;
                Ok(layout)
            } else {
                Ok(json!({}))
            }
        }
        "manuscripts:save-layout" => {
            let path = manuscript_layouts_path(state)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(
                &path,
                serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            Ok(json!({ "success": true }))
        }
        "manuscripts:format-wechat" => {
            let title = payload_string(&payload, "title").unwrap_or_default();
            let content = payload_string(&payload, "content").unwrap_or_default();
            Ok(json!({
                "success": true,
                "html": markdown_to_html(&title, &content),
                "plainText": content,
            }))
        }
        "chat:getOrCreateFileSession" => {
            let file_path = payload_string(&payload, "filePath").unwrap_or_default();
            let session_key = format!("file-session:{}", slug_from_relative_path(&file_path));
            let title = title_from_relative_path(&file_path);
            let session = with_store_mut(state, |store| {
                let (session, _) =
                    ensure_chat_session(&mut store.chat_sessions, Some(session_key), Some(title));
                Ok(session.clone())
            })?;
            Ok(json!(session))
        }
        "chat:getOrCreateContextSession" => {
            let context_id = payload_string(&payload, "contextId")
                .unwrap_or_else(|| make_id("context").to_string());
            let context_type =
                payload_string(&payload, "contextType").unwrap_or_else(|| "context".to_string());
            let title = payload_string(&payload, "title").unwrap_or_else(|| "New Chat".to_string());
            let session_id = format!(
                "context-session:{context_type}:{}",
                slug_from_relative_path(&context_id)
            );
            let session = with_store_mut(state, |store| {
                let (session, _) =
                    ensure_chat_session(&mut store.chat_sessions, Some(session_id), Some(title));
                Ok(session.clone())
            })?;
            Ok(json!(session))
        }
        "chat:get-sessions" => with_store(state, |store| {
            let mut sessions = store.chat_sessions.clone();
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!(sessions))
        }),
        "sessions:list" => with_store(state, |store| {
            let mut sessions = store.chat_sessions.clone();
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let items: Vec<Value> = sessions
                .into_iter()
                .map(|session| {
                    let transcript_count = store
                        .session_transcript_records
                        .iter()
                        .filter(|item| item.session_id == session.id)
                        .count() as i64;
                    let checkpoint_count = store
                        .session_checkpoints
                        .iter()
                        .filter(|item| item.session_id == session.id)
                        .count() as i64;
                    json!({
                        "id": session.id,
                        "transcriptCount": transcript_count,
                        "checkpointCount": checkpoint_count,
                        "chatSession": {
                            "id": session.id,
                            "title": session.title,
                            "updatedAt": session.updated_at,
                        }
                    })
                })
                .collect();
            Ok(json!(items))
        }),
        "sessions:get" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let chat_session = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == session_id)
                    .cloned();
                let transcript: Vec<SessionTranscriptRecord> = store
                    .session_transcript_records
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let checkpoints: Vec<SessionCheckpointRecord> = store
                    .session_checkpoints
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let tool_results: Vec<SessionToolResultRecord> = store
                    .session_tool_results
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                Ok(if let Some(session) = chat_session {
                    json!({
                        "chatSession": {
                            "id": session.id,
                            "title": session.title,
                            "updatedAt": session.updated_at,
                        },
                        "transcript": transcript,
                        "checkpoints": checkpoints,
                        "toolResults": tool_results,
                    })
                } else {
                    Value::Null
                })
            })
        }
        "sessions:resume" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let chat_session = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == session_id)
                    .cloned();
                let last_checkpoint = store
                    .session_checkpoints
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .max_by_key(|item| item.created_at)
                    .cloned();
                Ok(if let Some(session) = chat_session {
                    json!({
                        "chatSession": {
                            "id": session.id,
                            "title": session.title,
                            "updatedAt": session.updated_at,
                        },
                        "lastCheckpoint": last_checkpoint,
                    })
                } else {
                    Value::Null
                })
            })
        }
        "sessions:fork" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            let forked = with_store_mut(state, |store| {
                let Some(source) = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == session_id)
                    .cloned()
                else {
                    return Ok(json!({ "success": false, "error": "会话不存在" }));
                };
                let new_id = make_id("session");
                let timestamp = now_iso();
                let new_session = ChatSessionRecord {
                    id: new_id.clone(),
                    title: format!("{} (Fork)", source.title),
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    metadata: source.metadata.clone(),
                };
                store.chat_sessions.push(new_session.clone());
                for item in store
                    .chat_messages
                    .iter()
                    .filter(|entry| entry.session_id == source.id)
                    .cloned()
                    .collect::<Vec<_>>()
                {
                    let mut copy = item.clone();
                    copy.id = make_id("message");
                    copy.session_id = new_id.clone();
                    copy.created_at = timestamp.clone();
                    store.chat_messages.push(copy);
                }
                Ok(json!({
                    "success": true,
                    "session": {
                        "id": new_session.id,
                        "transcriptCount": store.session_transcript_records.iter().filter(|item| item.session_id == source.id).count(),
                        "checkpointCount": store.session_checkpoints.iter().filter(|item| item.session_id == source.id).count(),
                    }
                }))
            })?;
            Ok(forked)
        }
        "sessions:get-transcript" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<SessionTranscriptRecord> = store
                    .session_transcript_records
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                items.sort_by_key(|item| item.created_at);
                Ok(json!(items))
            })
        }
        "sessions:get-tool-results" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<SessionToolResultRecord> = store
                    .session_tool_results
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                items.sort_by_key(|item| item.created_at);
                Ok(json!(items))
            })
        }
        "chat:get-messages" => {
            let session_id = payload_value_as_string(&payload).unwrap_or_default();
            with_store(state, |store| {
                let mut messages: Vec<ChatMessageRecord> = store
                    .chat_messages
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
                Ok(json!(messages))
            })
        }
        "chat:get-runtime-state" => {
            let requested_session_id = payload_value_as_string(&payload).unwrap_or_default();
            let guard = state
                .chat_runtime_states
                .lock()
                .map_err(|_| "chat runtime state lock 已损坏".to_string())?;
            if let Some(current) = guard.get(&requested_session_id) {
                Ok(json!({
                    "success": true,
                    "sessionId": current.session_id,
                    "isProcessing": current.is_processing,
                    "partialResponse": current.partial_response,
                    "updatedAt": current.updated_at,
                    "error": current.error,
                }))
            } else {
                Ok(json!({
                    "success": true,
                    "sessionId": requested_session_id,
                    "isProcessing": false,
                    "partialResponse": "",
                    "updatedAt": now_ms(),
                }))
            }
        }
        "runtime:query" => {
            let session_id = payload_string(&payload, "sessionId");
            let message = payload_string(&payload, "message").unwrap_or_default();
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let runtime_mode = with_store(state, |store| {
                Ok(session_id
                    .as_deref()
                    .and_then(|current_session_id| {
                        store
                            .chat_sessions
                            .iter()
                            .find(|item| item.id == current_session_id)
                            .and_then(|session| {
                                session
                                    .metadata
                                    .as_ref()
                                    .and_then(|metadata| metadata.get("contextType"))
                                    .and_then(|value| value.as_str())
                            })
                    })
                    .map(|value| resolve_runtime_mode_from_context_type(Some(value)).to_string())
                    .unwrap_or_else(|| "redclaw".to_string()))
            })?;
            let route = route_runtime_intent_with_settings(
                &settings_snapshot,
                &runtime_mode,
                &message,
                payload_field(&payload, "metadata"),
            );
            let orchestration = if route
                .get("requiresMultiAgent")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || route
                    .get("requiresLongRunningTask")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                Some(run_subagent_orchestration_for_task(
                    &settings_snapshot,
                    &runtime_mode,
                    session_id.as_deref().unwrap_or("runtime-query"),
                    &route,
                    &message,
                )?)
            } else {
                None
            };
            let effective_message = orchestration
                .as_ref()
                .and_then(|value| value.get("outputs"))
                .and_then(|value| value.as_array())
                .filter(|items| !items.is_empty())
                .map(|items| {
                    let summaries = items
                        .iter()
                        .filter_map(|item| {
                            Some(format!(
                                "- {}: {}",
                                payload_string(item, "roleId")?,
                                payload_string(item, "summary").unwrap_or_default()
                            ))
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("{message}\n\nSubagent orchestration summary:\n{summaries}")
                })
                .unwrap_or_else(|| message.clone());
            let execution = execute_chat_exchange(
                Some(app),
                state,
                session_id,
                effective_message,
                message.clone(),
                payload_field(&payload, "modelConfig"),
                None,
                "runtime-query",
                "Runtime query completed",
            )?;
            let _ = with_store_mut(state, |store| {
                append_session_checkpoint(
                    store,
                    &execution.session_id,
                    "runtime.route",
                    payload_string(&route, "reasoning")
                        .unwrap_or_else(|| "runtime route".to_string()),
                    Some(route.clone()),
                );
                if let Some(orchestration_value) = orchestration.clone() {
                    append_session_checkpoint(
                        store,
                        &execution.session_id,
                        "runtime.orchestration",
                        "subagent orchestration completed".to_string(),
                        Some(orchestration_value),
                    );
                }
                Ok(())
            });
            emit_chat_sequence(
                app,
                &execution.session_id,
                &execution.response,
                "正在规划并调用模型生成响应。",
                execution.title_update,
            );
            Ok(json!({
                "success": true,
                "sessionId": execution.session_id,
                "response": execution.response,
                "route": route,
                "orchestration": orchestration
            }))
        }
        "runtime:resume" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            Ok(json!({ "success": true, "sessionId": session_id }))
        }
        "runtime:fork-session" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            let forked = with_store_mut(state, |store| {
                let Some(source) = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == session_id)
                    .cloned()
                else {
                    return Ok(json!({ "success": false, "error": "会话不存在" }));
                };
                let new_id = make_id("session");
                let timestamp = now_iso();
                let forked = ChatSessionRecord {
                    id: new_id.clone(),
                    title: format!("{} (Fork)", source.title),
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                    metadata: source.metadata.clone(),
                };
                store.chat_sessions.push(forked);
                Ok(json!({ "success": true, "sessionId": session_id, "forkedSessionId": new_id }))
            })?;
            Ok(forked)
        }
        "runtime:get-trace" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<SessionTranscriptRecord> = store
                    .session_transcript_records
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                items.sort_by_key(|item| item.created_at);
                Ok(json!(items))
            })
        }
        "runtime:get-checkpoints" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<SessionCheckpointRecord> = store
                    .session_checkpoints
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                items.sort_by_key(|item| item.created_at);
                Ok(json!(items))
            })
        }
        "runtime:get-tool-results" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<SessionToolResultRecord> = store
                    .session_tool_results
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                items.sort_by_key(|item| item.created_at);
                Ok(json!(items))
            })
        }
        "chat:create-session" => {
            let title = payload_value_as_string(&payload).unwrap_or_else(|| "New Chat".to_string());
            let session = with_store_mut(state, |store| {
                let timestamp = now_iso();
                let session = ChatSessionRecord {
                    id: make_id("session"),
                    title,
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                    metadata: None,
                };
                store.chat_sessions.push(session.clone());
                Ok(session)
            })?;
            Ok(json!(session))
        }
        "chat:delete-session" => {
            let session_id = payload_value_as_string(&payload).unwrap_or_default();
            with_store_mut(state, |store| {
                store.chat_sessions.retain(|item| item.id != session_id);
                store
                    .chat_messages
                    .retain(|item| item.session_id != session_id);
                Ok(json!({ "success": true }))
            })
        }
        "chat:clear-messages" => {
            let session_id = payload_value_as_string(&payload).unwrap_or_default();
            with_store_mut(state, |store| {
                store
                    .chat_messages
                    .retain(|item| item.session_id != session_id);
                Ok(json!({ "success": true }))
            })
        }
        "chat:compact-context" => Ok(json!({ "success": true })),
        "chat:get-context-usage" => Ok(json!({
            "success": true,
            "estimatedTotalTokens": 0,
            "compactThreshold": 0,
            "compactRatio": 0,
            "compactRounds": 0,
            "compactUpdatedAt": Value::Null,
        })),
        "chat:update-session-metadata" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            let metadata = payload_field(&payload, "metadata").cloned();
            with_store_mut(state, |store| {
                if let Some(session) = store
                    .chat_sessions
                    .iter_mut()
                    .find(|item| item.id == session_id)
                {
                    session.metadata = metadata;
                    session.updated_at = now_iso();
                }
                Ok(json!({ "success": true }))
            })
        }
        "tasks:create" => {
            let runtime_mode =
                payload_string(&payload, "runtimeMode").unwrap_or_else(|| "default".to_string());
            let owner_session_id = payload_string(&payload, "sessionId");
            let user_input = payload_string(&payload, "userInput")
                .unwrap_or_else(|| "开发者手动创建任务".to_string());
            let metadata = payload_field(&payload, "metadata").cloned();
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let route = route_runtime_intent_with_settings(
                &settings_snapshot,
                &runtime_mode,
                &user_input,
                metadata.as_ref(),
            );
            let role_id = payload_string(&route, "recommendedRole");
            let graph = runtime_graph_for_route(&route);
            let created = with_store_mut(state, |store| {
                let task = RuntimeTaskRecord {
                    id: make_id("task"),
                    task_type: "manual".to_string(),
                    status: "pending".to_string(),
                    runtime_mode,
                    owner_session_id,
                    intent: payload_string(&route, "intent"),
                    role_id: role_id.clone(),
                    goal: Some(user_input.clone()),
                    current_node: Some("plan".to_string()),
                    route: Some(route.clone()),
                    graph,
                    artifacts: Vec::new(),
                    checkpoints: vec![json!({
                        "type": "route",
                        "summary": payload_string(&route, "reasoning").unwrap_or_default(),
                        "payload": route.clone()
                    })],
                    metadata,
                    last_error: None,
                    created_at: now_i64(),
                    updated_at: now_i64(),
                    started_at: None,
                    completed_at: None,
                };
                append_runtime_task_trace(
                    store,
                    &task.id,
                    "created",
                    Some(json!({
                        "goal": task.goal.clone(),
                        "runtimeMode": task.runtime_mode,
                        "intent": task.intent,
                        "roleId": task.role_id,
                        "route": task.route
                    })),
                );
                store.runtime_tasks.push(task.clone());
                Ok(task)
            })?;
            Ok(json!(created))
        }
        "tasks:list" => with_store(state, |store| {
            let mut tasks = store.runtime_tasks.clone();
            tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!(tasks))
        }),
        "tasks:get" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            with_store(state, |store| {
                Ok(store
                    .runtime_tasks
                    .iter()
                    .find(|item| item.id == task_id)
                    .cloned()
                    .map_or(Value::Null, |item| json!(item)))
            })
        }
        "tasks:resume" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let task_snapshot = with_store_mut(state, |store| {
                let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                else {
                    return Ok(None);
                };
                task.status = "running".to_string();
                task.updated_at = now_i64();
                task.started_at.get_or_insert(now_i64());
                task.current_node = Some("plan".to_string());
                set_runtime_graph_node(
                    &mut task.graph,
                    "plan",
                    "running",
                    Some("route and execution plan resumed".to_string()),
                    None,
                );
                Ok(Some(task.clone()))
            })?;
            let Some(task_snapshot) = task_snapshot else {
                return Ok(json!({ "success": false, "error": "任务不存在" }));
            };
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let route = task_snapshot.route.clone().unwrap_or_else(|| {
                runtime_direct_route(
                    &task_snapshot.runtime_mode,
                    task_snapshot.goal.as_deref().unwrap_or(""),
                    task_snapshot.metadata.as_ref(),
                )
            });
            let orchestration = if route
                .get("requiresMultiAgent")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || task_snapshot.runtime_mode == "background-maintenance"
            {
                Some(run_subagent_orchestration_for_task(
                    &settings_snapshot,
                    &task_snapshot.runtime_mode,
                    &task_snapshot.id,
                    &route,
                    task_snapshot.goal.as_deref().unwrap_or(""),
                )?)
            } else {
                None
            };
            let reviewer_rejected = orchestration
                .as_ref()
                .and_then(|value| value.get("outputs"))
                .and_then(|value| value.as_array())
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("roleId").and_then(|value| value.as_str()) == Some("reviewer")
                    })
                })
                .map(|review| {
                    let approved = review
                        .get("approved")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(true);
                    let issue_count = review
                        .get("issues")
                        .and_then(|value| value.as_array())
                        .map(|items| items.len())
                        .unwrap_or(0);
                    !approved || issue_count > 0
                })
                .unwrap_or(false);
            let repair_plan = if reviewer_rejected {
                orchestration
                    .as_ref()
                    .map(|value| {
                        run_reviewer_repair_for_task(
                            &settings_snapshot,
                            &task_snapshot.id,
                            &route,
                            task_snapshot.goal.as_deref().unwrap_or(""),
                            value,
                        )
                    })
                    .transpose()?
            } else {
                None
            };
            let repair_orchestration = if reviewer_rejected {
                repair_plan
                    .as_ref()
                    .map(|repair| {
                        let repair_goal = format!(
                            "{}\n\nRepair instructions:\n{}",
                            task_snapshot.goal.as_deref().unwrap_or(""),
                            payload_string(repair, "summary").unwrap_or_else(|| repair.to_string())
                        );
                        run_subagent_orchestration_for_task(
                            &settings_snapshot,
                            &task_snapshot.runtime_mode,
                            &format!("{}-repair", task_snapshot.id),
                            &route,
                            &repair_goal,
                        )
                    })
                    .transpose()?
            } else {
                None
            };
            let repair_pass_failed = repair_orchestration
                .as_ref()
                .and_then(|value| value.get("outputs"))
                .and_then(|value| value.as_array())
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("roleId").and_then(|value| value.as_str()) == Some("reviewer")
                    })
                })
                .map(|review| {
                    let approved = review
                        .get("approved")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(true);
                    let issue_count = review
                        .get("issues")
                        .and_then(|value| value.as_array())
                        .map(|items| items.len())
                        .unwrap_or(0);
                    !approved || issue_count > 0
                })
                .unwrap_or(reviewer_rejected);
            let final_orchestration = repair_orchestration.as_ref().or(orchestration.as_ref());
            let saved_artifact = if reviewer_rejected && repair_pass_failed {
                None
            } else {
                Some(save_runtime_task_artifact(
                    state,
                    &task_snapshot.id,
                    &route,
                    task_snapshot.goal.as_deref().unwrap_or(""),
                    final_orchestration,
                )?)
            };
            let result = with_store_mut(state, |store| {
                let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                else {
                    return Ok(json!({ "success": false, "error": "任务不存在" }));
                };
                task.intent = payload_string(&route, "intent");
                task.role_id = payload_string(&route, "recommendedRole");
                task.route = Some(route.clone());
                task.current_node = Some("execute_tools".to_string());
                set_runtime_graph_node(
                    &mut task.graph,
                    "plan",
                    "completed",
                    Some(
                        payload_string(&route, "reasoning")
                            .unwrap_or_else(|| "route resolved".to_string()),
                    ),
                    None,
                );
                set_runtime_graph_node(
                    &mut task.graph,
                    "retrieve",
                    "completed",
                    Some("runtime context prepared".to_string()),
                    None,
                );
                if let Some(orchestration_value) = orchestration.clone() {
                    set_runtime_graph_node(
                        &mut task.graph,
                        "spawn_agents",
                        "completed",
                        Some("subagent orchestration completed".to_string()),
                        None,
                    );
                    task.artifacts.push(json!({
                        "type": "subagent-orchestration",
                        "payload": orchestration_value.clone(),
                        "createdAt": now_i64()
                    }));
                    task.checkpoints.push(json!({
                        "type": "orchestration",
                        "summary": "subagent orchestration completed",
                        "payload": orchestration_value
                    }));
                }
                if let Some(repair_value) = repair_plan.clone() {
                    set_runtime_graph_node(
                        &mut task.graph,
                        "review",
                        "failed",
                        Some("reviewer requested repair".to_string()),
                        Some("reviewer rejected execution".to_string()),
                    );
                    task.artifacts.push(json!({
                        "type": "repair-plan",
                        "payload": repair_value.clone(),
                        "createdAt": now_i64()
                    }));
                    task.checkpoints.push(json!({
                        "type": "repair",
                        "summary": payload_string(&repair_value, "summary").unwrap_or_else(|| "review repair plan generated".to_string()),
                        "payload": repair_value.clone()
                    }));
                }
                if let Some(repair_value) = repair_orchestration.clone() {
                    set_runtime_graph_node(
                        &mut task.graph,
                        "handoff",
                        "completed",
                        Some("repair pass completed".to_string()),
                        None,
                    );
                    task.artifacts.push(json!({
                        "type": "repair-pass",
                        "payload": repair_value.clone(),
                        "createdAt": now_i64()
                    }));
                    task.checkpoints.push(json!({
                        "type": "repair_pass",
                        "summary": "repair pass completed",
                        "payload": repair_value
                    }));
                }
                if let Some(artifact) = saved_artifact.clone() {
                    set_runtime_graph_node(
                        &mut task.graph,
                        "save_artifact",
                        "completed",
                        Some("artifact saved".to_string()),
                        None,
                    );
                    task.artifacts.push(artifact.clone());
                    task.checkpoints.push(json!({
                        "type": "save_artifact",
                        "summary": "artifact saved",
                        "payload": artifact
                    }));
                    let mut work_item = create_work_item(
                        "runtime-artifact",
                        format!(
                            "Runtime Artifact · {}",
                            payload_string(&route, "intent").unwrap_or_else(|| "task".to_string())
                        ),
                        Some(payload_string(&route, "goal").unwrap_or_default()),
                        Some(
                            saved_artifact
                                .as_ref()
                                .and_then(|value| payload_string(value, "path"))
                                .unwrap_or_default(),
                        ),
                        Some(json!({
                            "taskId": task_id,
                            "sessionId": task.owner_session_id.clone(),
                            "intent": payload_string(&route, "intent"),
                            "artifact": saved_artifact.clone(),
                        })),
                        2,
                    );
                    work_item.refs.task_ids.push(task_id.clone());
                    if let Some(session_id) = task.owner_session_id.clone() {
                        work_item.refs.session_ids.push(session_id);
                    }
                    store.work_items.push(work_item);
                }
                if reviewer_rejected && repair_pass_failed {
                    task.status = "failed".to_string();
                    task.last_error = Some("reviewer rejected execution".to_string());
                    set_runtime_graph_node(
                        &mut task.graph,
                        "execute_tools",
                        "failed",
                        Some("execution blocked by reviewer".to_string()),
                        Some("reviewer rejected execution".to_string()),
                    );
                    if let Some(repair_value) = repair_plan.clone() {
                        let mut work_item = create_work_item(
                            "runtime-repair",
                            format!(
                                "Runtime Repair · {}",
                                payload_string(&route, "intent")
                                    .unwrap_or_else(|| "task".to_string())
                            ),
                            Some(
                                payload_string(&repair_value, "summary")
                                    .unwrap_or_else(|| "reviewer repair required".to_string()),
                            ),
                            Some(payload_string(&route, "goal").unwrap_or_default()),
                            Some(json!({
                                "taskId": task_id,
                                "sessionId": task.owner_session_id.clone(),
                                "intent": payload_string(&route, "intent"),
                                "repair": repair_value,
                            })),
                            1,
                        );
                        work_item.refs.task_ids.push(task_id.clone());
                        if let Some(session_id) = task.owner_session_id.clone() {
                            work_item.refs.session_ids.push(session_id);
                        }
                        store.work_items.push(work_item);
                    }
                } else {
                    task.status = "completed".to_string();
                    task.last_error = None;
                    set_runtime_graph_node(
                        &mut task.graph,
                        "review",
                        "completed",
                        Some("reviewer approved execution".to_string()),
                        None,
                    );
                    set_runtime_graph_node(
                        &mut task.graph,
                        "execute_tools",
                        "completed",
                        Some("execution completed".to_string()),
                        None,
                    );
                }
                task.completed_at = Some(now_i64());
                task.updated_at = now_i64();
                append_runtime_task_trace(
                    store,
                    &task_id,
                    "resumed",
                    Some(json!({ "route": route.clone() })),
                );
                if let Some(orchestration_value) = orchestration.clone() {
                    append_runtime_task_trace(
                        store,
                        &task_id,
                        "subagent.completed",
                        Some(orchestration_value),
                    );
                }
                if let Some(repair_value) = repair_plan.clone() {
                    append_runtime_task_trace(
                        store,
                        &task_id,
                        "repair.generated",
                        Some(repair_value),
                    );
                }
                if let Some(repair_value) = repair_orchestration.clone() {
                    append_runtime_task_trace(
                        store,
                        &task_id,
                        "repair.pass_completed",
                        Some(repair_value),
                    );
                }
                append_runtime_task_trace(
                    store,
                    &task_id,
                    if reviewer_rejected && repair_pass_failed {
                        "failed"
                    } else {
                        "completed"
                    },
                    None,
                );
                Ok(json!({
                    "success": !(reviewer_rejected && repair_pass_failed),
                    "taskId": task_id,
                    "error": if reviewer_rejected && repair_pass_failed { Value::String("reviewer rejected execution".to_string()) } else { Value::Null }
                }))
            })?;
            Ok(result)
        }
        "tasks:cancel" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                else {
                    return Ok(json!({ "success": false, "error": "任务不存在" }));
                };
                task.status = "cancelled".to_string();
                task.updated_at = now_i64();
                task.completed_at = Some(now_i64());
                append_runtime_task_trace(store, &task_id, "cancelled", None);
                Ok(json!({ "success": true, "taskId": task_id }))
            })?;
            Ok(result)
        }
        "tasks:trace" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<RuntimeTaskTraceRecord> = store
                    .runtime_task_traces
                    .iter()
                    .filter(|item| item.task_id == task_id)
                    .cloned()
                    .collect();
                items.sort_by_key(|item| item.created_at);
                Ok(json!(items))
            })
        }
        "chat:pick-attachment" => {
            let files = pick_files_native("选择要发送给 AI 的文件", false, false)?;
            let Some(path) = files.into_iter().next() else {
                return Ok(json!({ "success": true, "canceled": true }));
            };
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            let (mime_type, kind, direct_upload_eligible) = guess_mime_and_kind(&path);
            let requires_multimodal = kind == "image" || kind == "audio" || kind == "video";
            let attachment = json!({
                "type": "uploaded-file",
                "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
                "ext": path.extension().and_then(|value| value.to_str()).unwrap_or(""),
                "size": metadata.len(),
                "absolutePath": path.display().to_string(),
                "originalAbsolutePath": path.display().to_string(),
                "localUrl": file_url_for_path(&path),
                "kind": kind,
                "mimeType": mime_type,
                "storageMode": "absolute",
                "directUploadEligible": direct_upload_eligible,
                "processingStrategy": if direct_upload_eligible { "direct" } else { "path-reference" },
                "summary": path.display().to_string(),
                "requiresMultimodal": requires_multimodal,
            });
            Ok(json!({ "success": true, "canceled": false, "attachment": attachment }))
        }
        "chat:transcribe-audio" => {
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let Some(audio_base64) = payload_string(&payload, "audioBase64") else {
                return Ok(json!({ "success": false, "error": "缺少音频内容" }));
            };
            let mime_type =
                payload_string(&payload, "mimeType").unwrap_or_else(|| "audio/webm".to_string());
            let file_name = payload_string(&payload, "fileName")
                .unwrap_or_else(|| format!("chat-audio-{}.webm", now_ms()));
            let Some((endpoint, api_key, model_name)) =
                resolve_transcription_settings(&settings_snapshot)
            else {
                return Ok(
                    json!({ "success": false, "error": "未配置音频转写服务，请先在设置中填写 transcription endpoint/model。" }),
                );
            };
            let temp_dir = store_root(state)?.join("tmp");
            fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
            let audio_path = temp_dir.join(file_name);
            write_base64_payload_to_file(&audio_base64, &audio_path)?;
            let text = run_curl_transcription(
                &endpoint,
                api_key.as_deref(),
                &model_name,
                &audio_path,
                &mime_type,
            )
            .or_else(|_| {
                let fallback = String::from_utf8_lossy(
                    &std::process::Command::new("file")
                        .arg("-b")
                        .arg(&audio_path)
                        .output()
                        .map(|output| output.stdout)
                        .unwrap_or_default(),
                )
                .trim()
                .to_string();
                if fallback.is_empty() {
                    Err("语音转写失败".to_string())
                } else {
                    Ok(format!(
                        "音频已接收，但转写接口不可用。\n\n文件类型：{fallback}"
                    ))
                }
            })?;
            let _ = fs::remove_file(&audio_path);
            Ok(json!({ "success": true, "text": text }))
        }
        "chatrooms:list" => with_store(state, |store| {
            let mut rooms = store.chat_rooms.clone();
            rooms.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            Ok(json!(rooms))
        }),
        "chatrooms:messages" => {
            let room_id = payload_value_as_string(&payload).unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<ChatRoomMessageRecord> = store
                    .chatroom_messages
                    .iter()
                    .filter(|item| item.room_id == room_id)
                    .cloned()
                    .collect();
                items.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
                Ok(json!(items))
            })
        }
        "chatrooms:create" => {
            let name = payload_string(&payload, "name").unwrap_or_else(|| "未命名群聊".to_string());
            let advisor_ids = payload_field(&payload, "advisorIds")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_else(Vec::new);
            let room = with_store_mut(state, |store| {
                let room = ChatRoomRecord {
                    id: make_id("chatroom"),
                    name,
                    advisor_ids,
                    created_at: now_iso(),
                    is_system: Some(false),
                    system_type: None,
                };
                store.chat_rooms.push(room.clone());
                Ok(room)
            })?;
            Ok(json!(room))
        }
        "chatrooms:update" => {
            let room_id = payload_string(&payload, "roomId").unwrap_or_default();
            let next_name = payload_string(&payload, "name");
            let next_advisor_ids = payload_field(&payload, "advisorIds")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                });
            let result = with_store_mut(state, |store| {
                let Some(room) = store.chat_rooms.iter_mut().find(|item| item.id == room_id) else {
                    return Ok(json!({ "success": false, "error": "群聊不存在" }));
                };
                if let Some(name) = next_name.clone() {
                    room.name = name;
                }
                if let Some(advisor_ids) = next_advisor_ids.clone() {
                    room.advisor_ids = advisor_ids;
                }
                Ok(json!({ "success": true, "room": room.clone() }))
            })?;
            Ok(result)
        }
        "chatrooms:delete" => {
            let room_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store.chat_rooms.retain(|item| item.id != room_id);
                store
                    .chatroom_messages
                    .retain(|item| item.room_id != room_id);
                Ok(json!({ "success": true }))
            })?;
            Ok(result)
        }
        "chatrooms:clear" => {
            let room_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store
                    .chatroom_messages
                    .retain(|item| item.room_id != room_id);
                Ok(json!({ "success": true }))
            })?;
            Ok(result)
        }
        "chatrooms:send" => {
            let room_id = payload_string(&payload, "roomId").unwrap_or_default();
            let message = payload_string(&payload, "message").unwrap_or_default();
            let context = payload_field(&payload, "context").cloned();
            if room_id.trim().is_empty() || message.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少 roomId 或 message" }));
            }
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let (room, advisors) = with_store(state, |store| {
                let room = store
                    .chat_rooms
                    .iter()
                    .find(|item| item.id == room_id)
                    .cloned();
                Ok((room, store.advisors.clone()))
            })?;
            let Some(room) = room else {
                return Ok(json!({ "success": false, "error": "群聊不存在" }));
            };
            let user_message = ChatRoomMessageRecord {
                id: make_id("chatroom-message"),
                room_id: room_id.clone(),
                role: "user".to_string(),
                advisor_id: None,
                advisor_name: None,
                advisor_avatar: None,
                content: message.clone(),
                timestamp: now_iso(),
                is_streaming: Some(false),
                phase: None,
            };
            with_store_mut(state, |store| {
                store.chatroom_messages.push(user_message.clone());
                Ok(())
            })?;
            let _ = app.emit(
                "creative-chat:user-message",
                json!({ "roomId": room_id.clone(), "message": user_message }),
            );

            let target_advisor_ids = if room.advisor_ids.is_empty() {
                vec!["director-system".to_string()]
            } else {
                room.advisor_ids.clone()
            };

            for (index, advisor_id) in target_advisor_ids.iter().enumerate() {
                let advisor = advisors.iter().find(|item| item.id == *advisor_id);
                let advisor_name = if advisor_id == "director-system" {
                    "总监".to_string()
                } else {
                    find_advisor_name(&advisors, advisor_id)
                };
                let advisor_avatar = if advisor_id == "director-system" {
                    "🎯".to_string()
                } else {
                    find_advisor_avatar(&advisors, advisor_id)
                };
                let phase = chatroom_response_phase(index, target_advisor_ids.len());
                let _ = app.emit(
                    "creative-chat:advisor-start",
                    json!({
                        "roomId": room_id,
                        "advisorId": advisor_id,
                        "advisorName": advisor_name,
                        "advisorAvatar": advisor_avatar,
                        "phase": phase
                    }),
                );
                let _ = app.emit(
                    "creative-chat:thinking",
                    json!({
                        "roomId": room_id,
                        "advisorId": advisor_id,
                        "type": "thinking_start",
                        "content": "正在分析群聊上下文..."
                    }),
                );
                let prompt = build_advisor_prompt(advisor, &message, context.as_ref());
                let response = generate_response_with_settings(&settings_snapshot, None, &prompt);
                let _ = app.emit(
                    "creative-chat:thinking",
                    json!({
                        "roomId": room_id,
                        "advisorId": advisor_id,
                        "type": "thinking_end",
                        "content": "分析完成"
                    }),
                );
                for chunk in split_stream_chunks(&response, 140) {
                    let _ = app.emit(
                        "creative-chat:stream",
                        json!({
                            "roomId": room_id,
                            "advisorId": advisor_id,
                            "advisorName": if advisor_id == "director-system" { "总监" } else { &advisor_name },
                            "advisorAvatar": if advisor_id == "director-system" { "🎯" } else { &advisor_avatar },
                            "content": chunk,
                            "done": false
                        }),
                    );
                }
                let ai_message = ChatRoomMessageRecord {
                    id: make_id("chatroom-message"),
                    room_id: room_id.clone(),
                    role: if advisor_id == "director-system" {
                        "director".to_string()
                    } else {
                        "advisor".to_string()
                    },
                    advisor_id: Some(advisor_id.clone()),
                    advisor_name: Some(advisor_name.clone()),
                    advisor_avatar: Some(advisor_avatar.clone()),
                    content: response.clone(),
                    timestamp: now_iso(),
                    is_streaming: Some(false),
                    phase: Some(phase.clone()),
                };
                with_store_mut(state, |store| {
                    store.chatroom_messages.push(ai_message);
                    Ok(())
                })?;
                let _ = app.emit(
                    "creative-chat:stream",
                    json!({
                        "roomId": room_id,
                        "advisorId": advisor_id,
                        "advisorName": advisor_name,
                        "advisorAvatar": advisor_avatar,
                        "content": "",
                        "done": true
                    }),
                );
            }

            let _ = app.emit("creative-chat:done", json!({ "roomId": room_id }));
            Ok(json!({ "success": true }))
        }
        "wander:list-history" => with_store(state, |store| {
            let mut history = store.wander_history.clone();
            history.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            Ok(json!(history))
        }),
        "wander:delete-history" => {
            let history_id = payload_value_as_string(&payload).unwrap_or_default();
            with_store_mut(state, |store| {
                store.wander_history.retain(|item| item.id != history_id);
                Ok(json!({ "success": true }))
            })
        }
        "wander:get-random" => with_store(state, |store| {
            let mut items = Vec::new();
            for note in store.knowledge_notes.iter().take(12) {
                items.push(wander_item_from_note(note));
            }
            for video in store.youtube_videos.iter().take(12) {
                items.push(wander_item_from_youtube(video));
            }
            for source in store.document_sources.iter().take(12) {
                items.push(wander_item_from_doc(source));
            }
            items.sort_by_key(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string()
            });
            let offset = (now_ms() as usize) % items.len().max(1);
            let mut selected = Vec::new();
            for index in 0..items.len().min(3) {
                selected.push(items[(offset + index) % items.len()].clone());
            }
            Ok(json!(selected))
        }),
        "wander:brainstorm" => {
            let request_started_at = now_ms();
            let mut items = payload
                .as_array()
                .cloned()
                .or_else(|| {
                    payload_field(&payload, "items").and_then(|value| value.as_array().cloned())
                })
                .unwrap_or_default();
            let options = payload
                .as_array()
                .and_then(|items| items.get(1))
                .cloned()
                .or_else(|| payload_field(&payload, "options").cloned())
                .unwrap_or_else(|| json!({}));
            let request_id =
                payload_string(&options, "requestId").unwrap_or_else(|| make_id("wander-request"));
            log_timing_event(
                state,
                "wander",
                &request_id,
                "request-received",
                request_started_at,
                Some(format!("inputItems={}", items.len())),
            );
            if items.is_empty() {
                let select_started_at = now_ms();
                items = with_store(state, |store| {
                    let mut collected = Vec::new();
                    for note in store.knowledge_notes.iter().take(12) {
                        collected.push(wander_item_from_note(note));
                    }
                    for video in store.youtube_videos.iter().take(12) {
                        collected.push(wander_item_from_youtube(video));
                    }
                    for source in store.document_sources.iter().take(12) {
                        collected.push(wander_item_from_doc(source));
                    }
                    collected.sort_by_key(|item| {
                        item.get("id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string()
                    });
                    let offset = (now_ms() as usize) % collected.len().max(1);
                    let mut selected = Vec::new();
                    for index in 0..collected.len().min(3) {
                        selected.push(collected[(offset + index) % collected.len()].clone());
                    }
                    Ok(selected)
                })?;
                log_timing_event(
                    state,
                    "wander",
                    &request_id,
                    "select-random-items",
                    select_started_at,
                    Some(format!("selectedItems={}", items.len())),
                );
            }
            let settings_started_at = now_ms();
            let warm_wander = ensure_runtime_warm_entry(state, "wander")?;
            log_timing_event(
                state,
                "wander",
                &request_id,
                "load-settings",
                settings_started_at,
                Some(format!("warmedAt={}", warm_wander.warmed_at)),
            );
            let route_started_at = now_ms();
            let route = runtime_direct_route(
                "wander",
                "基于随机知识素材生成新选题",
                Some(&json!({
                    "intent": "manuscript_creation",
                    "contextType": "wander",
                    "contextId": request_id.clone(),
                    "preferredRole": "copywriter",
                    "forceMultiAgent": false,
                    "forceLongRunningTask": false
                })),
            );
            log_timing_event(
                state,
                "wander",
                &request_id,
                "route-ready",
                route_started_at,
                Some(format!(
                    "intent={} role={}",
                    payload_string(&route, "intent").unwrap_or_default(),
                    payload_string(&route, "recommendedRole").unwrap_or_default()
                )),
            );
            let task_started_at = now_ms();
            let task_id = with_store_mut(state, |store| {
                let task = RuntimeTaskRecord {
                    id: make_id("task"),
                    task_type: "wander".to_string(),
                    status: "running".to_string(),
                    runtime_mode: "wander".to_string(),
                    owner_session_id: Some(format!(
                        "context-session:wander:{}",
                        slug_from_relative_path(&request_id)
                    )),
                    intent: payload_string(&route, "intent"),
                    role_id: payload_string(&route, "recommendedRole"),
                    goal: Some("漫步生成新选题".to_string()),
                    current_node: Some("plan".to_string()),
                    route: Some(route.clone()),
                    graph: runtime_graph_for_route(&route),
                    artifacts: Vec::new(),
                    checkpoints: vec![json!({
                        "type": "route",
                        "summary": payload_string(&route, "reasoning").unwrap_or_else(|| "wander route".to_string()),
                        "payload": route.clone()
                    })],
                    metadata: Some(json!({
                        "requestId": request_id.clone(),
                        "contextType": "wander",
                    })),
                    last_error: None,
                    created_at: now_i64(),
                    updated_at: now_i64(),
                    started_at: Some(now_i64()),
                    completed_at: None,
                };
                store.runtime_tasks.push(task.clone());
                append_runtime_task_trace(
                    store,
                    &task.id,
                    "wander.started",
                    Some(json!({ "requestId": request_id.clone() })),
                );
                Ok(task.id)
            })?;
            log_timing_event(
                state,
                "wander",
                &request_id,
                "task-created",
                task_started_at,
                Some(format!("taskId={}", task_id)),
            );
            let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": format!("session_wander_{}", slug_from_relative_path(&request_id)),
                    "phase": "collect",
                    "stepIndex": 1,
                    "totalSteps": 4,
                    "title": "选择随机素材",
                    "status": "completed",
                    "detail": "已从知识库中选出本轮用于漫步的 3 条随机素材。",
                }),
            );
            let _ = with_store_mut(state, |store| {
                if let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    set_runtime_graph_node(
                        &mut task.graph,
                        "plan",
                        "completed",
                        Some("漫步素材已读取".to_string()),
                        None,
                    );
                    set_runtime_graph_node(
                        &mut task.graph,
                        "retrieve",
                        "running",
                        Some("正在整理素材摘要".to_string()),
                        None,
                    );
                    task.current_node = Some("retrieve".to_string());
                    task.updated_at = now_i64();
                }
                append_runtime_task_trace(store, &task_id, "wander.collect.completed", None);
                Ok(())
            });
            let multi_choice = payload_field(&options, "multiChoice")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": format!("session_wander_{}", slug_from_relative_path(&request_id)),
                    "phase": "analyze",
                    "stepIndex": 2,
                    "totalSteps": 4,
                    "title": "构建上下文",
                    "status": "running",
                    "detail": format!("已装载 {} 条随机素材，正在整理素材摘要、长期上下文与已读取文件内容...", items.len()),
                }),
            );
            let context_started_at = now_ms();
            let long_term_context = warm_wander
                .long_term_context
                .clone()
                .unwrap_or_else(|| build_wander_long_term_context(state));
            log_timing_event(
                state,
                "wander",
                &request_id,
                "long-term-context-ready",
                context_started_at,
                Some(format!(
                    "profileChars={}",
                    long_term_context.chars().count(),
                )),
            );
            let wander_session_id =
                format!("session_wander_{}", slug_from_relative_path(&request_id));
            let materials_context_started_at = now_ms();
            let materials_context =
                build_wander_materials_context(app, state, &wander_session_id, &items);
            log_timing_event(
                state,
                "wander",
                &request_id,
                "materials-context-ready",
                materials_context_started_at,
                Some(format!(
                    "materialsChars={}",
                    materials_context.chars().count()
                )),
            );
            let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": format!("session_wander_{}", slug_from_relative_path(&request_id)),
                    "phase": "analyze",
                    "stepIndex": 2,
                    "totalSteps": 4,
                    "title": "构建上下文",
                    "status": "completed",
                    "detail": "随机素材摘要与长期上下文已准备完成��Agent 将继续自行读取关键文件。",
                }),
            );
            let items_text = build_wander_items_text(&items);
            let long_term_context_section = if long_term_context.trim().is_empty() {
                String::new()
            } else {
                format!(
                    "\n\n## 用户长期上下文（供你参考）\n{}\n\n使用要求：\n- 与长期定位保持一致；\n- 若素材与长期定位冲突，优先选择可落地、可执行的方向。",
                    long_term_context
                )
            };
            let prompt = build_wander_deep_agent_prompt(
                &items_text,
                &long_term_context_section,
                &materials_context,
                multi_choice,
            );
            log_timing_event(
                state,
                "wander",
                &request_id,
                "prompt-ready",
                context_started_at,
                Some(format!("promptChars={}", prompt.chars().count())),
            );
            let session_started_at = now_ms();
            let _ = with_store_mut(state, |store| {
                let (session, _) = ensure_chat_session(
                    &mut store.chat_sessions,
                    Some(wander_session_id.clone()),
                    Some("Wander Deep Think".to_string()),
                );
                session.metadata = Some(json!({
                    "contextId": format!("wander:{}", request_id),
                    "contextType": "wander",
                    "contextContent": items_text,
                    "isContextBound": true,
                }));
                session.updated_at = now_iso();
                Ok(())
            });
            log_timing_event(
                state,
                "wander",
                &request_id,
                "session-ready",
                session_started_at,
                Some(format!("sessionId={}", wander_session_id)),
            );
            let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": wander_session_id,
                    "phase": "generate",
                    "stepIndex": 3,
                    "totalSteps": 3,
                    "title": "生成选题",
                    "status": "running",
                    "detail": "正在启动漫步 Agent，并基于已读取的关键素材生成最终选题。",
                }),
            );
            let _ = app.emit(
                "chat:phase-start",
                json!({
                    "name": "responding",
                    "sessionId": wander_session_id,
                }),
            );
            let _ = app.emit(
                "chat:thought-delta",
                json!({
                    "content": "正在综合随机素材、长期上下文与关键文件内容，收敛最终选题方向。",
                    "sessionId": wander_session_id,
                }),
            );
            let execution_started_at = now_ms();
            let model_result = generate_wander_response(
                state,
                warm_wander
                    .model_config
                    .as_ref()
                    .ok_or_else(|| "wander model config missing".to_string())?,
                &prompt,
            )
            .map(|response| {
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][wander][{}] single-pass-succeeded",
                        wander_session_id
                    ),
                );
                response
            })
            .unwrap_or_else(|error| {
                append_debug_log_state(
                    state,
                    format!(
                        "[runtime][wander][{}] fallback-local-json | {}",
                        wander_session_id, error
                    ),
                );
                let first_title = items
                    .first()
                    .and_then(|item| item.get("title"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("随机素材");
                json!({
                    "content_direction": "围绕这组素材提炼一个更聚焦、可直接创作的小红书选题。",
                    "thinking_process": ["观察随机素材", "提取共同主题", "形成可执行选题"],
                    "topic": {
                        "title": format!("从{}延展出的内容选题", first_title),
                        "connections": [1, 2, 3]
                    },
                    "selected_index": 0
                })
                .to_string()
            });
            log_timing_event(
                state,
                "wander",
                &request_id,
                "execution-finished",
                execution_started_at,
                Some(format!("responseChars={}", model_result.chars().count())),
            );
            let parse_started_at = now_ms();
            let result_value = serde_json::from_str::<Value>(&model_result).unwrap_or_else(|_| {
                let first_title = items
                    .first()
                    .and_then(|item| item.get("title"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("随机素材");
                json!({
                    "content_direction": model_result,
                    "thinking_process": ["观察随机素材", "提取共同主题", "形成可执行选题"],
                    "topic": {
                        "title": format!("从{}延展出的内容选题", first_title),
                        "connections": [1, 2, 3]
                    },
                    "selected_index": 0
                })
            });
            log_timing_event(
                state,
                "wander",
                &request_id,
                "result-parsed",
                parse_started_at,
                None,
            );
            let result_text =
                serde_json::to_string(&result_value).map_err(|error| error.to_string())?;
            let history_id = make_id("wander");
            let history_started_at = now_ms();
            with_store_mut(state, |store| {
                store.chat_messages.push(ChatMessageRecord {
                    id: make_id("message"),
                    session_id: wander_session_id.clone(),
                    role: "user".to_string(),
                    content: prompt.clone(),
                    display_content: None,
                    attachment: None,
                    created_at: now_iso(),
                });
                store.chat_messages.push(ChatMessageRecord {
                    id: make_id("message"),
                    session_id: wander_session_id.clone(),
                    role: "assistant".to_string(),
                    content: model_result.clone(),
                    display_content: None,
                    attachment: None,
                    created_at: now_iso(),
                });
                append_session_transcript(
                    store,
                    &wander_session_id,
                    "message",
                    "user",
                    prompt.clone(),
                    Some(json!({ "source": "wander" })),
                );
                append_session_transcript(
                    store,
                    &wander_session_id,
                    "message",
                    "assistant",
                    model_result.clone(),
                    Some(json!({ "source": "wander" })),
                );
                append_session_checkpoint(
                    store,
                    &wander_session_id,
                    "wander-brainstorm",
                    "Wander brainstorm completed".to_string(),
                    Some(json!({ "responsePreview": text_snippet(&model_result, 160) })),
                );
                store.wander_history.push(WanderHistoryRecord {
                    id: history_id.clone(),
                    items: serde_json::to_string(&items).map_err(|error| error.to_string())?,
                    result: result_text.clone(),
                    created_at: now_i64(),
                });
                if let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    set_runtime_graph_node(
                        &mut task.graph,
                        "retrieve",
                        "completed",
                        Some("素材关联分析完成".to_string()),
                        None,
                    );
                    set_runtime_graph_node(
                        &mut task.graph,
                        "execute_tools",
                        "completed",
                        Some("选题生成完成".to_string()),
                        None,
                    );
                    set_runtime_graph_node(
                        &mut task.graph,
                        "save_artifact",
                        "completed",
                        Some("漫步结果已保存到历史".to_string()),
                        None,
                    );
                    task.current_node = Some("save_artifact".to_string());
                    task.status = "completed".to_string();
                    task.completed_at = Some(now_i64());
                    task.updated_at = now_i64();
                    task.artifacts.push(json!({
                        "type": "wander-result",
                        "label": "漫步结果",
                        "payload": result_value.clone(),
                        "historyId": history_id.clone(),
                    }));
                }
                append_runtime_task_trace(
                    store,
                    &task_id,
                    "wander.completed",
                    Some(json!({ "historyId": history_id.clone() })),
                );
                Ok(())
            })?;
            log_timing_event(
                state,
                "wander",
                &request_id,
                "history-saved",
                history_started_at,
                Some(format!("historyId={}", history_id)),
            );
            let _ = app.emit(
                "wander:progress",
                json!({
                    "requestId": request_id,
                    "taskId": task_id,
                    "sessionId": wander_session_id,
                    "phase": "complete",
                    "stepIndex": 3,
                    "totalSteps": 3,
                    "title": "保存结果",
                    "status": "completed",
                    "detail": "漫步完成，结果已写入历史记录。",
                }),
            );
            log_timing_event(
                state,
                "wander",
                &request_id,
                "request-complete",
                request_started_at,
                Some(format!(
                    "taskId={} sessionId={}",
                    task_id, wander_session_id
                )),
            );
            Ok(json!({ "result": result_text, "historyId": history_id, "items": items }))
        }
        "youtube:save-note" => {
            let input: YoutubeSavePayload = serde_json::from_value(payload)
                .map_err(|error| format!("YouTube note payload 无效: {error}"))?;
            let mut emitted_new: Option<(String, String)> = None;
            let result = with_store_mut(state, |store| {
                if let Some(existing) = store
                    .youtube_videos
                    .iter()
                    .find(|item| {
                        item.video_id == input.video_id || item.video_url == input.video_url
                    })
                    .cloned()
                {
                    return Ok(
                        json!({ "success": true, "duplicate": true, "noteId": existing.id }),
                    );
                }

                let record = YoutubeVideoRecord {
                    id: make_id("youtube"),
                    video_id: input.video_id,
                    video_url: input.video_url,
                    title: input.title.clone(),
                    original_title: Some(input.title),
                    description: input.description.unwrap_or_default(),
                    summary: Some(
                        "RedBox captured this video for later migration work.".to_string(),
                    ),
                    thumbnail_url: input.thumbnail_url.unwrap_or_default(),
                    has_subtitle: false,
                    subtitle_content: None,
                    status: Some("completed".to_string()),
                    created_at: now_iso(),
                    folder_path: None,
                };
                let note_id = record.id.clone();
                emitted_new = Some((record.id.clone(), record.title.clone()));
                store.youtube_videos.push(record);
                Ok(json!({ "success": true, "duplicate": false, "noteId": note_id }))
            })?;
            if let Some((note_id, title)) = emitted_new {
                let _ = app.emit(
                    "knowledge:new-youtube-video",
                    json!({ "noteId": note_id, "title": title, "status": "completed" }),
                );
            }
            Ok(result)
        }
        "knowledge:list" => {
            let _ = ensure_store_hydrated_for_knowledge(state);
            with_store(state, |store| {
                let mut items = store.knowledge_notes.clone();
                items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                Ok(json!(items))
            })
        }
        "knowledge:list-youtube" => {
            let _ = ensure_store_hydrated_for_knowledge(state);
            with_store(state, |store| {
                let mut items = store.youtube_videos.clone();
                items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                Ok(json!(items))
            })
        }
        "knowledge:docs:list" => {
            let _ = ensure_store_hydrated_for_knowledge(state);
            with_store(state, |store| {
                let mut items = store.document_sources.clone();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!(items))
            })
        }
        "knowledge:delete-youtube" => {
            let video_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store.youtube_videos.retain(|item| item.id != video_id);
                Ok(json!({ "success": true }))
            })?;
            let _ = app.emit(
                "knowledge:youtube-video-updated",
                json!({ "noteId": video_id, "status": "deleted" }),
            );
            Ok(result)
        }
        "knowledge:retry-youtube-subtitle" => {
            let video_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                let Some(video) = store
                    .youtube_videos
                    .iter_mut()
                    .find(|item| item.id == video_id)
                else {
                    return Ok(json!({ "success": false, "error": "视频记录不存在" }));
                };
                let subtitle = video
                    .subtitle_content
                    .clone()
                    .filter(|item| !item.trim().is_empty())
                    .unwrap_or_else(|| {
                        format!(
                            "RedBox recovered subtitle placeholder\n\n标题：{}\n链接：{}\n\n{}",
                            video.title, video.video_url, video.description
                        )
                    });
                video.subtitle_content = Some(subtitle.clone());
                video.has_subtitle = true;
                video.status = Some("completed".to_string());
                Ok(json!({ "success": true, "subtitleContent": subtitle }))
            })?;
            let _ = app.emit(
                "knowledge:youtube-video-updated",
                json!({ "noteId": video_id, "status": "completed" }),
            );
            Ok(result)
        }
        "knowledge:youtube-regenerate-summaries" => {
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let candidates = with_store(state, |store| {
                Ok(store
                    .youtube_videos
                    .iter()
                    .filter(|item| {
                        item.has_subtitle && item.summary.as_deref().unwrap_or("").trim().is_empty()
                    })
                    .map(|item| {
                        (
                            item.id.clone(),
                            item.title.clone(),
                            item.subtitle_content.clone().unwrap_or_default(),
                        )
                    })
                    .collect::<Vec<_>>())
            })?;
            let mut updates = Vec::new();
            for (video_id, title, subtitle) in &candidates {
                if subtitle.trim().is_empty() {
                    continue;
                }
                let prompt = format!(
                    "请基于下面的视频字幕，输出一段中文摘要，控制在 120 字以内。\n\n标题：{}\n\n字幕：\n{}",
                    title,
                    subtitle
                );
                let summary = generate_response_with_settings(&settings_snapshot, None, &prompt);
                updates.push((video_id.clone(), summary));
            }
            let updated_count = updates.len();
            with_store_mut(state, |store| {
                for (video_id, summary) in &updates {
                    if let Some(video) = store
                        .youtube_videos
                        .iter_mut()
                        .find(|item| item.id == *video_id)
                    {
                        video.summary = Some(summary.clone());
                    }
                }
                Ok(())
            })?;
            Ok(json!({ "success": true, "updated": updated_count }))
        }
        "knowledge:read-youtube-subtitle" => {
            let id = payload_value_as_string(&payload).unwrap_or_default();
            with_store(state, |store| {
                let content = store
                    .youtube_videos
                    .iter()
                    .find(|item| item.id == id || item.video_id == id)
                    .and_then(|item| item.subtitle_content.clone())
                    .unwrap_or_default();
                Ok(json!(content))
            })
        }
        "knowledge:delete" => {
            let note_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                let before = store.knowledge_notes.len();
                store.knowledge_notes.retain(|item| item.id != note_id);
                if before == store.knowledge_notes.len() {
                    return Ok(json!({ "success": false, "error": "笔记不存在" }));
                }
                Ok(json!({ "success": true }))
            })?;
            let _ = app.emit("knowledge:note-updated", json!({ "noteId": note_id }));
            Ok(result)
        }
        "knowledge:transcribe" => {
            let note_id = payload_value_as_string(&payload).unwrap_or_default();
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let note_snapshot = with_store(state, |store| {
                Ok(store
                    .knowledge_notes
                    .iter()
                    .find(|item| item.id == note_id)
                    .cloned())
            })?;
            let Some(note_snapshot) = note_snapshot else {
                return Ok(json!({ "success": false, "error": "笔记不存在" }));
            };
            let transcript = if let Some(video_source) = note_snapshot
                .video
                .clone()
                .or(note_snapshot.video_url.clone())
                .filter(|item| !item.trim().is_empty())
            {
                if let Some((endpoint, api_key, model_name)) =
                    resolve_transcription_settings(&settings_snapshot)
                {
                    let temp_dir = store_root(state)?.join("tmp");
                    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
                    let target_path = temp_dir.join(format!("knowledge-{}-media", note_id));
                    let source_path = resolve_local_path(&video_source);
                    let mime_type = if video_source.ends_with(".mp3")
                        || video_source.ends_with(".wav")
                        || video_source.ends_with(".m4a")
                    {
                        "audio/*"
                    } else {
                        "video/*"
                    };
                    let local_media_path =
                        if let Some(path) = source_path.filter(|path| path.exists()) {
                            path
                        } else {
                            let bytes = run_curl_bytes("GET", &video_source, None, &[], None)?;
                            fs::write(&target_path, bytes).map_err(|error| error.to_string())?;
                            target_path.clone()
                        };
                    run_curl_transcription(
                        &endpoint,
                        api_key.as_deref(),
                        &model_name,
                        &local_media_path,
                        mime_type,
                    )
                    .unwrap_or_else(|_| {
                        format!(
                            "RedBox transcript fallback\n\n标题：{}\n\n{}",
                            note_snapshot.title,
                            note_snapshot.content.chars().take(240).collect::<String>()
                        )
                    })
                } else {
                    format!(
                        "RedBox transcript fallback\n\n标题：{}\n\n{}",
                        note_snapshot.title,
                        note_snapshot.content.chars().take(240).collect::<String>()
                    )
                }
            } else {
                format!(
                    "RedBox transcript fallback\n\n标题：{}\n\n{}",
                    note_snapshot.title,
                    note_snapshot.content.chars().take(240).collect::<String>()
                )
            };
            let result = with_store_mut(state, |store| {
                let Some(note) = store
                    .knowledge_notes
                    .iter_mut()
                    .find(|item| item.id == note_id)
                else {
                    return Ok(json!({ "success": false, "error": "笔记不存在" }));
                };
                note.transcription_status = Some("completed".to_string());
                note.transcript = Some(transcript.clone());
                Ok(json!({
                    "success": true,
                    "transcript": note.transcript.clone(),
                }))
            })?;
            let _ = app.emit(
                "knowledge:note-updated",
                json!({ "noteId": note_id, "hasTranscript": true, "transcriptionStatus": "completed" }),
            );
            Ok(result)
        }
        "knowledge:docs:add-files"
        | "knowledge:docs:add-folder"
        | "knowledge:docs:add-obsidian-vault" => {
            let (kind, folder_name, title) = match channel {
                "knowledge:docs:add-files" => ("copied-file", "imported-files", "Imported Files"),
                "knowledge:docs:add-folder" => {
                    ("tracked-folder", "tracked-folder", "Tracked Folder")
                }
                _ => ("obsidian-vault", "obsidian-vault", "Obsidian Vault"),
            };

            let root = if channel == "knowledge:docs:add-files" {
                let selected = pick_files_native("选择要导入的文档文件", false, true)?;
                if selected.is_empty() {
                    return Ok(json!({ "success": false, "error": "未选择文件" }));
                }
                let batch_root =
                    knowledge_root(state)?.join(format!("{}-{}", folder_name, now_ms()));
                fs::create_dir_all(&batch_root).map_err(|error| error.to_string())?;
                for file in &selected {
                    let _ = copy_file_into_dir(file, &batch_root)?;
                }
                batch_root
            } else {
                let selected = pick_files_native(
                    if channel == "knowledge:docs:add-folder" {
                        "选择要追踪的文件夹"
                    } else {
                        "选择 Obsidian Vault 文件夹"
                    },
                    true,
                    false,
                )?;
                if let Some(folder) = selected.into_iter().next() {
                    folder
                } else {
                    return Ok(json!({ "success": false, "error": "未选择文件夹" }));
                }
            };
            if !root.exists() {
                fs::create_dir_all(&root).map_err(|error| error.to_string())?;
            }
            let file_count = count_files_in_dir(&root)?;
            let sample_files = collect_sample_files(&root, 6)?;
            let fallback_name = root
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(title)
                .to_string();
            let display_name = format!(
                "{} · {}",
                fallback_name,
                with_store(state, |store| Ok(store.active_space_id.clone()))?
            );
            let now = now_iso();
            let source = with_store_mut(state, |store| {
                if let Some(existing) = store
                    .document_sources
                    .iter_mut()
                    .find(|item| item.root_path == root.display().to_string())
                {
                    existing.file_count = file_count;
                    existing.sample_files = sample_files.clone();
                    existing.updated_at = now.clone();
                    return Ok(existing.clone());
                }
                let source = DocumentKnowledgeSourceRecord {
                    id: make_id("doc-source"),
                    kind: kind.to_string(),
                    name: display_name,
                    root_path: root.display().to_string(),
                    locked: kind != "tracked-folder",
                    indexing: false,
                    index_error: None,
                    file_count,
                    sample_files: sample_files.clone(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                store.document_sources.push(source.clone());
                Ok(source)
            })?;
            let _ = app.emit("knowledge:docs-updated", json!({ "sourceId": source.id }));
            Ok(json!({ "success": true, "source": source }))
        }
        "knowledge:docs:delete-source" => {
            let source_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                let before = store.document_sources.len();
                store.document_sources.retain(|item| item.id != source_id);
                if before == store.document_sources.len() {
                    return Ok(json!({ "success": false, "error": "文档源不存在" }));
                }
                Ok(json!({ "success": true }))
            })?;
            let _ = app.emit("knowledge:docs-updated", json!({ "sourceId": source_id }));
            Ok(result)
        }
        "file:show-in-folder" => {
            let source = payload_string(&payload, "source").unwrap_or_default();
            let Some(path) = resolve_local_path(&source) else {
                return Ok(json!({ "success": false, "error": "无效路径" }));
            };
            let target = if path.is_file() {
                path.parent().map(Path::to_path_buf).unwrap_or(path)
            } else {
                path
            };
            open::that(&target).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true }))
        }
        "file:copy-image" => {
            let source = payload_string(&payload, "source").unwrap_or_default();
            let Some(path) = resolve_local_path(&source) else {
                return Ok(json!({ "success": false, "error": "无效路径" }));
            };
            if !path.exists() {
                return Ok(json!({ "success": false, "error": "文件不存在" }));
            }
            copy_image_to_clipboard(&path)?;
            Ok(json!({ "success": true }))
        }
        "media:list" => {
            let _ = ensure_store_hydrated_for_media(state);
            with_store(state, |store| {
                let mut assets = store.media_assets.clone();
                assets.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!({ "success": true, "assets": assets }))
            })
        }
        "media:open-root" => {
            let root = media_root(state)?;
            open::that(&root).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": root.display().to_string() }))
        }
        "media:open" => {
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            let asset = with_store(state, |store| {
                Ok(store
                    .media_assets
                    .iter()
                    .find(|item| item.id == asset_id)
                    .cloned())
            })?;
            let Some(asset) = asset else {
                return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
            };
            let relative_media_path = asset.relative_path.clone().and_then(|rel| {
                media_root(state)
                    .ok()
                    .map(|root| root.join(rel).display().to_string())
            });
            if let Some(path) = asset.absolute_path.clone().or(relative_media_path) {
                open::that(&path).map_err(|error| error.to_string())?;
                return Ok(json!({ "success": true, "path": path }));
            }
            Ok(json!({ "success": false, "error": "媒体资产没有可打开的文件路径" }))
        }
        "media:update" => {
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            with_store_mut(state, |store| {
                let Some(asset) = store
                    .media_assets
                    .iter_mut()
                    .find(|item| item.id == asset_id)
                else {
                    return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                };
                asset.title = normalize_optional_string(payload_string(&payload, "title"));
                asset.project_id = normalize_optional_string(payload_string(&payload, "projectId"));
                asset.prompt = normalize_optional_string(payload_string(&payload, "prompt"));
                asset.updated_at = now_iso();
                Ok(json!({ "success": true, "asset": asset.clone() }))
            })
        }
        "media:bind" => {
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            let manuscript_path =
                normalize_optional_string(payload_string(&payload, "manuscriptPath"));
            with_store_mut(state, |store| {
                let Some(asset) = store
                    .media_assets
                    .iter_mut()
                    .find(|item| item.id == asset_id)
                else {
                    return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                };
                asset.bound_manuscript_path = manuscript_path;
                asset.updated_at = now_iso();
                Ok(json!({ "success": true, "asset": asset.clone() }))
            })
        }
        "media:delete" => {
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            with_store_mut(state, |store| {
                let before = store.media_assets.len();
                store.media_assets.retain(|item| item.id != asset_id);
                if before == store.media_assets.len() {
                    return Ok(json!({ "success": false, "error": "媒体资产不存在" }));
                }
                Ok(json!({ "success": true }))
            })
        }
        "media:import-files" => {
            let selected = pick_files_native("选择要导入媒体库的文件", false, true)?;
            if selected.is_empty() {
                return Ok(json!({ "success": false, "error": "未选择文件" }));
            }
            let imports_root = media_root(state)?.join("imports");
            fs::create_dir_all(&imports_root).map_err(|error| error.to_string())?;
            let imported = with_store_mut(state, |store| {
                let mut assets = Vec::new();
                for file in &selected {
                    let (relative_name, target) = copy_file_into_dir(file, &imports_root)?;
                    let (mime_type, _kind, _) = guess_mime_and_kind(&target);
                    let asset = MediaAssetRecord {
                        id: make_id("media"),
                        source: "imported".to_string(),
                        project_id: None,
                        title: file
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .map(ToString::to_string),
                        prompt: None,
                        provider: None,
                        provider_template: None,
                        model: None,
                        aspect_ratio: None,
                        size: None,
                        quality: None,
                        mime_type: Some(mime_type),
                        relative_path: Some(format!("imports/{}", relative_name)),
                        bound_manuscript_path: None,
                        created_at: now_iso(),
                        updated_at: now_iso(),
                        absolute_path: Some(target.display().to_string()),
                        preview_url: Some(file_url_for_path(&target)),
                        exists: true,
                    };
                    store.media_assets.push(asset.clone());
                    assets.push(asset);
                }
                Ok(assets)
            })?;
            Ok(json!({ "success": true, "assets": imported, "imported": imported.len() }))
        }
        "cover:list" => {
            let _ = ensure_store_hydrated_for_cover(state);
            with_store(state, |store| {
                let mut assets = store.cover_assets.clone();
                assets.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!({ "success": true, "assets": assets }))
            })
        }
        "cover:open-root" => {
            let root = cover_root(state)?;
            open::that(&root).map_err(|error| error.to_string())?;
            Ok(json!({ "success": true, "path": root.display().to_string() }))
        }
        "cover:open" => {
            let asset_id = payload_string(&payload, "assetId").unwrap_or_default();
            let asset = with_store(state, |store| {
                Ok(store
                    .cover_assets
                    .iter()
                    .find(|item| item.id == asset_id)
                    .cloned())
            })?;
            let Some(asset) = asset else {
                return Ok(json!({ "success": false, "error": "封面资产不存在" }));
            };
            let relative_cover_path = asset.relative_path.clone().and_then(|rel| {
                cover_root(state)
                    .ok()
                    .map(|root| root.join(rel).display().to_string())
            });
            if let Some(path) = relative_cover_path.or_else(|| asset.preview_url.clone()) {
                open::that(&path).map_err(|error| error.to_string())?;
                return Ok(json!({ "success": true, "path": path }));
            }
            Ok(json!({ "success": false, "error": "封面资产没有可打开的路径" }))
        }
        "cover:save-template-image" => {
            let image_source = payload_string(&payload, "imageSource").unwrap_or_default();
            if image_source.is_empty() {
                return Ok(json!({ "success": false, "error": "缺少模板图" }));
            }
            if let Some(source_path) =
                resolve_local_path(&image_source).filter(|path| path.exists())
            {
                let file_name = source_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| format!("cover-template-{}.png", now_ms()));
                let relative = format!("templates/{}", normalize_relative_path(&file_name));
                let target = cover_root(state)?.join(&relative);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::copy(&source_path, &target).map_err(|error| error.to_string())?;
                return Ok(json!({
                    "success": true,
                    "previewUrl": file_url_for_path(&target),
                    "relativePath": relative,
                }));
            }
            Ok(json!({ "success": true, "previewUrl": image_source }))
        }
        "cover:generate" => {
            let count = payload_field(&payload, "count")
                .and_then(|value| value.as_i64())
                .unwrap_or(1)
                .clamp(1, 4);
            let template_name = normalize_optional_string(payload_string(&payload, "templateName"));
            let provider = normalize_optional_string(payload_string(&payload, "provider"));
            let provider_template =
                normalize_optional_string(payload_string(&payload, "providerTemplate"));
            let model = normalize_optional_string(payload_string(&payload, "model"));
            let quality = normalize_optional_string(payload_string(&payload, "quality"));
            let titles = payload_field(&payload, "titles")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let prompt = titles
                .iter()
                .filter_map(|item| item.get("text").and_then(|value| value.as_str()))
                .collect::<Vec<_>>()
                .join(" / ");
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let real_image_config = resolve_image_generation_settings(&settings_snapshot);

            let created = with_store_mut(state, |store| {
                let mut assets = Vec::new();
                for index in 0..count {
                    let file_name = format!("cover-{}-{}.png", now_ms(), index + 1);
                    let relative_path = format!("generated/{}", file_name);
                    let absolute_path = cover_root(state)?.join(&relative_path);
                    let base_title = template_name
                        .clone()
                        .unwrap_or_else(|| "RedBox Cover".to_string());
                    let asset_title = if count > 1 {
                        format!("{base_title} {}", index + 1)
                    } else {
                        base_title
                    };
                    let mut wrote_real_asset = false;
                    if let Some((endpoint, api_key, default_model, _provider, _template)) =
                        &real_image_config
                    {
                        if let Ok(response) = run_image_generation_request(
                            endpoint,
                            api_key.as_deref(),
                            model
                                .clone()
                                .unwrap_or_else(|| default_model.clone())
                                .as_str(),
                            &prompt,
                            1,
                            None,
                            quality.as_deref(),
                        ) {
                            if let Some(item) = extract_first_media_result(&response) {
                                if write_generated_image_asset(&absolute_path, item).is_ok() {
                                    wrote_real_asset = true;
                                }
                            }
                        }
                    }
                    if !wrote_real_asset {
                        write_placeholder_svg(
                            &absolute_path,
                            &asset_title,
                            &prompt.chars().take(48).collect::<String>(),
                            "#F2B544",
                        )?;
                    }
                    let asset = CoverAssetRecord {
                        id: make_id("cover"),
                        title: Some(asset_title),
                        template_name: template_name.clone(),
                        prompt: normalize_optional_string(Some(prompt.clone())),
                        provider: provider.clone(),
                        provider_template: provider_template.clone(),
                        model: model.clone(),
                        aspect_ratio: Some("3:4".to_string()),
                        size: None,
                        quality: quality.clone(),
                        relative_path: Some(relative_path),
                        preview_url: Some(file_url_for_path(&absolute_path)),
                        exists: true,
                        updated_at: now_iso(),
                    };
                    store.cover_assets.push(asset.clone());
                    assets.push(asset);
                }
                store.work_items.push(create_work_item(
                    "cover-generation",
                    template_name
                        .clone()
                        .unwrap_or_else(|| "封面生成".to_string()),
                    normalize_optional_string(Some(if real_image_config.is_some() {
                        "RedBox 已尝试通过已配置图片 endpoint 生成封面。".to_string()
                    } else {
                        "RedBox 已保存封面生成请求；当前缺少图片 endpoint 配置，已生成可预览的本地 SVG 方案。".to_string()
                    })),
                    normalize_optional_string(Some(prompt.clone())),
                    None,
                    2,
                ));
                Ok(assets)
            })?;
            Ok(json!({ "success": true, "assets": created }))
        }
        "image-gen:generate" | "video-gen:generate" => {
            let count = payload_field(&payload, "count")
                .and_then(|value| value.as_i64())
                .unwrap_or(1)
                .clamp(1, 4);
            let prompt = normalize_optional_string(payload_string(&payload, "prompt"));
            let project_id = normalize_optional_string(payload_string(&payload, "projectId"));
            let title = normalize_optional_string(payload_string(&payload, "title"));
            let provider = normalize_optional_string(payload_string(&payload, "provider"));
            let provider_template =
                normalize_optional_string(payload_string(&payload, "providerTemplate"));
            let model = normalize_optional_string(payload_string(&payload, "model"));
            let aspect_ratio = normalize_optional_string(payload_string(&payload, "aspectRatio"));
            let size = normalize_optional_string(payload_string(&payload, "size"));
            let quality = normalize_optional_string(payload_string(&payload, "quality"));
            let mime_type = if channel == "video-gen:generate" {
                Some("video/mp4".to_string())
            } else {
                Some("image/png".to_string())
            };
            let source = if channel == "video-gen:generate" {
                "generated"
            } else {
                "generated"
            };
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let real_image_config = if channel == "image-gen:generate" {
                resolve_image_generation_settings(&settings_snapshot)
            } else {
                None
            };
            let real_video_config = if channel == "video-gen:generate" {
                resolve_video_generation_settings(&settings_snapshot)
            } else {
                None
            };

            let created = with_store_mut(state, |store| {
                let mut assets = Vec::new();
                for index in 0..count {
                    let mut effective_mime_type = mime_type.clone();
                    let mut file_ext = if channel == "video-gen:generate" {
                        "mp4"
                    } else {
                        "png"
                    };
                    let relative_path =
                        format!("generated/media-{}-{}.{}", now_ms(), index + 1, file_ext);
                    let mut relative_path = relative_path;
                    let mut absolute_path = media_root(state)?.join(&relative_path);
                    let preview_url = if channel == "video-gen:generate" {
                        let mut wrote_real_asset = false;
                        if let Some((endpoint, api_key, default_model)) = &real_video_config {
                            if let Ok(response) = run_video_generation_request(
                                endpoint,
                                api_key.as_deref(),
                                model
                                    .clone()
                                    .unwrap_or_else(|| default_model.clone())
                                    .as_str(),
                                &payload,
                            ) {
                                if let Some(item) = extract_first_media_result(&response) {
                                    if let Some(url) = extract_media_url(item).or_else(|| {
                                        poll_video_generation_result(
                                            endpoint,
                                            api_key.as_deref(),
                                            &response,
                                        )
                                    }) {
                                        let bytes = run_curl_bytes("GET", &url, None, &[], None)?;
                                        if let Some(parent) = absolute_path.parent() {
                                            fs::create_dir_all(parent)
                                                .map_err(|error| error.to_string())?;
                                        }
                                        fs::write(&absolute_path, bytes)
                                            .map_err(|error| error.to_string())?;
                                        wrote_real_asset = true;
                                    } else if let Some(b64) =
                                        item.get("b64_json").and_then(|value| value.as_str())
                                    {
                                        let bytes = decode_base64_bytes(b64)?;
                                        if let Some(parent) = absolute_path.parent() {
                                            fs::create_dir_all(parent)
                                                .map_err(|error| error.to_string())?;
                                        }
                                        fs::write(&absolute_path, bytes)
                                            .map_err(|error| error.to_string())?;
                                        wrote_real_asset = true;
                                    }
                                }
                            }
                        }
                        if !wrote_real_asset {
                            file_ext = "md";
                            effective_mime_type = Some("text/markdown".to_string());
                            relative_path =
                                format!("generated/media-{}-{}.{}", now_ms(), index + 1, file_ext);
                            absolute_path = media_root(state)?.join(&relative_path);
                            let fallback_note = format!(
                                "# Video Generation Fallback\n\nTitle: {}\n\nPrompt:\n{}\n\nThe configured video provider did not return a downloadable video within the polling window. This file records the request so it can be retried or inspected.",
                                title.clone().unwrap_or_else(|| "视频生成".to_string()),
                                prompt.clone().unwrap_or_default()
                            );
                            if let Some(parent) = absolute_path.parent() {
                                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                            }
                            fs::write(&absolute_path, fallback_note)
                                .map_err(|error| error.to_string())?;
                        }
                        None
                    } else {
                        let mut wrote_real_asset = false;
                        if let Some((endpoint, api_key, default_model, _provider, _template)) =
                            &real_image_config
                        {
                            let effective_prompt = match payload_field(&payload, "generationMode")
                                .and_then(|value| value.as_str())
                            {
                                Some("image-to-image") | Some("reference-guided") => format!(
                                    "{}\n\n请参考附带参考图的构图和风格生成最终图片。",
                                    prompt.clone().unwrap_or_default()
                                ),
                                _ => prompt.clone().unwrap_or_default(),
                            };
                            if let Ok(response) = run_image_generation_request(
                                endpoint,
                                api_key.as_deref(),
                                model
                                    .clone()
                                    .unwrap_or_else(|| default_model.clone())
                                    .as_str(),
                                &effective_prompt,
                                1,
                                size.as_deref(),
                                quality.as_deref(),
                            ) {
                                if let Some(item) = extract_first_media_result(&response) {
                                    if write_generated_image_asset(&absolute_path, item).is_ok() {
                                        wrote_real_asset = true;
                                    }
                                }
                            }
                        }
                        if !wrote_real_asset {
                            write_placeholder_svg(
                                &absolute_path,
                                &title.clone().unwrap_or_else(|| "RedBox Image".to_string()),
                                &prompt
                                    .clone()
                                    .unwrap_or_default()
                                    .chars()
                                    .take(48)
                                    .collect::<String>(),
                                "#E76F51",
                            )?;
                        }
                        Some(file_url_for_path(&absolute_path))
                    };
                    let asset = MediaAssetRecord {
                        id: make_id("media"),
                        source: source.to_string(),
                        project_id: project_id.clone(),
                        title: title
                            .clone()
                            .or_else(|| {
                                prompt
                                    .clone()
                                    .map(|item| item.chars().take(24).collect::<String>())
                            })
                            .map(|item| {
                                if count > 1 {
                                    format!("{item} {}", index + 1)
                                } else {
                                    item
                                }
                            }),
                        prompt: prompt.clone(),
                        provider: provider.clone(),
                        provider_template: provider_template.clone(),
                        model: model.clone(),
                        aspect_ratio: aspect_ratio.clone(),
                        size: size.clone(),
                        quality: quality.clone(),
                        mime_type: effective_mime_type.clone(),
                        relative_path: Some(relative_path),
                        bound_manuscript_path: None,
                        created_at: now_iso(),
                        updated_at: now_iso(),
                        absolute_path: Some(absolute_path.display().to_string()),
                        preview_url: preview_url.clone(),
                        exists: true,
                    };
                    store.media_assets.push(asset.clone());
                    assets.push(asset);
                }
                store.work_items.push(create_work_item(
                    if channel == "video-gen:generate" {
                        "video-generation"
                    } else {
                        "image-generation"
                    },
                    title.clone().unwrap_or_else(|| {
                        if channel == "video-gen:generate" {
                            "视频生成"
                        } else {
                            "图片生成"
                        }
                        .to_string()
                    }),
                    normalize_optional_string(Some(
                        if (channel == "image-gen:generate" && real_image_config.is_some())
                            || (channel == "video-gen:generate" && real_video_config.is_some())
                        {
                            "RedBox 已尝试通过已配置 endpoint 执行真实生成。".to_string()
                        } else {
                            "RedBox 已保存生成请求；当前缺少可用 provider 配置，已生成本地可追踪产物。".to_string()
                        },
                    )),
                    prompt.clone(),
                    project_id.clone().map(|value| {
                        json!({
                            "projectId": value,
                            "generationChannel": channel,
                            "usedConfiguredEndpoint": if channel == "video-gen:generate" {
                                real_video_config.is_some()
                            } else {
                                real_image_config.is_some()
                            }
                        })
                    }),
                    2,
                ));
                Ok(assets)
            })?;
            Ok(json!({ "success": true, "assets": created }))
        }
        "work:list" => {
            let _ = ensure_store_hydrated_for_work(state);
            with_store(state, |store| {
                let mut items = store.work_items.clone();
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!(items))
            })
        }
        "work:ready" => with_store(state, |store| {
            let mut items: Vec<WorkItemRecord> = store
                .work_items
                .iter()
                .filter(|item| {
                    item.effective_status == "ready" || item.effective_status == "pending"
                })
                .cloned()
                .collect();
            items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!(items))
        }),
        "work:get" => {
            let id = payload_string(&payload, "id").unwrap_or_default();
            with_store(state, |store| {
                Ok(store
                    .work_items
                    .iter()
                    .find(|item| item.id == id)
                    .cloned()
                    .map_or(Value::Null, |item| json!(item)))
            })
        }
        "work:update" => {
            let id = payload_string(&payload, "id").unwrap_or_default();
            let status = normalize_optional_string(payload_string(&payload, "status"));
            let title = normalize_optional_string(payload_string(&payload, "title"));
            let description = normalize_optional_string(payload_string(&payload, "description"));
            let summary = normalize_optional_string(payload_string(&payload, "summary"));
            with_store_mut(state, |store| {
                let Some(item) = store.work_items.iter_mut().find(|entry| entry.id == id) else {
                    return Ok(json!({ "success": false, "error": "工作项不存在" }));
                };
                if let Some(title) = title {
                    item.title = title;
                }
                if let Some(description) = description {
                    item.description = Some(description);
                }
                if let Some(summary) = summary {
                    item.summary = Some(summary);
                }
                if let Some(status) = status {
                    item.status = status.clone();
                    item.effective_status = match status.as_str() {
                        "pending" => "ready".to_string(),
                        other => other.to_string(),
                    };
                    item.completed_at = if status == "done" {
                        Some(now_iso())
                    } else {
                        None
                    };
                }
                item.updated_at = now_iso();
                Ok(json!({ "success": true, "item": item.clone() }))
            })
        }
        "archives:list" => with_store(state, |store| {
            let mut items = store.archive_profiles.clone();
            items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!(items))
        }),
        "archives:create" => {
            let profile = with_store_mut(state, |store| {
                let item = ArchiveProfileRecord {
                    id: make_id("archive-profile"),
                    name: payload_string(&payload, "name")
                        .unwrap_or_else(|| "未命名档案".to_string()),
                    platform: normalize_optional_string(payload_string(&payload, "platform")),
                    goal: normalize_optional_string(payload_string(&payload, "goal")),
                    domain: normalize_optional_string(payload_string(&payload, "domain")),
                    audience: normalize_optional_string(payload_string(&payload, "audience")),
                    tone_tags: payload_field(&payload, "toneTags")
                        .and_then(|value| value.as_array())
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|item| {
                                    item.as_str().map(|value| value.trim().to_string())
                                })
                                .filter(|value| !value.is_empty())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                    created_at: now_i64(),
                    updated_at: now_i64(),
                };
                store.archive_profiles.push(item.clone());
                Ok(item)
            })?;
            Ok(json!(profile))
        }
        "archives:update" => {
            let id = payload_string(&payload, "id").unwrap_or_default();
            with_store_mut(state, |store| {
                let Some(item) = store
                    .archive_profiles
                    .iter_mut()
                    .find(|entry| entry.id == id)
                else {
                    return Ok(json!({ "success": false, "error": "档案不存在" }));
                };
                if let Some(name) = normalize_optional_string(payload_string(&payload, "name")) {
                    item.name = name;
                }
                item.platform = normalize_optional_string(payload_string(&payload, "platform"));
                item.goal = normalize_optional_string(payload_string(&payload, "goal"));
                item.domain = normalize_optional_string(payload_string(&payload, "domain"));
                item.audience = normalize_optional_string(payload_string(&payload, "audience"));
                item.tone_tags = payload_field(&payload, "toneTags")
                    .and_then(|value| value.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|entry| {
                                entry.as_str().map(|value| value.trim().to_string())
                            })
                            .filter(|value| !value.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                item.updated_at = now_i64();
                Ok(json!({ "success": true, "profile": item.clone() }))
            })
        }
        "archives:delete" => {
            let id = payload_value_as_string(&payload).unwrap_or_default();
            with_store_mut(state, |store| {
                store.archive_profiles.retain(|item| item.id != id);
                store.archive_samples.retain(|item| item.profile_id != id);
                Ok(json!({ "success": true }))
            })
        }
        "archives:samples:list" => {
            let profile_id = payload_value_as_string(&payload).unwrap_or_default();
            with_store(state, |store| {
                let mut items: Vec<ArchiveSampleRecord> = store
                    .archive_samples
                    .iter()
                    .filter(|item| item.profile_id == profile_id)
                    .cloned()
                    .collect();
                items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                Ok(json!(items))
            })
        }
        "archives:samples:create" => {
            let sample = with_store_mut(state, |store| {
                let content = payload_string(&payload, "content").unwrap_or_default();
                let item = ArchiveSampleRecord {
                    id: make_id("archive-sample"),
                    profile_id: payload_string(&payload, "profileId").unwrap_or_default(),
                    title: normalize_optional_string(payload_string(&payload, "title")),
                    excerpt: normalize_optional_string(Some(
                        content.chars().take(160).collect::<String>(),
                    )),
                    content: Some(content),
                    tags: payload_field(&payload, "tags")
                        .and_then(|value| value.as_array())
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|entry| entry.as_str().map(ToString::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    images: Vec::new(),
                    platform: normalize_optional_string(payload_string(&payload, "platform")),
                    source_url: normalize_optional_string(payload_string(&payload, "sourceUrl")),
                    sample_date: normalize_optional_string(payload_string(&payload, "sampleDate")),
                    is_featured: if payload_field(&payload, "isFeatured")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        1
                    } else {
                        0
                    },
                    created_at: now_i64(),
                };
                store.archive_samples.push(item.clone());
                Ok(item)
            })?;
            let _ = app.emit(
                "archives:sample-created",
                json!({ "profileId": sample.profile_id.clone() }),
            );
            Ok(json!(sample))
        }
        "archives:samples:update" => {
            let id = payload_string(&payload, "id").unwrap_or_default();
            with_store_mut(state, |store| {
                let Some(item) = store
                    .archive_samples
                    .iter_mut()
                    .find(|entry| entry.id == id)
                else {
                    return Ok(json!({ "success": false, "error": "样本不存在" }));
                };
                let content = payload_string(&payload, "content").unwrap_or_default();
                item.profile_id = payload_string(&payload, "profileId")
                    .unwrap_or_else(|| item.profile_id.clone());
                item.title = normalize_optional_string(payload_string(&payload, "title"));
                item.content = Some(content.clone());
                item.excerpt =
                    normalize_optional_string(Some(content.chars().take(160).collect::<String>()));
                item.tags = payload_field(&payload, "tags")
                    .and_then(|value| value.as_array())
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|entry| entry.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                item.platform = normalize_optional_string(payload_string(&payload, "platform"));
                item.sample_date =
                    normalize_optional_string(payload_string(&payload, "sampleDate"));
                item.is_featured = if payload_field(&payload, "isFeatured")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    1
                } else {
                    0
                };
                Ok(json!({ "success": true, "sample": item.clone() }))
            })
        }
        "archives:samples:delete" => {
            let id = payload_value_as_string(&payload).unwrap_or_default();
            with_store_mut(state, |store| {
                store.archive_samples.retain(|item| item.id != id);
                Ok(json!({ "success": true }))
            })
        }
        "memory:list" => with_store(state, |store| {
            let mut items: Vec<UserMemoryRecord> = store
                .memories
                .iter()
                .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
                .cloned()
                .collect();
            items.sort_by(|a, b| {
                b.updated_at
                    .unwrap_or(b.created_at)
                    .cmp(&a.updated_at.unwrap_or(a.created_at))
            });
            Ok(json!(items))
        }),
        "memory:archived" => with_store(state, |store| {
            let mut items: Vec<UserMemoryRecord> = store
                .memories
                .iter()
                .filter(|item| item.status.as_deref() == Some("archived"))
                .cloned()
                .collect();
            items.sort_by(|a, b| b.archived_at.unwrap_or(0).cmp(&a.archived_at.unwrap_or(0)));
            Ok(json!(items))
        }),
        "memory:history" => with_store(state, |store| {
            let mut items = store.memory_history.clone();
            items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            Ok(json!(items))
        }),
        "memory:maintenance-status" => with_store(state, |store| {
            Ok(memory_maintenance_status_from_settings(&store.settings)
                .unwrap_or_else(default_memory_maintenance_status))
        }),
        "memory:maintenance-run" => run_memory_maintenance_with_reason(state, "manual"),
        "memory:search" => {
            let query = payload_string(&payload, "query")
                .unwrap_or_default()
                .to_lowercase();
            with_store(state, |store| {
                let results: Vec<Value> = store
                    .memories
                    .iter()
                    .filter(|item| item.content.to_lowercase().contains(&query))
                    .map(|item| {
                        let mut value = json!(item);
                        if let Some(object) = value.as_object_mut() {
                            object.insert("score".to_string(), json!(0.88));
                            object.insert("matchReasons".to_string(), json!(["content"]));
                        }
                        value
                    })
                    .collect();
                Ok(json!(results))
            })
        }
        "memory:add" => {
            let content = payload_string(&payload, "content").unwrap_or_default();
            let memory_type =
                payload_string(&payload, "type").unwrap_or_else(|| "general".to_string());
            let tags = payload_field(&payload, "tags")
                .and_then(|value| value.as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|entry| entry.as_str().map(ToString::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let memory = with_store_mut(state, |store| {
                let item = UserMemoryRecord {
                    id: make_id("memory"),
                    content: content.clone(),
                    r#type: memory_type.clone(),
                    tags,
                    created_at: now_i64(),
                    updated_at: Some(now_i64()),
                    last_accessed: None,
                    status: Some("active".to_string()),
                    archived_at: None,
                    archive_reason: None,
                    origin_id: None,
                    canonical_key: None,
                    revision: Some(1),
                    last_conflict_at: None,
                };
                store.memories.push(item.clone());
                store.memory_history.push(MemoryHistoryRecord {
                    id: make_id("memory-history"),
                    memory_id: item.id.clone(),
                    origin_id: item.id.clone(),
                    action: "create".to_string(),
                    reason: None,
                    timestamp: now_i64(),
                    before: None,
                    after: Some(json!(item.clone())),
                    archived_memory_id: None,
                });
                bump_memory_maintenance_mutation(store, "mutation");
                Ok(item)
            })?;
            let _ = with_store(state, |store| {
                let pending = memory_maintenance_status_from_settings(&store.settings)
                    .and_then(|value| value.get("pendingMutations").and_then(|v| v.as_i64()))
                    .unwrap_or(0);
                Ok(pending)
            })
            .and_then(|pending| {
                if pending >= 5 {
                    let _ = run_memory_maintenance_with_reason(state, "mutation");
                }
                Ok(())
            });
            Ok(json!(memory))
        }
        "memory:delete" => {
            let id = payload_value_as_string(&payload).unwrap_or_default();
            with_store_mut(state, |store| {
                if let Some(item) = store.memories.iter_mut().find(|entry| entry.id == id) {
                    item.status = Some("archived".to_string());
                    item.archived_at = Some(now_i64());
                    item.archive_reason = Some("manual-delete".to_string());
                    store.memory_history.push(MemoryHistoryRecord {
                        id: make_id("memory-history"),
                        memory_id: item.id.clone(),
                        origin_id: item.id.clone(),
                        action: "archive".to_string(),
                        reason: Some("manual-delete".to_string()),
                        timestamp: now_i64(),
                        before: None,
                        after: Some(json!(item.clone())),
                        archived_memory_id: Some(item.id.clone()),
                    });
                    bump_memory_maintenance_mutation(store, "mutation");
                }
                Ok(json!({ "success": true }))
            })?;
            let _ = with_store(state, |store| {
                let pending = memory_maintenance_status_from_settings(&store.settings)
                    .and_then(|value| value.get("pendingMutations").and_then(|v| v.as_i64()))
                    .unwrap_or(0);
                Ok(pending)
            })
            .and_then(|pending| {
                if pending >= 5 {
                    let _ = run_memory_maintenance_with_reason(state, "mutation");
                }
                Ok(())
            });
            Ok(json!({ "success": true }))
        }
        "skills:list" => with_store(state, |store| Ok(json!(store.skills.clone()))),
        "skills:create" => {
            let name = payload_string(&payload, "name").unwrap_or_default();
            if name.is_empty() {
                return Ok(json!({ "success": false, "error": "技能名称不能为空" }));
            }
            let created = with_store_mut(state, |store| {
                let item = SkillRecord {
                    name: name.clone(),
                    description: format!("{name} skill"),
                    location: format!("redbox://skills/{}", slug_from_relative_path(&name)),
                    body: format!("# {name}\n\nCreated by RedClaw for RedBox."),
                    source_scope: Some("user".to_string()),
                    is_builtin: Some(false),
                    disabled: Some(false),
                };
                store.skills.push(item.clone());
                Ok(item)
            })?;
            Ok(json!({ "success": true, "location": created.location }))
        }
        "skills:save" => {
            let location = payload_string(&payload, "location").unwrap_or_default();
            let content = payload_string(&payload, "content").unwrap_or_default();
            with_store_mut(state, |store| {
                let Some(skill) = store
                    .skills
                    .iter_mut()
                    .find(|item| item.location == location)
                else {
                    return Ok(json!({ "success": false, "error": "技能不存在" }));
                };
                skill.body = content;
                Ok(json!({ "success": true }))
            })
        }
        "skills:disable" | "skills:enable" => {
            let name = payload_string(&payload, "name").unwrap_or_default();
            let disabled = channel == "skills:disable";
            with_store_mut(state, |store| {
                let Some(skill) = store.skills.iter_mut().find(|item| item.name == name) else {
                    return Ok(json!({ "success": false, "error": "技能不存在" }));
                };
                skill.disabled = Some(disabled);
                Ok(json!({ "success": true }))
            })
        }
        "skills:market-install" => {
            let slug = payload_string(&payload, "slug").unwrap_or_default();
            if slug.is_empty() {
                return Ok(json!({ "success": false, "error": "缺少技能 slug" }));
            }
            let created = with_store_mut(state, |store| {
                let item = SkillRecord {
                    name: slug.clone(),
                    description: format!("Installed from market: {slug}"),
                    location: format!("redbox://skills/market/{}", slug),
                    body: format!(
                        "# {slug}\n\nThis skill was registered from the RedBox market installer.\n\nAdd the skill instructions here, or replace this body with content from the upstream skill package when a remote market source is configured."
                    ),
                    source_scope: Some("user".to_string()),
                    is_builtin: Some(false),
                    disabled: Some(false),
                };
                store.skills.push(item);
                Ok(json!({ "success": true, "displayName": slug }))
            })?;
            Ok(created)
        }
        "mcp:list" => with_store(state, |store| {
            Ok(json!({ "success": true, "servers": store.mcp_servers.clone() }))
        }),
        "mcp:save" => {
            let servers = payload_field(&payload, "servers")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let next: Vec<McpServerRecord> = servers
                .into_iter()
                .filter_map(|value| serde_json::from_value(value).ok())
                .collect();
            with_store_mut(state, |store| {
                store.mcp_servers = next.clone();
                Ok(json!({ "success": true, "servers": next }))
            })
        }
        "mcp:test" => {
            let server: McpServerRecord = payload_field(&payload, "server")
                .cloned()
                .ok_or_else(|| "缺少 server".to_string())
                .and_then(|value| {
                    serde_json::from_value(value).map_err(|error| error.to_string())
                })?;
            match test_mcp_server(&server) {
                Ok((message, detail)) => {
                    Ok(json!({ "success": true, "message": message, "detail": detail }))
                }
                Err(error) => {
                    Ok(json!({ "success": false, "message": error.clone(), "detail": error }))
                }
            }
        }
        "mcp:call" => {
            let server: McpServerRecord = payload_field(&payload, "server")
                .cloned()
                .ok_or_else(|| "缺少 server".to_string())
                .and_then(|value| {
                    serde_json::from_value(value).map_err(|error| error.to_string())
                })?;
            let method = payload_string(&payload, "method").unwrap_or_default();
            let params = payload_field(&payload, "params")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let session_id = payload_string(&payload, "sessionId");
            if method.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "缺少 method" }));
            }
            match invoke_mcp_server(&server, &method, params) {
                Ok(response) => {
                    if let Some(session_id) = session_id.clone() {
                        let _ = with_store_mut(state, |store| {
                            store.session_tool_results.push(SessionToolResultRecord {
                                id: make_id("tool-result"),
                                session_id,
                                call_id: make_id("call"),
                                tool_name: format!("mcp:{}", method),
                                command: server.command.clone().or(server.url.clone()),
                                success: true,
                                result_text: Some(response.to_string()),
                                summary_text: Some(format!("MCP {} succeeded", method)),
                                prompt_text: None,
                                original_chars: None,
                                prompt_chars: None,
                                truncated: false,
                                payload: Some(json!({ "server": server, "response": response })),
                                created_at: now_i64(),
                                updated_at: now_i64(),
                            });
                            Ok(())
                        });
                    }
                    Ok(json!({ "success": true, "response": response }))
                }
                Err(error) => {
                    if let Some(session_id) = session_id {
                        let _ = with_store_mut(state, |store| {
                            store.session_tool_results.push(SessionToolResultRecord {
                                id: make_id("tool-result"),
                                session_id,
                                call_id: make_id("call"),
                                tool_name: format!("mcp:{}", method),
                                command: server.command.clone().or(server.url.clone()),
                                success: false,
                                result_text: None,
                                summary_text: Some(error.clone()),
                                prompt_text: None,
                                original_chars: None,
                                prompt_chars: None,
                                truncated: false,
                                payload: Some(json!({ "server": server })),
                                created_at: now_i64(),
                                updated_at: now_i64(),
                            });
                            Ok(())
                        });
                    }
                    Ok(json!({ "success": false, "error": error }))
                }
            }
        }
        "mcp:discover-local" => {
            let items = discover_local_mcp_configs()
                .into_iter()
                .map(|(source_path, servers)| {
                    json!({
                        "sourcePath": source_path,
                        "count": servers.len(),
                        "servers": servers,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "success": true, "items": items }))
        }
        "mcp:import-local" => {
            let discovered = discover_local_mcp_configs();
            let mut merged = Vec::<McpServerRecord>::new();
            let mut sources = Vec::<String>::new();
            for (source_path, servers) in &discovered {
                sources.push(source_path.clone());
                merged.extend(servers.clone());
            }
            with_store_mut(state, |store| {
                if !merged.is_empty() {
                    store.mcp_servers = merged.clone();
                }
                Ok(json!({
                    "success": true,
                    "imported": merged.len(),
                    "total": merged.len(),
                    "sources": sources,
                    "servers": store.mcp_servers.clone()
                }))
            })
        }
        "mcp:oauth-status" => {
            let server_id = payload_string(&payload, "serverId").unwrap_or_default();
            with_store(state, |store| {
                let status = store
                    .mcp_servers
                    .iter()
                    .find(|item| item.id == server_id)
                    .and_then(|item| item.oauth.clone())
                    .unwrap_or_else(|| json!({}));
                Ok(json!({
                    "success": true,
                    "connected": status.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
                    "tokenPath": status.get("tokenPath").and_then(|v| v.as_str()).unwrap_or("")
                }))
            })
        }
        "assistant:daemon-status" => with_store(state, |store| {
            Ok(assistant_state_value(&store.assistant_state))
        }),
        "assistant:daemon-set-config" | "assistant:daemon-start" => {
            let enable_listening = channel == "assistant:daemon-start";
            let (status, host, port) = with_store_mut(state, |store| {
                store.assistant_state.enabled = payload_field(&payload, "enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(store.assistant_state.enabled);
                store.assistant_state.auto_start = payload_field(&payload, "autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(store.assistant_state.auto_start);
                store.assistant_state.keep_alive_when_no_window =
                    payload_field(&payload, "keepAliveWhenNoWindow")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(store.assistant_state.keep_alive_when_no_window);
                if let Some(host) = payload_string(&payload, "host") {
                    store.assistant_state.host = host;
                }
                if let Some(port) = payload_field(&payload, "port").and_then(|v| v.as_i64()) {
                    store.assistant_state.port = port;
                }
                if let Some(feishu) = payload_field(&payload, "feishu") {
                    store.assistant_state.feishu = feishu.clone();
                }
                if let Some(relay) = payload_field(&payload, "relay") {
                    store.assistant_state.relay = relay.clone();
                }
                if let Some(weixin) = payload_field(&payload, "weixin") {
                    store.assistant_state.weixin = weixin.clone();
                }
                if enable_listening {
                    store.assistant_state.enabled = true;
                    store.assistant_state.lock_state = "owner".to_string();
                    store.assistant_state.last_error =
                        Some("RedClaw assistant daemon is preparing local listener.".to_string());
                }
                Ok((
                    assistant_state_value(&store.assistant_state),
                    store.assistant_state.host.clone(),
                    store.assistant_state.port,
                ))
            })?;
            if enable_listening {
                let mut runtime_guard = state
                    .assistant_runtime
                    .lock()
                    .map_err(|_| "assistant runtime lock 已损坏".to_string())?;
                if runtime_guard.is_none() {
                    let stop = Arc::new(AtomicBool::new(false));
                    let join =
                        run_assistant_listener(app.clone(), host.clone(), port, stop.clone())?;
                    *runtime_guard = Some(AssistantRuntime {
                        stop,
                        join: Some(join),
                        host: host.clone(),
                        port,
                    });
                }
                drop(runtime_guard);
                let sidecar_status = {
                    let weixin =
                        with_store(state, |store| Ok(store.assistant_state.weixin.clone()))?;
                    let mut sidecar_guard = state
                        .assistant_sidecar
                        .lock()
                        .map_err(|_| "assistant sidecar lock 已损坏".to_string())?;
                    if sidecar_guard.is_none() {
                        match spawn_weixin_sidecar(&weixin) {
                            Ok(Some(runtime)) => {
                                let pid = runtime.pid;
                                *sidecar_guard = Some(runtime);
                                Some(Ok(pid))
                            }
                            Ok(None) => None,
                            Err(error) => Some(Err(error)),
                        }
                    } else {
                        sidecar_guard.as_ref().map(|runtime| Ok(runtime.pid))
                    }
                };
                let updated = with_store_mut(state, |store| {
                    store.assistant_state.listening = true;
                    store.assistant_state.last_error =
                        Some("RedClaw assistant daemon local listener is running.".to_string());
                    if let Some(status) = sidecar_status {
                        if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                            match status {
                                Ok(pid) => {
                                    object.insert("sidecarRunning".to_string(), json!(true));
                                    object.insert("sidecarPid".to_string(), json!(pid));
                                }
                                Err(error) => {
                                    object.insert("sidecarRunning".to_string(), json!(false));
                                    object.insert(
                                        "lastSidecarError".to_string(),
                                        json!(error.clone()),
                                    );
                                    store.assistant_state.last_error = Some(format!(
                                        "RedClaw assistant daemon is running; sidecar failed: {error}"
                                    ));
                                }
                            }
                        }
                    }
                    Ok(assistant_state_value(&store.assistant_state))
                })?;
                let snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
                emit_assistant_status(app, &snapshot);
                return Ok(updated);
            }
            let snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
            emit_assistant_status(app, &snapshot);
            Ok(status)
        }
        "assistant:daemon-stop" => {
            if let Ok(mut runtime_guard) = state.assistant_runtime.lock() {
                if let Some(mut runtime) = runtime_guard.take() {
                    runtime.stop.store(true, Ordering::Relaxed);
                    let _ = TcpStream::connect(format!("{}:{}", runtime.host, runtime.port));
                    if let Some(join) = runtime.join.take() {
                        let _ = join.join();
                    }
                }
            }
            let _ = stop_assistant_sidecar(state);
            let status = with_store_mut(state, |store| {
                store.assistant_state.listening = false;
                store.assistant_state.enabled = false;
                if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                    object.insert("sidecarRunning".to_string(), json!(false));
                    object.remove("sidecarPid");
                }
                store.assistant_state.last_error =
                    Some("RedClaw assistant daemon stopped.".to_string());
                Ok(assistant_state_value(&store.assistant_state))
            })?;
            let snapshot = with_store(state, |store| Ok(store.assistant_state.clone()))?;
            emit_assistant_status(app, &snapshot);
            Ok(status)
        }
        "assistant:daemon-weixin-login-start" => {
            let result = with_store_mut(state, |store| {
                let session_key = make_id("wx-login");
                let state_dir = format!("{}/assistant/weixin", store_root(state)?.display());
                if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                    object.insert("connected".to_string(), json!(false));
                    object.insert("stateDir".to_string(), json!(state_dir.clone()));
                }
                Ok(json!({
                    "success": true,
                    "sessionKey": session_key,
                    "qrcodeUrl": format!("redbox://assistant/weixin-login/{}", session_key),
                    "message": "RedBox 已生成本地微信登录会话。若已配置 sidecar，请使用 sidecar 日志中的真实二维码完成登录。",
                    "stateDir": state_dir
                }))
            })?;
            Ok(result)
        }
        "assistant:daemon-weixin-login-wait" => {
            let state_dir = with_store(state, |store| {
                Ok(store
                    .assistant_state
                    .weixin
                    .get("stateDir")
                    .and_then(|value| value.as_str())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        store_root(state)
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .join("assistant")
                            .join("weixin")
                    }))
            })?;
            let sidecar_state = read_weixin_sidecar_state(&state_dir);
            let result = with_store_mut(state, |store| {
                if let Some(object) = store.assistant_state.weixin.as_object_mut() {
                    if let Some(sidecar_state) = sidecar_state.clone() {
                        object.insert("connected".to_string(), json!(true));
                        if let Some(account_id) = sidecar_state.get("accountId").cloned() {
                            object.insert("accountId".to_string(), account_id.clone());
                            object.insert("availableAccountIds".to_string(), json!([account_id]));
                        }
                        if let Some(user_id) = sidecar_state.get("userId").cloned() {
                            object.insert("userId".to_string(), user_id);
                        }
                        if let Some(token) = sidecar_state.get("token").cloned() {
                            object.insert("token".to_string(), token);
                        }
                    } else {
                        object.insert("connected".to_string(), json!(false));
                    }
                }
                if let Some(sidecar_state) = sidecar_state {
                    Ok(json!({
                        "success": true,
                        "connected": true,
                        "message": "检测到微信 sidecar 登录状态。",
                        "accountId": sidecar_state.get("accountId").and_then(|value| value.as_str()).unwrap_or(""),
                        "userId": sidecar_state.get("userId").and_then(|value| value.as_str()).unwrap_or(""),
                        "stateDir": state_dir.display().to_string()
                    }))
                } else {
                    Ok(json!({
                        "success": true,
                        "connected": false,
                        "message": "尚未检测到微信 sidecar 登录状态，请扫码后重试。",
                        "stateDir": state_dir.display().to_string()
                    }))
                }
            })?;
            Ok(result)
        }
        "session-bridge:status" => Ok(json!({
            "enabled": true,
            "listening": false,
            "host": "127.0.0.1",
            "port": 0,
            "authToken": "",
            "websocketUrl": "",
            "httpBaseUrl": "",
            "subscriberCount": 0,
            "lastError": Value::Null,
        })),
        "session-bridge:list-sessions" => with_store(state, |store| {
            let mut sessions = store.chat_sessions.clone();
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(json!(sessions
                .iter()
                .map(|session| session_bridge_summary(session, &store))
                .collect::<Vec<_>>()))
        }),
        "session-bridge:get-session" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            with_store(state, |store| {
                let Some(session) = store
                    .chat_sessions
                    .iter()
                    .find(|item| item.id == session_id)
                else {
                    return Ok(Value::Null);
                };
                let transcript: Vec<SessionTranscriptRecord> = store
                    .session_transcript_records
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let checkpoints: Vec<SessionCheckpointRecord> = store
                    .session_checkpoints
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let tool_results: Vec<SessionToolResultRecord> = store
                    .session_tool_results
                    .iter()
                    .filter(|item| item.session_id == session_id)
                    .cloned()
                    .collect();
                let tasks: Vec<Value> = store
                    .runtime_tasks
                    .iter()
                    .filter(|task| task.owner_session_id.as_deref() == Some(session_id.as_str()))
                    .map(runtime_task_value)
                    .collect();
                let background_tasks = derived_background_tasks(&store);
                Ok(json!({
                    "session": {
                        "id": session.id,
                        "title": session.title,
                        "updatedAt": session.updated_at.parse::<i64>().unwrap_or(0),
                        "createdAt": session.created_at.parse::<i64>().unwrap_or(0),
                        "contextType": "chat",
                        "runtimeMode": "default",
                        "isBackgroundSession": false,
                        "ownerTaskCount": tasks.len(),
                        "backgroundTaskCount": background_tasks.len(),
                        "metadata": session.metadata,
                    },
                    "transcript": transcript,
                    "checkpoints": checkpoints,
                    "toolResults": tool_results,
                    "tasks": tasks,
                    "backgroundTasks": background_tasks,
                    "permissionRequests": [],
                }))
            })
        }
        "session-bridge:list-permissions" => Ok(json!([])),
        "session-bridge:create-session" => {
            let title =
                payload_string(&payload, "title").unwrap_or_else(|| "Session Bridge".to_string());
            let summary = with_store_mut(state, |store| {
                let session = ChatSessionRecord {
                    id: make_id("session"),
                    title,
                    created_at: now_iso(),
                    updated_at: now_iso(),
                    metadata: payload_field(&payload, "metadata").cloned(),
                };
                store.chat_sessions.push(session.clone());
                Ok(session_bridge_summary(&session, store))
            })?;
            Ok(summary)
        }
        "session-bridge:send-message" => {
            let session_id = payload_string(&payload, "sessionId").unwrap_or_default();
            let message = payload_string(&payload, "message").unwrap_or_default();
            let execution = execute_chat_exchange(
                None,
                state,
                Some(session_id.clone()),
                message.clone(),
                message,
                None,
                None,
                "session-bridge",
                "Session bridge message completed",
            )?;
            Ok(json!({ "accepted": true, "sessionId": execution.session_id }))
        }
        "session-bridge:resolve-permission" => Ok(json!({ "success": true })),
        "background-tasks:list" => {
            with_store(state, |store| Ok(json!(derived_background_tasks(&store))))
        }
        "background-tasks:get" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            with_store(state, |store| {
                let task = derived_background_tasks(&store)
                    .into_iter()
                    .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(task_id.as_str()))
                    .unwrap_or(Value::Null);
                Ok(task)
            })
        }
        "background-tasks:cancel" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.enabled = false;
                    task.last_error = Some("Cancelled from background tasks".to_string());
                    task.updated_at = now_iso();
                    return Ok(json!({ "success": true, "kind": "scheduled-task" }));
                }
                if let Some(task) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.enabled = false;
                    task.status = "cancelled".to_string();
                    task.last_error = Some("Cancelled from background tasks".to_string());
                    task.updated_at = now_iso();
                    return Ok(json!({ "success": true, "kind": "long-cycle" }));
                }
                if let Some(task) = store
                    .runtime_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.status = "cancelled".to_string();
                    task.updated_at = now_i64();
                    task.completed_at = Some(now_i64());
                    return Ok(json!({ "success": true, "kind": "runtime-task" }));
                }
                Ok(json!({ "success": false, "error": "后台任务不存在" }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "background-workers:get-pool-state" => Ok(json!({
            "json": [],
            "runtime": []
        })),
        "tools:diagnostics:list" => with_store(state, |store| {
            let mut items = vec![
                json!({
                    "name": "redbox_host",
                    "displayName": "RedBox Host",
                    "description": "Check local Rust host availability.",
                    "kind": "host",
                    "visibility": "developer",
                    "contexts": ["desktop"],
                    "availabilityStatus": "available",
                    "availabilityReason": "Rust host is compiled locally."
                }),
                json!({
                    "name": "tauri_runtime",
                    "displayName": "Tauri Runtime",
                    "description": "Check Tauri desktop runtime build pipeline.",
                    "kind": "host",
                    "visibility": "developer",
                    "contexts": ["desktop"],
                    "availabilityStatus": "available",
                    "availabilityReason": "Tauri debug build succeeds locally."
                }),
            ];
            for server in &store.mcp_servers {
                items.push(json!({
                    "name": format!("mcp_server:{}", server.id),
                    "displayName": format!("MCP · {}", server.name),
                    "description": "Run a real MCP tools/list probe against this configured server.",
                    "kind": "mcp",
                    "visibility": "developer",
                    "contexts": ["desktop"],
                    "availabilityStatus": if server.enabled { "available" } else { "missing_context" },
                    "availabilityReason": if server.enabled { "server configured in RedBox" } else { "server disabled" },
                }));
            }
            Ok(json!(items))
        }),
        "tools:diagnostics:run-direct" | "tools:diagnostics:run-ai" => {
            let tool_name =
                payload_string(&payload, "toolName").unwrap_or_else(|| "unknown".to_string());
            if let Some(server_id) = tool_name.strip_prefix("mcp_server:") {
                let server = with_store(state, |store| {
                    Ok(store
                        .mcp_servers
                        .iter()
                        .find(|item| item.id == server_id)
                        .cloned())
                })?;
                if let Some(server) = server {
                    let mode = if channel.ends_with("run-ai") {
                        "ai"
                    } else {
                        "direct"
                    };
                    return match invoke_mcp_server(&server, "tools/list", json!({})) {
                        Ok(response) => Ok(json!({
                            "success": true,
                            "mode": mode,
                            "toolName": tool_name,
                            "request": { "server": server, "method": "tools/list" },
                            "response": response,
                            "executionSucceeded": true
                        })),
                        Err(error) => Ok(json!({
                            "success": false,
                            "mode": mode,
                            "toolName": tool_name,
                            "request": { "server": server, "method": "tools/list" },
                            "error": error,
                            "executionSucceeded": false
                        })),
                    };
                }
            }
            Ok(json!({
                "success": true,
                "mode": if channel.ends_with("run-ai") { "ai" } else { "direct" },
                "toolName": tool_name,
                "request": payload,
                "response": { "status": "ok", "source": "lexbox-local-host" },
                "executionSucceeded": true
            }))
        }
        "tools:hooks:list" => with_store(state, |store| Ok(json!(store.runtime_hooks.clone()))),
        "tools:hooks:register" => {
            let hook = RuntimeHookRecord {
                id: make_id("hook"),
                event: payload_string(&payload, "event").unwrap_or_else(|| "tool".to_string()),
                r#type: payload_string(&payload, "type").unwrap_or_else(|| "log".to_string()),
                matcher: normalize_optional_string(payload_string(&payload, "matcher")),
                enabled: Some(
                    payload_field(&payload, "enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                ),
            };
            with_store_mut(state, |store| {
                store.runtime_hooks.push(hook.clone());
                Ok(json!({ "success": true, "hookId": hook.id }))
            })
        }
        "tools:hooks:remove" => {
            let hook_id = payload_string(&payload, "hookId")
                .or_else(|| payload_string(&payload, "id"))
                .unwrap_or_default();
            with_store_mut(state, |store| {
                store.runtime_hooks.retain(|item| item.id != hook_id);
                Ok(json!({ "success": true }))
            })
        }
        "ai:roles:list" => Ok(json!([
            {
                "roleId": "planner",
                "purpose": "负责拆解目标、确定阶段顺序、把任务转成明确执行步骤。",
                "systemPrompt": "你是任务规划者，优先澄清目标、阶段、依赖和落盘动作，不要直接跳到模糊回答。",
                "allowedToolPack": "redclaw",
                "inputSchema": "目标、上下文、约束、历史项目状态",
                "outputSchema": "阶段计划、执行建议、关键依赖、保存策略",
                "handoffContract": "把任务拆成可执行步骤，并给出下一角色所需最小输入。",
                "artifactTypes": ["plan", "task-outline"]
            },
            {
                "roleId": "researcher",
                "purpose": "负责检索知识、提取证据、整理素材、形成研究摘要。",
                "systemPrompt": "你是研究代理，优先检索证据、阅读素材、提炼事实，不要在证据不足时强行下结论。",
                "allowedToolPack": "knowledge",
                "inputSchema": "问题、知识来源、素材、已有假设",
                "outputSchema": "证据摘要、引用来源、结论边界、待验证点",
                "handoffContract": "输出给写作者或评审时，必须包含证据、结论和不确定项。",
                "artifactTypes": ["research-note", "evidence-summary"]
            },
            {
                "roleId": "copywriter",
                "purpose": "负责产出标题、正文、发布话术、完整稿件和成品文案。",
                "systemPrompt": "你是写作代理，目标是生成可直接交付和落盘的内容，而不是停留在聊天草稿。",
                "allowedToolPack": "redclaw",
                "inputSchema": "目标、受众、策略、素材、证据",
                "outputSchema": "完整稿件、标题包、标签、发布建议",
                "handoffContract": "完成正文后必须准备保存路径或项目归档信息。",
                "artifactTypes": ["manuscript", "title-pack", "copy-pack"]
            },
            {
                "roleId": "image-director",
                "purpose": "负责封面、配图、海报、图片策略和视觉执行指令。",
                "systemPrompt": "你是图像策略代理，负责把目标转成可执行的配图/封面方案，并推动真实出图或落盘。",
                "allowedToolPack": "redclaw",
                "inputSchema": "内容目标、风格要求、参考素材、输出形式",
                "outputSchema": "封面策略、图片提示词、视觉结构、保存方案",
                "handoffContract": "给执行层的输出必须是可以直接生成或保存的结构化内容。",
                "artifactTypes": ["image-plan", "cover-plan", "image-pack"]
            },
            {
                "roleId": "reviewer",
                "purpose": "负责校验结果是否符合需求、是否保存、是否存在幻觉或遗漏。",
                "systemPrompt": "你是质量评审代理，优先检查结果是否满足需求、是否真实落盘、是否存在伪成功。",
                "allowedToolPack": "redclaw",
                "inputSchema": "目标、执行结果、工具回执、产物路径",
                "outputSchema": "评审结论、问题列表、修正建议",
                "handoffContract": "如果结果不满足交付条件，明确指出缺口并阻止宣称成功。",
                "artifactTypes": ["review-report"]
            },
            {
                "roleId": "ops-coordinator",
                "purpose": "负责后台任务、自动化、记忆维护和持续执行任务的推进。",
                "systemPrompt": "你是运行协调代理，负责长任务推进、自动化配置、状态检查、恢复和后台维护。",
                "allowedToolPack": "redclaw",
                "inputSchema": "任务目标、调度需求、运行状态、失败原因",
                "outputSchema": "调度动作、运行状态、恢复策略、维护结论",
                "handoffContract": "输出必须明确包含下一步执行条件与当前状态。",
                "artifactTypes": ["automation-config", "ops-report"]
            }
        ])),
        "ai:detect-protocol" => {
            let base_url = payload_string(&payload, "baseURL").unwrap_or_default();
            let preset_id = payload_string(&payload, "presetId");
            let explicit = payload_string(&payload, "protocol");
            let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
            Ok(json!({ "success": true, "protocol": protocol }))
        }
        "ai:test-connection" => {
            let base_url = payload_string(&payload, "baseURL").unwrap_or_default();
            let api_key = payload_string(&payload, "apiKey");
            let preset_id = payload_string(&payload, "presetId");
            let explicit = payload_string(&payload, "protocol");
            let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
            let models = fetch_models_by_protocol(&protocol, &base_url, api_key.as_deref())?;
            Ok(json!({
                "success": true,
                "protocol": protocol,
                "message": format!("连接成功，发现 {} 个模型", models.len())
            }))
        }
        "ai:fetch-models" => {
            let base_url = payload_string(&payload, "baseURL").unwrap_or_default();
            let api_key = payload_string(&payload, "apiKey");
            let preset_id = payload_string(&payload, "presetId");
            let explicit = payload_string(&payload, "protocol");
            let protocol = infer_protocol(&base_url, preset_id.as_deref(), explicit.as_deref());
            Ok(json!(fetch_models_by_protocol(
                &protocol,
                &base_url,
                api_key.as_deref()
            )?))
        }
        "advisors:list" => {
            let _ = ensure_store_hydrated_for_advisors(state);
            with_store(state, |store| {
                let mut advisors = store.advisors.clone();
                advisors.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                Ok(json!(advisors))
            })
        }
        "advisors:create" => {
            let advisor = with_store_mut(state, |store| {
                let timestamp = now_iso();
                let advisor = AdvisorRecord {
                    id: make_id("advisor"),
                    name: payload_string(&payload, "name")
                        .unwrap_or_else(|| "未命名成员".to_string()),
                    avatar: payload_string(&payload, "avatar").unwrap_or_else(|| "🧠".to_string()),
                    personality: payload_string(&payload, "personality").unwrap_or_default(),
                    system_prompt: payload_string(&payload, "systemPrompt").unwrap_or_default(),
                    knowledge_language: normalize_optional_string(payload_string(
                        &payload,
                        "knowledgeLanguage",
                    )),
                    knowledge_files: Vec::new(),
                    youtube_channel: payload_field(&payload, "youtubeChannel").cloned(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                };
                store.advisors.push(advisor.clone());
                Ok(advisor)
            })?;
            let _ = app.emit(
                "advisors:changed",
                json!({ "advisorId": advisor.id.clone() }),
            );
            Ok(json!({ "success": true, "id": advisor.id }))
        }
        "advisors:update" => {
            let advisor_id = payload_string(&payload, "id").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
                else {
                    return Ok(json!({ "success": false, "error": "成员不存在" }));
                };
                if let Some(name) = payload_string(&payload, "name") {
                    advisor.name = name;
                }
                if let Some(avatar) = payload_string(&payload, "avatar") {
                    advisor.avatar = avatar;
                }
                if let Some(personality) = payload_string(&payload, "personality") {
                    advisor.personality = personality;
                }
                if let Some(system_prompt) = payload_string(&payload, "systemPrompt") {
                    advisor.system_prompt = system_prompt;
                }
                if payload_field(&payload, "knowledgeLanguage").is_some() {
                    advisor.knowledge_language =
                        normalize_optional_string(payload_string(&payload, "knowledgeLanguage"));
                }
                if let Some(youtube_channel) = payload_field(&payload, "youtubeChannel") {
                    advisor.youtube_channel = Some(youtube_channel.clone());
                }
                advisor.updated_at = now_iso();
                Ok(json!({ "success": true, "advisor": advisor.clone() }))
            })?;
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:delete" => {
            let advisor_id = payload_value_as_string(&payload).unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store.advisors.retain(|item| item.id != advisor_id);
                store
                    .advisor_videos
                    .retain(|item| item.advisor_id != advisor_id);
                for room in &mut store.chat_rooms {
                    room.advisor_ids.retain(|item| item != &advisor_id);
                }
                Ok(json!({ "success": true }))
            })?;
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:upload-knowledge" => {
            let advisor_id = payload_value_as_string(&payload).unwrap_or_default();
            let selected = pick_files_native("选择要导入该成员知识库的文件", false, true)?;
            if selected.is_empty() {
                return Ok(json!({ "success": false, "error": "未选择文件" }));
            }
            let target_dir = advisor_knowledge_dir(state, &advisor_id)?;
            let imported = with_store_mut(state, |store| {
                let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
                else {
                    return Ok(json!({ "success": false, "error": "成员不存在" }));
                };
                let mut imported_files = Vec::new();
                for file in &selected {
                    let (relative_name, _) = copy_file_into_dir(file, &target_dir)?;
                    if !advisor.knowledge_files.contains(&relative_name) {
                        advisor.knowledge_files.push(relative_name.clone());
                    }
                    imported_files.push(relative_name);
                }
                advisor.updated_at = now_iso();
                Ok(json!({ "success": true, "files": imported_files }))
            })?;
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(imported)
        }
        "advisors:delete-knowledge" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let file_name = payload_string(&payload, "fileName").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
                else {
                    return Ok(json!({ "success": false, "error": "成员不存在" }));
                };
                advisor.knowledge_files.retain(|item| item != &file_name);
                advisor.updated_at = now_iso();
                Ok(json!({ "success": true }))
            })?;
            let path = advisor_knowledge_dir(state, &advisor_id)?.join(&file_name);
            let _ = fs::remove_file(path);
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:optimize-prompt" => {
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let info = payload_string(&payload, "info").unwrap_or_default();
            let system_prompt = load_redbox_prompt("runtime/advisors/optimize_system.txt")
                .unwrap_or_else(|| {
                    "你是一个专业��� Prompt 工程师，直接返回优化后的系统提示词正文。".to_string()
                });
            let optimized = generate_structured_response_with_settings(
                &settings_snapshot,
                None,
                &system_prompt,
                &info,
                false,
            )
            .unwrap_or_else(|_| generate_response_with_settings(&settings_snapshot, None, &info));
            Ok(json!({ "success": true, "prompt": optimized }))
        }
        "advisors:optimize-prompt-deep" => {
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let name = payload_string(&payload, "name").unwrap_or_else(|| "智囊团成员".to_string());
            let personality = payload_string(&payload, "personality").unwrap_or_default();
            let current_prompt = payload_string(&payload, "currentPrompt").unwrap_or_default();
            let system_prompt = load_redbox_prompt("runtime/advisors/optimize_deep_system.txt")
                .unwrap_or_else(|| "你是一位专业的 AI 角色设计师和 Prompt 工程师。".to_string());
            let user_prompt = format!(
                "成员名称：{}\n人格描述：{}\n\n当前提示词：\n{}",
                name, personality, current_prompt
            );
            let optimized = generate_structured_response_with_settings(
                &settings_snapshot,
                None,
                &system_prompt,
                &user_prompt,
                false,
            )
            .unwrap_or_else(|_| {
                generate_response_with_settings(&settings_snapshot, None, &user_prompt)
            });
            Ok(json!({ "success": true, "prompt": optimized }))
        }
        "advisors:generate-persona" => {
            let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let channel_name = payload_string(&payload, "channelName")
                .unwrap_or_else(|| "YouTube 频道".to_string());
            let channel_description =
                payload_string(&payload, "channelDescription").unwrap_or_default();
            let video_titles = payload_field(&payload, "videoTitles")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .collect::<Vec<_>>()
                        .join(" / ")
                })
                .unwrap_or_default();
            let knowledge_language =
                payload_string(&payload, "knowledgeLanguage").unwrap_or_else(|| "中文".to_string());
            let subject_names = vec![channel_name.clone()];
            let existing_context = with_store(state, |store| {
                Ok(load_advisor_existing_context(&store, &advisor_id))
            })?;
            let advisor_knowledge = collect_advisor_knowledge_evidence(state, &advisor_id)?;
            let manuscript_evidence = collect_related_manuscript_evidence(state, &subject_names)?;
            let search_results = search_web_with_settings(
                &settings_snapshot,
                &format!("{channel_name} YouTube 博主 创作者 频道定位 内容风格"),
                6,
            )
            .unwrap_or_default();
            let (skill_name, skill_body, skill_references, skill_scripts) =
                load_skill_bundle_sections("agent-persona-creator");
            let search_summary = if search_results.is_empty() {
                "(无外部搜索结果)".to_string()
            } else {
                search_results
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        format!(
                            "Result {}\nTitle: {}\nURL: {}\nSnippet: {}",
                            index + 1,
                            item.get("title")
                                .and_then(|value| value.as_str())
                                .unwrap_or(""),
                            item.get("url")
                                .and_then(|value| value.as_str())
                                .unwrap_or(""),
                            item.get("snippet")
                                .and_then(|value| value.as_str())
                                .unwrap_or(""),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };
            let research_system_prompt =
                load_redbox_prompt("runtime/advisors/generate_persona_research_system.txt")
                    .map(|template| {
                        render_redbox_prompt(
                            &template,
                            &[
                                ("skill_name", skill_name.clone()),
                                ("skill_body", skill_body.clone()),
                                ("skill_references", skill_references.clone()),
                                ("skill_scripts", skill_scripts.clone()),
                            ],
                        )
                    })
                    .unwrap_or_else(|| {
                        "你是 RedBox 内部的智囊团角色研究代理，负责做角色研究并输出严格 JSON。"
                            .to_string()
                    });
            let research_user_template =
                load_redbox_prompt("runtime/advisors/generate_persona_research_user.txt")
                    .unwrap_or_else(|| "请根据证据做角色研究并输出严格 JSON。".to_string());
            let research_user_prompt = render_redbox_prompt(
                &research_user_template,
                &[
                    ("channel_name", channel_name.clone()),
                    ("knowledge_language", knowledge_language.clone()),
                    (
                        "channel_description",
                        if channel_description.trim().is_empty() {
                            "(无频道描述)".to_string()
                        } else {
                            channel_description.clone()
                        },
                    ),
                    (
                        "video_titles",
                        if video_titles.trim().is_empty() {
                            "(无视频标题)".to_string()
                        } else {
                            video_titles
                                .split(" / ")
                                .enumerate()
                                .map(|(index, title)| format!("{}. {}", index + 1, title))
                                .collect::<Vec<_>>()
                                .join("\n")
                        },
                    ),
                    ("search_summary", search_summary.clone()),
                    ("existing_context", existing_context),
                    (
                        "advisor_knowledge_corpus",
                        render_named_corpus(
                            "Knowledge Evidence",
                            &advisor_knowledge,
                            "(无 advisor 知识文件)",
                        ),
                    ),
                    (
                        "manuscript_corpus",
                        render_named_corpus(
                            "Manuscript Evidence",
                            &manuscript_evidence,
                            "(无关联稿件命中)",
                        ),
                    ),
                ],
            );
            let research_raw = generate_structured_response_with_settings(
                &settings_snapshot,
                None,
                &research_system_prompt,
                &research_user_prompt,
                true,
            )
            .unwrap_or_else(|_| {
                generate_response_with_settings(
                    &settings_snapshot,
                    None,
                    &format!(
                        "请为一个基于 YouTube 频道创建的智囊团成员生成研究 JSON。频道名：{}，频道简介：{}，视频标题：{}",
                        channel_name, channel_description, video_titles
                    ),
                )
            });
            let research = parse_json_value_from_text(&research_raw).unwrap_or_else(|| json!({}));
            let final_system_prompt =
                load_redbox_prompt("runtime/advisors/generate_persona_final_system.txt")
                    .map(|template| {
                        render_redbox_prompt(
                            &template,
                            &[
                                ("skill_name", skill_name),
                                ("skill_body", skill_body),
                                ("skill_references", skill_references),
                                ("skill_scripts", skill_scripts),
                            ],
                        )
                    })
                    .unwrap_or_else(|| {
                        "你是 RedBox 内部的智囊团角色文档生成代理，只输出最终 Markdown 文档。"
                            .to_string()
                    });
            let final_user_template =
                load_redbox_prompt("runtime/advisors/generate_persona_final_user.txt")
                    .unwrap_or_else(|| "请根据研究结果输出最终智囊团角色文档。".to_string());
            let final_user_prompt = render_redbox_prompt(
                &final_user_template,
                &[
                    ("channel_name", channel_name.clone()),
                    ("knowledge_language", knowledge_language),
                    (
                        "research_json",
                        serde_json::to_string_pretty(&research)
                            .unwrap_or_else(|_| "{}".to_string()),
                    ),
                    ("search_summary", search_summary),
                    (
                        "advisor_knowledge_corpus",
                        render_named_corpus(
                            "Knowledge Evidence",
                            &advisor_knowledge,
                            "(无 advisor 知识文件)",
                        ),
                    ),
                    (
                        "manuscript_corpus",
                        render_named_corpus(
                            "Manuscript Evidence",
                            &manuscript_evidence,
                            "(无关联稿件命中)",
                        ),
                    ),
                ],
            );
            let final_markdown = generate_structured_response_with_settings(
                &settings_snapshot,
                None,
                &final_system_prompt,
                &final_user_prompt,
                false,
            )
            .unwrap_or_else(|_| {
                generate_response_with_settings(&settings_snapshot, None, &final_user_prompt)
            });
            let prompt = research
                .get("prompt")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    research
                        .get("description")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| final_markdown.clone());
            let personality = research
                .get("personality")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    research
                        .get("personality_summary")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| format!("模仿 {} 的内容风格与表达方式", channel_name));
            Ok(json!({
                "success": true,
                "prompt": final_markdown,
                "personality": personality,
                "research": research,
                "systemPrompt": prompt
            }))
        }
        "advisors:select-avatar" => {
            let selected = pick_files_native("选择成员头像图片", false, false)?;
            let Some(path) = selected.into_iter().next() else {
                return Ok(Value::Null);
            };
            let target_dir = advisor_avatar_dir(state)?;
            let (_, copied) = copy_file_into_dir(&path, &target_dir)?;
            Ok(json!(file_url_for_path(&copied)))
        }
        "advisors:youtube-runner-status" => {
            let status = with_store(state, |store| {
                let enabled = store.advisors.iter().any(|advisor| {
                    advisor
                        .youtube_channel
                        .as_ref()
                        .and_then(|value| value.get("backgroundEnabled"))
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                });
                Ok(json!({
                    "success": true,
                    "status": {
                        "enabled": enabled,
                        "isTicking": false,
                        "tickIntervalMinutes": 180,
                        "lastTickAt": store.legacy_imported_at,
                        "nextTickAt": Value::Null,
                        "lastError": Value::Null
                    }
                }))
            })?;
            Ok(status)
        }
        "advisors:fetch-youtube-info" => {
            let channel_url = payload_string(&payload, "channelUrl").unwrap_or_default();
            let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(&channel_url);
            let fetched =
                detect_ytdlp().and_then(|_| fetch_ytdlp_channel_info(&channel_url, 6).ok());
            let channel_id = fetched
                .as_ref()
                .and_then(|value| value.get("channel_id").and_then(|item| item.as_str()))
                .map(|item| item.to_string())
                .unwrap_or(fallback_channel_id);
            let channel_name = fetched
                .as_ref()
                .and_then(|value| {
                    value
                        .get("channel")
                        .or_else(|| value.get("uploader"))
                        .or_else(|| value.get("title"))
                        .and_then(|item| item.as_str())
                })
                .map(|item| item.to_string())
                .unwrap_or(fallback_channel_name);
            let channel_description = fetched
                .as_ref()
                .and_then(|value| value.get("description").and_then(|item| item.as_str()))
                .map(|item| item.to_string())
                .unwrap_or_else(|| {
                    format!("RedBox 已根据频道链接 {} 建立本地频道画像。", channel_url)
                });
            let avatar_url = fetched
                .as_ref()
                .and_then(|value| {
                    value
                        .get("thumbnails")
                        .and_then(|item| item.as_array())
                        .and_then(|items| items.last())
                        .and_then(|item| item.get("url"))
                        .and_then(|item| item.as_str())
                })
                .unwrap_or("")
                .to_string();
            let recent_videos = fetched
                .as_ref()
                .map(|value| {
                    value
                        .get("entries")
                        .and_then(|item| item.as_array())
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .take(5)
                        .filter_map(|entry| {
                            let id = entry.get("id").and_then(|item| item.as_str())?;
                            let title = entry
                                .get("title")
                                .and_then(|item| item.as_str())
                                .unwrap_or("Untitled");
                            Some(json!({ "id": id, "title": title }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| {
                    (0..5)
                        .map(|index| {
                            json!({
                                "id": format!("{}-{}", channel_id, index + 1),
                                "title": format!("{} · 最近视频 {}", channel_name, index + 1)
                            })
                        })
                        .collect::<Vec<_>>()
                });
            Ok(json!({
                "success": true,
                "data": {
                    "channelId": channel_id,
                    "channelName": channel_name,
                    "channelDescription": channel_description,
                    "avatarUrl": avatar_url,
                    "recentVideos": recent_videos
                }
            }))
        }
        "advisors:download-youtube-subtitles" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let channel_url = payload_string(&payload, "channelUrl").unwrap_or_default();
            let count = payload_field(&payload, "videoCount")
                .and_then(|value| value.as_i64())
                .unwrap_or(10)
                .max(1);
            let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(&channel_url);
            let fetched =
                detect_ytdlp().and_then(|_| fetch_ytdlp_channel_info(&channel_url, count).ok());
            let channel_id = fetched
                .as_ref()
                .and_then(|value| value.get("channel_id").and_then(|item| item.as_str()))
                .map(|item| item.to_string())
                .unwrap_or(fallback_channel_id);
            let channel_name = fetched
                .as_ref()
                .and_then(|value| {
                    value
                        .get("channel")
                        .or_else(|| value.get("uploader"))
                        .or_else(|| value.get("title"))
                        .and_then(|item| item.as_str())
                })
                .map(|item| item.to_string())
                .unwrap_or(fallback_channel_name);
            let real_videos = fetched
                .as_ref()
                .map(|value| parse_ytdlp_videos(&advisor_id, Some(&channel_id), value))
                .unwrap_or_default();
            let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
            let mut success_count = 0_i64;
            for index in 0..count {
                let _ = app.emit(
                    "advisors:download-progress",
                    json!({ "advisorId": advisor_id, "progress": format!("正在处理第 {} / {} 个视频...", index + 1, count) }),
                );
                let video = real_videos.get(index as usize).cloned().unwrap_or_else(|| {
                    AdvisorVideoRecord {
                        id: format!("{}-{}", channel_id, index + 1),
                        advisor_id: advisor_id.clone(),
                        title: format!("{} · 视频 {}", channel_name, index + 1),
                        published_at: now_iso(),
                        status: "pending".to_string(),
                        retry_count: 0,
                        error_message: None,
                        subtitle_file: None,
                        video_url: Some(format!(
                            "{}/videos/{}",
                            channel_url.trim_end_matches('/'),
                            format!("{}-{}", channel_id, index + 1)
                        )),
                        channel_id: Some(channel_id.clone()),
                        created_at: now_iso(),
                        updated_at: now_iso(),
                    }
                });
                let video_id = video.id.clone();
                let subtitle_path = if let Some(video_url) = video.video_url.clone() {
                    download_ytdlp_subtitle(
                        &video_url,
                        &knowledge_dir,
                        &slug_from_relative_path(&video_id),
                    )
                    .unwrap_or_else(|_| {
                        let fallback = knowledge_dir.join(format!(
                            "{}-subtitle-{}.txt",
                            slug_from_relative_path(&channel_id),
                            index + 1
                        ));
                        let _ = fs::write(
                            &fallback,
                            format!(
                                "RedBox generated subtitle fallback\n\n频道：{}\n视频：{}\n来源：{}\n",
                                channel_name, video_id, channel_url
                            ),
                        );
                        fallback
                    })
                } else {
                    let fallback = knowledge_dir.join(format!(
                        "{}-subtitle-{}.txt",
                        slug_from_relative_path(&channel_id),
                        index + 1
                    ));
                    fs::write(
                        &fallback,
                        format!(
                            "RedBox generated subtitle fallback\n\n频道：{}\n视频：{}\n来源：{}\n",
                            channel_name, video_id, channel_url
                        ),
                    )
                    .map_err(|error| error.to_string())?;
                    fallback
                };
                let subtitle_name = subtitle_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("subtitle.txt")
                    .to_string();
                let subtitle_content = read_text_file_or_empty(&subtitle_path);
                let video_title = video.title.clone();
                let video_published_at = video.published_at.clone();
                let video_url_saved = video.video_url.clone();
                with_store_mut(state, |store| {
                    if let Some(advisor) =
                        store.advisors.iter_mut().find(|item| item.id == advisor_id)
                    {
                        advisor.youtube_channel = Some(build_advisor_youtube_channel(
                            advisor.youtube_channel.as_ref(),
                            &channel_url,
                            &channel_id,
                        ));
                        if !advisor.knowledge_files.contains(&subtitle_name) {
                            advisor.knowledge_files.push(subtitle_name.clone());
                        }
                        advisor.updated_at = now_iso();
                    }
                    if let Some(video) = store
                        .advisor_videos
                        .iter_mut()
                        .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                    {
                        video.title = video_title.clone();
                        video.published_at = video_published_at.clone();
                        video.video_url = video_url_saved.clone();
                        video.status = "success".to_string();
                        video.subtitle_file = Some(subtitle_name.clone());
                        video.updated_at = now_iso();
                        video.error_message = None;
                    } else {
                        store.advisor_videos.push(AdvisorVideoRecord {
                            id: video_id.clone(),
                            advisor_id: advisor_id.clone(),
                            title: video_title.clone(),
                            published_at: video_published_at.clone(),
                            status: "success".to_string(),
                            retry_count: 0,
                            error_message: None,
                            subtitle_file: Some(subtitle_name.clone()),
                            video_url: video_url_saved.clone(),
                            channel_id: Some(channel_id.clone()),
                            created_at: now_iso(),
                            updated_at: now_iso(),
                        });
                    }
                    if !store
                        .youtube_videos
                        .iter()
                        .any(|item| item.video_id == video_id)
                    {
                        store.youtube_videos.push(YoutubeVideoRecord {
                            id: make_id("youtube"),
                            video_id: video_id.clone(),
                            video_url: video_url_saved.clone().unwrap_or_else(|| {
                                format!("{}/videos/{}", channel_url.trim_end_matches('/'), video_id)
                            }),
                            title: video_title.clone(),
                            original_title: None,
                            description: format!("Imported from advisor channel {}", channel_name),
                            summary: Some(
                                "RedBox imported this advisor video into the knowledge store."
                                    .to_string(),
                            ),
                            thumbnail_url: "".to_string(),
                            has_subtitle: true,
                            subtitle_content: Some(subtitle_content.clone()),
                            status: Some("completed".to_string()),
                            created_at: now_iso(),
                            folder_path: Some(knowledge_dir.display().to_string()),
                        });
                    } else if let Some(existing) = store
                        .youtube_videos
                        .iter_mut()
                        .find(|item| item.video_id == video_id)
                    {
                        existing.subtitle_content = Some(subtitle_content.clone());
                        existing.has_subtitle = true;
                        existing.status = Some("completed".to_string());
                    }
                    Ok(())
                })?;
                success_count += 1;
            }
            let _ = app.emit(
                "advisors:download-progress",
                json!({ "advisorId": advisor_id, "progress": "下载完成！" }),
            );
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(json!({ "success": true, "successCount": success_count, "failCount": 0 }))
        }
        "advisors:get-videos" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            with_store(state, |store| {
                let mut videos: Vec<AdvisorVideoRecord> = store
                    .advisor_videos
                    .iter()
                    .filter(|item| item.advisor_id == advisor_id)
                    .cloned()
                    .collect();
                videos.sort_by(|a, b| b.published_at.cmp(&a.published_at));
                let youtube_channel = store
                    .advisors
                    .iter()
                    .find(|item| item.id == advisor_id)
                    .and_then(|item| item.youtube_channel.clone())
                    .unwrap_or(Value::Null);
                Ok(json!({ "success": true, "videos": videos, "youtubeChannel": youtube_channel }))
            })
        }
        "advisors:refresh-videos" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let limit = payload_field(&payload, "limit")
                .and_then(|value| value.as_i64())
                .unwrap_or(20)
                .max(1);
            let result = with_store_mut(state, |store| {
                let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
                else {
                    return Ok(json!({ "success": false, "error": "成员不存在" }));
                };
                let channel = advisor.youtube_channel.clone().unwrap_or_else(|| {
                    build_advisor_youtube_channel(None, "https://youtube.com/@redbox", "redbox")
                });
                let url = channel
                    .get("url")
                    .and_then(|value| value.as_str())
                    .unwrap_or("https://youtube.com/@redbox");
                let (fallback_channel_id, fallback_channel_name) = parse_youtube_channel(url);
                let fetched =
                    detect_ytdlp().and_then(|_| fetch_ytdlp_channel_info(url, limit).ok());
                let channel_id = fetched
                    .as_ref()
                    .and_then(|value| value.get("channel_id").and_then(|item| item.as_str()))
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_id);
                let channel_name = fetched
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("channel")
                            .or_else(|| value.get("uploader"))
                            .or_else(|| value.get("title"))
                            .and_then(|item| item.as_str())
                    })
                    .map(|item| item.to_string())
                    .unwrap_or(fallback_channel_name);
                let next_videos = fetched
                    .as_ref()
                    .map(|value| parse_ytdlp_videos(&advisor_id, Some(&channel_id), value))
                    .unwrap_or_else(|| {
                        (0..limit)
                            .map(|index| AdvisorVideoRecord {
                                id: format!("{}-pending-{}", channel_id, index + 1),
                                advisor_id: advisor_id.clone(),
                                title: format!("{} · 新视频 {}", channel_name, index + 1),
                                published_at: now_iso(),
                                status: "pending".to_string(),
                                retry_count: 0,
                                error_message: None,
                                subtitle_file: None,
                                video_url: Some(format!(
                                    "{}/videos/{}",
                                    url.trim_end_matches('/'),
                                    format!("{}-pending-{}", channel_id, index + 1)
                                )),
                                channel_id: Some(channel_id.clone()),
                                created_at: now_iso(),
                                updated_at: now_iso(),
                            })
                            .collect::<Vec<_>>()
                    });
                for next_video in next_videos {
                    if let Some(existing) = store
                        .advisor_videos
                        .iter_mut()
                        .find(|item| item.id == next_video.id && item.advisor_id == advisor_id)
                    {
                        existing.title = next_video.title.clone();
                        existing.published_at = next_video.published_at.clone();
                        existing.video_url = next_video.video_url.clone();
                        existing.channel_id = next_video.channel_id.clone();
                        existing.updated_at = now_iso();
                    } else {
                        store.advisor_videos.push(next_video);
                    }
                }
                advisor.youtube_channel = Some(build_advisor_youtube_channel(
                    Some(&channel),
                    url,
                    &channel_id,
                ));
                advisor.updated_at = now_iso();
                let mut videos: Vec<AdvisorVideoRecord> = store
                    .advisor_videos
                    .iter()
                    .filter(|item| item.advisor_id == advisor_id)
                    .cloned()
                    .collect();
                videos.sort_by(|a, b| b.published_at.cmp(&a.published_at));
                Ok(json!({ "success": true, "videos": videos }))
            })?;
            Ok(result)
        }
        "advisors:download-video" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let video_id = payload_string(&payload, "videoId").unwrap_or_default();
            let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
            let result = with_store_mut(state, |store| {
                let Some(video) = store
                    .advisor_videos
                    .iter_mut()
                    .find(|item| item.id == video_id && item.advisor_id == advisor_id)
                else {
                    return Ok(json!({ "success": false, "error": "视频不存在" }));
                };
                let subtitle_path = if let Some(video_url) = video.video_url.clone() {
                    download_ytdlp_subtitle(
                        &video_url,
                        &knowledge_dir,
                        &slug_from_relative_path(&video.id),
                    )
                    .unwrap_or_else(|_| {
                        let fallback = knowledge_dir
                            .join(format!("{}.txt", slug_from_relative_path(&video.title)));
                        let _ = fs::write(
                            &fallback,
                            format!(
                                "RedBox subtitle fallback\n\n{}\n{}",
                                video.title,
                                video.video_url.clone().unwrap_or_default()
                            ),
                        );
                        fallback
                    })
                } else {
                    let fallback = knowledge_dir
                        .join(format!("{}.txt", slug_from_relative_path(&video.title)));
                    fs::write(
                        &fallback,
                        format!(
                            "RedBox subtitle fallback\n\n{}\n{}",
                            video.title,
                            video.video_url.clone().unwrap_or_default()
                        ),
                    )
                    .map_err(|error| error.to_string())?;
                    fallback
                };
                let subtitle_name = subtitle_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("subtitle.txt")
                    .to_string();
                let subtitle_content = read_text_file_or_empty(&subtitle_path);
                video.status = "success".to_string();
                video.subtitle_file = Some(subtitle_name.clone());
                video.error_message = None;
                video.updated_at = now_iso();
                if let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
                {
                    if !advisor.knowledge_files.contains(&subtitle_name) {
                        advisor.knowledge_files.push(subtitle_name.clone());
                    }
                    advisor.updated_at = now_iso();
                }
                if let Some(existing) = store
                    .youtube_videos
                    .iter_mut()
                    .find(|item| item.video_id == video_id)
                {
                    existing.subtitle_content = Some(subtitle_content);
                    existing.has_subtitle = true;
                    existing.status = Some("completed".to_string());
                }
                Ok(json!({ "success": true, "subtitleFile": subtitle_name }))
            })?;
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:retry-failed" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let knowledge_dir = advisor_knowledge_dir(state, &advisor_id)?;
            let result = with_store_mut(state, |store| {
                let mut success_count = 0_i64;
                let mut fail_count = 0_i64;
                for video in store
                    .advisor_videos
                    .iter_mut()
                    .filter(|item| item.advisor_id == advisor_id && item.status == "failed")
                {
                    let subtitle_result = video.video_url.clone().map(|video_url| {
                        download_ytdlp_subtitle(
                            &video_url,
                            &knowledge_dir,
                            &format!("retry-{}", slug_from_relative_path(&video.id)),
                        )
                    });
                    match subtitle_result.unwrap_or_else(|| Err("missing video url".to_string())) {
                        Ok(subtitle_path) => {
                            let subtitle_name = subtitle_path
                                .file_name()
                                .and_then(|value| value.to_str())
                                .unwrap_or("subtitle.txt")
                                .to_string();
                            video.status = "success".to_string();
                            video.subtitle_file = Some(subtitle_name);
                            video.error_message = None;
                            video.retry_count += 1;
                            video.updated_at = now_iso();
                            success_count += 1;
                        }
                        Err(error) => {
                            video.retry_count += 1;
                            video.error_message = Some(error.to_string());
                            fail_count += 1;
                        }
                    }
                }
                Ok(
                    json!({ "success": true, "successCount": success_count, "failCount": fail_count }),
                )
            })?;
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:update-youtube-settings" => {
            let advisor_id = payload_string(&payload, "advisorId").unwrap_or_default();
            let settings_patch = payload_field(&payload, "settings")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = with_store_mut(state, |store| {
                let Some(advisor) = store.advisors.iter_mut().find(|item| item.id == advisor_id)
                else {
                    return Ok(json!({ "success": false, "error": "成员不存在" }));
                };
                let mut channel = advisor
                    .youtube_channel
                    .clone()
                    .unwrap_or_else(|| {
                        build_advisor_youtube_channel(None, "https://youtube.com/@redbox", "redbox")
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                if let Some(patch) = settings_patch.as_object() {
                    for (key, value) in patch {
                        channel.insert(key.clone(), value.clone());
                    }
                }
                channel.insert("lastBackgroundError".to_string(), Value::Null);
                advisor.youtube_channel = Some(Value::Object(channel.clone()));
                advisor.updated_at = now_iso();
                Ok(json!({ "success": true, "youtubeChannel": Value::Object(channel) }))
            })?;
            Ok(result)
        }
        "advisors:youtube-runner-run-now" => {
            let advisor_id = payload_string(&payload, "advisorId");
            let targets = with_store(state, |store| {
                let items = store
                    .advisors
                    .iter()
                    .filter(|advisor| {
                        if let Some(target) = advisor_id.as_deref() {
                            advisor.id == target
                        } else {
                            advisor
                                .youtube_channel
                                .as_ref()
                                .and_then(|value| value.get("backgroundEnabled"))
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false)
                        }
                    })
                    .map(|advisor| advisor.id.clone())
                    .collect::<Vec<_>>();
                Ok(items)
            })?;
            let mut processed = 0_i64;
            for target in targets {
                let _ = handle_channel(
                    app,
                    "advisors:refresh-videos",
                    json!({ "advisorId": target, "limit": 5 }),
                    state,
                );
                processed += 1;
            }
            Ok(json!({ "success": true, "processed": processed }))
        }
        "redclaw:runner-status" => {
            let _ = ensure_store_hydrated_for_redclaw(state);
            with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))
        }
        "redclaw:list-projects" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.projects.clone()))
        }),
        "redclaw:runner-start" => {
            let status = with_store_mut(state, |store| {
                store.redclaw_state.enabled = true;
                store.redclaw_state.is_ticking = true;
                store.redclaw_state.last_tick_at = Some(now_iso());
                store.redclaw_state.next_tick_at = Some(now_iso());
                if store.redclaw_state.next_maintenance_at.is_none() {
                    store.redclaw_state.next_maintenance_at =
                        Some((now_i64() + 10 * 60 * 1000).to_string());
                }
                if let Some(interval) =
                    payload_field(&payload, "intervalMinutes").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.interval_minutes = interval;
                }
                if let Some(max_auto) =
                    payload_field(&payload, "maxAutomationPerTick").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.max_automation_per_tick = max_auto;
                }
                if let Some(heartbeat) =
                    payload_field(&payload, "heartbeatEnabled").and_then(|v| v.as_bool())
                {
                    if let Some(object) = store.redclaw_state.heartbeat.as_object_mut() {
                        object.insert("enabled".to_string(), json!(heartbeat));
                    }
                }
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
                if runtime_guard.is_none() {
                    let stop = Arc::new(AtomicBool::new(false));
                    let join = run_redclaw_scheduler(app.clone(), stop.clone());
                    *runtime_guard = Some(RedclawRuntime {
                        stop,
                        join: Some(join),
                    });
                }
            }
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        }
        "redclaw:runner-stop" => {
            if let Ok(mut runtime_guard) = state.redclaw_runtime.lock() {
                if let Some(mut runtime) = runtime_guard.take() {
                    runtime.stop.store(true, Ordering::Relaxed);
                    if let Some(join) = runtime.join.take() {
                        let _ = join.join();
                    }
                }
            }
            let status = with_store_mut(state, |store| {
                store.redclaw_state.enabled = false;
                store.redclaw_state.is_ticking = false;
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        }
        "redclaw:runner-run-now" => {
            let (project_id, prompt) = with_store(state, |store| {
                let project = store.redclaw_state.projects.first().cloned();
                let project_id = project.as_ref().map(|item| item.id.clone());
                let prompt = project
                    .as_ref()
                    .map(|item| format!("请推进当前 RedClaw 项目：{}\n\n输出最小下一步行动、内容策略和执行建议。", item.goal))
                    .unwrap_or_else(|| "请为当前空间执行一次 RedClaw 巡检，给出内容生产的下一步建议。".to_string());
                Ok((project_id, prompt))
            })?;
            let run_result = execute_redclaw_run(app, state, prompt, project_id, "runner-run-now")?;
            let status = with_store_mut(state, |store| {
                store.redclaw_state.last_tick_at = Some(now_iso());
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(json!({ "success": true, "status": status, "run": run_result }))
        }
        "redclaw:runner-set-project" => {
            let project_id = payload_string(&payload, "projectId").unwrap_or_default();
            let enabled = payload_field(&payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let prompt = normalize_optional_string(payload_string(&payload, "prompt"));
            let updated = with_store_mut(state, |store| {
                if enabled {
                    if let Some(project) = store
                        .redclaw_state
                        .projects
                        .iter_mut()
                        .find(|item| item.id == project_id)
                    {
                        project.status = "active".to_string();
                        project.updated_at = now_iso();
                    } else {
                        store.redclaw_state.projects.push(RedclawProjectRecord {
                            id: if project_id.is_empty() {
                                make_id("redclaw-project")
                            } else {
                                project_id.clone()
                            },
                            goal: prompt
                                .clone()
                                .unwrap_or_else(|| "RedClaw Project".to_string()),
                            platform: Some("generic".to_string()),
                            task_type: Some("manual".to_string()),
                            status: "active".to_string(),
                            updated_at: now_iso(),
                        });
                    }
                } else {
                    store
                        .redclaw_state
                        .projects
                        .retain(|item| item.id != project_id);
                }
                Ok(json!({ "success": true }))
            })?;
            Ok(updated)
        }
        "redclaw:runner-set-config" => {
            let status = with_store_mut(state, |store| {
                if let Some(interval) =
                    payload_field(&payload, "intervalMinutes").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.interval_minutes = interval;
                }
                if let Some(max_auto) =
                    payload_field(&payload, "maxAutomationPerTick").and_then(|v| v.as_i64())
                {
                    store.redclaw_state.max_automation_per_tick = max_auto;
                }
                if let Some(object) = store.redclaw_state.heartbeat.as_object_mut() {
                    if let Some(value) =
                        payload_field(&payload, "heartbeatEnabled").and_then(|v| v.as_bool())
                    {
                        object.insert("enabled".to_string(), json!(value));
                    }
                    if let Some(value) =
                        payload_field(&payload, "heartbeatIntervalMinutes").and_then(|v| v.as_i64())
                    {
                        object.insert("intervalMinutes".to_string(), json!(value));
                    }
                    if let Some(value) = payload_field(&payload, "heartbeatSuppressEmptyReport")
                        .and_then(|v| v.as_bool())
                    {
                        object.insert("suppressEmptyReport".to_string(), json!(value));
                    }
                    if let Some(value) = payload_field(&payload, "heartbeatReportToMainSession")
                        .and_then(|v| v.as_bool())
                    {
                        object.insert("reportToMainSession".to_string(), json!(value));
                    }
                }
                Ok(redclaw_state_value(&store.redclaw_state))
            })?;
            let _ = app.emit("redclaw:runner-status", status.clone());
            Ok(status)
        }
        "redclaw:runner-list-scheduled" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.scheduled_tasks.clone()))
        }),
        "redclaw:runner-add-scheduled" => {
            let task = with_store_mut(state, |store| {
                let item = RedclawScheduledTaskRecord {
                    id: make_id("scheduled"),
                    name: payload_string(&payload, "name")
                        .unwrap_or_else(|| "定时任务".to_string()),
                    enabled: payload_field(&payload, "enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    mode: payload_string(&payload, "mode").unwrap_or_else(|| "daily".to_string()),
                    prompt: payload_string(&payload, "prompt").unwrap_or_default(),
                    project_id: normalize_optional_string(payload_string(&payload, "projectId")),
                    interval_minutes: payload_field(&payload, "intervalMinutes")
                        .and_then(|v| v.as_i64()),
                    time: normalize_optional_string(payload_string(&payload, "time")),
                    weekdays: payload_field(&payload, "weekdays")
                        .and_then(|v| v.as_array())
                        .map(|items| items.iter().filter_map(|i| i.as_i64()).collect()),
                    run_at: normalize_optional_string(payload_string(&payload, "runAt")),
                    created_at: now_iso(),
                    updated_at: now_iso(),
                    last_run_at: None,
                    last_result: None,
                    last_error: None,
                    next_run_at: Some(now_iso()),
                };
                store.redclaw_state.scheduled_tasks.push(item.clone());
                Ok(item)
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(json!({ "success": true, "task": task }))
        }
        "redclaw:runner-remove-scheduled" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store
                    .redclaw_state
                    .scheduled_tasks
                    .retain(|item| item.id != task_id);
                Ok(json!({ "success": true }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "redclaw:runner-set-scheduled-enabled" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let enabled = payload_field(&payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.enabled = enabled;
                    task.updated_at = now_iso();
                }
                Ok(json!({ "success": true }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "redclaw:runner-run-scheduled-now" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let (project_id, prompt) = with_store(state, |store| {
                let task = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter()
                    .find(|item| item.id == task_id)
                    .cloned();
                let prompt = task
                    .as_ref()
                    .map(|item| item.prompt.clone())
                    .unwrap_or_else(|| "请执行一次 RedClaw 定时任务。".to_string());
                let project_id = task.and_then(|item| item.project_id);
                Ok((project_id, prompt))
            })?;
            let run_result = execute_redclaw_run(app, state, prompt, project_id, "scheduled-task")?;
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .scheduled_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.last_run_at = Some(now_iso());
                    task.last_result = Some("success".to_string());
                    task.updated_at = now_iso();
                }
                Ok(json!({ "success": true, "run": run_result }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "redclaw:runner-list-long-cycle" => with_store(state, |store| {
            Ok(json!(store.redclaw_state.long_cycle_tasks.clone()))
        }),
        "redclaw:runner-add-long-cycle" => {
            let task = with_store_mut(state, |store| {
                let item = RedclawLongCycleTaskRecord {
                    id: make_id("long-cycle"),
                    name: payload_string(&payload, "name")
                        .unwrap_or_else(|| "长周期任务".to_string()),
                    enabled: payload_field(&payload, "enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                    status: "paused".to_string(),
                    objective: payload_string(&payload, "objective").unwrap_or_default(),
                    step_prompt: payload_string(&payload, "stepPrompt").unwrap_or_default(),
                    project_id: normalize_optional_string(payload_string(&payload, "projectId")),
                    interval_minutes: payload_field(&payload, "intervalMinutes")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(720),
                    total_rounds: payload_field(&payload, "totalRounds")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(12),
                    completed_rounds: 0,
                    created_at: now_iso(),
                    updated_at: now_iso(),
                    last_run_at: None,
                    last_result: None,
                    last_error: None,
                    next_run_at: Some(now_iso()),
                };
                store.redclaw_state.long_cycle_tasks.push(item.clone());
                Ok(item)
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(json!({ "success": true, "task": task }))
        }
        "redclaw:runner-remove-long-cycle" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let result = with_store_mut(state, |store| {
                store
                    .redclaw_state
                    .long_cycle_tasks
                    .retain(|item| item.id != task_id);
                Ok(json!({ "success": true }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "redclaw:runner-set-long-cycle-enabled" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let enabled = payload_field(&payload, "enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.enabled = enabled;
                    task.status = if enabled {
                        "running".to_string()
                    } else {
                        "paused".to_string()
                    };
                    task.updated_at = now_iso();
                }
                Ok(json!({ "success": true }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "redclaw:runner-run-long-cycle-now" => {
            let task_id = payload_string(&payload, "taskId").unwrap_or_default();
            let (project_id, prompt) = with_store(state, |store| {
                let task = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter()
                    .find(|item| item.id == task_id)
                    .cloned();
                let prompt = task
                    .as_ref()
                    .map(|item| {
                        format!(
                            "目标：{}\n\n当前轮执行指令：{}",
                            item.objective, item.step_prompt
                        )
                    })
                    .unwrap_or_else(|| "请执行一次 RedClaw 长周期任务。".to_string());
                let project_id = task.and_then(|item| item.project_id);
                Ok((project_id, prompt))
            })?;
            let run_result =
                execute_redclaw_run(app, state, prompt, project_id, "long-cycle-task")?;
            let result = with_store_mut(state, |store| {
                if let Some(task) = store
                    .redclaw_state
                    .long_cycle_tasks
                    .iter_mut()
                    .find(|item| item.id == task_id)
                {
                    task.completed_rounds += 1;
                    task.last_run_at = Some(now_iso());
                    task.last_result = Some("success".to_string());
                    task.status = if task.completed_rounds >= task.total_rounds {
                        "completed".to_string()
                    } else {
                        "running".to_string()
                    };
                    task.updated_at = now_iso();
                }
                Ok(json!({ "success": true, "run": run_result }))
            })?;
            let status = with_store(state, |store| Ok(redclaw_state_value(&store.redclaw_state)))?;
            let _ = app.emit("redclaw:runner-status", status);
            Ok(result)
        }
        "youtube:check-ytdlp" => {
            if let Some((path, version)) = detect_ytdlp() {
                Ok(json!({ "installed": true, "version": version, "path": path }))
            } else {
                Ok(json!({ "installed": false }))
            }
        }
        "youtube:install" => {
            let _ = app.emit("youtube:install-progress", 10);
            let result = match ensure_ytdlp_installed(false) {
                Ok((path, version)) => {
                    append_debug_log_state(
                        state,
                        format!("yt-dlp install/check succeeded: {path} {version}"),
                    );
                    json!({ "success": true, "path": path, "version": version })
                }
                Err(error) => {
                    append_debug_log_state(state, format!("yt-dlp install/check failed: {error}"));
                    json!({ "success": false, "error": error })
                }
            };
            let _ = app.emit("youtube:install-progress", 100);
            Ok(result)
        }
        "youtube:update" => {
            let _ = app.emit("youtube:install-progress", 10);
            let result = match ensure_ytdlp_installed(true) {
                Ok((path, version)) => {
                    append_debug_log_state(
                        state,
                        format!("yt-dlp update succeeded: {path} {version}"),
                    );
                    json!({ "success": true, "path": path, "version": version })
                }
                Err(error) => {
                    append_debug_log_state(state, format!("yt-dlp update failed: {error}"));
                    json!({ "success": false, "error": error })
                }
            };
            let _ = app.emit("youtube:install-progress", 100);
            Ok(result)
        }
        _ => Err(format!(
            "RedBox host does not recognize channel `{channel}`."
        )),
    }
}

fn handle_send_channel(
    app: &AppHandle,
    channel: &str,
    payload: Value,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    match channel {
        "chat:send-message" => {
            let session_id = payload_string(&payload, "sessionId");
            let message = payload_string(&payload, "message").unwrap_or_default();
            let display_content =
                payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone());
            let is_redclaw_session = session_id
                .as_deref()
                .map(|value| value.starts_with("context-session:redclaw:"))
                .unwrap_or(false);
            let execution = execute_chat_exchange(
                Some(app),
                state,
                session_id,
                message.clone(),
                display_content.clone(),
                payload_field(&payload, "modelConfig"),
                payload_field(&payload, "attachment").cloned(),
                "chat-send",
                "Chat response completed",
            )?;
            let mut redclaw_artifacts: Vec<Value> = Vec::new();
            let mut redclaw_artifact_kind: Option<&str> = None;

            if is_redclaw_session {
                let project_id = with_store(state, |store| {
                    Ok(store
                        .redclaw_state
                        .projects
                        .first()
                        .map(|item| item.id.clone())
                        .unwrap_or_else(|| "redclaw-chat".to_string()))
                })?;
                let artifact_kind = detect_redclaw_artifact_kind(&message, "chat-session");
                redclaw_artifacts = save_redclaw_outputs(
                    state,
                    artifact_kind,
                    &project_id,
                    &execution.session_id,
                    &message,
                    &execution.response,
                    "chat-session",
                )?;
                redclaw_artifact_kind = Some(artifact_kind);
                let _ = with_store_mut(state, |store| {
                    store.work_items.push(create_work_item(
                        "redclaw-note",
                        format!("RedClaw Chat {}", artifact_kind),
                        Some("RedClaw fixed session generated a persisted artifact.".to_string()),
                        Some(display_content.clone()),
                        Some(json!({
                            "sessionId": execution.session_id,
                            "artifactKind": artifact_kind,
                            "artifacts": redclaw_artifacts.clone(),
                        })),
                        2,
                    ));
                    Ok(())
                });
            }

            emit_chat_sequence(
                app,
                &execution.session_id,
                &execution.response,
                "正在分析输入并生成回答。",
                execution.title_update,
            );
            if is_redclaw_session {
                let _ = app.emit(
                    "redclaw:runner-message",
                    json!({
                        "sessionId": execution.session_id,
                        "artifactKind": redclaw_artifact_kind,
                        "artifacts": redclaw_artifacts,
                    }),
                );
            }
            Ok(())
        }
        "chat:cancel" | "ai:cancel" => Ok(()),
        "chat:confirm-tool" | "ai:confirm-tool" => {
            let call_id = payload_string(&payload, "callId").unwrap_or_else(|| make_id("call"));
            let confirmed = payload_field(&payload, "confirmed")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let session_id = with_store_mut(state, |store| {
                let session_id = latest_session_id(store);
                store.session_tool_results.push(SessionToolResultRecord {
                    id: make_id("tool-result"),
                    session_id: session_id.clone(),
                    call_id: call_id.clone(),
                    tool_name: "confirmation".to_string(),
                    command: None,
                    success: confirmed,
                    result_text: Some(if confirmed {
                        "User confirmed tool execution".to_string()
                    } else {
                        "User cancelled tool execution".to_string()
                    }),
                    summary_text: Some(if confirmed {
                        "Tool execution confirmed".to_string()
                    } else {
                        "Tool execution cancelled".to_string()
                    }),
                    prompt_text: None,
                    original_chars: None,
                    prompt_chars: None,
                    truncated: false,
                    payload: Some(json!({ "confirmed": confirmed })),
                    created_at: now_i64(),
                    updated_at: now_i64(),
                });
                Ok(session_id)
            })?;
            let _ = app.emit(
                "chat:tool-end",
                json!({
                    "callId": call_id,
                    "name": "confirmation",
                    "sessionId": session_id,
                    "output": {
                        "success": confirmed,
                        "content": if confirmed { "用户已确认执行" } else { "用户已取消执行" }
                    }
                }),
            );
            Ok(())
        }
        "ai:start-chat" => {
            let message = payload_string(&payload, "message").unwrap_or_default();
            let model_config = payload_field(&payload, "modelConfig").cloned();
            handle_send_channel(
                app,
                "chat:send-message",
                json!({
                    "message": message,
                    "displayContent": payload_string(&payload, "displayContent").unwrap_or_else(|| message.clone()),
                    "modelConfig": model_config
                }),
                state,
            )
        }
        _ => Ok(()),
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
            } else if let Err(error) = handle_send_channel(
                &app_handle,
                &channel_name,
                payload_value.clone(),
                &managed_state,
            ) {
                let session_id = payload_string(&payload_value, "sessionId");
                let _ = app_handle.emit(
                    "chat:error",
                    json!({
                        "message": error,
                        "category": "execution",
                        "sessionId": session_id,
                    }),
                );
            }
        });
        Ok(())
    } else {
        handle_send_channel(&app, &channel, payload, &state)
    }
}

fn main() {
    let store_path = build_store_path();
    let mut store = load_store(&store_path);
    if let Err(error) = maybe_import_legacy_store(&mut store, &store_path) {
        eprintln!("[RedBox legacy import] {error}");
    }
    if let Err(error) = persist_store(&store_path, &store) {
        eprintln!("[RedBox store persist] {error}");
    }

    tauri::Builder::default()
        .manage(AppState {
            store_path,
            store: Mutex::new(store),
            chat_runtime_states: Mutex::new(std::collections::HashMap::new()),
            assistant_runtime: Mutex::new(None),
            assistant_sidecar: Mutex::new(None),
            redclaw_runtime: Mutex::new(None),
            runtime_warm: Mutex::new(RuntimeWarmState::default()),
        })
        .invoke_handler(tauri::generate_handler![ipc_invoke, ipc_send])
        .setup(|app| {
            let _ = app.emit("indexing:status", default_indexing_stats());
            let state = app.state::<AppState>();
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
