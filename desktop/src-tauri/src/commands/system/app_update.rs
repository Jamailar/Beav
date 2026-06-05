use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::app_brand_display_name;

pub(super) const APP_UPDATE_DOWNLOAD_PAGE_URL: &str = "https://redbox.ziz.hk/download";
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
            eprintln!("[AppUpdate] check failed: {message}");
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
