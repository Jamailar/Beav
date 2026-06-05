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
mod lifecycle;
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
use lifecycle::{
    install_thrive_plugin_from_path, install_thrive_plugin_from_path_for_marketplace,
    open_thrive_plugin_data_dir, set_thrive_plugin_enabled, uninstall_thrive_plugin,
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
