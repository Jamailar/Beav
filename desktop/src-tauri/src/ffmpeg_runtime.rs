use std::env;
use std::path::PathBuf;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-unknown-linux-gnu";
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const TARGET_TRIPLE: &str = "unknown-target";

fn executable_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

fn sidecar_candidate_names(name: &str) -> Vec<String> {
    let suffix = executable_suffix();
    vec![
        format!("binaries/{name}-{TARGET_TRIPLE}{suffix}"),
        format!("{name}-{TARGET_TRIPLE}{suffix}"),
        format!("binaries/{name}{suffix}"),
        format!("{name}{suffix}"),
    ]
}

fn executable_in_path(name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(format!("{name}{}", executable_suffix()));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_sidecar_binary(app: Option<&AppHandle>, name: &str) -> Option<PathBuf> {
    let candidates = sidecar_candidate_names(name);
    if let Some(app) = app {
        for candidate in &candidates {
            if let Ok(path) = app.path().resolve(candidate, BaseDirectory::Resource) {
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for candidate in candidates {
        let path = manifest_dir.join(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub(crate) fn resolve_media_binary(app: Option<&AppHandle>, name: &str) -> Result<PathBuf, String> {
    resolve_sidecar_binary(app, name)
        .or_else(|| executable_in_path(name))
        .ok_or_else(|| {
            format!("{name} binary is not bundled for {TARGET_TRIPLE} and was not found in PATH")
        })
}

pub(crate) fn ffmpeg_executable(app: Option<&AppHandle>) -> Result<PathBuf, String> {
    resolve_media_binary(app, "ffmpeg")
}

pub(crate) fn ffmpeg_program(app: Option<&AppHandle>) -> Result<String, String> {
    Ok(ffmpeg_executable(app)?.display().to_string())
}

#[allow(dead_code)]
pub(crate) fn ffprobe_executable(app: Option<&AppHandle>) -> Result<PathBuf, String> {
    resolve_media_binary(app, "ffprobe")
}
