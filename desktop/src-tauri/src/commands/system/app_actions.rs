use super::app_update::APP_UPDATE_DOWNLOAD_PAGE_URL;
use crate::commands::file_ops::resolve_file_action_path;
use crate::{payload_string, payload_value_as_string, pick_files_native, AppState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

fn is_http_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("https://") || normalized.starts_with("http://")
}

fn bundled_html_resource_path(
    app: &AppHandle,
    file_name: &str,
    missing_message: &str,
) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut push = |path: PathBuf| {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            candidates.push(path);
        }
    };

    push(resource_dir.join(file_name));
    push(resource_dir.join("resources").join(file_name));
    push(resource_dir.join("_up_").join(file_name));
    push(resource_dir.join("_up_").join("resources").join(file_name));

    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            push(cwd.join("src-tauri").join("resources").join(file_name));
            push(cwd.join("resources").join(file_name));
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(missing_message.to_string())
}

fn knowledge_api_guide_path(app: &AppHandle) -> Result<PathBuf, String> {
    bundled_html_resource_path(app, "knowledge-api-guide.html", "知识导入 API 文档页不存在")
}

pub(super) fn open_release_page(payload: &Value) -> Result<Value, String> {
    let url = payload_string(payload, "url")
        .or_else(|| payload_value_as_string(payload))
        .unwrap_or_else(|| APP_UPDATE_DOWNLOAD_PAGE_URL.to_string());
    if !is_http_url(&url) {
        return Err("Invalid download URL".to_string());
    }
    open::that(&url).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "url": url }))
}

pub(super) fn open_knowledge_api_guide(app: &AppHandle) -> Result<Value, String> {
    let path = knowledge_api_guide_path(app)?;
    open::that(&path).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": path.display().to_string() }))
}

pub(super) fn open_path(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let path = payload_string(payload, "path")
        .or_else(|| payload_value_as_string(payload))
        .ok_or_else(|| "path is required".to_string())?;
    if is_http_url(&path) {
        open::that(&path).map_err(|error| error.to_string())?;
        return Ok(json!({ "success": true, "path": path }));
    }
    let open_target =
        resolve_file_action_path(state, &path).unwrap_or_else(|_| PathBuf::from(&path));
    open::that(&open_target).map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "path": open_target }))
}

pub(super) fn pick_workspace_dir() -> Result<Value, String> {
    let selected = pick_files_native("选择工作区目录", true, false)?;
    let path = selected.first().map(|item| item.display().to_string());
    Ok(json!({
        "success": path.is_some(),
        "canceled": path.is_none(),
        "path": path,
    }))
}

#[cfg(test)]
mod tests {
    use super::is_http_url;

    #[test]
    fn http_url_validation_accepts_http_and_https_only() {
        assert!(is_http_url(" https://redbox.ziz.hk/download "));
        assert!(is_http_url("http://localhost:3000"));
        assert!(!is_http_url("file:///tmp/app.dmg"));
        assert!(!is_http_url("javascript:alert(1)"));
    }
}
