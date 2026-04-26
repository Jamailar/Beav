use arboard::Clipboard;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::logging::event::LogLevel;
use crate::logging::{
    create_report_from_trigger, dismiss_pending_report, export_bundle_for_report,
    list_pending_reports_value, log_renderer_event, recent_value,
    status_value as logging_status_value, update_upload_consent, upload_pending_report,
};
use crate::persistence::{with_store, with_store_mut};
use crate::{
    now_iso, payload_field, payload_string, payload_value_as_string, pick_files_native,
    refresh_runtime_warm_state, store_root, update_workspace_root_cache, AppState,
};

const APP_UPDATE_RELEASES_PAGE_URL: &str = "https://github.com/Jamailar/RedBox/releases";
const APP_UPDATE_LATEST_RELEASE_API_URL: &str =
    "https://api.github.com/repos/Jamailar/RedBox/releases/latest";
const APP_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const APP_UPDATE_CHECK_MIN_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
struct AppUpdateCheckState {
    in_flight: bool,
    last_checked_at: Option<Instant>,
    last_notified_version: String,
}

static APP_UPDATE_CHECK_STATE: OnceLock<Mutex<AppUpdateCheckState>> = OnceLock::new();

#[derive(Deserialize)]
struct GithubReleaseResponse {
    tag_name: Option<String>,
    html_url: Option<String>,
    name: Option<String>,
    draft: Option<bool>,
    prerelease: Option<bool>,
    published_at: Option<String>,
    body: Option<String>,
}

struct LatestGithubRelease {
    version: String,
    html_url: String,
    name: String,
    published_at: String,
    body: String,
}

fn app_update_state() -> &'static Mutex<AppUpdateCheckState> {
    APP_UPDATE_CHECK_STATE.get_or_init(|| Mutex::new(AppUpdateCheckState::default()))
}

fn normalize_version_tag(raw: &str) -> String {
    raw.trim()
        .trim_start_matches(|value| value == 'v' || value == 'V')
        .to_string()
}

fn parse_semver_like(input: &str) -> [u64; 4] {
    let normalized = normalize_version_tag(input);
    let base = normalized.split('-').next().unwrap_or_default();
    let mut parts = [0_u64; 4];
    for (index, item) in base.split('.').take(4).enumerate() {
        parts[index] = item.parse::<u64>().unwrap_or(0);
    }
    parts
}

fn compare_semver_like(current: &str, latest: &str) -> std::cmp::Ordering {
    parse_semver_like(current).cmp(&parse_semver_like(latest))
}

fn is_http_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("https://") || normalized.starts_with("http://")
}

fn fetch_latest_github_release() -> Result<LatestGithubRelease, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(APP_UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(APP_UPDATE_LATEST_RELEASE_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header(
            "User-Agent",
            format!("RedBox/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .map_err(|error| error.to_string())?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("GitHub latest release not found".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub latest release request failed: HTTP {}",
            response.status()
        ));
    }

    let data = response
        .json::<GithubReleaseResponse>()
        .map_err(|error| error.to_string())?;
    if data.draft.unwrap_or(false) {
        return Err("Latest release is draft".to_string());
    }
    if data.prerelease.unwrap_or(false) {
        return Err("Latest release is prerelease".to_string());
    }

    let version = normalize_version_tag(data.tag_name.as_deref().unwrap_or_default());
    if version.is_empty() {
        return Err("Latest release tag is empty".to_string());
    }

    Ok(LatestGithubRelease {
        version,
        html_url: data
            .html_url
            .unwrap_or_else(|| APP_UPDATE_RELEASES_PAGE_URL.to_string()),
        name: data.name.unwrap_or_default(),
        published_at: data.published_at.unwrap_or_default(),
        body: data.body.unwrap_or_default(),
    })
}

fn maybe_emit_app_update_available(
    app: &AppHandle,
    payload: &Value,
    latest_version: &str,
    force_notify: bool,
) {
    let should_emit = {
        let Ok(mut state) = app_update_state().lock() else {
            return;
        };
        if !force_notify && state.last_notified_version == latest_version {
            false
        } else {
            state.last_notified_version = latest_version.to_string();
            true
        }
    };

    if should_emit {
        let _ = app.emit("app:update-available", payload.clone());
    }
}

fn check_app_update(app: &AppHandle, force: bool, force_notify: bool) -> Result<Value, String> {
    let now = Instant::now();
    {
        let mut state = app_update_state()
            .lock()
            .map_err(|_| "App update state lock is poisoned".to_string())?;
        if state.in_flight {
            return Ok(json!({
                "success": false,
                "hasUpdate": false,
                "inFlight": true,
                "message": "Update check already in flight",
            }));
        }
        if !force
            && state
                .last_checked_at
                .map(|last_checked_at| {
                    now.duration_since(last_checked_at) < APP_UPDATE_CHECK_MIN_INTERVAL
                })
                .unwrap_or(false)
        {
            return Ok(json!({
                "success": true,
                "hasUpdate": false,
                "throttled": true,
                "message": "Update check skipped due to interval throttling",
            }));
        }
        state.in_flight = true;
        state.last_checked_at = Some(now);
    }

    let result: Result<Value, String> = (|| {
        let latest = fetch_latest_github_release()?;
        let current_version = normalize_version_tag(env!("CARGO_PKG_VERSION"));
        let has_update =
            compare_semver_like(&current_version, &latest.version) == std::cmp::Ordering::Less;
        let notice = json!({
            "currentVersion": current_version,
            "latestVersion": latest.version,
            "htmlUrl": if latest.html_url.is_empty() {
                APP_UPDATE_RELEASES_PAGE_URL.to_string()
            } else {
                latest.html_url.clone()
            },
            "name": latest.name,
            "publishedAt": latest.published_at,
            "body": latest.body,
        });

        if has_update {
            maybe_emit_app_update_available(app, &notice, &latest.version, force_notify);
        }

        Ok(json!({
            "success": true,
            "hasUpdate": has_update,
            "notice": notice,
        }))
    })();

    if let Ok(mut state) = app_update_state().lock() {
        state.in_flight = false;
    }

    match result {
        Ok(value) => Ok(value),
        Err(message) if message == "GitHub latest release not found" => Ok(json!({
            "success": true,
            "hasUpdate": false,
            "message": "No published release found",
        })),
        Err(message) => {
            eprintln!("[AppUpdate] check failed: {message}");
            Ok(json!({
                "success": false,
                "hasUpdate": false,
                "message": message,
            }))
        }
    }
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

fn richpost_theme_guide_path(app: &AppHandle) -> Result<PathBuf, String> {
    bundled_html_resource_path(app, "richpost-theme-guide.html", "主题编辑指南不存在")
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
        | "app:open-richpost-theme-guide"
        | "app:open-path"
        | "settings:pick-workspace-dir"
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
                        .unwrap_or_else(|| APP_UPDATE_RELEASES_PAGE_URL.to_string());
                    if !is_http_url(&url) {
                        return Err("Invalid release URL".to_string());
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
                "app:open-richpost-theme-guide" => {
                    let path = richpost_theme_guide_path(app)?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path.display().to_string() }))
                }
                "app:open-path" => {
                    let path = payload_string(payload, "path")
                        .or_else(|| payload_value_as_string(payload))
                        .ok_or_else(|| "path is required".to_string())?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path }))
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
                "db:get-settings" => with_store(state, |store| {
                    let runtime = state
                        .auth_runtime
                        .lock()
                        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                    let mut projected =
                        crate::auth::project_settings_for_runtime(&store.settings, &runtime);
                    normalize_default_ai_route_settings(&mut projected);
                    Ok(projected)
                }),
                "db:save-settings" => {
                    let active_space_id = with_store_mut(state, |store| {
                        if let (Some(current), Some(next)) =
                            (store.settings.as_object(), payload.as_object())
                        {
                            let mut merged = current.clone();
                            for (key, value) in next {
                                if matches!(key.as_str(), "redbox_auth_session_json") {
                                    continue;
                                }
                                merged.insert(key.to_string(), value.clone());
                            }
                            store.settings = Value::Object(merged);
                            normalize_default_ai_route_settings(&mut store.settings);
                        } else {
                            store.settings = payload.clone();
                            normalize_default_ai_route_settings(&mut store.settings);
                        }
                        Ok(store.active_space_id.clone())
                    })?;
                    let _ = update_workspace_root_cache(state, payload, &active_space_id);
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                    let _ = app.emit(
                        "settings:updated",
                        json!({
                            "updatedAt": now_iso(),
                        }),
                    );
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
}
