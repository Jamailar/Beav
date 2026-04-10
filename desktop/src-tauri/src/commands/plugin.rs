use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::{
    browser_plugin_bundled_root, browser_plugin_export_root, copy_dir_recursive, AppState,
};

pub fn handle_plugin_channel(
    _app: &AppHandle,
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
                let bundled_path = browser_plugin_bundled_root();
                let export_path = browser_plugin_export_root(state)?;
                let bundled = bundled_path.join("manifest.json").exists();
                let exported = export_path.join("manifest.json").exists();
                Ok(json!({
                    "success": true,
                    "bundled": bundled,
                    "exported": exported,
                    "exportPath": export_path.display().to_string(),
                    "bundledPath": bundled_path.display().to_string(),
                    "error": if bundled { Value::Null } else { json!("Plugin/manifest.json not found") }
                }))
            }
            "plugin:prepare-browser-extension" => {
                let bundled_path = browser_plugin_bundled_root();
                if !bundled_path.join("manifest.json").exists() {
                    return Ok(
                        json!({ "success": false, "error": "未找到仓库内置浏览器插件资源。" }),
                    );
                }
                let export_path = browser_plugin_export_root(state)?;
                if !export_path.join("manifest.json").exists() {
                    copy_dir_recursive(&bundled_path, &export_path)?;
                }
                Ok(json!({
                    "success": true,
                    "path": export_path.display().to_string(),
                    "alreadyPrepared": export_path.join("manifest.json").exists()
                }))
            }
            "plugin:open-browser-extension-dir" => {
                let export_path = browser_plugin_export_root(state)?;
                if !export_path.join("manifest.json").exists() {
                    let bundled_path = browser_plugin_bundled_root();
                    if bundled_path.join("manifest.json").exists() {
                        copy_dir_recursive(&bundled_path, &export_path)?;
                    }
                }
                open::that(&export_path).map_err(|error| error.to_string())?;
                Ok(json!({ "success": true, "path": export_path.display().to_string() }))
            }
            _ => unreachable!(),
        }
    })())
}
