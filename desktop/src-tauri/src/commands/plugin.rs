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
struct ThrivePluginIndex {
    schema_version: u32,
    #[serde(default)]
    plugins: BTreeMap<String, ThrivePluginIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginIndexEntry {
    enabled: bool,
    active_version: String,
    marketplace: String,
    installed_at: String,
    updated_at: String,
    root: String,
    #[serde(default)]
    granted_capabilities: Vec<String>,
    #[serde(default)]
    approval_required: Vec<String>,
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginSummary {
    id: String,
    name: String,
    display_name: String,
    version: String,
    description: Option<String>,
    enabled: bool,
    marketplace: String,
    installed_at: String,
    updated_at: String,
    root: String,
    data_dir: String,
    capabilities: Vec<String>,
    approval_required: Vec<String>,
    ui_slots: Vec<String>,
    mcp_servers_path: Option<String>,
    skills_path: Option<String>,
    actions_path: Option<String>,
    media_path: Option<String>,
    home_widgets: usize,
    home_quick_actions: usize,
    error: Option<String>,
}

fn thrive_plugins_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = store_root(state)?.join("thrive-plugins");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn thrive_plugin_cache_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = thrive_plugins_root(state)?.join("cache");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn thrive_plugin_data_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = thrive_plugins_root(state)?.join("data");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn thrive_plugin_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(thrive_plugins_root(state)?.join(THRIVE_PLUGIN_INDEX_FILE))
}

fn load_thrive_plugin_index(state: &State<'_, AppState>) -> Result<ThrivePluginIndex, String> {
    let path = thrive_plugin_index_path(state)?;
    let value = read_json_value_or(
        &path,
        json!({
            "schemaVersion": THRIVE_PLUGIN_SCHEMA_VERSION,
            "plugins": {}
        }),
    );
    let mut index =
        serde_json::from_value::<ThrivePluginIndex>(value).unwrap_or(ThrivePluginIndex {
            schema_version: THRIVE_PLUGIN_SCHEMA_VERSION,
            plugins: BTreeMap::new(),
        });
    index.schema_version = THRIVE_PLUGIN_SCHEMA_VERSION;
    Ok(index)
}

fn write_thrive_plugin_index(
    state: &State<'_, AppState>,
    index: &ThrivePluginIndex,
) -> Result<(), String> {
    let path = thrive_plugin_index_path(state)?;
    write_json_value(&path, &json!(index))
}

fn plugin_id_for_manifest(manifest: &RawThrivePluginManifest, marketplace: &str) -> String {
    format!("{}@{}", manifest.name, marketplace)
}

fn thrive_plugin_source_scope(plugin_id: &str) -> String {
    format!("thrive-plugin:{plugin_id}")
}

fn display_name_for_manifest(manifest: &RawThrivePluginManifest) -> String {
    manifest
        .interface
        .as_ref()
        .and_then(|interface| interface.display_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&manifest.name)
        .to_string()
}

fn plugin_data_dir_for_id(state: &State<'_, AppState>, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let dir = thrive_plugin_data_root(state)?.join(plugin_id.replace('@', "__"));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    let Some((name, marketplace)) = plugin_id.rsplit_once('@') else {
        return Err("plugin id must use `<name>@<marketplace>`".to_string());
    };
    validate_plugin_segment(name, "plugin name")?;
    validate_plugin_segment(marketplace, "plugin marketplace")?;
    Ok(())
}

fn thrive_plugin_summary(
    state: &State<'_, AppState>,
    plugin_id: &str,
    entry: &ThrivePluginIndexEntry,
) -> ThrivePluginSummary {
    let root = PathBuf::from(&entry.root);
    let (manifest, error) = match load_thrive_plugin_manifest(&root) {
        Ok(manifest) => (Some(manifest), None),
        Err(error) => (None, Some(error)),
    };
    let fallback_name = plugin_id
        .rsplit_once('@')
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| plugin_id.to_string());
    let data_dir = plugin_data_dir_for_id(state, plugin_id)
        .map(|path| path.display().to_string())
        .unwrap_or_default();

    if let Some(manifest) = manifest {
        let paths = |raw_path: Option<&str>| {
            validate_manifest_relative_path(&root, "path", raw_path)
                .ok()
                .flatten()
                .map(|path| path.display().to_string())
        };
        ThrivePluginSummary {
            id: plugin_id.to_string(),
            name: manifest.name.clone(),
            display_name: display_name_for_manifest(&manifest),
            version: manifest
                .version
                .clone()
                .unwrap_or_else(|| "local".to_string()),
            description: manifest.description.clone(),
            enabled: entry.enabled,
            marketplace: entry.marketplace.clone(),
            installed_at: entry.installed_at.clone(),
            updated_at: entry.updated_at.clone(),
            root: entry.root.clone(),
            data_dir,
            capabilities: manifest.permissions.capabilities.clone(),
            approval_required: manifest.permissions.approval_required.clone(),
            ui_slots: manifest.ui.keys().cloned().collect(),
            mcp_servers_path: paths(manifest.mcp_servers.as_deref()),
            skills_path: paths(manifest.skills.as_deref()),
            actions_path: paths(manifest.actions.as_deref()),
            media_path: paths(manifest.media.as_deref()),
            home_widgets: manifest.home.widgets.len() + manifest.home.sidebar_sections.len(),
            home_quick_actions: manifest.home.quick_actions.len(),
            error,
        }
    } else {
        ThrivePluginSummary {
            id: plugin_id.to_string(),
            name: fallback_name.clone(),
            display_name: fallback_name,
            version: entry.active_version.clone(),
            description: None,
            enabled: entry.enabled,
            marketplace: entry.marketplace.clone(),
            installed_at: entry.installed_at.clone(),
            updated_at: entry.updated_at.clone(),
            root: entry.root.clone(),
            data_dir,
            capabilities: entry.granted_capabilities.clone(),
            approval_required: entry.approval_required.clone(),
            ui_slots: Vec::new(),
            mcp_servers_path: None,
            skills_path: None,
            actions_path: None,
            media_path: None,
            home_widgets: 0,
            home_quick_actions: 0,
            error,
        }
    }
}

fn normalize_plugin_skill_name(plugin_name: &str, skill_name: &str) -> String {
    let prefix = format!("{plugin_name}:");
    if skill_name.starts_with(&prefix) {
        skill_name.to_string()
    } else {
        format!("{prefix}{skill_name}")
    }
}

fn enabled_thrive_plugin_entries(
    state: &State<'_, AppState>,
) -> Result<Vec<(String, ThrivePluginIndexEntry, RawThrivePluginManifest)>, String> {
    let index = load_thrive_plugin_index(state)?;
    let mut plugins = Vec::new();
    for (plugin_id, entry) in index.plugins {
        if !entry.enabled {
            continue;
        }
        let root = PathBuf::from(&entry.root);
        let manifest = load_thrive_plugin_manifest(&root)?;
        plugins.push((plugin_id, entry, manifest));
    }
    Ok(plugins)
}

fn discover_thrive_plugin_skill_records(
    plugin_id: &str,
    entry: &ThrivePluginIndexEntry,
    manifest: &RawThrivePluginManifest,
) -> Vec<SkillRecord> {
    let root = PathBuf::from(&entry.root);
    let Some(skills_root) =
        validate_manifest_relative_path(&root, "skills", manifest.skills.as_deref())
            .ok()
            .flatten()
            .or_else(|| {
                let default_root = root.join("skills");
                default_root.is_dir().then_some(default_root)
            })
    else {
        return Vec::new();
    };
    discover_skill_records_from_root(&skills_root, &thrive_plugin_source_scope(plugin_id), false)
        .into_iter()
        .map(|mut record| {
            record.name = normalize_plugin_skill_name(&manifest.name, &record.name);
            record.location = format!(
                "thrive://plugins/{}/skills/{}",
                plugin_id,
                slug_from_relative_path(&record.name)
            );
            record.source_scope = Some(thrive_plugin_source_scope(plugin_id));
            record.is_builtin = Some(false);
            record.disabled = Some(false);
            record
        })
        .collect()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginMcpServersFile {
    #[serde(default)]
    mcp_servers: BTreeMap<String, Value>,
}

fn parse_plugin_mcp_servers_file(value: Value) -> BTreeMap<String, Value> {
    if let Ok(file) = serde_json::from_value::<PluginMcpServersFile>(value.clone()) {
        if !file.mcp_servers.is_empty() {
            return file.mcp_servers;
        }
    }
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default()
}

fn resolve_plugin_runtime_path(root: &Path, value: &str) -> String {
    value
        .strip_prefix("./")
        .map(|relative| root.join(relative).display().to_string())
        .unwrap_or_else(|| value.to_string())
}

fn discover_thrive_plugin_mcp_servers(
    plugin_id: &str,
    entry: &ThrivePluginIndexEntry,
    manifest: &RawThrivePluginManifest,
) -> Vec<McpServerRecord> {
    let root = PathBuf::from(&entry.root);
    let Some(mcp_path) =
        validate_manifest_relative_path(&root, "mcpServers", manifest.mcp_servers.as_deref())
            .ok()
            .flatten()
            .or_else(|| {
                let default_path = root.join("mcp.json");
                default_path.is_file().then_some(default_path)
            })
            .or_else(|| {
                let default_path = root.join(".mcp.json");
                default_path.is_file().then_some(default_path)
            })
    else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&mcp_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    parse_plugin_mcp_servers_file(value)
        .into_iter()
        .filter_map(|(name, config)| {
            let object = config.as_object()?;
            let transport = object
                .get("transport")
                .and_then(Value::as_str)
                .unwrap_or("stdio")
                .to_string();
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .map(|value| resolve_plugin_runtime_path(&root, value));
            let args = object
                .get("args")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|value| resolve_plugin_runtime_path(&root, value))
                        .collect::<Vec<_>>()
                })
                .filter(|items| !items.is_empty());
            let env = object
                .get("env")
                .and_then(Value::as_object)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_string()))
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                })
                .filter(|items| !items.is_empty());
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let oauth = object
                .get("oauth")
                .cloned()
                .or_else(|| object.get("redbox").cloned());
            let namespaced_name = format!("{}__{}", manifest.name, name);
            let mut oauth_value = oauth.unwrap_or_else(|| json!({}));
            if !oauth_value.is_object() {
                oauth_value = json!({});
            }
            if let Some(object) = oauth_value.as_object_mut() {
                let redbox = object.entry("redbox").or_insert_with(|| json!({}));
                if !redbox.is_object() {
                    *redbox = json!({});
                }
                if let Some(redbox_object) = redbox.as_object_mut() {
                    redbox_object.insert("pluginId".to_string(), json!(plugin_id));
                    redbox_object.insert("pluginName".to_string(), json!(manifest.name));
                }
            }
            Some(McpServerRecord {
                id: format!("plugin:{}:{}", plugin_id, name),
                name: namespaced_name,
                enabled: object
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                transport,
                command,
                args,
                env,
                cwd: None,
                url,
                oauth: Some(oauth_value),
            })
        })
        .collect()
}

pub(crate) fn sync_enabled_thrive_plugin_capabilities(
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let enabled_plugins = enabled_thrive_plugin_entries(state)?;
    let mut plugin_skills = Vec::<SkillRecord>::new();
    let mut plugin_mcp_servers = Vec::<McpServerRecord>::new();
    let mut plugin_ids = Vec::<String>::new();
    for (plugin_id, entry, manifest) in &enabled_plugins {
        plugin_ids.push(plugin_id.clone());
        plugin_skills.extend(discover_thrive_plugin_skill_records(
            plugin_id, entry, manifest,
        ));
        plugin_mcp_servers.extend(discover_thrive_plugin_mcp_servers(
            plugin_id, entry, manifest,
        ));
    }

    let next_mcp_servers = with_store_mut(state, |store| {
        store.skills.retain(|skill| {
            !skill
                .source_scope
                .as_deref()
                .unwrap_or_default()
                .starts_with("thrive-plugin:")
        });
        store.skills.extend(plugin_skills.clone());
        Ok(mcp_tools_store::replace_thrive_plugin_servers(
            store,
            plugin_mcp_servers.clone(),
        ))
    })?;
    state.mcp_manager.sync_servers(&next_mcp_servers)?;

    Ok(json!({
        "success": true,
        "pluginIds": plugin_ids,
        "skills": plugin_skills.len(),
        "mcpServers": plugin_mcp_servers.len(),
    }))
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

fn list_thrive_plugins(state: &State<'_, AppState>) -> Result<Value, String> {
    let index = load_thrive_plugin_index(state)?;
    let plugins = index
        .plugins
        .iter()
        .map(|(plugin_id, entry)| thrive_plugin_summary(state, plugin_id, entry))
        .collect::<Vec<_>>();
    Ok(json!({
        "success": true,
        "schemaVersion": THRIVE_PLUGIN_SCHEMA_VERSION,
        "root": thrive_plugins_root(state)?.display().to_string(),
        "plugins": plugins,
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
