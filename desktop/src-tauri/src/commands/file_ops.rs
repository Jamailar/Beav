use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, State};

use crate::{
    copy_image_to_clipboard, cover_root, media_root, payload_string, pick_save_file_native,
    resolve_local_path, resolve_manuscript_path, workspace_root, AppState,
};

const PREVIEW_TEXT_MAX_BYTES: u64 = 512 * 1024;

fn find_existing_file_candidate(raw_path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    if raw_path.as_os_str().is_empty() {
        return None;
    }
    if raw_path.exists() {
        return Some(raw_path.to_path_buf());
    }
    if raw_path.is_absolute() {
        return None;
    }
    roots
        .iter()
        .map(|root| root.join(raw_path))
        .find(|candidate| candidate.exists())
}

fn resolve_file_action_path(state: &State<'_, AppState>, source: &str) -> Result<PathBuf, String> {
    if let Some(path) = resolve_virtual_resource_path(state, source)? {
        if path.exists() {
            return Ok(path);
        }
    }
    let path = resolve_local_path(source).ok_or_else(|| "无效路径".to_string())?;
    if path.exists() {
        return Ok(path);
    }
    if path.is_relative() {
        let mut roots = Vec::new();
        if let Ok(root) = resolve_manuscript_path(state, "") {
            roots.push(root);
        }
        if let Ok(root) = media_root(state) {
            roots.push(root);
        }
        if let Ok(root) = cover_root(state) {
            roots.push(root);
        }
        if let Ok(root) = workspace_root(state) {
            roots.push(root);
        }
        if let Some(candidate) = find_existing_file_candidate(&path, &roots) {
            return Ok(candidate);
        }
    }
    Err("文件不存在".to_string())
}

fn extension_for_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

fn preview_kind_for_extension(extension: Option<&str>, is_local: bool) -> &'static str {
    let Some(extension) = extension else {
        return if is_local { "unknown" } else { "web" };
    };
    match extension {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "svg" | "avif" => "image",
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "avi" => "video",
        "mp3" | "wav" | "m4a" | "flac" | "aac" | "ogg" => "audio",
        "pdf" => "pdf",
        "html" | "htm" => "html",
        "md" | "markdown" | "txt" | "json" | "csv" | "yaml" | "yml" | "xml" | "log" | "ts"
        | "tsx" | "js" | "jsx" | "rs" | "py" | "go" | "java" | "c" | "cpp" | "h" | "hpp"
        | "css" | "scss" => "text",
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" => "archive",
        _ => {
            if is_local {
                "unknown"
            } else {
                "web"
            }
        }
    }
}

fn mime_type_for_extension(extension: Option<&str>) -> Option<&'static str> {
    let extension = extension?;
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "ts" | "tsx" | "js" | "jsx" | "rs" | "py" | "go" | "java" | "c" | "cpp" | "h" | "hpp"
        | "css" | "scss" => "text/plain",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => return None,
    })
}

fn read_preview_text(path: &Path, kind: &str) -> Option<String> {
    if kind != "text" && kind != "html" {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > PREVIEW_TEXT_MAX_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn is_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn safe_virtual_relative_path(raw: &str) -> Option<PathBuf> {
    let decoded = urlencoding::decode(raw)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    if decoded.starts_with("//") || decoded.starts_with("\\\\") {
        return None;
    }
    let normalized = decoded
        .trim_start_matches(|value| value == '/' || value == '\\')
        .replace('\\', "/");
    if normalized.is_empty() {
        return Some(PathBuf::new());
    }
    if is_windows_drive_prefix(&normalized) {
        return None;
    }
    let path = PathBuf::from(normalized);
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return None;
        }
    }
    Some(path)
}

fn virtual_path_parts(source: &str) -> Option<(String, String)> {
    let trimmed = source.trim();
    let separator = trimmed.find("://")?;
    let scheme = trimmed[..separator].to_ascii_lowercase();
    let rest = trimmed[(separator + 3)..].to_string();
    Some((scheme, rest))
}

fn resolve_virtual_resource_path(
    state: &State<'_, AppState>,
    source: &str,
) -> Result<Option<PathBuf>, String> {
    let Some((scheme, rest)) = virtual_path_parts(source) else {
        return Ok(None);
    };
    let root = match scheme.as_str() {
        "workspace" => workspace_root(state)?,
        "knowledge" => crate::knowledge_root(state)?,
        "manuscripts" => resolve_manuscript_path(state, "")?,
        "media" => media_root(state)?,
        "cover" => cover_root(state)?,
        "redclaw" => crate::redclaw_root(state)?,
        _ => return Ok(None),
    };
    let relative = safe_virtual_relative_path(&rest).ok_or_else(|| "虚拟路径不安全".to_string())?;
    Ok(Some(root.join(relative)))
}

fn redbox_asset_url_for_path(path: &Path) -> String {
    let path_string = path.to_string_lossy().replace('\\', "/");
    format!("redbox-asset://asset/{}", urlencoding::encode(&path_string))
}

fn resolve_preview_target(state: &State<'_, AppState>, source: &str) -> Result<Value, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let extension = extension_for_path(Path::new(trimmed));
        let kind = preview_kind_for_extension(extension.as_deref(), false);
        return Ok(json!({
            "success": true,
            "isLocal": false,
            "exists": true,
            "isDirectory": false,
            "absolutePath": null,
            "localPathCandidate": null,
            "resolvedUrl": trimmed,
            "title": trimmed,
            "extension": extension,
            "kind": kind,
            "mimeType": mime_type_for_extension(extension.as_deref()),
            "sizeBytes": null,
            "previewText": null,
        }));
    }

    let resolved = match resolve_virtual_resource_path(state, trimmed)? {
        Some(path) => Some(path),
        None => resolve_local_path(trimmed),
    };
    let path = resolved.ok_or_else(|| "无效路径".to_string())?;
    let exists = path.exists();
    let is_directory = path.is_dir();
    let metadata = if exists {
        fs::metadata(&path).ok()
    } else {
        None
    };
    let extension = extension_for_path(&path);
    let kind = preview_kind_for_extension(extension.as_deref(), true);
    let title = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| trimmed.to_string());
    let preview_text = if exists && !is_directory {
        read_preview_text(&path, kind)
    } else {
        None
    };
    let resolved_url = if exists && !is_directory {
        redbox_asset_url_for_path(&path)
    } else {
        String::new()
    };

    Ok(json!({
        "success": true,
        "isLocal": true,
        "exists": exists,
        "isDirectory": is_directory,
        "absolutePath": path,
        "localPathCandidate": path,
        "resolvedUrl": resolved_url,
        "title": title,
        "extension": extension,
        "kind": kind,
        "mimeType": mime_type_for_extension(extension.as_deref()),
        "sizeBytes": metadata.map(|value| value.len()),
        "previewText": preview_text,
    }))
}

#[cfg(test)]
mod tests {
    use super::{find_existing_file_candidate, safe_virtual_relative_path};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn make_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "redbox-file-ops-{label}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn resolves_relative_path_against_workspace_roots() {
        let root = make_temp_dir("relative");
        let media_root = root.join("media");
        fs::create_dir_all(media_root.join("generated")).expect("create media root");
        let target = media_root.join("generated/example.png");
        fs::write(&target, b"ok").expect("write media file");

        let resolved =
            find_existing_file_candidate(Path::new("generated/example.png"), &[media_root.clone()]);

        assert_eq!(resolved, Some(target));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keeps_absolute_paths_when_they_exist() {
        let root = make_temp_dir("absolute");
        let target = root.join("example.png");
        fs::write(&target, b"ok").expect("write media file");

        let resolved = find_existing_file_candidate(&target, &[]);

        assert_eq!(resolved, Some(target.clone()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn virtual_preview_paths_decode_and_block_parent_dir() {
        assert_eq!(
            safe_virtual_relative_path("folder/My%20File.md"),
            Some(PathBuf::from("folder/My File.md"))
        );
        assert_eq!(safe_virtual_relative_path("../secret.md"), None);
        assert_eq!(safe_virtual_relative_path("C:/secret.md"), None);
        assert_eq!(safe_virtual_relative_path("//server/share/secret.md"), None);
    }
}

pub fn handle_file_ops_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "file:show-in-folder" | "file:copy-image" | "file:save-as" | "file:preview-resolve"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "file:show-in-folder" => {
                let source = payload_string(payload, "source").unwrap_or_default();
                let path = match resolve_file_action_path(state, &source) {
                    Ok(path) => path,
                    Err(error) => return Ok(json!({ "success": false, "error": error })),
                };
                let target = if path.is_file() {
                    path.parent()
                        .map(std::path::Path::to_path_buf)
                        .unwrap_or(path)
                } else {
                    path
                };
                open::that(&target).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true }))
            }
            "file:copy-image" => {
                let source = payload_string(payload, "source").unwrap_or_default();
                let path = match resolve_file_action_path(state, &source) {
                    Ok(path) => path,
                    Err(error) => return Ok(json!({ "success": false, "error": error })),
                };
                copy_image_to_clipboard(&path)?;
                Ok(json!({ "success": true }))
            }
            "file:save-as" => {
                let source = payload_string(payload, "source").unwrap_or_default();
                let path = match resolve_file_action_path(state, &source) {
                    Ok(path) => path,
                    Err(error) => return Ok(json!({ "success": false, "error": error })),
                };
                let default_name = payload_string(payload, "defaultName")
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| {
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .map(ToString::to_string)
                    })
                    .unwrap_or_else(|| "generated-asset".to_string());
                let selected = pick_save_file_native("选择保存位置", &default_name, path.parent())?;
                let Some(target_path) = selected else {
                    return Ok(json!({ "success": false, "canceled": true }));
                };
                fs::copy(&path, &target_path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": target_path }))
            }
            "file:preview-resolve" => {
                let source = payload_string(payload, "source").unwrap_or_default();
                match resolve_preview_target(state, &source) {
                    Ok(value) => Ok(value),
                    Err(error) => Ok(json!({ "success": false, "error": error })),
                }
            }
            _ => unreachable!(),
        }
    })())
}
