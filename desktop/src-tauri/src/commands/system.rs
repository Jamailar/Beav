mod ai_model_ops;
mod app_actions;
mod app_onboarding;
pub(crate) mod app_update;
mod clipboard_ops;
mod feedback;
mod logging_ops;
mod renderer_log;
mod settings_ops;

use app_update::check_app_update;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::{payload_field, AppState};

pub fn handle_system_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "app:get-version"
        | "app:get-release-notes"
        | "app:onboarding-status"
        | "app:onboarding-mark-seen"
        | "app:check-update"
        | "app:open-release-page"
        | "app:open-external-url"
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
        | "logs:create-auto-report"
        | "clipboard:read-text"
        | "clipboard:write-html" => (|| -> Result<Value, String> {
            match channel {
                "app:get-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
                "app:get-release-notes" => app_update::get_release_notes(payload),
                "app:onboarding-status" => app_onboarding::get_status(state, payload),
                "app:onboarding-mark-seen" => app_onboarding::mark_seen(state),
                "app:check-update" => {
                    let force = payload_field(payload, "force")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    check_app_update(app, force, force)
                }
                "app:open-release-page" => app_actions::open_release_page(payload),
                "app:open-external-url" => app_actions::open_external_url(payload),
                "app:startup-migration-status" => crate::startup_migration_status_value(state),
                "app:startup-migration-start" => crate::start_startup_migration(app, state),
                "app:open-knowledge-api-guide" => app_actions::open_knowledge_api_guide(app),
                "app:open-path" => app_actions::open_path(state, payload),
                "settings:pick-workspace-dir" => app_actions::pick_workspace_dir(),
                "ai-model-manager:snapshot" => ai_model_ops::snapshot(state),
                "ai-model-manager:resolve" => ai_model_ops::resolve(state, payload),
                "db:get-settings" => settings_ops::get_settings(state),
                "db:save-settings" => settings_ops::save_settings(app, state, payload),
                "debug:get-status" | "logs:get-status" => logging_ops::status(state),
                "debug:get-recent" => logging_ops::recent(payload),
                "debug:get-runtime-summary" => crate::build_runtime_diagnostics_summary(state),
                "debug:open-log-dir" | "logs:open-dir" => logging_ops::open_dir(state),
                "logs:get-recent" => logging_ops::recent(payload),
                "logs:list-pending-reports" => logging_ops::list_pending_reports(),
                "logs:export-bundle" => logging_ops::export_bundle(state, payload),
                "logs:create-feedback-report" => {
                    feedback::create_feedback_report_command(app, state, payload)
                }
                "logs:upload-report" => logging_ops::upload_report(state, payload),
                "logs:dismiss-report" => logging_ops::dismiss_report(payload),
                "logs:set-upload-consent" => logging_ops::set_upload_consent(state, payload),
                "logs:append-renderer" => renderer_log::append_renderer_log(payload),
                "logs:create-auto-report" => renderer_log::create_auto_report(app, state, payload),
                "clipboard:read-text" => clipboard_ops::read_text(),
                "clipboard:write-html" => clipboard_ops::write_html(payload),
                _ => unreachable!("channel prefiltered"),
            }
        })(),
        _ => return None,
    };

    Some(result)
}
