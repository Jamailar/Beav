mod app_update;
mod feedback;

use app_update::{check_app_update, APP_UPDATE_DOWNLOAD_PAGE_URL};
use arboard::Clipboard;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::file_ops::resolve_file_action_path;
use crate::logging::event::LogLevel;
use crate::logging::{
    create_report_from_trigger, dismiss_pending_report, export_bundle_for_report,
    list_pending_reports_value, log_renderer_event, recent_value,
    status_value as logging_status_value, update_upload_consent, upload_pending_report,
};
use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::store::{settings as settings_store, spaces as spaces_store};
use crate::{
    is_same_path, now_iso, payload_field, payload_string, payload_value_as_string,
    pick_files_native, refresh_runtime_warm_state, store_root, update_workspace_root_cache,
    workspace_root_from_snapshot, AppState,
};

fn is_http_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("https://") || normalized.starts_with("http://")
}

fn normalize_default_ai_route_settings(settings: &mut Value) {
    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let Some(raw_sources) = payload_string(settings, "ai_sources_json") else {
        return;
    };
    let sources = serde_json::from_str::<Vec<Value>>(&raw_sources).unwrap_or_default();
    let default_source = sources.iter().find(|source| {
        source
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.trim() == default_source_id)
            .unwrap_or(false)
    });
    let Some(source) = default_source else {
        return;
    };

    let base_url = source
        .get("baseURL")
        .or_else(|| source.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let api_key = source
        .get("apiKey")
        .or_else(|| source.get("key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let model_name = source
        .get("model")
        .or_else(|| source.get("modelName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    if let Some(object) = settings.as_object_mut() {
        object.insert("api_endpoint".to_string(), json!(base_url));
        object.insert("api_key".to_string(), json!(api_key.clone()));
        object.insert("model_name".to_string(), json!(model_name));
        let current_video_api_key = object
            .get("video_api_key")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if current_video_api_key.is_empty() && !api_key.is_empty() {
            object.insert("video_api_key".to_string(), json!(api_key));
        }
    }
}

fn payload_updates_ai_model_selection(payload: &Value) -> bool {
    let Some(object) = payload.as_object() else {
        return false;
    };
    object.keys().any(|key| {
        matches!(
            key.as_str(),
            "ai_model_routes_json"
                | "ai_sources_json"
                | "default_ai_source_id"
                | "model_name"
                | "model_name_wander"
                | "model_name_chatroom"
                | "model_name_knowledge"
                | "model_name_redclaw"
                | "transcription_model"
                | "embedding_model"
                | "image_model"
                | "video_model"
                | "visual_index_model"
                | "video_analysis_model"
                | "voice_tts_model"
                | "voice_clone_model"
        )
    })
}

fn merged_settings_payload(current: &Value, payload: &Value) -> Value {
    let mut next =
        if let (Some(current), Some(payload)) = (current.as_object(), payload.as_object()) {
            let mut merged = current.clone();
            for (key, value) in payload {
                if matches!(key.as_str(), "redbox_auth_session_json") {
                    continue;
                }
                merged.insert(key.to_string(), value.clone());
            }
            Value::Object(merged)
        } else {
            payload.clone()
        };
    normalize_default_ai_route_settings(&mut next);
    if payload_updates_ai_model_selection(payload) {
        if let Some(object) = next.as_object_mut() {
            object
                .entry(crate::official_support::AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY.to_string())
                .or_insert_with(|| json!(now_iso()));
        }
    }
    if let Some(object) = next.as_object_mut() {
        object.insert("visual_index_enabled".to_string(), json!(true));
        object.insert("video_analysis_enabled".to_string(), json!(true));
    }
    next
}

fn bundled_html_resource_path(
    app: &AppHandle,
    file_name: &str,
    missing_message: &str,
) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut push = |path: PathBuf| {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            candidates.push(path);
        }
    };

    push(resource_dir.join(file_name));
    push(resource_dir.join("resources").join(file_name));
    push(resource_dir.join("_up_").join(file_name));
    push(resource_dir.join("_up_").join("resources").join(file_name));

    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            push(cwd.join("src-tauri").join("resources").join(file_name));
            push(cwd.join("resources").join(file_name));
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(missing_message.to_string())
}

fn knowledge_api_guide_path(app: &AppHandle) -> Result<PathBuf, String> {
    bundled_html_resource_path(app, "knowledge-api-guide.html", "知识导入 API 文档页不存在")
}

pub fn handle_system_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "app:get-version"
        | "app:check-update"
        | "app:open-release-page"
        | "app:startup-migration-start"
        | "app:startup-migration-status"
        | "app:open-knowledge-api-guide"
        | "app:open-path"
        | "settings:pick-workspace-dir"
        | "ai-model-manager:snapshot"
        | "ai-model-manager:resolve"
        | "db:get-settings"
        | "db:save-settings"
        | "debug:get-status"
        | "debug:get-recent"
        | "debug:get-runtime-summary"
        | "debug:open-log-dir"
        | "logs:get-status"
        | "logs:get-recent"
        | "logs:open-dir"
        | "logs:list-pending-reports"
        | "logs:export-bundle"
        | "logs:create-feedback-report"
        | "logs:upload-report"
        | "logs:dismiss-report"
        | "logs:set-upload-consent"
        | "logs:append-renderer"
        | "clipboard:read-text"
        | "clipboard:write-html" => (|| -> Result<Value, String> {
            match channel {
                "app:get-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
                "app:check-update" => {
                    let force = payload_field(payload, "force")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    check_app_update(app, force, force)
                }
                "app:open-release-page" => {
                    let url = payload_string(payload, "url")
                        .or_else(|| payload_value_as_string(payload))
                        .unwrap_or_else(|| APP_UPDATE_DOWNLOAD_PAGE_URL.to_string());
                    if !is_http_url(&url) {
                        return Err("Invalid download URL".to_string());
                    }
                    open::that(&url).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "url": url }))
                }
                "app:startup-migration-status" => crate::startup_migration_status_value(state),
                "app:startup-migration-start" => crate::start_startup_migration(app, state),
                "app:open-knowledge-api-guide" => {
                    let path = knowledge_api_guide_path(app)?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path.display().to_string() }))
                }
                "app:open-path" => {
                    let path = payload_string(payload, "path")
                        .or_else(|| payload_value_as_string(payload))
                        .ok_or_else(|| "path is required".to_string())?;
                    if is_http_url(&path) {
                        open::that(&path).map_err(|error| error.to_string())?;
                        return Ok(json!({ "success": true, "path": path }));
                    }
                    let open_target = resolve_file_action_path(state, &path)
                        .unwrap_or_else(|_| PathBuf::from(&path));
                    open::that(&open_target).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": open_target }))
                }
                "settings:pick-workspace-dir" => {
                    let selected = pick_files_native("选择工作区目录", true, false)?;
                    let path = selected.first().map(|item| item.display().to_string());
                    Ok(json!({
                        "success": path.is_some(),
                        "canceled": path.is_none(),
                        "path": path,
                    }))
                }
                "ai-model-manager:snapshot" => with_store(state, |store| {
                    let runtime = state
                        .auth_runtime
                        .lock()
                        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                    let settings = settings_store::settings_snapshot(&store);
                    let projected = crate::auth::project_settings_for_runtime(&settings, &runtime);
                    serde_json::to_value(crate::ai_model_manager::AiModelManager::snapshot(
                        &projected,
                    ))
                    .map_err(|error| error.to_string())
                }),
                "ai-model-manager:resolve" => {
                    let runtime_mode = payload_string(payload, "runtimeMode")
                        .or_else(|| payload_string(payload, "runtime_mode"));
                    let scope = payload_string(payload, "scope");
                    let action = payload_string(payload, "action");
                    with_store(state, |store| {
                        let runtime = state
                            .auth_runtime
                            .lock()
                            .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                        let settings = settings_store::settings_snapshot(&store);
                        let projected =
                            crate::auth::project_settings_for_runtime(&settings, &runtime);
                        let resolved = if let Some(action) = action.as_deref() {
                            crate::ai_model_manager::AiModelManager::resolve_for_tool(
                                &projected,
                                action,
                                Some(payload),
                            )
                        } else {
                            let scope = scope
                                .as_deref()
                                .map(crate::ai_model_manager::AiModelScope::from_route_scope)
                                .unwrap_or_else(|| {
                                    crate::ai_model_manager::scope_for_runtime_mode(
                                        runtime_mode.as_deref(),
                                    )
                                });
                            crate::ai_model_manager::AiModelManager::resolve(
                                &projected,
                                scope,
                                Some(payload),
                            )
                        };
                        Ok(resolved
                            .as_ref()
                            .map(crate::ai_model_manager::resolved_value_for_debug)
                            .unwrap_or_else(|| json!({ "success": false, "error": "unresolved" })))
                    })
                }
                "db:get-settings" => with_store(state, |store| {
                    let runtime = state
                        .auth_runtime
                        .lock()
                        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                    let settings = settings_store::settings_snapshot(&store);
                    let mut projected =
                        crate::auth::project_settings_for_runtime(&settings, &runtime);
                    crate::ai_model_manager::legacy_projection::normalize_settings_projection(
                        &mut projected,
                    );
                    normalize_default_ai_route_settings(&mut projected);
                    Ok(projected)
                }),
                "db:save-settings" => {
                    let previous_workspace_root = with_store(state, |store| {
                        let settings = settings_store::settings_snapshot(&store);
                        let active_space_id = spaces_store::active_space_id(&store);
                        Ok(workspace_root_from_snapshot(
                            &settings,
                            &active_space_id,
                            &state.store_path,
                        )
                        .ok())
                    })?;
                    let (active_space_id, settings_snapshot) = with_store_mut(state, |store| {
                        let settings_snapshot = settings_store::update_settings(
                            store,
                            |settings| {
                                *settings = merged_settings_payload(settings, payload);
                                crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
                            },
                        );
                        Ok((spaces_store::active_space_id(store), settings_snapshot))
                    })?;
                    crate::ai_model_manager::store::sync_model_config_file(
                        &state.store_path,
                        &settings_snapshot,
                    )?;
                    let _ =
                        crate::ai_model_manager::defaults::repair_missing_official_defaults_for_store(
                            Some(app),
                            state,
                            "settings-model-defaults-repair",
                        );
                    let workspace_root =
                        update_workspace_root_cache(state, &settings_snapshot, &active_space_id)?;
                    let workspace_changed = previous_workspace_root
                        .as_ref()
                        .map(|previous| !is_same_path(previous, &workspace_root))
                        .unwrap_or(true);
                    if workspace_changed {
                        let snapshot = load_workspace_hydration_snapshot(&workspace_root);
                        with_store_mut(state, |store| {
                            apply_workspace_hydration_snapshot(store, snapshot);
                            Ok(())
                        })?;
                    }
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
                    let _ = app.emit(
                        "settings:updated",
                        json!({
                            "updatedAt": now_iso(),
                        }),
                    );
                    if payload_requests_visual_index_backfill(payload) {
                        crate::knowledge_index::jobs::schedule_visual_backfill(
                            app,
                            "settings-visual-index",
                        );
                    }
                    Ok(json!({ "success": true }))
                }
                "debug:get-status" | "logs:get-status" => logging_status_value(state),
                "debug:get-recent" => {
                    let limit = payload_field(payload, "limit")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(50)
                        .clamp(1, 200) as usize;
                    Ok(recent_value(limit))
                }
                "debug:get-runtime-summary" => crate::build_runtime_diagnostics_summary(state),
                "debug:open-log-dir" | "logs:open-dir" => {
                    let path = store_root(state)?.join("logs");
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path.display().to_string() }))
                }
                "logs:get-recent" => {
                    let limit = payload_field(payload, "limit")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(50)
                        .clamp(1, 200) as usize;
                    Ok(recent_value(limit))
                }
                "logs:list-pending-reports" => list_pending_reports_value(),
                "logs:export-bundle" => {
                    let report_id = if let Some(report_id) = payload_string(payload, "reportId") {
                        report_id
                    } else {
                        create_report_from_trigger(
                            state,
                            "manual-export",
                            "用户手动导出诊断包",
                            payload
                                .get("includeAdvancedContext")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            json!({
                                "source": "settings",
                            }),
                        )?
                        .id
                    };
                    let path = export_bundle_for_report(state, &report_id)?;
                    Ok(
                        json!({ "success": true, "reportId": report_id, "path": path.display().to_string() }),
                    )
                }
                "logs:create-feedback-report" => {
                    feedback::create_feedback_report_command(app, state, payload)
                }
                "logs:upload-report" => {
                    let report_id = payload_string(payload, "reportId")
                        .ok_or_else(|| "reportId is required".to_string())?;
                    upload_pending_report(state, &report_id)
                }
                "logs:dismiss-report" => {
                    let report_id = payload_string(payload, "reportId")
                        .ok_or_else(|| "reportId is required".to_string())?;
                    dismiss_pending_report(&report_id)
                }
                "logs:set-upload-consent" => {
                    let consent =
                        payload_string(payload, "consent").unwrap_or_else(|| "none".to_string());
                    let auto_send_same_crash = payload
                        .get("autoSendSameCrash")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    update_upload_consent(state, &consent, auto_send_same_crash)
                }
                "logs:append-renderer" => {
                    let level =
                        payload_string(payload, "level").unwrap_or_else(|| "error".to_string());
                    let category = payload_string(payload, "category")
                        .unwrap_or_else(|| "plugin.bridge".to_string());
                    let event = payload_string(payload, "event")
                        .unwrap_or_else(|| "renderer.log".to_string());
                    let message = payload_string(payload, "message")
                        .unwrap_or_else(|| "renderer log".to_string());
                    log_renderer_event(
                        match level.to_ascii_lowercase().as_str() {
                            "trace" => LogLevel::Trace,
                            "debug" => LogLevel::Debug,
                            "warn" => LogLevel::Warn,
                            "error" => LogLevel::Error,
                            _ => LogLevel::Info,
                        },
                        &category,
                        &event,
                        &message,
                        payload_field(payload, "fields")
                            .cloned()
                            .unwrap_or(Value::Null),
                    );
                    Ok(json!({ "success": true }))
                }
                "clipboard:read-text" => Ok(json!(Clipboard::new()
                    .and_then(|mut clipboard| clipboard.get_text())
                    .unwrap_or_default())),
                "clipboard:write-html" => {
                    let text = payload_string(payload, "text")
                        .or_else(|| payload_string(payload, "html"))
                        .unwrap_or_default();
                    Clipboard::new()
                        .and_then(|mut clipboard| clipboard.set_text(text.clone()))
                        .map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "text": text }))
                }
                _ => unreachable!("channel prefiltered"),
            }
        })(),
        _ => return None,
    };

    Some(result)
}

fn payload_requests_visual_index_backfill(payload: &Value) -> bool {
    payload_field(payload, "visual_index_enabled")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            payload
                .as_object()
                .map(|object| object.keys().any(|key| key.starts_with("visual_index_")))
                .unwrap_or(false)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_default_ai_route_settings_replaces_stale_root_fields_with_empty_values() {
        let mut settings = json!({
            "default_ai_source_id": "next",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "next",
                "name": "Next",
                "baseURL": "",
                "apiKey": "",
                "model": ""
            })]).unwrap()
        });

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(settings["api_endpoint"], json!(""));
        assert_eq!(settings["api_key"], json!(""));
        assert_eq!(settings["model_name"], json!(""));
    }

    #[test]
    fn normalize_default_ai_route_settings_syncs_selected_source_to_root_fields() {
        let mut settings = json!({
            "default_ai_source_id": "next",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "next",
                "name": "Next",
                "baseURL": "https://next.example/v1",
                "apiKey": "next-key",
                "model": "next-model"
            })]).unwrap()
        });

        normalize_default_ai_route_settings(&mut settings);

        assert_eq!(settings["api_endpoint"], json!("https://next.example/v1"));
        assert_eq!(settings["api_key"], json!("next-key"));
        assert_eq!(settings["model_name"], json!("next-model"));
    }

    #[test]
    fn merged_settings_payload_preserves_custom_workspace_dir_for_partial_updates() {
        let current = json!({
            "workspace_dir": "/Volumes/RedBox Workspace",
            "default_ai_source_id": "official",
            "theme": "dark"
        });
        let payload = json!({
            "theme": "light"
        });

        let merged = merged_settings_payload(&current, &payload);

        assert_eq!(
            merged.get("workspace_dir").and_then(Value::as_str),
            Some("/Volumes/RedBox Workspace")
        );
        assert_eq!(merged.get("theme").and_then(Value::as_str), Some("light"));
    }

    #[test]
    fn merged_settings_payload_marks_model_defaults_initialized_on_model_save() {
        let current = json!({
            "theme": "dark"
        });
        let payload = json!({
            "model_name": "user-model"
        });

        let merged = merged_settings_payload(&current, &payload);

        assert_eq!(
            merged.get("model_name").and_then(Value::as_str),
            Some("user-model")
        );
        assert!(merged
            .get(crate::official_support::AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY)
            .and_then(Value::as_str)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn merged_settings_payload_does_not_overwrite_auth_session_from_renderer_payload() {
        let current = json!({
            "workspace_dir": "/Volumes/RedBox Workspace",
            "redbox_auth_session_json": "{\"token\":\"current\"}"
        });
        let payload = json!({
            "redbox_auth_session_json": "{\"token\":\"stale\"}",
            "theme": "light"
        });

        let merged = merged_settings_payload(&current, &payload);

        assert_eq!(
            merged
                .get("redbox_auth_session_json")
                .and_then(Value::as_str),
            Some("{\"token\":\"current\"}")
        );
        assert_eq!(
            merged.get("workspace_dir").and_then(Value::as_str),
            Some("/Volumes/RedBox Workspace")
        );
    }
}
