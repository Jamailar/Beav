#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod agent;
mod agent_hub;
mod ai_model_manager;
mod app_shared;
mod app_state;
mod assistant_core;
mod auth;
mod browser_control_mcp;
mod channel_router;
mod chat_binding;
mod chat_helpers;
mod chat_title;
mod cli_runtime;
mod command_execution;
mod commands;
mod desktop_io;
mod diagnostics;
mod document_ingest;
mod document_parse;
mod events;
mod ffmpeg_runtime;
mod helpers;
mod host_impl;
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
mod membership;
mod memory;
mod memory_maintenance;
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
mod startup;
mod startup_migration;
mod store;
mod subagents;
mod tools;
mod voice_service;
mod workspace;
mod workspace_loaders;

pub(crate) use commands::chat_state::{
    ensure_chat_session, is_chat_runtime_cancel_requested, resolve_runtime_mode_for_session,
    update_chat_runtime_state,
};
pub(crate) use ffmpeg_runtime::{ffmpeg_executable, ffmpeg_program};
pub(crate) use persistence::{
    build_store_path, hydrate_store_from_workspace_files, load_store, persist_store, with_store,
    with_store_mut,
};
pub(crate) use runtime::{
    append_session_checkpoint, infer_protocol, next_memory_maintenance_at_ms, resolve_chat_config,
    resolve_runtime_mode_from_context_type, role_sequence_for_route, session_lineage_fields,
    session_title_from_message, ApprovalRuntimeState, InteractiveToolCall, McpServerRecord,
    RedclawJobDefinitionRecord, RedclawJobExecutionRecord, RedclawLongCycleTaskRecord,
    RedclawScheduledTaskRecord, RedclawStateRecord, ResolvedChatConfig, RuntimeHookRecord,
    RuntimeWarmState, SessionCheckpointRecord, SessionToolResultRecord, SessionTranscriptRecord,
};
use std::collections::{HashMap, HashSet};
pub(crate) use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Arc, Mutex,
};
use tauri::Manager;

pub(crate) use app_shared::*;
pub(crate) use app_state::{
    AppState, AssistantRuntime, AssistantSidecarRuntime, GLOBAL_APP_HANDLE, GLOBAL_DEBUG_STORE,
};
pub(crate) use assistant_core::*;
pub(crate) use auth::*;
pub(crate) use channel_router::handle_channel;
pub(crate) use diagnostics::*;
pub(crate) use helpers::*;
pub(crate) use host_impl::*;
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
pub(crate) use store::types::*;
pub(crate) use workspace::paths::*;

fn main() {
    if browser_control_mcp::maybe_run_from_args() {
        return;
    }
    let startup::StartupPreparedState {
        store_path,
        store,
        startup_migration_status,
        initial_workspace_root,
    } = startup::prepare_startup_state();
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
            active_team_member_wakes: Mutex::new(HashSet::new()),
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
        .setup(startup::run_setup_restore_sequence)
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
