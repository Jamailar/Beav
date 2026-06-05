mod app_actions;
mod app_update;
mod feedback;
mod renderer_log;
mod settings_ops;

use app_update::check_app_update;
use arboard::Clipboard;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::logging::{
    create_report_from_trigger, dismiss_pending_report, export_bundle_for_report,
    list_pending_reports_value, recent_value, status_value as logging_status_value,
    update_upload_consent, upload_pending_report,
};
use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{payload_field, payload_string, store_root, AppState};

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
                "app:open-release-page" => app_actions::open_release_page(payload),
                "app:startup-migration-status" => crate::startup_migration_status_value(state),
                "app:startup-migration-start" => crate::start_startup_migration(app, state),
                "app:open-knowledge-api-guide" => app_actions::open_knowledge_api_guide(app),
                "app:open-path" => app_actions::open_path(state, payload),
                "settings:pick-workspace-dir" => app_actions::pick_workspace_dir(),
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
