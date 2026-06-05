mod app_update;
mod feedback;
mod renderer_log;
mod settings_ops;

use app_update::{check_app_update, APP_UPDATE_DOWNLOAD_PAGE_URL};
use arboard::Clipboard;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::commands::file_ops::resolve_file_action_path;
use crate::logging::{
    create_report_from_trigger, dismiss_pending_report, export_bundle_for_report,
    list_pending_reports_value, recent_value, status_value as logging_status_value,
    update_upload_consent, upload_pending_report,
};
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{
    payload_field, payload_string, payload_value_as_string, pick_files_native, store_root, AppState,
};

fn is_http_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("https://") || normalized.starts_with("http://")
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
                "db:get-settings" => settings_ops::get_settings(state),
                "db:save-settings" => settings_ops::save_settings(app, state, payload),
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
                "logs:append-renderer" => renderer_log::append_renderer_log(payload),
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
