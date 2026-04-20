use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::scheduler::sync_redclaw_job_definitions;
use crate::{
    auth, compatible_workspace_base_dir, create_manuscript_package, detect_best_legacy_db,
    emit_space_changed, is_legacy_workspace_base, is_manuscript_package_name, join_relative,
    legacy_workspace_dir, maybe_import_legacy_store, normalize_relative_path, now_iso,
    persist_store, preferred_workspace_dir, title_from_relative_path, AppState, AppStore,
    POST_DRAFT_EXTENSION,
};

pub(crate) const STARTUP_MIGRATION_EVENT: &str = "app:startup-migration-status";
const STARTUP_MIGRATION_VERSION: i64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StartupMigrationStatus {
    pub status: String,
    pub needs_db_import: bool,
    pub needs_project_upgrade: bool,
    pub should_show_modal: bool,
    pub legacy_db_path: Option<String>,
    pub legacy_workspace_path: Option<String>,
    pub workspace_path: Option<String>,
    pub current_step: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub progress: f64,
    pub legacy_markdown_count: Option<usize>,
    pub imported_counts: Option<Value>,
    pub project_upgrade_counts: Option<Value>,
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
    project_upgrade_counts: Option<Value>,
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

fn project_upgrade_counts_payload(found: usize, upgraded: usize, skipped: usize) -> Value {
    json!({
        "found": found,
        "upgraded": upgraded,
        "skipped": skipped
    })
}

fn status_requires_work(status: &StartupMigrationStatus) -> bool {
    status.needs_db_import || status.needs_project_upgrade
}

fn collect_legacy_markdown_manuscripts(
    manuscripts_root: &Path,
    current: &Path,
    out: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }

    let mut entries = fs::read_dir(current)
        .map_err(|error| error.to_string())?
        .flatten()
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if is_manuscript_package_name(&file_name) {
                continue;
            }
            collect_legacy_markdown_manuscripts(manuscripts_root, &path, out)?;
            continue;
        }

        let is_markdown = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_markdown {
            continue;
        }

        let relative = path
            .strip_prefix(manuscripts_root)
            .map_err(|error| error.to_string())?;
        let relative_string = normalize_relative_path(relative.to_string_lossy().as_ref());
        out.push((path, relative_string));
    }

    Ok(())
}

fn list_legacy_markdown_manuscripts(
    manuscripts_root: &Path,
) -> Result<Vec<(PathBuf, String)>, String> {
    let mut items = Vec::new();
    collect_legacy_markdown_manuscripts(manuscripts_root, manuscripts_root, &mut items)?;
    Ok(items)
}

fn count_legacy_markdown_manuscripts(workspace_root: &Path) -> usize {
    list_legacy_markdown_manuscripts(&workspace_root.join("manuscripts"))
        .map(|items| items.len())
        .unwrap_or(0)
}

fn migrate_legacy_markdown_manuscripts(workspace_root: &Path) -> Result<Value, String> {
    let manuscripts_root = workspace_root.join("manuscripts");
    let files = list_legacy_markdown_manuscripts(&manuscripts_root)?;
    let found = files.len();
    let mut upgraded = 0usize;
    let mut skipped = 0usize;

    for (source_path, source_relative) in files {
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
            &format!("{stem}{POST_DRAFT_EXTENSION}"),
        ));
        let target_path = manuscripts_root.join(&target_relative);
        if target_path.exists() {
            skipped += 1;
            continue;
        }

        let content = fs::read_to_string(&source_path).map_err(|error| error.to_string())?;
        let title = title_from_relative_path(&source_relative);
        create_manuscript_package(&target_path, &content, &target_relative, &title)?;
        fs::remove_file(&source_path).map_err(|error| error.to_string())?;
        upgraded += 1;
    }

    Ok(project_upgrade_counts_payload(found, upgraded, skipped))
}

fn startup_pending_message(needs_db_import: bool, legacy_markdown_count: usize) -> String {
    match (needs_db_import, legacy_markdown_count > 0) {
        (true, true) => format!(
            "检测到旧版数据库，同时发现 {legacy_markdown_count} 个旧版 Markdown 稿件。需要把数据库导入到新版状态，并把这些 `.md` 自动升级成 `.redpost` 图文工程。"
        ),
        (true, false) => {
            "检测到旧版数据库，需要导入到新版数据格式。文件目录会继续直接使用旧版位置。"
                .to_string()
        }
        (false, true) => format!(
            "检测到 {legacy_markdown_count} 个旧版 Markdown 稿件，需要自动升级成 `.redpost` 图文工程。"
        ),
        (false, false) => "当前不需要启动迁移。".to_string(),
    }
}

fn startup_failed_message(needs_db_import: bool, legacy_markdown_count: usize) -> String {
    match (needs_db_import, legacy_markdown_count > 0) {
        (true, true) => "上次启动迁移没有完成，可以重新开始数据库导入和稿件工程升级。".to_string(),
        (true, false) => "上次数据库导入没有完成，可以重新开始。".to_string(),
        (false, true) => "上次稿件工程升级没有完成，可以重新开始。".to_string(),
        (false, false) => "上次启动迁移没有完成，可以重新开始。".to_string(),
    }
}

fn startup_completed_message(
    imported_counts: Option<&Value>,
    project_upgrade_counts: Option<&Value>,
) -> String {
    let project_upgraded = project_upgrade_counts
        .and_then(|value| value.get("upgraded"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let project_skipped = project_upgrade_counts
        .and_then(|value| value.get("skipped"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    match (imported_counts.is_some(), project_upgraded > 0 || project_skipped > 0) {
        (true, true) => format!(
            "旧版数据库导入完成，旧稿件工程升级也已完成。已升级 {project_upgraded} 个 Markdown 稿件，跳过 {project_skipped} 个已有同名工程的文件。"
        ),
        (true, false) => "旧版数据库已经导入完成。文件目录仍然保留在原来的位置。".to_string(),
        (false, true) => format!(
            "旧稿件工程升级完成。已升级 {project_upgraded} 个 Markdown 稿件，跳过 {project_skipped} 个已有同名工程的文件。"
        ),
        (false, false) => "启动迁移已完成。".to_string(),
    }
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
    let workspace_root =
        crate::workspace_root_from_snapshot(&store.settings, &store.active_space_id, store_path)
            .ok();
    let legacy_markdown_count = workspace_root
        .as_ref()
        .map(|path| count_legacy_markdown_manuscripts(path))
        .unwrap_or(0);
    let needs_project_upgrade = legacy_markdown_count > 0;
    let receipt = load_startup_migration_receipt(store_path);

    let Some(db_path) = legacy_db_path.as_ref() else {
        let failed_message = receipt
            .as_ref()
            .filter(|item| item.status == "failed" && needs_project_upgrade)
            .and_then(|item| item.last_error.clone());
        if !needs_project_upgrade {
            return StartupMigrationStatus {
                status: "not-needed".to_string(),
                needs_db_import: false,
                needs_project_upgrade: false,
                should_show_modal: false,
                legacy_db_path: None,
                legacy_workspace_path,
                workspace_path,
                current_step: None,
                message: None,
                error: None,
                progress: 0.0,
                legacy_markdown_count: Some(0),
                imported_counts: None,
                project_upgrade_counts: None,
            };
        }

        return StartupMigrationStatus {
            status: if failed_message.is_some() {
                "failed".to_string()
            } else {
                "pending".to_string()
            },
            needs_db_import: false,
            needs_project_upgrade: true,
            should_show_modal: true,
            legacy_db_path: None,
            legacy_workspace_path,
            workspace_path,
            current_step: None,
            message: Some(if failed_message.is_some() {
                startup_failed_message(false, legacy_markdown_count)
            } else {
                startup_pending_message(false, legacy_markdown_count)
            }),
            error: failed_message,
            progress: 0.0,
            legacy_markdown_count: Some(legacy_markdown_count),
            imported_counts: None,
            project_upgrade_counts: None,
        };
    };

    let fingerprint = legacy_db_fingerprint(db_path);
    let db_path_string = db_path.display().to_string();
    let already_completed = receipt.as_ref().is_some_and(|item| {
        item.version >= 1
            && item.status == "completed"
            && item.legacy_db_path.as_deref() == Some(db_path_string.as_str())
            && item.source_fingerprint == fingerprint
    });

    if already_completed && !needs_project_upgrade {
        return StartupMigrationStatus {
            status: "completed".to_string(),
            needs_db_import: false,
            needs_project_upgrade: false,
            should_show_modal: false,
            legacy_db_path: Some(db_path_string),
            legacy_workspace_path,
            workspace_path,
            current_step: None,
            message: Some("旧版数据库已经导入过，新版将直接使用当前数据。".to_string()),
            error: None,
            progress: 1.0,
            legacy_markdown_count: Some(0),
            imported_counts: receipt.and_then(|item| item.imported_counts),
            project_upgrade_counts: None,
        };
    }

    let failed_message = receipt
        .as_ref()
        .filter(|item| item.status == "failed" && (needs_project_upgrade || !already_completed))
        .and_then(|item| item.last_error.clone());

    let needs_db_import = !already_completed;
    StartupMigrationStatus {
        status: if failed_message.is_some() {
            "failed".to_string()
        } else {
            "pending".to_string()
        },
        needs_db_import,
        needs_project_upgrade,
        should_show_modal: true,
        legacy_db_path: Some(db_path_string),
        legacy_workspace_path,
        workspace_path,
        current_step: None,
        message: if failed_message.is_some() {
            Some(startup_failed_message(
                needs_db_import,
                legacy_markdown_count,
            ))
        } else {
            Some(startup_pending_message(
                needs_db_import,
                legacy_markdown_count,
            ))
        },
        error: failed_message,
        progress: 0.0,
        legacy_markdown_count: Some(legacy_markdown_count),
        imported_counts: None,
        project_upgrade_counts: None,
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
        project_upgrade_counts: None,
        last_error: Some(error),
    };
    save_startup_migration_receipt(store_path, &receipt)
}

fn execute_startup_migration(app: AppHandle) -> Result<AppStore, String> {
    let state = app.state::<AppState>();
    let (needs_db_import, needs_project_upgrade, legacy_db_path) = {
        let status = state
            .startup_migration
            .lock()
            .map_err(|_| "startup migration lock is poisoned".to_string())?;
        (
            status.needs_db_import,
            status.needs_project_upgrade,
            status.legacy_db_path.clone(),
        )
    };
    if !needs_db_import && !needs_project_upgrade {
        return Err("startup migration is not needed".to_string());
    }
    if needs_db_import && legacy_db_path.is_none() {
        return Err("legacy db path is unavailable".to_string());
    }

    let mut started_receipt = StartupMigrationReceipt {
        version: STARTUP_MIGRATION_VERSION,
        status: "running".to_string(),
        legacy_db_path: legacy_db_path.clone(),
        source_fingerprint: legacy_db_path
            .as_deref()
            .map(Path::new)
            .and_then(legacy_db_fingerprint),
        started_at: Some(now_iso()),
        completed_at: None,
        imported_counts: None,
        project_upgrade_counts: None,
        last_error: None,
    };
    save_startup_migration_receipt(&state.store_path, &started_receipt)?;

    let _ = set_status(&app, &state, |status| {
        status.status = "running".to_string();
        status.should_show_modal = true;
        status.current_step = Some("准备迁移".to_string());
        status.message = Some(if needs_db_import {
            "正在准备数据库导入和工程文件升级。".to_string()
        } else {
            "正在准备旧稿件工程升级。".to_string()
        });
        status.error = None;
        status.progress = 0.05;
        status.project_upgrade_counts = None;
        status.imported_counts = None;
    })?;

    let mut imported_store = {
        let store = state
            .store
            .lock()
            .map_err(|_| "state lock is poisoned".to_string())?;
        store.clone()
    };

    if needs_db_import {
        let _ = set_status(&app, &state, |status| {
            status.current_step = Some("导入数据库记录".to_string());
            status.message = Some("正在导入设置、空间、聊天记录和历史数据。".to_string());
            status.progress = 0.28;
        })?;
        maybe_import_legacy_store(&mut imported_store, &state.store_path)?;

        let _ = set_status(&app, &state, |status| {
            status.current_step = Some("同步认证与空间数据".to_string());
            status.message = Some("正在整理新版运行所需的状态。".to_string());
            status.progress = 0.58;
        })?;
        auth::migrate_legacy_auth_store(&state.store_path, &mut imported_store)?;
    } else {
        let _ = set_status(&app, &state, |status| {
            status.current_step = Some("检查当前工作区".to_string());
            status.message = Some("正在确认当前工作区与稿件目录。".to_string());
            status.progress = 0.24;
        })?;
    }

    normalize_workspace_dir_setting(&mut imported_store)?;
    sync_redclaw_job_definitions(&mut imported_store);

    let workspace_root = crate::workspace_root_from_snapshot(
        &imported_store.settings,
        &imported_store.active_space_id,
        &state.store_path,
    )?;

    let project_upgrade_counts = if needs_project_upgrade {
        let _ = set_status(&app, &state, |status| {
            status.current_step = Some("升级工程文件".to_string());
            status.message = Some("正在把旧 `.md` 稿件升级成 `.redpost` 图文工程。".to_string());
            status.progress = if needs_db_import { 0.78 } else { 0.62 };
        })?;
        let counts = migrate_legacy_markdown_manuscripts(&workspace_root)?;
        let _ = set_status(&app, &state, |status| {
            status.legacy_markdown_count = Some(0);
            status.project_upgrade_counts = Some(counts.clone());
        })?;
        Some(counts)
    } else {
        None
    };

    let _ = set_status(&app, &state, |status| {
        status.current_step = Some("保存新版数据".to_string());
        status.message = Some("正在写入迁移后的状态。".to_string());
        status.progress = 0.9;
    })?;
    persist_store(&state.store_path, &imported_store)?;

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
    started_receipt.imported_counts = if needs_db_import {
        Some(imported_counts.clone())
    } else {
        None
    };
    started_receipt.project_upgrade_counts = project_upgrade_counts.clone();
    save_startup_migration_receipt(&state.store_path, &started_receipt)?;

    let completed_message = startup_completed_message(
        started_receipt.imported_counts.as_ref(),
        started_receipt.project_upgrade_counts.as_ref(),
    );
    let _ = set_status(&app, &state, |status| {
        status.status = "completed".to_string();
        status.needs_db_import = false;
        status.needs_project_upgrade = false;
        status.should_show_modal = true;
        status.current_step = Some("迁移完成".to_string());
        status.message = Some(completed_message);
        status.error = None;
        status.progress = 1.0;
        status.legacy_markdown_count = Some(0);
        status.imported_counts = started_receipt.imported_counts.clone();
        status.project_upgrade_counts = started_receipt.project_upgrade_counts.clone();
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
        if status.status == "running" || !status_requires_work(&status) {
            status.clone()
        } else {
            status.status = "running".to_string();
            status.current_step = Some("准备迁移".to_string());
            status.message = Some(if status.needs_db_import {
                "正在启动数据库导入和稿件工程升级。".to_string()
            } else {
                "正在启动旧稿件工程升级。".to_string()
            });
            status.error = None;
            status.progress = 0.02;
            status.clone()
        }
    };
    emit_status(app, &snapshot);

    if snapshot.status != "running" || !status_requires_work(&snapshot) {
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
                status.should_show_modal = true;
                status.current_step = Some("迁移失败".to_string());
                status.message = Some(startup_failed_message(
                    status.needs_db_import,
                    status.legacy_markdown_count.unwrap_or_default(),
                ));
                status.error = Some(error.clone());
                status.progress = 0.0;
            });
        }
    });

    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("redbox-startup-migration-{label}-{unique}"))
    }

    #[test]
    fn markdown_migration_upgrades_only_legacy_markdown_files() {
        let workspace_root = temp_workspace_path("project-upgrade");
        let manuscripts_root = workspace_root.join("manuscripts");
        fs::create_dir_all(manuscripts_root.join("nested")).expect("should create nested dir");
        fs::create_dir_all(manuscripts_root.join("existing.redpost"))
            .expect("should create package dir");
        fs::write(manuscripts_root.join("draft.md"), "# Draft").expect("should write markdown");
        fs::write(manuscripts_root.join("nested").join("deep.md"), "Deep body")
            .expect("should write nested markdown");
        fs::write(
            manuscripts_root.join("existing.redpost").join("content.md"),
            "package content",
        )
        .expect("should write package markdown");

        let counts =
            migrate_legacy_markdown_manuscripts(&workspace_root).expect("migration should succeed");

        assert_eq!(counts.get("found").and_then(Value::as_u64), Some(2));
        assert_eq!(counts.get("upgraded").and_then(Value::as_u64), Some(2));
        assert_eq!(counts.get("skipped").and_then(Value::as_u64), Some(0));
        assert!(manuscripts_root.join("draft.redpost").exists());
        assert!(manuscripts_root
            .join("nested")
            .join("deep.redpost")
            .exists());
        assert!(!manuscripts_root.join("draft.md").exists());
        assert!(!manuscripts_root.join("nested").join("deep.md").exists());
        assert!(manuscripts_root
            .join("existing.redpost")
            .join("content.md")
            .exists());

        let _ = fs::remove_dir_all(&workspace_root);
    }

    #[test]
    fn markdown_migration_skips_when_same_name_package_already_exists() {
        let workspace_root = temp_workspace_path("project-skip");
        let manuscripts_root = workspace_root.join("manuscripts");
        fs::create_dir_all(manuscripts_root.join("conflict.redpost"))
            .expect("should create package dir");
        fs::write(manuscripts_root.join("conflict.md"), "legacy").expect("should write markdown");

        let counts =
            migrate_legacy_markdown_manuscripts(&workspace_root).expect("migration should succeed");

        assert_eq!(counts.get("found").and_then(Value::as_u64), Some(1));
        assert_eq!(counts.get("upgraded").and_then(Value::as_u64), Some(0));
        assert_eq!(counts.get("skipped").and_then(Value::as_u64), Some(1));
        assert!(manuscripts_root.join("conflict.md").exists());

        let _ = fs::remove_dir_all(&workspace_root);
    }
}
