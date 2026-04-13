use arboard::Clipboard;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    log_timing_event, now_iso, now_ms, payload_field, payload_string, payload_value_as_string,
    refresh_runtime_warm_state, store_root, update_workspace_root_cache, AppState,
};

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
        | "app:open-path"
        | "db:get-settings"
        | "db:save-settings"
        | "debug:get-status"
        | "debug:get-recent"
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
                "app:open-path" => {
                    let path = payload_string(payload, "path")
                        .or_else(|| payload_value_as_string(payload))
                        .ok_or_else(|| "path is required".to_string())?;
                    open::that(&path).map_err(|error| error.to_string())?;
                    Ok(json!({ "success": true, "path": path }))
                }
                "db:get-settings" => {
                    let started_at = now_ms();
                    let request_id = format!("db:get-settings:{}", started_at);
                    let result = with_store(state, |store| Ok(store.settings.clone()));
                    log_timing_event(
                        state,
                        "settings",
                        &request_id,
                        "db:get-settings",
                        started_at,
                        None,
                    );
                    result
                }
                "db:save-settings" => {
                    let started_at = now_ms();
                    let request_id = format!("db:save-settings:{}", started_at);
                    let active_space_id = with_store_mut(state, |store| {
                        if let (Some(current), Some(next)) = (store.settings.as_object(), payload.as_object()) {
                            let mut merged = current.clone();
                            for (key, value) in next {
                                merged.insert(key.to_string(), value.clone());
                            }
                            store.settings = Value::Object(merged);
                        } else {
                            store.settings = payload.clone();
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
                    log_timing_event(
                        state,
                        "settings",
                        &request_id,
                        "db:save-settings",
                        started_at,
                        None,
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
