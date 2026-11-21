use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;

use crate::app_brand_display_name;

pub(super) const APP_UPDATE_DOWNLOAD_PAGE_URL: &str = "https://redbox.ziz.hk/download";
const APP_UPDATE_API_URL: &str = "https://redbox.ziz.hk/api/updates/app";
const APP_RELEASE_MANIFEST_URL: &str =
    "https://xitunimagedb.oss-rg-china-mainland.aliyuncs.com/manifests/latest.json";
const APP_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const APP_UPDATE_CHECK_MIN_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
struct AppUpdateCheckState {
    in_flight: bool,
    install_in_flight: bool,
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

#[derive(Deserialize)]
struct RedboxReleaseManifest {
    tag: String,
    #[serde(rename = "releaseName")]
    release_name: String,
    #[serde(rename = "releaseUrl")]
    release_url: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    notes: String,
    #[serde(rename = "releaseNotes", default)]
    release_notes: Vec<RedboxReleaseNotesEntry>,
}

#[derive(Deserialize)]
struct RedboxReleaseNotesEntry {
    tag: String,
    #[serde(rename = "releaseName")]
    release_name: String,
    #[serde(rename = "releaseUrl")]
    release_url: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    notes: String,
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

fn app_update_debug_log_enabled() -> bool {
    std::env::var("REDBOX_APP_UPDATE_DEBUG").ok().as_deref() == Some("1")
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

pub(super) fn app_update_platform() -> Result<&'static str, String> {
    if cfg!(target_os = "windows") {
        Ok("windows")
    } else if cfg!(target_os = "macos") {
        Ok("macos")
    } else {
        Err("当前系统暂不支持自动更新检查".to_string())
    }
}

pub(super) fn app_update_arch() -> Result<&'static str, String> {
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

fn fetch_release_manifest() -> Result<RedboxReleaseManifest, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(APP_UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(APP_RELEASE_MANIFEST_URL)
        .header("Accept", "application/json")
        .header(
            "User-Agent",
            format!("{}/{}", app_brand_display_name(), env!("CARGO_PKG_VERSION")),
        )
        .send()
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("更新日志请求失败：HTTP {}", status));
    }

    response
        .json::<RedboxReleaseManifest>()
        .map_err(|error| error.to_string())
}

pub(super) fn get_release_notes(payload: &Value) -> Result<Value, String> {
    let requested_version = payload
        .get("version")
        .and_then(Value::as_str)
        .map(normalize_version_tag)
        .unwrap_or_else(|| normalize_version_tag(env!("CARGO_PKG_VERSION")));

    if requested_version.is_empty() {
        return Ok(json!({
            "success": false,
            "error": "缺少版本号",
        }));
    }

    let manifest = fetch_release_manifest()?;
    let matched = manifest
        .release_notes
        .iter()
        .find(|entry| normalize_version_tag(&entry.tag) == requested_version);

    if let Some(entry) = matched {
        return Ok(json!({
            "success": true,
            "version": requested_version,
            "tag": entry.tag,
            "name": entry.release_name,
            "htmlUrl": entry.release_url,
            "publishedAt": entry.published_at,
            "body": entry.notes,
        }));
    }

    if normalize_version_tag(&manifest.tag) == requested_version {
        return Ok(json!({
            "success": true,
            "version": requested_version,
            "tag": manifest.tag,
            "name": manifest.release_name,
            "htmlUrl": manifest.release_url,
            "publishedAt": manifest.published_at,
            "body": manifest.notes,
        }));
    }

    Ok(json!({
        "success": false,
        "version": requested_version,
        "error": format!("未找到 v{} 的更新日志", requested_version),
    }))
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

fn update_raw_string(update: &Update, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = update.raw_json.get(*key).and_then(Value::as_str) {
            let normalized = value.trim();
            if !normalized.is_empty() {
                return normalized.to_string();
            }
        }
    }
    String::new()
}

fn format_update_date(update: &Update) -> String {
    update
        .date
        .and_then(|date| date.format(&Rfc3339).ok())
        .unwrap_or_default()
}

fn native_update_notice_payload(update: &Update) -> Value {
    let current_version = normalize_version_tag(&update.current_version);
    let latest_version = normalize_version_tag(&update.version);
    let release_url = update_raw_string(update, &["release_url", "releaseUrl", "htmlUrl"]);
    let mut name = update_raw_string(update, &["name", "releaseName"]);
    if name.is_empty() {
        name = format!("{} v{}", app_brand_display_name(), latest_version);
    }

    json!({
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "htmlUrl": if is_http_url(&release_url) {
            release_url
        } else {
            APP_UPDATE_DOWNLOAD_PAGE_URL.to_string()
        },
        "name": name,
        "publishedAt": format_update_date(update),
        "body": update.body.clone().unwrap_or_default(),
        "installable": true,
    })
}

async fn check_app_update_native(
    app: &AppHandle,
    force: bool,
    force_notify: bool,
) -> Result<Value, String> {
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

    let result: Result<Value, String> = async {
        let update = app
            .updater()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string())?;

        if let Some(update) = update {
            let latest_version = normalize_version_tag(&update.version);
            let notice = native_update_notice_payload(&update);
            maybe_emit_app_update_available(app, &notice, &latest_version, force_notify);
            Ok(json!({
                "success": true,
                "hasUpdate": true,
                "notice": notice,
            }))
        } else {
            Ok(json!({
                "success": true,
                "hasUpdate": false,
            }))
        }
    }
    .await;

    if let Ok(mut state) = app_update_state().lock() {
        state.in_flight = false;
    }

    match result {
        Ok(value) => Ok(value),
        Err(message) => {
            if app_update_debug_log_enabled() {
                eprintln!("[AppUpdate] native check failed: {message}");
            }
            Ok(json!({
                "success": false,
                "hasUpdate": false,
                "message": message,
            }))
        }
    }
}

#[tauri::command]
pub(crate) async fn app_check_update(app: AppHandle, force: Option<bool>) -> Result<Value, String> {
    let force = force.unwrap_or(false);
    check_app_update_native(&app, force, force).await
}

async fn install_app_update_inner(app: &AppHandle) -> Result<Value, String> {
    let _ = app.emit(
        "app:update-install-progress",
        json!({ "status": "checking" }),
    );
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let Some(update) = update else {
        let payload = json!({
            "status": "idle",
            "hasUpdate": false,
        });
        let _ = app.emit("app:update-install-progress", payload.clone());
        return Ok(json!({
            "success": false,
            "hasUpdate": false,
            "error": "No installable update is available",
        }));
    };

    let version = normalize_version_tag(&update.version);
    let _ = app.emit(
        "app:update-install-progress",
        json!({
            "status": "downloading",
            "version": version.clone(),
            "downloaded": 0,
            "contentLength": null,
        }),
    );

    let mut downloaded = 0_u64;
    let progress_app = app.clone();
    let finish_app = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = progress_app.emit(
                    "app:update-install-progress",
                    json!({
                        "status": "downloading",
                        "version": version.clone(),
                        "downloaded": downloaded,
                        "contentLength": content_length,
                    }),
                );
            },
            move || {
                let _ = finish_app.emit(
                    "app:update-install-progress",
                    json!({
                        "status": "installing",
                    }),
                );
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let _ = app.emit(
        "app:update-install-progress",
        json!({
            "status": "installed",
        }),
    );

    #[cfg(not(target_os = "windows"))]
    {
        app.restart();
    }

    #[cfg(target_os = "windows")]
    {
        Ok(json!({
            "success": true,
            "installed": true,
        }))
    }
}

#[tauri::command]
pub(crate) async fn app_install_update(app: AppHandle) -> Result<Value, String> {
    {
        let mut state = app_update_state()
            .lock()
            .map_err(|_| "App update state lock is poisoned".to_string())?;
        if state.install_in_flight {
            return Ok(json!({
                "success": false,
                "inFlight": true,
                "error": "Update installation already in flight",
            }));
        }
        state.install_in_flight = true;
    }

    let result = install_app_update_inner(&app).await;

    if let Ok(mut state) = app_update_state().lock() {
        state.install_in_flight = false;
    }

    match result {
        Ok(value) => Ok(value),
        Err(message) => {
            if app_update_debug_log_enabled() {
                eprintln!("[AppUpdate] install failed: {message}");
            }
            let _ = app.emit(
                "app:update-install-progress",
                json!({
                    "status": "failed",
                    "error": message,
                }),
            );
            Ok(json!({
                "success": false,
                "error": message,
            }))
        }
    }
}

pub(super) fn check_app_update(
    app: &AppHandle,
    force: bool,
    force_notify: bool,
) -> Result<Value, String> {
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
            if app_update_debug_log_enabled() {
                eprintln!("[AppUpdate] check failed: {message}");
            }
            Ok(json!({
                "success": false,
                "hasUpdate": false,
                "message": message,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{compare_semver_like, normalize_version_tag, parse_semver_like};

    #[test]
    fn version_tag_normalization_removes_v_prefix_only() {
        assert_eq!(normalize_version_tag(" v1.2.3 "), "1.2.3");
        assert_eq!(normalize_version_tag("release-1.2.3"), "release-1.2.3");
    }

    #[test]
    fn semver_like_parser_ignores_prerelease_suffix() {
        assert_eq!(parse_semver_like("v1.2.3-beta.1"), [1, 2, 3, 0]);
    }

    #[test]
    fn semver_like_compare_uses_numeric_segments() {
        assert_eq!(
            compare_semver_like("1.9.0", "1.10.0"),
            std::cmp::Ordering::Less
        );
    }
}
