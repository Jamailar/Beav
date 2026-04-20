use arboard::Clipboard;
use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{
    AdvisorVideoRecord, configure_background_command, file_url_for_path, normalize_base_url,
    now_iso, now_ms, payload_string,
};

pub(crate) fn write_base64_payload_to_file(
    encoded: &str,
    output_path: &Path,
) -> Result<(), String> {
    let encoded_path = std::env::temp_dir().join(format!("redbox-audio-{}.b64", now_ms()));
    fs::write(&encoded_path, encoded).map_err(|error| error.to_string())?;
    let output = std::process::Command::new("base64")
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

fn detect_ytdlp_at(candidate: &Path) -> Option<(String, String)> {
    let mut command = std::process::Command::new(candidate);
    configure_background_command(&mut command);
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some((candidate.display().to_string(), version))
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
        if let Some(found) = detect_ytdlp_at(&candidate) {
            return Some(found);
        }
    }
    None
}

pub(crate) fn ensure_ytdlp_installed(update: bool) -> Result<(String, String), String> {
    if let Some(found) = detect_ytdlp() {
        if !update {
            return Ok(found);
        }
    }
    let pip_commands = [
        (
            "python3",
            vec!["-m", "pip", "install", "--user", "-U", "yt-dlp"],
        ),
        (
            "python",
            vec!["-m", "pip", "install", "--user", "-U", "yt-dlp"],
        ),
    ];
    for (binary, args) in pip_commands {
        let mut command = std::process::Command::new(binary);
        configure_background_command(&mut command);
        let output = command.args(args).output();
        if let Ok(output) = output {
            if output.status.success() {
                if let Some(found) = detect_ytdlp() {
                    return Ok(found);
                }
            }
        }
    }
    Err("未检测到可用的 yt-dlp，且自动安装失败。请先确保 python3/pip 可用。".to_string())
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
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let template = target_dir.join(format!("{file_prefix}.%(ext)s"));
    let (binary, _) = detect_ytdlp()
        .ok_or_else(|| "未检测到可用的 yt-dlp，请先在设置中完成安装。".to_string())?;
    let mut command = std::process::Command::new(&binary);
    configure_background_command(&mut command);
    let output = command
        .args([
            "--skip-download",
            "--no-warnings",
            "--no-progress",
            "--write-auto-sub",
            "--write-sub",
            "--sub-langs",
            "zh.*,zh-Hans,zh-Hant,en.*",
            "--convert-subs",
            "srt",
            "-o",
        ])
        .arg(&template)
        .arg(video_url)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "yt-dlp subtitle download failed with status {}",
                output.status
            )
        } else {
            stderr
        });
    }
    let mut candidates = fs::read_dir(target_dir)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.starts_with(file_prefix))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
        .into_iter()
        .find(|path| {
            path.extension()
                .and_then(|v| v.to_str())
                .map(|ext| {
                    ext.eq_ignore_ascii_case("srt")
                        || ext.eq_ignore_ascii_case("vtt")
                        || ext.eq_ignore_ascii_case("txt")
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| "yt-dlp completed but no subtitle file was produced".to_string())
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
        let output = std::process::Command::new("osascript")
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
