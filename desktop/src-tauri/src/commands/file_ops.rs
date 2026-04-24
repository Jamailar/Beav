use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use crate::{
    copy_image_to_clipboard, cover_root, media_root, payload_string, pick_save_file_native,
    resolve_local_path, resolve_manuscript_path, workspace_root, AppState,
};

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

#[cfg(test)]
mod tests {
    use super::find_existing_file_candidate;
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
}

pub fn handle_file_ops_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "file:show-in-folder" | "file:copy-image" | "file:save-as"
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
            _ => unreachable!(),
        }
    })())
}
