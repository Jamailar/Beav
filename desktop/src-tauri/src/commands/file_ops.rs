use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::{AppState, copy_image_to_clipboard, payload_string, resolve_local_path};

pub fn handle_file_ops_channel(
    _app: &AppHandle,
    _state: &State<'_, AppState>,
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
                let Some(path) = resolve_local_path(&source) else {
                    return Ok(json!({ "success": false, "error": "无效路径" }));
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
                let Some(path) = resolve_local_path(&source) else {
                    return Ok(json!({ "success": false, "error": "无效路径" }));
                };
                if !path.exists() {
                    return Ok(json!({ "success": false, "error": "文件不存在" }));
                }
                copy_image_to_clipboard(&path)?;
                Ok(json!({ "success": true }))
            }
            _ => unreachable!(),
        }
    })())
}
