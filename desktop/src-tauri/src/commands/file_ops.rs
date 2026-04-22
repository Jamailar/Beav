use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::{
    copy_image_to_clipboard, payload_string, resolve_local_path, resolve_manuscript_path, AppState,
};

fn resolve_file_action_path(state: &State<'_, AppState>, source: &str) -> Result<PathBuf, String> {
    let path = resolve_local_path(source).ok_or_else(|| "无效路径".to_string())?;
    if path.exists() {
        return Ok(path);
    }
    if path.is_relative() {
        let manuscript_path = resolve_manuscript_path(state, source)?;
        if manuscript_path.exists() {
            return Ok(manuscript_path);
        }
    }
    Err("文件不存在".to_string())
}

pub fn handle_file_ops_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(channel, "file:show-in-folder" | "file:copy-image") {
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
            _ => unreachable!(),
        }
    })())
}
