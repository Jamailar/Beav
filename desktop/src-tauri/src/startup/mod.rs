use crate::scheduler::sync_redclaw_job_definitions;
use crate::*;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) struct StartupPreparedState {
    pub(crate) store_path: PathBuf,
    pub(crate) store: AppStore,
    pub(crate) startup_migration_status: startup_migration::StartupMigrationStatus,
    pub(crate) initial_workspace_root: PathBuf,
}

pub(crate) fn prepare_startup_state() -> StartupPreparedState {
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
    let model_config_existed_at_startup =
        ai_model_manager::legacy_config::model_config_path(&store_path).exists();
    let model_defaults_initialized = official_support::model_defaults_initialized(&store.settings);
    if !model_config_existed_at_startup && !model_defaults_initialized {
        match official_support::fetch_official_default_model_slots_for_settings(&store.settings) {
            Ok(default_slots) => {
                let catalog_models =
                    official_support::fetch_official_models_for_settings(&store.settings);
                if official_support::seed_official_default_models_into_settings(
                    &mut store.settings,
                    &default_slots,
                    &catalog_models,
                ) {
                    if let Err(error) = ai_model_manager::store::sync_model_config_file(
                        &store_path,
                        &store.settings,
                    ) {
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
    } else if !model_config_existed_at_startup && model_defaults_initialized {
        if let Err(error) =
            ai_model_manager::store::sync_model_config_file(&store_path, &store.settings)
        {
            logging::emit_legacy_line(
                logging::event::LogSource::Host,
                logging::event::LogLevel::Warn,
                "model_config",
                "startup.model_config_user_settings_sync_failed",
                format!("[{} model config] {error}", app_brand_display_name()),
                json!({ "error": error }),
                None,
            );
        }
    }
    if let Err(error) = ai_model_manager::legacy_config::load_model_config_into_settings(
        &store_path,
        &mut store.settings,
    ) {
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
    let repaired_missing_model_defaults =
        match ai_model_manager::defaults::repair_missing_official_defaults_in_settings(
            &mut store.settings,
        ) {
            Ok(repaired) => repaired,
            Err(error) => {
                logging::emit_legacy_line(
                    logging::event::LogSource::Host,
                    logging::event::LogLevel::Warn,
                    "model_config",
                    "startup.model_config_defaults_repair_failed",
                    format!("[{} model config] {error}", app_brand_display_name()),
                    json!({ "error": error }),
                    None,
                );
                false
            }
        };
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
    if (synced_cached_official_models || repaired_missing_model_defaults)
        && ai_model_manager::legacy_config::model_config_path(&store_path).exists()
    {
        ai_model_manager::legacy_projection::normalize_settings_projection(&mut store.settings);
        if let Err(error) =
            ai_model_manager::store::sync_model_config_file(&store_path, &store.settings)
        {
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

    StartupPreparedState {
        store_path,
        store,
        startup_migration_status,
        initial_workspace_root,
    }
}

pub(crate) fn run_setup_restore_sequence(
    app: &mut tauri::App,
) -> Result<(), Box<dyn std::error::Error>> {
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
                let _ =
                    commands::official::trigger_official_cached_data_refresh(app.handle().clone());
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
    if let Err(error) = commands::redclaw::ensure_redclaw_runtime_running(app.handle(), &state) {
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
    if let Err(error) = media_runtime::ensure_media_generation_runtime_running(app.handle(), &state)
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
    if let Err(error) =
        commands::assistant_daemon::ensure_assistant_daemon_running(app.handle(), &state, true)
    {
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
