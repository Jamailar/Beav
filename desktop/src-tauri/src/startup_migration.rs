use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::scheduler::sync_redclaw_job_definitions;
use crate::{
    AppState, AppStore, auth, compatible_workspace_base_dir, detect_best_legacy_db,
    emit_space_changed, is_legacy_workspace_base, legacy_workspace_dir, maybe_import_legacy_store,
    now_iso, persist_store, preferred_workspace_dir,
};

pub(crate) const STARTUP_MIGRATION_EVENT: &str = "app:startup-migration-status";
const STARTUP_MIGRATION_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StartupMigrationStatus {
    pub status: String,
    pub needs_db_import: bool,
    pub should_show_modal: bool,
    pub legacy_db_path: Option<String>,
    pub legacy_workspace_path: Option<String>,
    pub workspace_path: Option<String>,
    pub current_step: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub progress: f64,
    pub imported_counts: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct StartupMigrationReceipt {
    version: i64,
    status: String,
    legacy_db_path: Option<String>,
    source_fingerprint: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    imported_counts: Option<Value>,
    last_error: Option<String>,
}

fn startup_migration_receipt_path(store_path: &Path) -> PathBuf {
    store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("migrations")
        .join("db-import-v1.json")
}

fn load_startup_migration_receipt(store_path: &Path) -> Option<StartupMigrationReceipt> {
    let path = startup_migration_receipt_path(store_path);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<StartupMigrationReceipt>(&raw).ok()
}

fn save_startup_migration_receipt(
    store_path: &Path,
    receipt: &StartupMigrationReceipt,
) -> Result<(), String> {
    let path = startup_migration_receipt_path(store_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(receipt).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn legacy_db_fingerprint(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!(
        "{}:{}:{}",
        path.display(),
        metadata.len(),
        modified_ms
    ))
}

fn counts_payload(store: &AppStore) -> Value {
    json!({
        "chatSessions": store.chat_sessions.len(),
        "chatMessages": store.chat_messages.len(),
        "spaces": store.spaces.len(),
        "transcriptRecords": store.session_transcript_records.len(),
        "checkpoints": store.session_checkpoints.len(),
        "toolResults": store.session_tool_results.len(),
        "wanderHistory": store.wander_history.len(),
        "memories": store.memories.len(),
        "archiveProfiles": store.archive_profiles.len(),
        "archiveSamples": store.archive_samples.len()
    })
}

pub(crate) fn normalize_workspace_dir_setting(store: &mut AppStore) -> Result<(), String> {
    let mut chosen = compatible_workspace_base_dir(&store.settings);
    if is_legacy_workspace_base(&chosen) && !chosen.exists() {
        chosen = preferred_workspace_dir();
    }

    if !is_legacy_workspace_base(&chosen) {
        if let Some(parent) = chosen.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(&chosen).map_err(|error| error.to_string())?;
    }

    if !store.settings.is_object() {
        store.settings = json!({});
    }
    let settings = store
        .settings
        .as_object_mut()
        .ok_or_else(|| "settings should be a JSON object".to_string())?;
    settings.insert(
        "workspace_dir".to_string(),
        json!(chosen.display().to_string()),
    );
    Ok(())
}

pub(crate) fn probe_startup_migration(
    store: &AppStore,
    store_path: &Path,
) -> StartupMigrationStatus {
    let legacy_db_path = detect_best_legacy_db();
    let legacy_workspace_path = legacy_workspace_dir()
        .filter(|path| path.join("spaces").join("default").exists())
        .map(|path| path.display().to_string());
    let workspace_path = Some(
        compatible_workspace_base_dir(&store.settings)
            .display()
            .to_string(),
    );

    let Some(db_path) = legacy_db_path.as_ref() else {
        return StartupMigrationStatus {
            status: "not-needed".to_string(),
            needs_db_import: false,
            should_show_modal: false,
            legacy_db_path: None,
            legacy_workspace_path,
            workspace_path,
            current_step: None,
            message: None,
            error: None,
            progress: 0.0,
            imported_counts: None,
        };
    };

    let fingerprint = legacy_db_fingerprint(db_path);
    let db_path_string = db_path.display().to_string();
    let receipt = load_startup_migration_receipt(store_path);
    let already_completed = receipt.as_ref().is_some_and(|item| {
        item.version == STARTUP_MIGRATION_VERSION
            && item.status == "completed"
            && item.legacy_db_path.as_deref() == Some(db_path_string.as_str())
            && item.source_fingerprint == fingerprint
    });

    if already_completed {
        return StartupMigrationStatus {
            status: "completed".to_string(),
            needs_db_import: false,
            should_show_modal: false,
            legacy_db_path: Some(db_path_string),
            legacy_workspace_path,
            workspace_path,
            current_step: None,
            message: Some("旧版数据库已经导入过，新版将直接使用当前数据。".to_string()),
            error: None,
            progress: 1.0,
            imported_counts: receipt.and_then(|item| item.imported_counts),
        };
    }

    let failed_message = receipt
        .as_ref()
        .filter(|item| item.status == "failed")
        .and_then(|item| item.last_error.clone());

    StartupMigrationStatus {
        status: if failed_message.is_some() {
            "failed".to_string()
        } else {
            "pending".to_string()
        },
        needs_db_import: true,
        should_show_modal: true,
        legacy_db_path: Some(db_path_string),
        legacy_workspace_path,
        workspace_path,
        current_step: None,
        message: if failed_message.is_some() {
            Some("上次数据库导入没有完成，可以重新开始。".to_string())
        } else {
            Some(
                "检测到旧版数据库，需要导入到新版数据格式。文件目录会继续直接使用旧版位置。"
                    .to_string(),
            )
        },
        error: failed_message,
        progress: 0.0,
        imported_counts: None,
    }
}

pub(crate) fn startup_migration_status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let status = state
        .startup_migration
        .lock()
        .map_err(|_| "startup migration lock is poisoned".to_string())?
        .clone();
    serde_json::to_value(status).map_err(|error| error.to_string())
}

fn emit_status(app: &AppHandle, status: &StartupMigrationStatus) {
    let _ = app.emit(STARTUP_MIGRATION_EVENT, status.clone());
}

fn set_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    updater: impl FnOnce(&mut StartupMigrationStatus),
) -> Result<StartupMigrationStatus, String> {
    let snapshot = {
        let mut status = state
            .startup_migration
            .lock()
            .map_err(|_| "startup migration lock is poisoned".to_string())?;
        updater(&mut status);
        status.clone()
    };
    emit_status(app, &snapshot);
    Ok(snapshot)
}

fn write_failed_receipt(
    store_path: &Path,
    legacy_db_path: Option<String>,
    error: String,
) -> Result<(), String> {
    let receipt = StartupMigrationReceipt {
        version: STARTUP_MIGRATION_VERSION,
        status: "failed".to_string(),
        legacy_db_path: legacy_db_path.clone(),
        source_fingerprint: legacy_db_path
            .as_deref()
            .map(PathBuf::from)
            .as_deref()
            .and_then(legacy_db_fingerprint),
        started_at: Some(now_iso()),
        completed_at: None,
        imported_counts: None,
        last_error: Some(error),
    };
    save_startup_migration_receipt(store_path, &receipt)
}

fn execute_startup_migration(app: AppHandle) -> Result<AppStore, String> {
    let state = app.state::<AppState>();
    let legacy_db_path = {
        let status = state
            .startup_migration
            .lock()
            .map_err(|_| "startup migration lock is poisoned".to_string())?;
        status
            .legacy_db_path
            .clone()
            .ok_or_else(|| "legacy db path is unavailable".to_string())?
    };

    let mut started_receipt = StartupMigrationReceipt {
        version: STARTUP_MIGRATION_VERSION,
        status: "running".to_string(),
        legacy_db_path: Some(legacy_db_path.clone()),
        source_fingerprint: legacy_db_fingerprint(Path::new(&legacy_db_path)),
        started_at: Some(now_iso()),
        completed_at: None,
        imported_counts: None,
        last_error: None,
    };
    save_startup_migration_receipt(&state.store_path, &started_receipt)?;

    let _ = set_status(&app, &state, |status| {
        status.status = "running".to_string();
        status.should_show_modal = true;
        status.current_step = Some("读取旧版数据库".to_string());
        status.message = Some("正在准备旧版数据导入。".to_string());
        status.error = None;
        status.progress = 0.1;
        status.imported_counts = None;
    })?;

    let mut imported_store = {
        let store = state
            .store
            .lock()
            .map_err(|_| "state lock is poisoned".to_string())?;
        store.clone()
    };

    let _ = set_status(&app, &state, |status| {
        status.current_step = Some("导入数据库记录".to_string());
        status.message = Some("正在导入设置、空间、聊天记录和历史数据。".to_string());
        status.progress = 0.35;
    })?;
    maybe_import_legacy_store(&mut imported_store, &state.store_path)?;

    let _ = set_status(&app, &state, |status| {
        status.current_step = Some("同步认证与空间数据".to_string());
        status.message = Some("正在整理新版运行所需的状态。".to_string());
        status.progress = 0.7;
    })?;
    auth::migrate_legacy_auth_store(&state.store_path, &mut imported_store)?;
    normalize_workspace_dir_setting(&mut imported_store)?;
    sync_redclaw_job_definitions(&mut imported_store);

    let _ = set_status(&app, &state, |status| {
        status.current_step = Some("保存新版数据".to_string());
        status.message = Some("正在写入新版状态文件。".to_string());
        status.progress = 0.9;
    })?;
    persist_store(&state.store_path, &imported_store)?;

    let workspace_root = crate::workspace_root_from_snapshot(
        &imported_store.settings,
        &imported_store.active_space_id,
        &state.store_path,
    )?;

    {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "state lock is poisoned".to_string())?;
        *store = imported_store.clone();
    }
    {
        let mut cache = state
            .workspace_root_cache
            .lock()
            .map_err(|_| "workspace cache lock is poisoned".to_string())?;
        *cache = workspace_root;
    }

    let imported_counts = counts_payload(&imported_store);
    started_receipt.status = "completed".to_string();
    started_receipt.completed_at = Some(now_iso());
    started_receipt.imported_counts = Some(imported_counts.clone());
    save_startup_migration_receipt(&state.store_path, &started_receipt)?;

    let _ = set_status(&app, &state, |status| {
        status.status = "completed".to_string();
        status.needs_db_import = false;
        status.should_show_modal = true;
        status.current_step = Some("导入完成".to_string());
        status.message = Some("旧版数据库已经导入完成。文件目录仍然保留在原来的位置。".to_string());
        status.error = None;
        status.progress = 1.0;
        status.imported_counts = Some(imported_counts);
    })?;
    emit_space_changed(&app, &imported_store.active_space_id);
    let _ = app.emit("settings:updated", json!({ "updatedAt": now_iso() }));

    Ok(imported_store)
}

pub(crate) fn start_startup_migration(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let snapshot = {
        let mut status = state
            .startup_migration
            .lock()
            .map_err(|_| "startup migration lock is poisoned".to_string())?;
        if status.status == "running" || !status.needs_db_import {
            status.clone()
        } else {
            status.status = "running".to_string();
            status.current_step = Some("准备迁移".to_string());
            status.message = Some("正在启动旧版数据库导入。".to_string());
            status.error = None;
            status.progress = 0.02;
            status.clone()
        }
    };
    emit_status(app, &snapshot);

    if snapshot.status != "running" || !snapshot.needs_db_import {
        return serde_json::to_value(snapshot).map_err(|error| error.to_string());
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        if let Err(error) = execute_startup_migration(app_handle.clone()) {
            let state = app_handle.state::<AppState>();
            let legacy_db_path = state
                .startup_migration
                .lock()
                .ok()
                .and_then(|status| status.legacy_db_path.clone());
            let _ = write_failed_receipt(&state.store_path, legacy_db_path, error.clone());
            let _ = set_status(&app_handle, &state, |status| {
                status.status = "failed".to_string();
                status.needs_db_import = true;
                status.should_show_modal = true;
                status.current_step = Some("导入失败".to_string());
                status.message = Some("旧版数据库导入失败，请重试。".to_string());
                status.error = Some(error.clone());
                status.progress = 0.0;
            });
        }
    });

    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}
