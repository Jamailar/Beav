use crate::{
    auth::AuthRuntimeState,
    diagnostics::DiagnosticsState,
    knowledge_index, mcp, media_runtime,
    runtime::{ApprovalRuntimeState, RedclawRuntime, RuntimeWarmState},
    skills, startup_migration, AppStore, ChatRuntimeStateRecord, EditorRuntimeStateRecord,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Arc, Mutex, OnceLock,
};
use std::thread::JoinHandle;
use tauri::AppHandle;

pub(crate) struct AppState {
    pub(crate) store_path: PathBuf,
    pub(crate) store: Arc<Mutex<AppStore>>,
    pub(crate) workspace_root_cache: Mutex<PathBuf>,
    pub(crate) startup_migration: Mutex<startup_migration::StartupMigrationStatus>,
    pub(crate) store_persist_version: Arc<AtomicU64>,
    pub(crate) store_persist_scheduled: Arc<AtomicBool>,
    pub(crate) auth_runtime: Mutex<AuthRuntimeState>,
    pub(crate) official_auth_refresh_lock: Mutex<()>,
    pub(crate) official_wechat_status_lock: Mutex<()>,
    pub(crate) official_cache_refresh_inflight: AtomicBool,
    pub(crate) mcp_manager: mcp::McpManager,
    pub(crate) chat_runtime_states:
        Mutex<std::collections::HashMap<String, ChatRuntimeStateRecord>>,
    pub(crate) editor_runtime_states:
        Mutex<std::collections::HashMap<String, EditorRuntimeStateRecord>>,
    pub(crate) active_chat_requests: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    pub(crate) active_team_member_wakes: Mutex<HashSet<String>>,
    pub(crate) assistant_runtime: Mutex<Option<AssistantRuntime>>,
    pub(crate) assistant_sidecar: Mutex<Option<AssistantSidecarRuntime>>,
    pub(crate) redclaw_runtime: Mutex<Option<RedclawRuntime>>,
    pub(crate) media_generation_runtime: Mutex<Option<media_runtime::MediaGenerationRuntime>>,
    pub(crate) runtime_warm: Mutex<RuntimeWarmState>,
    pub(crate) approval_runtime: Mutex<ApprovalRuntimeState>,
    pub(crate) skill_watch: Mutex<skills::SkillWatcherSnapshot>,
    pub(crate) diagnostics: Mutex<DiagnosticsState>,
    pub(crate) knowledge_index_state: Mutex<knowledge_index::KnowledgeIndexRuntimeState>,
}

pub(crate) static GLOBAL_DEBUG_STORE: OnceLock<Arc<Mutex<AppStore>>> = OnceLock::new();
pub(crate) static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub(crate) struct AssistantRuntime {
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) join: Option<JoinHandle<()>>,
    pub(crate) host: String,
    pub(crate) port: i64,
}

pub(crate) struct AssistantSidecarRuntime {
    pub(crate) child: std::process::Child,
    pub(crate) pid: u32,
}
