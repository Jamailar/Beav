use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use crate::{
    copy_image_to_clipboard, cover_root, media_root, payload_string, pick_save_file_native,
    resolve_local_path, resolve_manuscript_path, workspace_root, AppState,
};

mod archive;
mod preview;

use archive::write_zip_archive;
use preview::{resolve_preview_target, resolve_virtual_resource_path};

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

fn decode_encoded_local_path_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if !trimmed.contains('%') {
        return None;
    }
    let decoded = urlencoding::decode(trimmed).ok()?.into_owned();
    let decoded = decoded.trim();
    if decoded == trimmed {
        return None;
    }
    let bytes = decoded.as_bytes();
    let has_windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    if has_windows_drive || matches!(bytes.first(), Some(b'/' | b'\\')) {
        Some(decoded.to_string())
    } else {
        None
    }
}

fn resolve_local_path_with_encoded_fallback(source: &str) -> Option<PathBuf> {
    let primary = resolve_local_path(source)?;
    if primary.exists() {
        return Some(primary);
    }
    decode_encoded_local_path_source(source)
        .and_then(|decoded| resolve_local_path(&decoded))
        .or(Some(primary))
}

pub(crate) fn resolve_file_action_path(
    state: &State<'_, AppState>,
    source: &str,
) -> Result<PathBuf, String> {
    if let Some(path) = resolve_virtual_resource_path(state, source)? {
        if path.exists() {
            return Ok(path);
        }
    }
    let path =
        resolve_local_path_with_encoded_fallback(source).ok_or_else(|| "无效路径".to_string())?;
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

#[cfg(test)]
mod tests {
    use super::{
        decode_encoded_local_path_source, find_existing_file_candidate,
        resolve_local_path_with_encoded_fallback,
    };
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
    fn decodes_markdown_encoded_windows_drive_path() {
        let decoded = decode_encoded_local_path_source(
            "C:%5CUsers%5C%E5%BC%A0%E4%B8%89%5CRedBox%5Ctranscript.srt",
        )
        .expect("decoded windows path");

        assert_eq!(decoded, r#"C:\Users\张三\RedBox\transcript.srt"#);
    }

    #[test]
    fn decodes_markdown_encoded_rooted_windows_path_for_preview() {
        let decoded = decode_encoded_local_path_source(
            "%5CUsers%5C%E5%BC%A0%E4%B8%89%5CRedBox%5Ctranscript.srt",
        )
        .expect("decoded rooted path");

        assert_eq!(decoded, r#"\Users\张三\RedBox\transcript.srt"#);
    }

    #[test]
    fn resolve_local_path_falls_back_to_decoded_existing_path() {
        let root = make_temp_dir("encoded-existing");
        let target = root.join("字幕 transcript.srt");
        fs::write(&target, b"ok").expect("write target");
        let encoded = urlencoding::encode(&target.to_string_lossy()).to_string();

        let resolved =
            resolve_local_path_with_encoded_fallback(&encoded).expect("resolved encoded path");

        assert_eq!(resolved, target);
        let _ = fs::remove_dir_all(root);
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
        "file:show-in-folder"
            | "file:copy-image"
            | "file:save-as"
            | "file:save-zip"
            | "file:preview-resolve"
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
            "file:save-zip" => {
                let default_name = payload_string(payload, "defaultName")
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "assets.zip".to_string());
                let files = payload
                    .get("files")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "file:save-zip requires files".to_string())?;
                if files.is_empty() {
                    return Ok(json!({ "success": false, "error": "没有可下载的文件" }));
                }
                let default_dir = dirs::download_dir();
                let selected = pick_save_file_native(
                    "选择压缩包保存位置",
                    &default_name,
                    default_dir.as_deref(),
                )?;
                let Some(target_path) = selected else {
                    return Ok(json!({ "success": false, "canceled": true }));
                };
                write_zip_archive(state, files, target_path)
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
