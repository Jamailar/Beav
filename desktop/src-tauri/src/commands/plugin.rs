use serde_json::{json, Value};
use std::{ffi::OsStr, fs, path::Path};
use tauri::{AppHandle, State};

use crate::{
    browser_plugin_bundled_candidates, browser_plugin_bundled_root, browser_plugin_export_root,
    copy_dir_recursive, log_timing_event, now_ms, AppState,
};

const EXPORTED_BROWSER_PLUGIN_DIR_NAME: &str = "RedBox Browser Extension";

fn missing_browser_plugin_error(app: &AppHandle) -> String {
    let checked_paths = browser_plugin_bundled_candidates(app);
    if checked_paths.is_empty() {
        return "未找到仓库内置浏览器插件资源。".to_string();
    }
    format!(
        "未找到仓库内置浏览器插件资源。已检查：{}",
        checked_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join("；")
    )
}

fn browser_plugin_prepared_dir(export_root: &Path) -> std::path::PathBuf {
    export_root.join(EXPORTED_BROWSER_PLUGIN_DIR_NAME)
}

fn migrate_flat_browser_plugin_layout(
    export_root: &Path,
    prepared_dir: &Path,
) -> Result<(), String> {
    if prepared_dir.join("manifest.json").exists() || !export_root.join("manifest.json").exists() {
        return Ok(());
    }

    fs::create_dir_all(prepared_dir).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(export_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_name = entry.file_name();
        if file_name == OsStr::new(EXPORTED_BROWSER_PLUGIN_DIR_NAME) {
            continue;
        }
        let source = entry.path();
        let target = prepared_dir.join(&file_name);
        fs::rename(&source, &target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn handle_plugin_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    _payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "plugin:browser-extension-status"
            | "plugin:prepare-browser-extension"
            | "plugin:open-browser-extension-dir"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "plugin:browser-extension-status" => {
                let started_at = now_ms();
                let request_id = format!("plugin:browser-extension-status:{}", started_at);
                let bundled_path = browser_plugin_bundled_root(app);
                let export_path = browser_plugin_export_root(state)?;
                let prepared_path = browser_plugin_prepared_dir(&export_path);
                migrate_flat_browser_plugin_layout(&export_path, &prepared_path)?;
                let bundled = bundled_path.is_some();
                let exported = prepared_path.join("manifest.json").exists();
                let checked_paths = browser_plugin_bundled_candidates(app);
                log_timing_event(
                    state,
                    "settings",
                    &request_id,
                    "plugin:browser-extension-status",
                    started_at,
                    Some(format!("bundled={} exported={}", bundled, exported)),
                );
                Ok(json!({
                    "success": true,
                    "bundled": bundled,
                    "exported": exported,
                    "exportPath": export_path.display().to_string(),
                    "pluginPath": prepared_path.display().to_string(),
                    "bundledPath": bundled_path
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_default(),
                    "checkedPaths": checked_paths
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>(),
                    "error": if bundled {
                        Value::Null
                    } else {
                        json!(missing_browser_plugin_error(app))
                    }
                }))
            }
            "plugin:prepare-browser-extension" => {
                let Some(bundled_path) = browser_plugin_bundled_root(app) else {
                    return Ok(json!({
                        "success": false,
                        "error": missing_browser_plugin_error(app),
                    }));
                };
                let export_path = browser_plugin_export_root(state)?;
                let prepared_path = browser_plugin_prepared_dir(&export_path);
                migrate_flat_browser_plugin_layout(&export_path, &prepared_path)?;
                if !prepared_path.join("manifest.json").exists() {
                    copy_dir_recursive(&bundled_path, &prepared_path)?;
                }
                Ok(json!({
                    "success": true,
                    "path": export_path.display().to_string(),
                    "pluginPath": prepared_path.display().to_string(),
                    "alreadyPrepared": prepared_path.join("manifest.json").exists()
                }))
            }
            "plugin:open-browser-extension-dir" => {
                let export_path = browser_plugin_export_root(state)?;
                let prepared_path = browser_plugin_prepared_dir(&export_path);
                migrate_flat_browser_plugin_layout(&export_path, &prepared_path)?;
                if !prepared_path.join("manifest.json").exists() {
                    if let Some(bundled_path) = browser_plugin_bundled_root(app) {
                        copy_dir_recursive(&bundled_path, &prepared_path)?;
                    }
                }
                open::that(&export_path).map_err(|error| error.to_string())?;
                Ok(json!({
                    "success": true,
                    "path": export_path.display().to_string(),
                    "pluginPath": prepared_path.display().to_string()
                }))
            }
            _ => unreachable!(),
        }
    })())
}
