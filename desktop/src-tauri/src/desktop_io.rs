use arboard::Clipboard;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{
    configure_background_command, file_url_for_path, normalize_base_url, now_iso, now_ms,
    payload_string, run_curl_bytes, AdvisorVideoRecord,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub(crate) fn write_base64_payload_to_file(
    encoded: &str,
    output_path: &Path,
) -> Result<(), String> {
    let encoded_path = std::env::temp_dir().join(format!("redbox-audio-{}.b64", now_ms()));
    fs::write(&encoded_path, encoded).map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new("base64");
    configure_background_command(&mut command);
    let output = command
        .arg("-D")
        .arg("-i")
        .arg(&encoded_path)
        .arg("-o")
        .arg(output_path)
        .output()
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&encoded_path);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "base64 decode failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

pub(crate) fn normalize_transcription_url(endpoint: &str) -> String {
    let normalized = normalize_base_url(endpoint);
    if normalized.ends_with("/audio/transcriptions") {
        normalized
    } else {
        format!("{normalized}/audio/transcriptions")
    }
}

pub(crate) fn run_curl_transcription(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
) -> Result<String, String> {
    run_curl_transcription_with_response_format(
        endpoint, api_key, model_name, file_path, mime_type, None,
    )
}

pub(crate) fn run_curl_transcription_with_response_format(
    endpoint: &str,
    api_key: Option<&str>,
    model_name: &str,
    file_path: &Path,
    mime_type: &str,
    response_format: Option<&str>,
) -> Result<String, String> {
    let mut command = std::process::Command::new("curl");
    configure_background_command(&mut command);
    command
        .arg("-sS")
        .arg("-X")
        .arg("POST")
        .arg(normalize_transcription_url(endpoint))
        .arg("-F")
        .arg(format!("model={model_name}"))
        .arg("-F")
        .arg(format!("file=@{};type={mime_type}", file_path.display()));
    if let Some(format) = response_format
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("-F").arg(format!("response_format={format}"));
    }
    if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {key}"));
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("curl failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err("转写接口返回了空结果".to_string());
    }

    let preferred_format = response_format
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("json");
    if preferred_format != "json" && !stdout.starts_with('{') && !stdout.starts_with('[') {
        return Ok(stdout);
    }

    let value: Value =
        serde_json::from_str(&stdout).map_err(|error| format!("Invalid JSON response: {error}"))?;
    let text = value
        .get("text")
        .or_else(|| value.get("transcript"))
        .or_else(|| value.get("srt"))
        .and_then(|item| item.as_str())
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .ok_or_else(|| "转写接口返回了空结果".to_string())?;
    Ok(text)
}

pub(crate) fn resolve_transcription_settings(
    settings: &Value,
) -> Option<(String, Option<String>, String)> {
    let endpoint = payload_string(settings, "transcription_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))?;
    let model_name = payload_string(settings, "transcription_model")
        .or_else(|| Some("whisper-1".to_string()))?;
    let api_key = payload_string(settings, "transcription_key")
        .or_else(|| payload_string(settings, "api_key"));
    Some((endpoint, api_key, model_name))
}

const YTDLP_AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const YTDLP_UPDATE_RECEIPT_FILE: &str = "yt-dlp-update-check.json";
const YTDLP_CHECKSUM_ASSET: &str = "SHA2-256SUMS";
const YTDLP_PREFERRED_SUB_LANGS: &str = "zh.*,zh-Hans,zh-Hant,en.*";
const YTDLP_DOWNLOAD_URL_ENV: &str = "REDBOX_YTDLP_DOWNLOAD_URL_TEMPLATES";
const YTDLP_LOG_PREFIX: &str = "[RedBox yt-dlp]";
const YTDLP_DEFAULT_URL_TEMPLATES: &[&str] = &[
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}",
    "https://gh.llkk.cc/https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}",
];

#[derive(Debug, Clone, Default)]
struct YtdlpCommandCapture {
    success: bool,
    status_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Default, Clone)]
struct YtdlpSubtitleLanguageProbe {
    manual: Vec<String>,
    automatic: Vec<String>,
}

fn log_ytdlp(message: impl AsRef<str>) {
    eprintln!("{YTDLP_LOG_PREFIX} {}", message.as_ref());
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn ytdlp_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "yt-dlp.exe"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "yt-dlp"
    }
}

fn managed_ytdlp_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .or_else(home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("RedBox")
        .join("tools")
        .join("yt-dlp")
}

fn managed_ytdlp_path() -> PathBuf {
    managed_ytdlp_dir().join(ytdlp_binary_name())
}

fn ytdlp_release_asset_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "yt-dlp_macos"
    }
    #[cfg(target_os = "windows")]
    {
        match std::env::consts::ARCH {
            "x86" => "yt-dlp_x86.exe",
            "aarch64" => "yt-dlp_arm64.exe",
            _ => "yt-dlp.exe",
        }
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        match std::env::consts::ARCH {
            "aarch64" => "yt-dlp_linux_aarch64",
            _ => "yt-dlp_linux",
        }
    }
}

fn command_output_string(binary: &str, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new(binary);
    configure_background_command(&mut command);
    let output = command.args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn python_user_base(binary: &str) -> Option<PathBuf> {
    let raw = command_output_string(binary, &["-m", "site", "--user-base"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn ytdlp_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let binary_name = ytdlp_binary_name();
    candidates.push(managed_ytdlp_path());
    candidates.push(PathBuf::from(binary_name));

    for python_binary in ["python3", "python"] {
        if let Some(user_base) = python_user_base(python_binary) {
            #[cfg(target_os = "windows")]
            let candidate = user_base.join("Scripts").join(binary_name);
            #[cfg(not(target_os = "windows"))]
            let candidate = user_base.join("bin").join(binary_name);
            candidates.push(candidate);
        }
    }

    if let Some(home) = home_dir() {
        #[cfg(target_os = "windows")]
        {
            candidates.push(
                home.join("AppData")
                    .join("Roaming")
                    .join("Python")
                    .join("Scripts")
                    .join(binary_name),
            );
            candidates.push(
                home.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("Python")
                    .join("Scripts")
                    .join(binary_name),
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(home.join(".local").join("bin").join(binary_name));
        }
    }

    let mut deduped = Vec::new();
    for path in candidates {
        if !deduped.iter().any(|existing: &PathBuf| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn detect_ytdlp_at(candidate: &Path) -> Result<(String, String), String> {
    let mut command = std::process::Command::new(candidate);
    configure_background_command(&mut command);
    let output = command
        .arg("--version")
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("exit status {}", output.status)
        } else {
            stderr
        });
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return Err("empty version output".to_string());
    }
    let display = if candidate.is_absolute() {
        candidate.display().to_string()
    } else {
        candidate.to_string_lossy().to_string()
    };
    Ok((display, version))
}

fn ytdlp_receipt_path(store_path: &Path) -> PathBuf {
    store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(YTDLP_UPDATE_RECEIPT_FILE)
}

pub(crate) fn should_auto_update_ytdlp(store_path: &Path) -> bool {
    let receipt_path = ytdlp_receipt_path(store_path);
    let contents = match fs::read_to_string(receipt_path) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return true,
        Err(_) => return true,
    };
    let value: Value = match serde_json::from_str(&contents) {
        Ok(parsed) => parsed,
        Err(_) => return true,
    };
    let last_checked_ms = value
        .get("lastCheckedAtMs")
        .and_then(|item| item.as_u64())
        .unwrap_or(0);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    now_ms.saturating_sub(last_checked_ms) >= YTDLP_AUTO_UPDATE_INTERVAL.as_millis() as u64
}

pub(crate) fn record_ytdlp_update_check(store_path: &Path, outcome: &str) {
    let receipt_path = ytdlp_receipt_path(store_path);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "lastCheckedAtMs": now_ms,
        "outcome": outcome,
    });
    if let Some(parent) = receipt_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(receipt_path, payload.to_string());
}

pub(crate) fn detect_ytdlp() -> Option<(String, String)> {
    for candidate in ytdlp_candidate_paths() {
        if let Ok(found) = detect_ytdlp_at(&candidate) {
            return Some(found);
        }
    }
    None
}

pub(crate) fn inspect_ytdlp_candidates() -> Vec<String> {
    ytdlp_candidate_paths()
        .into_iter()
        .map(|candidate| match detect_ytdlp_at(&candidate) {
            Ok((path, version)) => format!("{path} => ok ({version})"),
            Err(error) => format!("{} => {}", candidate.display(), error),
        })
        .collect()
}

fn ytdlp_url_templates() -> Vec<String> {
    let mut values = std::env::var(YTDLP_DOWNLOAD_URL_ENV)
        .ok()
        .map(|raw| {
            raw.split(|ch| matches!(ch, '\n' | '\r' | ',' | ';'))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if values.is_empty() {
        values = YTDLP_DEFAULT_URL_TEMPLATES
            .iter()
            .map(|value| (*value).to_string())
            .collect();
    }
    values
}

fn expand_ytdlp_download_url(template: &str, asset: &str) -> String {
    template.replace("{asset}", asset)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn parse_sha256_manifest(contents: &str, asset: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if name == asset {
            Some(hash.to_string())
        } else {
            None
        }
    })
}

fn fetch_expected_ytdlp_sha256(asset: &str, templates: &[String]) -> Result<String, String> {
    let mut failures = Vec::new();
    for template in templates {
        let checksum_url = expand_ytdlp_download_url(template, YTDLP_CHECKSUM_ASSET);
        log_ytdlp(format!("fetch checksum manifest: {checksum_url}"));
        match run_curl_bytes("GET", &checksum_url, None, &[], None) {
            Ok(bytes) => {
                let manifest = String::from_utf8_lossy(&bytes).to_string();
                if let Some(hash) = parse_sha256_manifest(&manifest, asset) {
                    return Ok(hash);
                }
                failures.push(format!("{checksum_url}: missing checksum for {asset}"));
            }
            Err(error) => failures.push(format!("{checksum_url}: {error}")),
        }
    }
    Err(failures.join(" | "))
}

fn download_verified_ytdlp_asset(asset: &str) -> Result<(Vec<u8>, String, String), String> {
    let templates = ytdlp_url_templates();
    let expected_hash = fetch_expected_ytdlp_sha256(asset, &templates)?;
    let mut failures = Vec::new();
    for template in templates {
        let url = expand_ytdlp_download_url(&template, asset);
        log_ytdlp(format!("download release asset: {url}"));
        match run_curl_bytes("GET", &url, None, &[], None) {
            Ok(bytes) => {
                let actual_hash = sha256_hex(&bytes);
                if actual_hash.eq_ignore_ascii_case(&expected_hash) {
                    return Ok((bytes, url, expected_hash));
                }
                failures.push(format!(
                    "{url}: checksum mismatch (expected {expected_hash}, got {actual_hash})"
                ));
            }
            Err(error) => failures.push(format!("{url}: {error}")),
        }
    }
    Err(failures.join(" | "))
}

fn install_managed_ytdlp_binary() -> Result<(String, String), String> {
    let managed_path = managed_ytdlp_path();
    let asset = ytdlp_release_asset_name();
    let (bytes, source_url, expected_hash) = download_verified_ytdlp_asset(asset)?;
    if let Some(parent) = managed_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp_path = managed_path.with_extension(format!("download-{}", now_ms()));
    fs::write(&tmp_path, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&tmp_path, permissions).map_err(|error| error.to_string())?;
    }
    if managed_path.exists() {
        fs::remove_file(&managed_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&tmp_path, &managed_path).map_err(|error| error.to_string())?;
    let installed = detect_ytdlp_at(&managed_path)?;
    log_ytdlp(format!(
        "installed managed binary: path={} source={} sha256={}",
        managed_path.display(),
        source_url,
        expected_hash
    ));
    Ok(installed)
}

pub(crate) fn ensure_ytdlp_installed(update: bool) -> Result<(String, String), String> {
    if !update {
        if let Ok(found) = detect_ytdlp_at(&managed_ytdlp_path()) {
            return Ok(found);
        }
    }
    install_managed_ytdlp_binary()
}

pub(crate) fn run_ytdlp_json(args: &[&str]) -> Result<Value, String> {
    let (binary, _) = detect_ytdlp()
        .ok_or_else(|| "未检测到可用的 yt-dlp，请先在设置中完成安装。".to_string())?;
    let mut command = std::process::Command::new(&binary);
    configure_background_command(&mut command);
    let output = command
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("yt-dlp failed with status {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str(&stdout).map_err(|error| format!("Invalid yt-dlp JSON: {error}"))
}

pub(crate) fn fetch_ytdlp_channel_info(channel_url: &str, limit: i64) -> Result<Value, String> {
    run_ytdlp_json(&[
        "-J",
        "--flat-playlist",
        "--playlist-end",
        &limit.max(1).to_string(),
        channel_url,
    ])
}

pub(crate) fn parse_ytdlp_videos(
    advisor_id: &str,
    channel_id: Option<&str>,
    value: &Value,
) -> Vec<AdvisorVideoRecord> {
    value
        .get("entries")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .and_then(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())?;
            let title = entry
                .get("title")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string())
                .unwrap_or_else(|| format!("Video {}", id));
            let published_at = entry
                .get("release_timestamp")
                .or_else(|| entry.get("timestamp"))
                .and_then(|item| item.as_i64())
                .map(|item| item.to_string())
                .or_else(|| {
                    entry
                        .get("upload_date")
                        .and_then(|item| item.as_str())
                        .map(|item| item.to_string())
                })
                .unwrap_or_else(now_iso);
            let video_url = entry
                .get("url")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string())
                .filter(|item| item.starts_with("http"))
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
            Some(AdvisorVideoRecord {
                id,
                advisor_id: advisor_id.to_string(),
                title,
                published_at,
                status: "pending".to_string(),
                retry_count: 0,
                error_message: None,
                subtitle_file: None,
                video_url: Some(video_url),
                channel_id: channel_id.map(|item| item.to_string()),
                created_at: now_iso(),
                updated_at: now_iso(),
            })
        })
        .collect()
}

pub(crate) fn download_ytdlp_subtitle(
    video_url: &str,
    target_dir: &Path,
    file_prefix: &str,
) -> Result<PathBuf, String> {
    fn truncate_for_log(raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.len() > 1_200 {
            format!("{}…", &trimmed[..1_200])
        } else {
            trimmed.to_string()
        }
    }

    fn combine_output(capture: &YtdlpCommandCapture) -> String {
        let stderr = capture.stderr.trim();
        let stdout = capture.stdout.trim();
        if !stderr.is_empty() {
            stderr.to_string()
        } else if !stdout.is_empty() {
            stdout.to_string()
        } else if let Some(code) = capture.status_code {
            format!("exit status {code}")
        } else {
            "yt-dlp exited without output".to_string()
        }
    }

    fn output_is_rate_limited(capture: &YtdlpCommandCapture) -> bool {
        let haystack = format!("{}\n{}", capture.stdout, capture.stderr).to_lowercase();
        haystack.contains("http error 429")
            || haystack.contains("too many requests")
            || haystack.contains("rate limit")
    }

    fn output_mentions_missing_subtitles(capture: &YtdlpCommandCapture) -> bool {
        let haystack = format!("{}\n{}", capture.stdout, capture.stderr).to_lowercase();
        haystack.contains("there are no subtitles")
            || haystack.contains("does not have subtitles")
            || haystack.contains("no subtitles")
    }

    fn subtitle_browser_candidates() -> Vec<&'static str> {
        #[cfg(target_os = "macos")]
        {
            vec!["safari", "chrome", "edge", "firefox", "chromium", "brave"]
        }
        #[cfg(target_os = "windows")]
        {
            vec!["edge", "chrome", "firefox", "chromium", "brave"]
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            vec!["chrome", "firefox", "chromium", "brave"]
        }
    }

    fn collect_paths_with_prefix(target_dir: &Path, file_prefix: &str) -> Vec<PathBuf> {
        let mut paths = fs::read_dir(target_dir)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.starts_with(file_prefix))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    fn find_downloaded_file(
        target_dir: &Path,
        file_prefix: &str,
        extensions: &[&str],
    ) -> Option<PathBuf> {
        collect_paths_with_prefix(target_dir, file_prefix)
            .into_iter()
            .find(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(|ext| {
                        extensions
                            .iter()
                            .any(|expected| ext.eq_ignore_ascii_case(expected))
                    })
                    .unwrap_or(false)
            })
    }

    fn cleanup_downloaded_files(target_dir: &Path, file_prefix: &str) {
        for path in collect_paths_with_prefix(target_dir, file_prefix) {
            let _ = fs::remove_file(path);
        }
    }

    fn run_ytdlp_capture(binary: &str, args: &[String]) -> Result<YtdlpCommandCapture, String> {
        let mut command = std::process::Command::new(binary);
        configure_background_command(&mut command);
        let output = command
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        Ok(YtdlpCommandCapture {
            success: output.status.success(),
            status_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }

    fn run_ytdlp_with_retry(
        binary: &str,
        args: &[String],
        label: &str,
    ) -> Result<YtdlpCommandCapture, String> {
        let delays = [0_u64, 2, 5];
        let mut last_capture = None;
        for (index, delay) in delays.iter().enumerate() {
            if *delay > 0 {
                log_ytdlp(format!("{label}: retry in {delay}s"));
                thread::sleep(Duration::from_secs(*delay));
            }
            let capture = run_ytdlp_capture(binary, args)?;
            log_ytdlp(format!(
                "{label}: success={} status={:?}",
                capture.success, capture.status_code
            ));
            if !capture.stdout.trim().is_empty() {
                log_ytdlp(format!("stdout: {}", truncate_for_log(&capture.stdout)));
            }
            if !capture.stderr.trim().is_empty() {
                log_ytdlp(format!("stderr: {}", truncate_for_log(&capture.stderr)));
            }
            let rate_limited = output_is_rate_limited(&capture);
            last_capture = Some(capture.clone());
            if !rate_limited || index + 1 == delays.len() {
                return Ok(capture);
            }
        }
        Ok(last_capture.unwrap_or_default())
    }

    fn build_subtitle_args(
        template: &Path,
        video_url: &str,
        sub_langs: &str,
        cookie_browser: Option<&str>,
    ) -> Vec<String> {
        let mut args = vec![
            "--skip-download".to_string(),
            "--no-playlist".to_string(),
            "--no-warnings".to_string(),
            "--no-progress".to_string(),
            "--write-auto-sub".to_string(),
            "--write-sub".to_string(),
        ];
        if let Some(browser) = cookie_browser {
            args.push("--cookies-from-browser".to_string());
            args.push(browser.to_string());
        }
        args.extend([
            "--sub-langs".to_string(),
            sub_langs.to_string(),
            "--convert-subs".to_string(),
            "srt".to_string(),
            "-o".to_string(),
            template.display().to_string(),
            video_url.to_string(),
        ]);
        args
    }

    fn probe_subtitle_languages(
        binary: &str,
        video_url: &str,
        cookie_browser: Option<&str>,
    ) -> Result<YtdlpSubtitleLanguageProbe, String> {
        let mut args = vec![
            "-J".to_string(),
            "--skip-download".to_string(),
            "--no-playlist".to_string(),
            "--no-warnings".to_string(),
        ];
        if let Some(browser) = cookie_browser {
            args.push("--cookies-from-browser".to_string());
            args.push(browser.to_string());
        }
        args.push(video_url.to_string());
        let capture = run_ytdlp_with_retry(binary, &args, "subtitle language probe")?;
        if !capture.success {
            return Err(combine_output(&capture));
        }
        let parsed: Value = serde_json::from_str(capture.stdout.trim())
            .map_err(|error| format!("Invalid yt-dlp JSON: {error}"))?;
        let collect_keys = |field: &str| -> Vec<String> {
            parsed
                .get(field)
                .and_then(|value| value.as_object())
                .map(|map| {
                    let mut keys = map.keys().map(|key| key.to_string()).collect::<Vec<_>>();
                    keys.sort();
                    keys
                })
                .unwrap_or_default()
        };
        Ok(YtdlpSubtitleLanguageProbe {
            manual: collect_keys("subtitles"),
            automatic: collect_keys("automatic_captions"),
        })
    }

    fn available_probe_languages(probe: &YtdlpSubtitleLanguageProbe) -> Vec<String> {
        let mut values = BTreeSet::new();
        for language in probe.manual.iter().chain(probe.automatic.iter()) {
            values.insert(language.clone());
        }
        values.into_iter().collect()
    }

    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let template = target_dir.join(format!("{file_prefix}.%(ext)s"));
    let (binary, _) = detect_ytdlp()
        .ok_or_else(|| "未检测到可用的 yt-dlp，请先在设置中完成安装。".to_string())?;
    log_ytdlp(format!(
        "start subtitle download: video_url={video_url} target_dir={} file_prefix={} binary={binary}",
        target_dir.display(),
        file_prefix
    ));

    let mut browser_attempts = vec![None];
    browser_attempts.extend(subtitle_browser_candidates().into_iter().map(Some));
    let mut last_error = None;

    for cookie_browser in browser_attempts {
        let browser_label = cookie_browser.unwrap_or("none");
        cleanup_downloaded_files(target_dir, file_prefix);
        let preferred_args = build_subtitle_args(
            &template,
            video_url,
            YTDLP_PREFERRED_SUB_LANGS,
            cookie_browser,
        );
        let preferred_capture = run_ytdlp_with_retry(
            &binary,
            &preferred_args,
            &format!("preferred subtitle attempt ({browser_label})"),
        )?;
        if preferred_capture.success {
            if let Some(path) =
                find_downloaded_file(target_dir, file_prefix, &["srt", "vtt", "txt"])
            {
                return Ok(path);
            }
        }

        let should_probe = preferred_capture.success
            || output_mentions_missing_subtitles(&preferred_capture)
            || output_is_rate_limited(&preferred_capture);
        if should_probe {
            match probe_subtitle_languages(&binary, video_url, cookie_browser) {
                Ok(probe) => {
                    log_ytdlp(format!(
                        "subtitle language probe: manual={:?} automatic={:?}",
                        probe.manual, probe.automatic
                    ));
                    let fallback_languages = available_probe_languages(&probe);
                    if fallback_languages.is_empty() {
                        return Err(
                            "该视频没有可用字幕（YouTube 未提供手动或自动字幕）".to_string()
                        );
                    }
                    let fallback_csv = fallback_languages.join(",");
                    cleanup_downloaded_files(target_dir, file_prefix);
                    let fallback_args =
                        build_subtitle_args(&template, video_url, &fallback_csv, cookie_browser);
                    let fallback_capture = run_ytdlp_with_retry(
                        &binary,
                        &fallback_args,
                        &format!("fallback subtitle attempt ({browser_label})"),
                    )?;
                    if fallback_capture.success {
                        if let Some(path) =
                            find_downloaded_file(target_dir, file_prefix, &["srt", "vtt", "txt"])
                        {
                            return Ok(path);
                        }
                        last_error = Some(format!(
                            "yt-dlp completed but no subtitle file was produced; available subtitles: manual={:?}, automatic={:?}",
                            probe.manual, probe.automatic
                        ));
                    } else if output_is_rate_limited(&fallback_capture) {
                        last_error = Some(format!(
                            "字幕下载被 YouTube 限流（HTTP 429 / Too Many Requests）: {}",
                            combine_output(&fallback_capture)
                        ));
                    } else {
                        last_error = Some(combine_output(&fallback_capture));
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        } else if output_is_rate_limited(&preferred_capture) {
            last_error = Some(format!(
                "字幕下载被 YouTube 限流（HTTP 429 / Too Many Requests）: {}",
                combine_output(&preferred_capture)
            ));
        } else {
            last_error = Some(combine_output(&preferred_capture));
        }
    }

    Err(last_error
        .unwrap_or_else(|| "yt-dlp completed but no subtitle file was produced".to_string()))
}

pub(crate) fn download_ytdlp_audio(
    video_url: &str,
    target_dir: &Path,
    file_prefix: &str,
) -> Result<PathBuf, String> {
    fn truncate_for_log(raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.len() > 1_200 {
            format!("{}…", &trimmed[..1_200])
        } else {
            trimmed.to_string()
        }
    }

    fn combine_output(capture: &YtdlpCommandCapture) -> String {
        let stderr = capture.stderr.trim();
        let stdout = capture.stdout.trim();
        if !stderr.is_empty() {
            stderr.to_string()
        } else if !stdout.is_empty() {
            stdout.to_string()
        } else if let Some(code) = capture.status_code {
            format!("exit status {code}")
        } else {
            "yt-dlp exited without output".to_string()
        }
    }

    fn output_is_rate_limited(capture: &YtdlpCommandCapture) -> bool {
        let haystack = format!("{}\n{}", capture.stdout, capture.stderr).to_lowercase();
        haystack.contains("http error 429")
            || haystack.contains("too many requests")
            || haystack.contains("rate limit")
    }

    fn browser_candidates() -> Vec<&'static str> {
        #[cfg(target_os = "macos")]
        {
            vec!["safari", "chrome", "edge", "firefox", "chromium", "brave"]
        }
        #[cfg(target_os = "windows")]
        {
            vec!["edge", "chrome", "firefox", "chromium", "brave"]
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            vec!["chrome", "firefox", "chromium", "brave"]
        }
    }

    fn collect_paths_with_prefix(target_dir: &Path, file_prefix: &str) -> Vec<PathBuf> {
        let mut paths = fs::read_dir(target_dir)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.starts_with(file_prefix))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    fn cleanup_downloaded_files(target_dir: &Path, file_prefix: &str) {
        for path in collect_paths_with_prefix(target_dir, file_prefix) {
            let _ = fs::remove_file(path);
        }
    }

    fn find_audio_file(target_dir: &Path, file_prefix: &str) -> Option<PathBuf> {
        collect_paths_with_prefix(target_dir, file_prefix)
            .into_iter()
            .find(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(|ext| {
                        ["m4a", "mp3", "webm", "opus", "ogg", "wav", "aac"]
                            .iter()
                            .any(|expected| ext.eq_ignore_ascii_case(expected))
                    })
                    .unwrap_or(false)
            })
    }

    fn run_ytdlp_capture(binary: &str, args: &[String]) -> Result<YtdlpCommandCapture, String> {
        let mut command = std::process::Command::new(binary);
        configure_background_command(&mut command);
        let output = command
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        Ok(YtdlpCommandCapture {
            success: output.status.success(),
            status_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }

    fn run_ytdlp_with_retry(
        binary: &str,
        args: &[String],
        label: &str,
    ) -> Result<YtdlpCommandCapture, String> {
        let delays = [0_u64, 2, 5];
        let mut last_capture = None;
        for (index, delay) in delays.iter().enumerate() {
            if *delay > 0 {
                log_ytdlp(format!("{label}: retry in {delay}s"));
                thread::sleep(Duration::from_secs(*delay));
            }
            let capture = run_ytdlp_capture(binary, args)?;
            log_ytdlp(format!(
                "{label}: success={} status={:?}",
                capture.success, capture.status_code
            ));
            if !capture.stdout.trim().is_empty() {
                log_ytdlp(format!("stdout: {}", truncate_for_log(&capture.stdout)));
            }
            if !capture.stderr.trim().is_empty() {
                log_ytdlp(format!("stderr: {}", truncate_for_log(&capture.stderr)));
            }
            let rate_limited = output_is_rate_limited(&capture);
            last_capture = Some(capture.clone());
            if !rate_limited || index + 1 == delays.len() {
                return Ok(capture);
            }
        }
        Ok(last_capture.unwrap_or_default())
    }

    fn build_audio_args(
        template: &Path,
        video_url: &str,
        cookie_browser: Option<&str>,
    ) -> Vec<String> {
        let mut args = vec![
            "--no-playlist".to_string(),
            "--no-warnings".to_string(),
            "--no-progress".to_string(),
        ];
        if let Some(browser) = cookie_browser {
            args.push("--cookies-from-browser".to_string());
            args.push(browser.to_string());
        }
        args.extend([
            "-f".to_string(),
            "bestaudio[ext=m4a]/bestaudio/best".to_string(),
            "-o".to_string(),
            template.display().to_string(),
            video_url.to_string(),
        ]);
        args
    }

    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let template = target_dir.join(format!("{file_prefix}.%(ext)s"));
    let (binary, _) = detect_ytdlp()
        .ok_or_else(|| "未检测到可用的 yt-dlp，请先在设置中完成安装。".to_string())?;
    log_ytdlp(format!(
        "start audio download: video_url={video_url} target_dir={} file_prefix={} binary={binary}",
        target_dir.display(),
        file_prefix
    ));

    let mut attempts = vec![None];
    attempts.extend(browser_candidates().into_iter().map(Some));
    let mut last_error = None;
    for cookie_browser in attempts {
        cleanup_downloaded_files(target_dir, file_prefix);
        let label = format!(
            "audio fallback attempt ({})",
            cookie_browser.unwrap_or("none")
        );
        let args = build_audio_args(&template, video_url, cookie_browser);
        let capture = run_ytdlp_with_retry(&binary, &args, &label)?;
        if capture.success {
            if let Some(path) = find_audio_file(target_dir, file_prefix) {
                return Ok(path);
            }
            last_error = Some("yt-dlp completed but no audio file was produced".to_string());
        } else {
            last_error = Some(combine_output(&capture));
        }
    }
    Err(last_error.unwrap_or_else(|| "yt-dlp audio download failed".to_string()))
}

pub(crate) fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let image_class = match ext.as_str() {
        "png" => Some("PNG picture"),
        "jpg" | "jpeg" => Some("JPEG picture"),
        "gif" => Some("GIF picture"),
        _ => None,
    };
    if let Some(image_class) = image_class {
        let script = format!(
            "set the clipboard to (read (POSIX file {}) as {})",
            format!("{:?}", path.display().to_string()),
            image_class
        );
        let mut command = std::process::Command::new("osascript");
        configure_background_command(&mut command);
        let output = command
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(());
        }
    }
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(file_url_for_path(path)))
        .map_err(|error| error.to_string())
}
