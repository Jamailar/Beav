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
    create_feedback_report, create_report_from_trigger, dismiss_pending_report,
    export_bundle_for_report, list_pending_reports_value, log_renderer_event,
    mark_feedback_report_uploaded, recent_value, status_value as logging_status_value,
    update_upload_consent, upload_pending_report,
};
use crate::persistence::{
    apply_workspace_hydration_snapshot, load_workspace_hydration_snapshot, with_store,
    with_store_mut,
};
use crate::{
    app_brand_display_name, is_same_path, now_iso, payload_field, payload_string,
    payload_value_as_string, pick_files_native, refresh_runtime_warm_state, store_root,
    update_workspace_root_cache, workspace_root_from_snapshot, AppState,
};

const APP_UPDATE_DOWNLOAD_PAGE_URL: &str = "https://redbox.ziz.hk/download";
const APP_UPDATE_API_URL: &str = "https://redbox.ziz.hk/api/updates/app";
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
struct RedboxAppUpdateResponse {
    ready: Option<bool>,
    #[serde(rename = "updateAvailable")]
    update_available: Option<bool>,
    version: Option<String>,
    tag: Option<String>,
    #[serde(rename = "releaseName")]
    release_name: Option<String>,
    #[serde(rename = "releaseUrl")]
    release_url: Option<String>,
    #[serde(rename = "publishedAt")]
    published_at: Option<String>,
    notes: Option<String>,
    asset: Option<RedboxAppUpdateAsset>,
}

#[derive(Deserialize)]
struct RedboxAppUpdateAsset {
    url: Option<String>,
}

struct LatestAppUpdate {
    ready: bool,
    update_available: bool,
    version: String,
    download_url: String,
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

fn app_update_platform() -> Result<&'static str, String> {
    if cfg!(target_os = "windows") {
        Ok("windows")
    } else if cfg!(target_os = "macos") {
        Ok("macos")
    } else {
        Err("当前系统暂不支持自动更新检查".to_string())
    }
}

fn app_update_arch() -> Result<&'static str, String> {
    if cfg!(target_arch = "x86_64") {
        Ok("x64")
    } else if cfg!(target_arch = "x86") {
        Ok("x86")
    } else if cfg!(target_arch = "aarch64") {
        Ok("arm64")
    } else {
        Err("当前 CPU 架构暂不支持自动更新检查".to_string())
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect::<String>()
}

fn current_os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
        {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

fn feedback_priority(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "low" | "medium" | "high" | "urgent" => value.trim().to_ascii_lowercase(),
        _ => "medium".to_string(),
    }
}

fn feedback_category(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "desktop_bug".to_string();
    }
    normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(64)
        .collect::<String>()
}

fn feedback_source(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "desktop".to_string();
    }
    normalized
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .take(64)
        .collect::<String>()
}

fn fetch_latest_app_update(current_version: &str) -> Result<LatestAppUpdate, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(APP_UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(APP_UPDATE_API_URL)
        .query(&[
            ("platform", app_update_platform()?),
            ("arch", app_update_arch()?),
            ("currentVersion", current_version),
        ])
        .header("Accept", "application/json")
        .header(
            "User-Agent",
            format!("{}/{}", app_brand_display_name(), env!("CARGO_PKG_VERSION")),
        )
        .send()
        .map_err(|error| error.to_string())?;

    let status = response.status();
    let data = response
        .json::<RedboxAppUpdateResponse>()
        .map_err(|error| error.to_string())?;

    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(LatestAppUpdate {
            ready: false,
            update_available: false,
            version: data
                .version
                .map(|value| normalize_version_tag(&value))
                .unwrap_or_default(),
            download_url: data
                .release_url
                .unwrap_or_else(|| APP_UPDATE_DOWNLOAD_PAGE_URL.to_string()),
            name: data.release_name.unwrap_or_default(),
            published_at: data.published_at.unwrap_or_default(),
            body: data.notes.unwrap_or_default(),
        });
    }
    if !status.is_success() {
        return Err(format!("更新源请求失败：HTTP {}", status));
    }

    let version = normalize_version_tag(
        data.version
            .as_deref()
            .or(data.tag.as_deref())
            .unwrap_or_default(),
    );
    if version.is_empty() {
        return Err("更新源没有返回有效版本号".to_string());
    }

    let download_url = data
        .asset
        .and_then(|asset| asset.url)
        .or(data.release_url)
        .filter(|url| is_http_url(url))
        .unwrap_or_else(|| APP_UPDATE_DOWNLOAD_PAGE_URL.to_string());

    Ok(LatestAppUpdate {
        ready: data.ready.unwrap_or(false),
        update_available: data.update_available.unwrap_or(false),
        version,
        download_url,
        name: data.release_name.unwrap_or_default(),
        published_at: data.published_at.unwrap_or_default(),
        body: data.notes.unwrap_or_default(),
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
        let current_version = normalize_version_tag(env!("CARGO_PKG_VERSION"));
        let latest = fetch_latest_app_update(&current_version)?;
        let has_update = latest.ready
            && (latest.update_available
                || compare_semver_like(&current_version, &latest.version)
                    == std::cmp::Ordering::Less);
        let notice = json!({
            "currentVersion": current_version,
            "latestVersion": latest.version.clone(),
            "htmlUrl": if latest.download_url.is_empty() {
                APP_UPDATE_DOWNLOAD_PAGE_URL.to_string()
            } else {
                latest.download_url.clone()
            },
            "name": latest.name.clone(),
            "publishedAt": latest.published_at.clone(),
            "body": latest.body.clone(),
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
        | "model-config:read"
        | "model-config:effective"
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
                "model-config:read" => with_store(state, |store| {
                    Ok(crate::model_config::model_config_diagnostics_value(
                        &state.store_path,
                        &store.settings,
                    ))
                }),
                "model-config:effective" => {
                    let runtime_mode = payload_string(payload, "runtimeMode")
                        .or_else(|| payload_string(payload, "runtime_mode"));
                    with_store(state, |store| {
                        Ok(crate::model_config::effective_model_config_value(
                            &store.settings,
                            runtime_mode.as_deref(),
                        ))
                    })
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
                    let previous_workspace_root = with_store(state, |store| {
                        Ok(workspace_root_from_snapshot(
                            &store.settings,
                            &store.active_space_id,
                            &state.store_path,
                        )
                        .ok())
                    })?;
                    let (active_space_id, settings_snapshot) = with_store_mut(state, |store| {
                        store.settings = merged_settings_payload(&store.settings, payload);
                        Ok((store.active_space_id.clone(), store.settings.clone()))
                    })?;
                    crate::model_config::sync_model_config_file(
                        &state.store_path,
                        &settings_snapshot,
                    )?;
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
                    let content = truncate_chars(
                        &payload_string(payload, "content")
                            .or_else(|| payload_string(payload, "message"))
                            .unwrap_or_default(),
                        4000,
                    );
                    if content.chars().count() < 2 {
                        return Err("请填写问题描述".to_string());
                    }
                    let title = truncate_chars(
                        &payload_string(payload, "title").unwrap_or_else(|| {
                            content
                                .lines()
                                .next()
                                .unwrap_or("用户反馈")
                                .chars()
                                .take(40)
                                .collect::<String>()
                        }),
                        120,
                    );
                    let category = feedback_category(
                        &payload_string(payload, "category")
                            .unwrap_or_else(|| "desktop_bug".to_string()),
                    );
                    let priority = feedback_priority(
                        &payload_string(payload, "priority")
                            .unwrap_or_else(|| "medium".to_string()),
                    );
                    let source = feedback_source(
                        &payload_string(payload, "source").unwrap_or_else(|| "desktop".to_string()),
                    );
                    let include_advanced_context = payload
                        .get("includeAdvancedContext")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let context = payload
                        .get("context")
                        .filter(|value| value.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let contact = truncate_chars(
                        &payload_string(payload, "contact").unwrap_or_default(),
                        256,
                    );
                    let upload_now = payload
                        .get("uploadNow")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    let (report, log_text) = create_feedback_report(
                        state,
                        &title,
                        &content,
                        &category,
                        &priority,
                        &source,
                        include_advanced_context,
                        json!({
                            "context": context,
                            "contact": contact,
                            "includeAdvancedContext": include_advanced_context,
                        }),
                    )?;
                    if !upload_now {
                        return Ok(json!({
                            "success": true,
                            "uploaded": false,
                            "report": report,
                        }));
                    }

                    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut feedback_context = context.as_object().cloned().unwrap_or_default();
                    if !contact.is_empty() {
                        feedback_context.insert("contact".to_string(), json!(contact));
                    }
                    feedback_context.insert("report_id".to_string(), json!(report.id.clone()));
                    feedback_context.insert(
                        "include_advanced_context".to_string(),
                        json!(include_advanced_context),
                    );

                    let request_body = json!({
                        "title": title,
                        "content": content,
                        "category": category,
                        "priority": priority,
                        "source": source,
                        "client": {
                            "app_version": env!("CARGO_PKG_VERSION"),
                            "platform": app_update_platform().unwrap_or(std::env::consts::OS),
                            "os_version": current_os_version(),
                            "arch": app_update_arch().unwrap_or(std::env::consts::ARCH),
                            "trace_id": report.id.clone(),
                        },
                        "log_text": log_text,
                        "attachments": [],
                        "context": Value::Object(feedback_context),
                    });

                    match crate::run_official_json_request_response(
                        &settings,
                        "POST",
                        "/users/me/feedback",
                        Some(request_body),
                    ) {
                        Ok(response) if (200..300).contains(&response.status) => {
                            let uploaded_report =
                                mark_feedback_report_uploaded(&report.id, response.body.clone())?;
                            Ok(json!({
                                "success": true,
                                "uploaded": true,
                                "report": uploaded_report,
                                "response": response.body,
                            }))
                        }
                        Ok(response) => Ok(json!({
                            "success": true,
                            "uploaded": false,
                            "report": report,
                            "error": format!("反馈提交失败：HTTP {}", response.status),
                            "response": response.body,
                        })),
                        Err(error) => Ok(json!({
                            "success": true,
                            "uploaded": false,
                            "report": report,
                            "error": error,
                        })),
                    }
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
        .unwrap_or(false)
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
