use dirs::config_dir;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;
use tauri::State;

use crate::runtime::SkillRecord;
use crate::scheduler::sync_redclaw_job_definitions;
use crate::workspace_loaders::{
    load_chat_rooms_from_fs, load_chatroom_messages_from_fs, load_memories_from_fs,
    load_memory_history_from_fs,
};
use crate::{
    active_space_workspace_root_from_store, load_advisors_from_fs, load_cover_assets_from_fs,
    load_document_sources_from_fs, load_knowledge_notes_from_fs, load_media_assets_from_fs,
    load_redclaw_state_from_fs, load_subject_categories_from_fs, load_subjects_from_fs,
    load_work_items_from_fs, load_youtube_videos_from_fs, now_iso, AppState, AppStore,
    AssistantStateRecord, RedclawStateRecord, SpaceRecord,
};

pub fn build_store_path() -> PathBuf {
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

pub fn default_store() -> AppStore {
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
        redclaw_job_definitions: Vec::new(),
        redclaw_job_executions: Vec::new(),
        media_assets: Vec::new(),
        cover_assets: Vec::new(),
        work_items: Vec::new(),
        legacy_imported_at: None,
        legacy_import_source: None,
    }
}

pub fn load_store(path: &PathBuf) -> AppStore {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_store(),
    };
    serde_json::from_str(&content).unwrap_or_else(|_| default_store())
}

pub fn persist_store(path: &PathBuf, store: &AppStore) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, serialized).map_err(|error| error.to_string())
}

pub fn with_store_mut<T>(
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut AppStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    let result = mutator(&mut store)?;
    let snapshot = store.clone();
    drop(store);
    schedule_store_persist(state, snapshot);
    Ok(result)
}

pub fn with_store<T>(
    state: &State<'_, AppState>,
    reader: impl FnOnce(MutexGuard<'_, AppStore>) -> Result<T, String>,
) -> Result<T, String> {
    let store = state.store.lock().map_err(|_| "状态锁已损坏".to_string())?;
    reader(store)
}

pub fn hydrate_store_from_workspace_files(
    store: &mut AppStore,
    store_path: &Path,
) -> Result<(), String> {
    let root = active_space_workspace_root_from_store(store, &store.active_space_id, store_path)?;
    store.categories = load_subject_categories_from_fs(&root.join("subjects"));
    store.subjects = load_subjects_from_fs(&root.join("subjects"));
    store.advisors = load_advisors_from_fs(&root.join("advisors"));
    store.chat_rooms = load_chat_rooms_from_fs(&root.join("chatrooms"));
    store.chatroom_messages = load_chatroom_messages_from_fs(&root.join("chatrooms"));
    store.memories = load_memories_from_fs(&root.join("memory"));
    store.memory_history = load_memory_history_from_fs(&root.join("memory"));
    store.media_assets = load_media_assets_from_fs(&root.join("media"));
    store.cover_assets = load_cover_assets_from_fs(&root.join("cover"));
    store.knowledge_notes = load_knowledge_notes_from_fs(&root.join("knowledge"));
    store.youtube_videos = load_youtube_videos_from_fs(&root.join("knowledge"));
    store.document_sources = load_document_sources_from_fs(&root.join("knowledge"));
    store.redclaw_state = load_redclaw_state_from_fs(&root.join("redclaw"));
    sync_redclaw_job_definitions(store);
    store.work_items = load_work_items_from_fs(&root.join("redclaw"));
    Ok(())
}

pub fn ensure_store_hydrated_for_knowledge(state: &State<'_, AppState>) -> Result<(), String> {
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

pub fn ensure_store_hydrated_for_subjects(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.subjects.is_empty() || store.categories.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

pub fn ensure_store_hydrated_for_media(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.media_assets.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

pub fn ensure_store_hydrated_for_cover(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.cover_assets.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

pub fn ensure_store_hydrated_for_work(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.work_items.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

pub fn ensure_store_hydrated_for_advisors(state: &State<'_, AppState>) -> Result<(), String> {
    with_store_mut(state, |store| {
        if store.advisors.is_empty() {
            hydrate_store_from_workspace_files(store, &state.store_path)?;
        }
        Ok(())
    })
}

pub fn ensure_store_hydrated_for_redclaw(state: &State<'_, AppState>) -> Result<(), String> {
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

fn schedule_store_persist(state: &State<'_, AppState>, store: AppStore) {
    let path = state.store_path.clone();
    let version = state
        .store_persist_version
        .fetch_add(1, Ordering::SeqCst)
        .saturating_add(1);
    let latest = state.store_persist_version.clone();
    std::thread::spawn(move || {
        let serialized = match serde_json::to_string_pretty(&store) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[RedBox async persist] serialize failed: {error}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("[RedBox async persist] create dir failed: {error}");
                return;
            }
        }
        let tmp_path = path.with_extension(format!("json.tmp.{version}"));
        if let Err(error) = fs::write(&tmp_path, serialized) {
            eprintln!("[RedBox async persist] temp write failed: {error}");
            return;
        }
        if version != latest.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&tmp_path);
            return;
        }
        if let Err(error) = fs::rename(&tmp_path, &path) {
            let _ = fs::remove_file(&tmp_path);
            eprintln!("[RedBox async persist] rename failed: {error}");
        }
    });
}
