use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

mod data_sources;
mod install_files;
mod manifest;
mod manifest_primitives;
mod marketplace;
mod registry;
mod runtime_sync;

use crate::{
    list_tree, now_iso, now_ms,
    persistence::{with_store, with_store_mut},
    read_json_value_or,
    runtime::{McpServerRecord, SkillRecord},
    skills::discover_skill_records_from_root,
    slug_from_relative_path,
    store::mcp_tools as mcp_tools_store,
    store::media as media_store,
    store::subjects as subjects_store,
    store_root, workspace_root, write_json_value, AppState,
};
use data_sources::{list_thrive_plugin_home, read_thrive_plugin_data, ThrivePluginReadDataRequest};
use install_files::{
    copy_plugin_dir_secure, extract_plugin_archive, remove_path_if_exists,
    resolve_plugin_source_root,
};
use manifest::{
    find_thrive_plugin_manifest_path, load_thrive_plugin_manifest, validate_manifest_relative_path,
    validate_thrive_plugin_manifest,
};
use manifest_primitives::{
    is_known_plugin_capability, is_known_plugin_home_action_target, is_known_plugin_home_source,
    is_known_plugin_home_widget_kind, is_known_plugin_ui_slot, normalize_plugin_home_limit,
    validate_network_host, validate_plugin_segment, validate_plugin_version,
};
use marketplace::{
    install_thrive_plugin_from_marketplace, list_thrive_plugin_marketplace,
    ThrivePluginInstallMarketplaceRequest, ThrivePluginMarketplaceRequest,
};
use registry::{
    display_name_for_manifest, list_thrive_plugins, load_thrive_plugin_index,
    plugin_data_dir_for_id, plugin_id_for_manifest, thrive_plugin_cache_root,
    thrive_plugin_data_root, thrive_plugin_source_scope, thrive_plugin_summary,
    thrive_plugins_root, validate_plugin_id, write_thrive_plugin_index, ThrivePluginIndexEntry,
};
use runtime_sync::enabled_thrive_plugin_entries;
pub(crate) use runtime_sync::sync_enabled_thrive_plugin_capabilities;

const THRIVE_PLUGIN_SCHEMA_VERSION: u32 = 1;
const THRIVE_PLUGIN_LOCAL_MARKETPLACE: &str = "local";
const THRIVE_PLUGIN_COMMUNITY_MARKETPLACE: &str = "community";
const THRIVE_PLUGIN_INDEX_FILE: &str = "index.json";
const THRIVE_PLUGIN_DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/ThrivingOS/Thrive-release/main/community-plugins.json";
const THRIVE_PLUGIN_HTTP_USER_AGENT: &str =
    "Thrive/PluginMarketplace (+https://github.com/ThrivingOS/Thrive-release)";
const THRIVE_PLUGIN_MANIFEST_PATHS: &[&str] = &[
    ".redbox-plugin/plugin.json",
    ".thrive-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "plugin.json",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThrivePluginManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    min_app_version: Option<String>,
    #[serde(default)]
    platforms: Vec<String>,
    #[serde(default)]
    skills: Option<String>,
    #[serde(default)]
    mcp_servers: Option<String>,
    #[serde(default)]
    apps: Option<String>,
    #[serde(default)]
    actions: Option<String>,
    #[serde(default)]
    media: Option<String>,
    #[serde(default)]
    ui: BTreeMap<String, String>,
    #[serde(default)]
    permissions: RawThrivePluginPermissions,
    #[serde(default)]
    interface: Option<RawThrivePluginInterface>,
    #[serde(default)]
    home: RawThrivePluginHome,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThrivePluginPermissions {
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    network: Vec<String>,
    #[serde(default)]
    approval_required: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThrivePluginInterface {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    short_description: Option<String>,
    #[serde(default)]
    long_description: Option<String>,
    #[serde(default)]
    developer_name: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    default_prompt: Option<Value>,
    #[serde(default)]
    logo: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThrivePluginHome {
    #[serde(default)]
    widgets: Vec<RawThrivePluginHomeWidget>,
    #[serde(default)]
    quick_actions: Vec<RawThrivePluginHomeAction>,
    #[serde(default)]
    sidebar_sections: Vec<RawThrivePluginHomeWidget>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThrivePluginHomeWidget {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    tone: Option<String>,
    #[serde(default)]
    order: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawThrivePluginHomeAction {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    tone: Option<String>,
    #[serde(default)]
    order: Option<i64>,
}

fn install_thrive_plugin_from_path(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source_path: &Path,
) -> Result<Value, String> {
    install_thrive_plugin_from_path_for_marketplace(
        app,
        state,
        source_path,
        THRIVE_PLUGIN_LOCAL_MARKETPLACE,
    )
}

fn install_thrive_plugin_from_path_for_marketplace(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source_path: &Path,
    marketplace: &str,
) -> Result<Value, String> {
    validate_plugin_segment(marketplace, "plugin marketplace")?;
    if !source_path.exists() {
        return Err(format!(
            "plugin source does not exist: {}",
            source_path.display()
        ));
    }

    let temp_root = thrive_plugins_root(state)?
        .join(".tmp")
        .join(format!("install-{}", now_ms()));
    remove_path_if_exists(&temp_root)?;
    fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;

    let resolved_source = if source_path.is_dir() {
        resolve_plugin_source_root(source_path)?
    } else {
        extract_plugin_archive(source_path, &temp_root)?
    };

    let manifest = load_thrive_plugin_manifest(&resolved_source)?;
    let plugin_id = plugin_id_for_manifest(&manifest, marketplace);
    let version = manifest
        .version
        .clone()
        .unwrap_or_else(|| "local".to_string());
    let cache_root = thrive_plugin_cache_root(state)?;
    let plugin_base = cache_root.join(marketplace).join(&manifest.name);
    let target_root = plugin_base.join(&version);
    let staged_root = plugin_base.join(format!(".staged-{}-{version}", now_ms()));
    let backup_root = plugin_base.join(format!(".backup-{}-{version}", now_ms()));

    fs::create_dir_all(&plugin_base).map_err(|error| error.to_string())?;
    remove_path_if_exists(&staged_root)?;
    copy_plugin_dir_secure(&resolved_source, &staged_root)?;
    load_thrive_plugin_manifest(&staged_root)?;

    let had_existing = target_root.exists();
    if had_existing {
        remove_path_if_exists(&backup_root)?;
        fs::rename(&target_root, &backup_root)
            .map_err(|error| format!("failed to back up existing plugin: {error}"))?;
    }

    if let Err(error) = fs::rename(&staged_root, &target_root) {
        if had_existing {
            let _ = fs::rename(&backup_root, &target_root);
        }
        return Err(format!("failed to activate plugin: {error}"));
    }
    remove_path_if_exists(&backup_root)?;
    remove_path_if_exists(&temp_root)?;

    let mut index = load_thrive_plugin_index(state)?;
    let timestamp = now_iso();
    let installed_at = index
        .plugins
        .get(&plugin_id)
        .map(|entry| entry.installed_at.clone())
        .unwrap_or_else(|| timestamp.clone());
    index.plugins.insert(
        plugin_id.clone(),
        ThrivePluginIndexEntry {
            enabled: true,
            active_version: version,
            marketplace: marketplace.to_string(),
            installed_at,
            updated_at: timestamp,
            root: target_root.display().to_string(),
            granted_capabilities: manifest.permissions.capabilities.clone(),
            approval_required: manifest.permissions.approval_required.clone(),
        },
    );
    write_thrive_plugin_index(state, &index)?;
    let sync_result = sync_enabled_thrive_plugin_capabilities(state).unwrap_or_else(|error| {
        json!({
            "success": false,
            "error": error,
        })
    });
    let summary = thrive_plugin_summary(
        state,
        &plugin_id,
        index
            .plugins
            .get(&plugin_id)
            .ok_or_else(|| "installed plugin index entry missing".to_string())?,
    );
    let _ = app.emit(
        "plugins:changed",
        json!({ "at": now_iso(), "pluginId": plugin_id }),
    );
    Ok(json!({
        "success": true,
        "plugin": summary,
        "sync": sync_result,
    }))
}

fn set_thrive_plugin_enabled(
    app: &AppHandle,
    state: &State<'_, AppState>,
    plugin_id: &str,
    enabled: bool,
) -> Result<Value, String> {
    validate_plugin_id(plugin_id)?;
    let mut index = load_thrive_plugin_index(state)?;
    let entry = index
        .plugins
        .get_mut(plugin_id)
        .ok_or_else(|| format!("plugin `{plugin_id}` is not installed"))?;
    entry.enabled = enabled;
    entry.updated_at = now_iso();
    let summary = thrive_plugin_summary(state, plugin_id, entry);
    write_thrive_plugin_index(state, &index)?;
    let sync_result = sync_enabled_thrive_plugin_capabilities(state).unwrap_or_else(|error| {
        json!({
            "success": false,
            "error": error,
        })
    });
    let _ = app.emit(
        "plugins:changed",
        json!({ "at": now_iso(), "pluginId": plugin_id, "enabled": enabled }),
    );
    Ok(json!({
        "success": true,
        "plugin": summary,
        "sync": sync_result,
    }))
}

fn uninstall_thrive_plugin(
    app: &AppHandle,
    state: &State<'_, AppState>,
    plugin_id: &str,
) -> Result<Value, String> {
    validate_plugin_id(plugin_id)?;
    let mut index = load_thrive_plugin_index(state)?;
    let Some(entry) = index.plugins.remove(plugin_id) else {
        return Err(format!("plugin `{plugin_id}` is not installed"));
    };
    let root = PathBuf::from(&entry.root);
    if let Some(plugin_base) = root.parent() {
        remove_path_if_exists(plugin_base)?;
    } else {
        remove_path_if_exists(&root)?;
    }
    write_thrive_plugin_index(state, &index)?;
    let sync_result = sync_enabled_thrive_plugin_capabilities(state).unwrap_or_else(|error| {
        json!({
            "success": false,
            "error": error,
        })
    });
    let _ = app.emit(
        "plugins:changed",
        json!({ "at": now_iso(), "pluginId": plugin_id }),
    );
    Ok(json!({
        "success": true,
        "pluginId": plugin_id,
        "sync": sync_result,
    }))
}

fn open_thrive_plugin_data_dir(
    state: &State<'_, AppState>,
    plugin_id: Option<&str>,
) -> Result<Value, String> {
    let path = match plugin_id {
        Some(plugin_id) if !plugin_id.trim().is_empty() => {
            plugin_data_dir_for_id(state, plugin_id)?
        }
        _ => thrive_plugin_data_root(state)?,
    };
    open::that(&path).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "path": path.display().to_string(),
    }))
}

pub fn handle_plugin_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "plugins:list"
            | "plugins:marketplace"
            | "plugins:install"
            | "plugins:install-marketplace"
            | "plugins:set-enabled"
            | "plugins:uninstall"
            | "plugins:open-data-dir"
            | "plugins:sync-capabilities"
            | "plugins:read-data"
            | "plugins:home"
    ) {
        return None;
    }

    Some((|| -> Result<Value, String> {
        match channel {
            "plugins:list" => list_thrive_plugins(state),
            "plugins:marketplace" => {
                let request: ThrivePluginMarketplaceRequest =
                    serde_json::from_value(payload.clone())
                        .map_err(|error| format!("plugins:marketplace payload invalid: {error}"))?;
                list_thrive_plugin_marketplace(state, request)
            }
            "plugins:install" => {
                let path = payload
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "plugins:install requires `path`".to_string())?;
                install_thrive_plugin_from_path(app, state, Path::new(path))
            }
            "plugins:install-marketplace" => {
                let request: ThrivePluginInstallMarketplaceRequest =
                    serde_json::from_value(payload.clone()).map_err(|error| {
                        format!("plugins:install-marketplace payload invalid: {error}")
                    })?;
                install_thrive_plugin_from_marketplace(app, state, request)
            }
            "plugins:set-enabled" => {
                let plugin_id = payload
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "plugins:set-enabled requires `pluginId`".to_string())?;
                let enabled = payload
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "plugins:set-enabled requires `enabled`".to_string())?;
                set_thrive_plugin_enabled(app, state, plugin_id, enabled)
            }
            "plugins:uninstall" => {
                let plugin_id = payload
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "plugins:uninstall requires `pluginId`".to_string())?;
                uninstall_thrive_plugin(app, state, plugin_id)
            }
            "plugins:open-data-dir" => {
                open_thrive_plugin_data_dir(state, payload.get("pluginId").and_then(Value::as_str))
            }
            "plugins:sync-capabilities" => sync_enabled_thrive_plugin_capabilities(state),
            "plugins:read-data" => {
                let request: ThrivePluginReadDataRequest = serde_json::from_value(payload.clone())
                    .map_err(|error| format!("plugins:read-data payload invalid: {error}"))?;
                read_thrive_plugin_data(state, request)
            }
            "plugins:home" => list_thrive_plugin_home(state),
            _ => unreachable!(),
        }
    })())
}
