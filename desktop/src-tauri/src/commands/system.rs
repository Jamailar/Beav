use arboard::Clipboard;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    now_iso, payload_field, payload_string, payload_value_as_string, refresh_runtime_warm_state,
    store_root, AppState,
};

pub fn handle_system_channel(
    _app: &AppHandle,
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
                "db:get-settings" => with_store(state, |store| Ok(store.settings.clone())),
                "db:save-settings" => {
                    with_store_mut(state, |store| {
                        store.settings = payload.clone();
                        Ok(())
                    })?;
                    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "chatroom"]);
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
