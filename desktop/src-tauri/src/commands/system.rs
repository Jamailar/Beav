use arboard::Clipboard;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    now_iso, payload_field, payload_string, payload_value_as_string, pick_files_native,
    refresh_runtime_warm_state, store_root, update_workspace_root_cache, AppState,
};

fn normalize_default_ai_route_settings(settings: &mut Value) {
    let default_source_id = payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let Some(raw_sources) = payload_string(settings, "ai_sources_json") else {
        return;
    };
    let sources = serde_json::from_str::<Vec<Value>>(&raw_sources).unwrap_or_default();
    let default_source = sources.iter().find(|source| {
        source
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.trim() == default_source_id)
            .unwrap_or(false)
    });
    let Some(source) = default_source else {
        return;
    };

    let base_url = source
        .get("baseURL")
        .or_else(|| source.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let api_key = source
        .get("apiKey")
        .or_else(|| source.get("key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let model_name = source
        .get("model")
        .or_else(|| source.get("modelName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    if let Some(object) = settings.as_object_mut() {
        if !base_url.is_empty() {
            object.insert("api_endpoint".to_string(), json!(base_url));
        }
        if !api_key.is_empty() {
            object.insert("api_key".to_string(), json!(api_key.clone()));
            let current_video_api_key = object
                .get("video_api_key")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if current_video_api_key.is_empty() {
                object.insert("video_api_key".to_string(), json!(api_key));
            }
        }
        if !model_name.is_empty() {
            object.insert("model_name".to_string(), json!(model_name));
        }
    }
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

fn richpost_theme_guide_path(app: &AppHandle) -> Result<PathBuf, String> {
    bundled_html_resource_path(app, "richpost-theme-guide.html", "主题编辑指南不存在")
}

pub fn handle_system_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "app:get-version"
        | "app:check-update"
        | "app:open-release-page"
        | "app:startup-migration-start"
        | "app:startup-migration-status"
        | "app:open-knowledge-api-guide"
        | "app:open-richpost-theme-guide"
        | "app:open-path"
        | "settings:pick-workspace-dir"
        | "db:get-settings"
        | "db:save-settings"
        | "debug:get-status"
        | "debug:get-recent"
        | "debug:get-runtime-summary"
        | "debug:open-log-dir"
        | "clipboard:read-text"
        | "clipboard:write-html" => (|| -> Result<Value, String> {
            match channel {
                "app:get-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
                "app:check-update" => Ok(json!({
                    "success": true,
                    "hasUpdate": false,
                    "currentVersion": env!("CARGO_PKG_VERSION"),
                })),
                "app:open-release-page" => {
                    let url = payload_string(payload, "url")
                        .or_else(|| payload_value_as_string(payload))
                        .unwrap_or_else(|| {
                            "https://github.com/Jamailar/RedBox/releases".to_string()
                        });
                    open::that(&url).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "url": url }))
                }
                "app:startup-migration-status" => crate::startup_migration_status_value(state),
                "app:startup-migration-start" => crate::start_startup_migration(app, state),
                "app:open-knowledge-api-guide" => {
                    let path = knowledge_api_guide_path(app)?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path.display().to_string() }))
                }
                "app:open-richpost-theme-guide" => {
                    let path = richpost_theme_guide_path(app)?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path.display().to_string() }))
                }
                "app:open-path" => {
                    let path = payload_string(payload, "path")
                        .or_else(|| payload_value_as_string(payload))
                        .ok_or_else(|| "path is required".to_string())?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path }))
                }
                "settings:pick-workspace-dir" => {
                    let selected = pick_files_native("选择工作区目录", true, false)?;
                    let path = selected.first().map(|item| item.display().to_string());
                    Ok(json!({
                        "success": path.is_some(),
                        "canceled": path.is_none(),
                        "path": path,
                    }))
                }
                "db:get-settings" => with_store(state, |store| {
                    let runtime = state
                        .auth_runtime
                        .lock()
                        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
                    let mut projected =
                        crate::auth::project_settings_for_runtime(&store.settings, &runtime);
                    normalize_default_ai_route_settings(&mut projected);
                    Ok(projected)
                }),
                "db:save-settings" => {
                    let active_space_id = with_store_mut(state, |store| {
                        if let (Some(current), Some(next)) =
                            (store.settings.as_object(), payload.as_object())
                        {
                            let mut merged = current.clone();
                            for (key, value) in next {
                                if matches!(key.as_str(), "redbox_auth_session_json") {
                                    continue;
                                }
                                merged.insert(key.to_string(), value.clone());
                            }
                            store.settings = Value::Object(merged);
                            normalize_default_ai_route_settings(&mut store.settings);
                        } else {
                            store.settings = payload.clone();
                            normalize_default_ai_route_settings(&mut store.settings);
                        }
                        Ok(store.active_space_id.clone())
                    })?;
                    let _ = update_workspace_root_cache(state, payload, &active_space_id);
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
                    let _ = app.emit(
                        "settings:updated",
                        json!({
                            "updatedAt": now_iso(),
                        }),
                    );
                    Ok(json!({ "success": true }))
                }
                "debug:get-status" => Ok(json!({
                    "enabled": true,
                    "logDirectory": store_root(state)?.display().to_string(),
                })),
                "debug:get-recent" => {
                    let limit = payload_field(payload, "limit")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(50)
                        .clamp(1, 200) as usize;
                    with_store(state, |store| {
                        let mut lines = store.debug_logs.clone();
                        if lines.is_empty() {
                            lines.push(format!("{} | RedBox Rust host is active.", now_iso()));
                        }
                        lines.truncate(limit);
                        Ok(json!({ "lines": lines }))
                    })
                }
                "debug:get-runtime-summary" => crate::build_runtime_diagnostics_summary(state),
                "debug:open-log-dir" => {
                    let path = store_root(state)?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path.display().to_string() }))
                }
                "clipboard:read-text" => Ok(json!(Clipboard::new()
                    .and_then(|mut clipboard| clipboard.get_text())
                    .unwrap_or_default())),
                "clipboard:write-html" => {
                    let text = payload_string(payload, "text")
                        .or_else(|| payload_string(payload, "html"))
                        .unwrap_or_default();
                    Clipboard::new()
                        .and_then(|mut clipboard| clipboard.set_text(text.clone()))
                        .map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "text": text }))
                }
                _ => unreachable!("channel prefiltered"),
            }
        })(),
        _ => return None,
    };

    Some(result)
}
