use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Emitter, State};
use zip::ZipArchive;

use crate::{
    list_tree, now_iso, now_ms,
    persistence::{with_store, with_store_mut},
    read_json_value_or,
    runtime::{McpServerRecord, SkillRecord},
    skills::discover_skill_records_from_root,
    slug_from_relative_path, store_root, workspace_root, write_json_value, AppState,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginReadDataRequest {
    plugin_id: String,
    source: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    query: Option<String>,
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

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginMarketplaceRequest {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginInstallMarketplaceRequest {
    #[serde(default)]
    id: Option<String>,
    repo: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    package_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginMarketplaceEntry {
    id: String,
    name: String,
    author: String,
    description: String,
    repo: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThrivePluginMarketplaceItem {
    id: String,
    name: String,
    author: String,
    description: String,
    repo: String,
    version: Option<String>,
    display_name: Option<String>,
    capabilities: Vec<String>,
    package_url: Option<String>,
    package_asset_name: Option<String>,
    manifest_url: Option<String>,
    installed: bool,
    installed_plugin_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct GitHubReleaseResponse {
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
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

fn validate_plugin_segment(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!(
            "{field} only allows ASCII letters, digits, `-`, and `_`"
        ));
    }
    Ok(())
}

fn validate_plugin_version(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("version must not be empty".to_string());
    }
    if matches!(value, "." | "..") {
        return Err("version must not be `.` or `..`".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '+' | '-' | '_'))
    {
        return Err(
            "version only allows ASCII letters, digits, `.`, `+`, `-`, and `_`".to_string(),
        );
    }
    Ok(())
}

fn is_known_plugin_capability(value: &str) -> bool {
    matches!(
        value,
        "ai.skill"
            | "mcp.server"
            | "app.connector"
            | "knowledge.read"
            | "knowledge.import"
            | "assets.read"
            | "subjects.read"
            | "manuscripts.read"
            | "manuscripts.write.current"
            | "editor.read.current"
            | "editor.write.current"
            | "media.read"
            | "media.import"
            | "media.process"
            | "video.exportPreset"
            | "video.effectPreset"
            | "subtitle.stylePreset"
            | "audio.processor"
            | "cover.template"
            | "export.create"
            | "network.request.scoped"
            | "pluginData.read"
            | "pluginData.write"
            | "ui.settingsPanel"
            | "ui.home"
            | "ui.manuscriptSidebar"
            | "ui.videoInspectorPanel"
    )
}

fn is_known_plugin_ui_slot(value: &str) -> bool {
    matches!(
        value,
        "settings"
            | "settingsPanel"
            | "home"
            | "homeWidget"
            | "manuscriptSidebar"
            | "videoInspectorPanel"
            | "exportPanelAddon"
            | "knowledgeImporterPanel"
            | "commandPaletteCommand"
    )
}

fn is_known_plugin_home_widget_kind(value: &str) -> bool {
    matches!(value, "metric" | "list" | "prompt" | "action")
}

fn is_known_plugin_home_source(value: &str) -> bool {
    matches!(
        value,
        "knowledge.count"
            | "knowledge.recent"
            | "knowledge.items"
            | "manuscripts.count"
            | "manuscripts.recent"
            | "manuscripts.tree"
            | "media.count"
            | "media.recent"
            | "media.assets"
            | "subjects.count"
            | "subjects.recent"
            | "subjects.list"
    )
}

fn is_known_plugin_home_action_target(value: &str) -> bool {
    matches!(
        value,
        "redclaw" | "coverStudio" | "generationStudio" | "manuscripts"
    )
}

fn normalize_plugin_home_limit(value: Option<usize>) -> usize {
    value.unwrap_or(4).clamp(1, 20)
}

fn validate_network_host(value: &str) -> Result<(), String> {
    let host = value.trim();
    if host.is_empty() {
        return Err("network host must not be empty".to_string());
    }
    if host.contains("://") || host.contains('/') || host.contains('*') {
        return Err(format!("invalid network host `{host}`"));
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
    {
        return Err(format!("invalid network host `{host}`"));
    }
    Ok(())
}

fn validate_manifest_relative_path(
    plugin_root: &Path,
    field: &str,
    raw_path: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(raw_path) = raw_path else {
        return Ok(None);
    };
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Ok(None);
    }
    let Some(relative_path) = raw_path.strip_prefix("./") else {
        return Err(format!("{field} path must start with `./`"));
    };
    if relative_path.is_empty() {
        return Err(format!("{field} path must not be `./`"));
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => return Err(format!("{field} path must not contain `..`")),
            _ => return Err(format!("{field} path must stay inside the plugin root")),
        }
    }

    Ok(Some(plugin_root.join(normalized)))
}

fn find_thrive_plugin_manifest_path(plugin_root: &Path) -> Option<PathBuf> {
    THRIVE_PLUGIN_MANIFEST_PATHS
        .iter()
        .map(|relative_path| plugin_root.join(relative_path))
        .find(|path| path.is_file())
}

fn load_thrive_plugin_manifest(plugin_root: &Path) -> Result<RawThrivePluginManifest, String> {
    let manifest_path = find_thrive_plugin_manifest_path(plugin_root)
        .ok_or_else(|| "missing .redbox-plugin/plugin.json".to_string())?;
    let content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("failed to read plugin manifest: {error}"))?;
    let mut manifest = serde_json::from_str::<RawThrivePluginManifest>(&content)
        .map_err(|error| format!("failed to parse plugin manifest: {error}"))?;
    if manifest.name.trim().is_empty() {
        manifest.name = plugin_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("plugin")
            .to_string();
    }
    validate_thrive_plugin_manifest(plugin_root, &manifest)?;
    Ok(manifest)
}

fn validate_thrive_plugin_manifest(
    plugin_root: &Path,
    manifest: &RawThrivePluginManifest,
) -> Result<(), String> {
    validate_plugin_segment(&manifest.name, "plugin name")?;
    validate_plugin_version(manifest.version.as_deref().unwrap_or("local"))?;

    for capability in &manifest.permissions.capabilities {
        if !is_known_plugin_capability(capability) {
            return Err(format!("unknown plugin capability `{capability}`"));
        }
    }
    for capability in &manifest.permissions.approval_required {
        if !is_known_plugin_capability(capability) {
            return Err(format!(
                "unknown approval-required plugin capability `{capability}`"
            ));
        }
    }
    for host in &manifest.permissions.network {
        validate_network_host(host)?;
    }
    for (slot, path) in &manifest.ui {
        if !is_known_plugin_ui_slot(slot) {
            return Err(format!("unknown plugin UI slot `{slot}`"));
        }
        validate_manifest_relative_path(plugin_root, &format!("ui.{slot}"), Some(path))?;
    }
    for (field, raw_path) in [
        ("skills", manifest.skills.as_deref()),
        ("mcpServers", manifest.mcp_servers.as_deref()),
        ("apps", manifest.apps.as_deref()),
        ("actions", manifest.actions.as_deref()),
        ("media", manifest.media.as_deref()),
    ] {
        validate_manifest_relative_path(plugin_root, field, raw_path)?;
    }
    if let Some(interface) = manifest.interface.as_ref() {
        if let Some(logo) = interface.logo.as_deref() {
            validate_manifest_relative_path(plugin_root, "interface.logo", Some(logo))?;
        }
        if let Some(default_prompt) = interface.default_prompt.as_ref() {
            validate_default_prompts(default_prompt)?;
        }
    }
    validate_plugin_home(manifest)?;
    Ok(())
}

fn validate_plugin_home(manifest: &RawThrivePluginManifest) -> Result<(), String> {
    let has_home = !manifest.home.widgets.is_empty()
        || !manifest.home.quick_actions.is_empty()
        || !manifest.home.sidebar_sections.is_empty();
    if has_home
        && !manifest
            .permissions
            .capabilities
            .iter()
            .any(|capability| capability == "ui.home")
    {
        return Err("home extensions require `ui.home` capability".to_string());
    }

    for (field, widgets) in [
        ("home.widgets", &manifest.home.widgets),
        ("home.sidebarSections", &manifest.home.sidebar_sections),
    ] {
        if widgets.len() > 12 {
            return Err(format!("{field} supports at most 12 entries"));
        }
        for widget in widgets {
            validate_plugin_segment(&widget.id, &format!("{field}.id"))?;
            let kind = widget.kind.trim();
            if !is_known_plugin_home_widget_kind(kind) {
                return Err(format!(
                    "{field}.{id} uses unknown kind `{kind}`",
                    id = widget.id
                ));
            }
            if let Some(source) = widget
                .source
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                if !is_known_plugin_home_source(source) {
                    return Err(format!(
                        "{field}.{id} uses unknown data source `{source}`",
                        id = widget.id
                    ));
                }
            }
            if normalize_plugin_home_limit(widget.limit) > 20 {
                return Err(format!("{field}.{id} limit is too large", id = widget.id));
            }
            if let Some(prompt) = widget.prompt.as_deref() {
                validate_short_plugin_text(
                    prompt,
                    &format!("{field}.{id}.prompt", id = widget.id),
                    240,
                )?;
            }
            validate_short_plugin_text(
                &widget.title,
                &format!("{field}.{id}.title", id = widget.id),
                80,
            )?;
        }
    }

    if manifest.home.quick_actions.len() > 12 {
        return Err("home.quickActions supports at most 12 entries".to_string());
    }
    for action in &manifest.home.quick_actions {
        validate_plugin_segment(&action.id, "home.quickActions.id")?;
        validate_short_plugin_text(&action.label, "home.quickActions.label", 40)?;
        if let Some(target) = action
            .target
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !is_known_plugin_home_action_target(target) {
                return Err(format!(
                    "home.quickActions.{id} uses unknown target `{target}`",
                    id = action.id
                ));
            }
        }
        if let Some(prompt) = action.prompt.as_deref() {
            validate_short_plugin_text(prompt, "home.quickActions.prompt", 240)?;
        }
    }
    Ok(())
}

fn validate_short_plugin_text(value: &str, field: &str, max_chars: usize) -> Result<(), String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if normalized.chars().count() > max_chars {
        return Err(format!("{field} must be at most {max_chars} chars"));
    }
    Ok(())
}

fn validate_default_prompts(value: &Value) -> Result<(), String> {
    let prompts = if let Some(prompt) = value.as_str() {
        vec![prompt]
    } else if let Some(items) = value.as_array() {
        if items.len() > 3 {
            return Err("interface.defaultPrompt supports at most 3 prompts".to_string());
        }
        items
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| "interface.defaultPrompt entries must be strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        return Err("interface.defaultPrompt must be a string or string array".to_string());
    };
    for prompt in prompts {
        let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.is_empty() {
            return Err("interface.defaultPrompt entries must not be empty".to_string());
        }
        if normalized.chars().count() > 128 {
            return Err("interface.defaultPrompt entries must be at most 128 chars".to_string());
        }
    }
    Ok(())
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
        store.mcp_servers.retain(|server| {
            server
                .oauth
                .as_ref()
                .and_then(|value| value.get("redbox"))
                .and_then(|value| value.get("pluginId"))
                .and_then(Value::as_str)
                .is_none()
        });
        store.skills.extend(plugin_skills.clone());
        store.mcp_servers.extend(plugin_mcp_servers.clone());
        Ok(store.mcp_servers.clone())
    })?;
    state.mcp_manager.sync_servers(&next_mcp_servers)?;

    Ok(json!({
        "success": true,
        "pluginIds": plugin_ids,
        "skills": plugin_skills.len(),
        "mcpServers": plugin_mcp_servers.len(),
    }))
}

fn copy_plugin_dir_secure(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect plugin source: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "plugin packages must not contain symlinks: {}",
                entry.path().display()
            ));
        }
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_plugin_dir_secure(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn extract_plugin_archive(source_path: &Path, temp_root: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(source_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let extract_root = temp_root.join("extracted");
    fs::create_dir_all(&extract_root).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed_name) = file.enclosed_name().map(Path::to_path_buf) else {
            return Err(format!("archive contains an unsafe path: {}", file.name()));
        };
        let output_path = extract_root.join(enclosed_name);
        if file.name().ends_with('/') {
            fs::create_dir_all(&output_path).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = fs::File::create(&output_path).map_err(|error| error.to_string())?;
        io::copy(&mut file, &mut output).map_err(|error| error.to_string())?;
    }
    resolve_plugin_source_root(&extract_root)
}

fn resolve_plugin_source_root(source_root: &Path) -> Result<PathBuf, String> {
    if find_thrive_plugin_manifest_path(source_root).is_some() {
        return Ok(source_root.to_path_buf());
    }
    let mut matches = Vec::new();
    for entry in fs::read_dir(source_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
            && find_thrive_plugin_manifest_path(&entry.path()).is_some()
        {
            matches.push(entry.path());
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("plugin source does not contain .redbox-plugin/plugin.json".to_string()),
        _ => Err("plugin archive contains multiple plugin roots".to_string()),
    }
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

fn plugin_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(THRIVE_PLUGIN_HTTP_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())
}

fn is_safe_marketplace_url(url: &str) -> bool {
    url.starts_with("https://raw.githubusercontent.com/")
        || url.starts_with("https://github.com/")
        || url.starts_with("https://api.github.com/")
}

fn marketplace_registry_url(request: &ThrivePluginMarketplaceRequest) -> Result<String, String> {
    let url = request
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(THRIVE_PLUGIN_DEFAULT_REGISTRY_URL);
    if !is_safe_marketplace_url(url) {
        return Err("plugin marketplace registry must be a GitHub HTTPS URL".to_string());
    }
    Ok(url.to_string())
}

fn http_get_text(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    if !is_safe_marketplace_url(url) {
        return Err("plugin marketplace request must use a GitHub HTTPS URL".to_string());
    }
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("failed to request `{url}`: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("request `{url}` failed with HTTP {status}"));
    }
    response
        .text()
        .map_err(|error| format!("failed to read `{url}`: {error}"))
}

fn http_get_json<T: for<'de> Deserialize<'de>>(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<T, String> {
    let text = http_get_text(client, url)?;
    serde_json::from_str::<T>(&text).map_err(|error| format!("failed to parse `{url}`: {error}"))
}

fn http_download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    target_path: &Path,
) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("plugin package downloads must come from GitHub release assets".to_string());
    }
    let bytes = client
        .get(url)
        .send()
        .map_err(|error| format!("failed to download plugin package: {error}"))?
        .error_for_status()
        .map_err(|error| format!("failed to download plugin package: {error}"))?
        .bytes()
        .map_err(|error| format!("failed to read plugin package: {error}"))?;
    fs::write(target_path, bytes).map_err(|error| error.to_string())
}

fn normalize_github_repo(repo: &str) -> Result<String, String> {
    let repo = repo
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let parts = repo.split('/').collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err("plugin repo must use `owner/name`".to_string());
    }
    for part in &parts {
        if part.is_empty()
            || !part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            return Err(format!("invalid GitHub repo segment `{part}`"));
        }
    }
    Ok(format!("{}/{}", parts[0], parts[1]))
}

fn raw_plugin_manifest_url(repo: &str, branch: &str, manifest_path: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/{branch}/{manifest_path}")
}

fn load_marketplace_manifest(
    client: &reqwest::blocking::Client,
    repo: &str,
    fallback_name: &str,
) -> Result<(RawThrivePluginManifest, String), String> {
    let repo = normalize_github_repo(repo)?;
    let mut last_error = String::new();
    for branch in ["main", "master"] {
        for manifest_path in THRIVE_PLUGIN_MANIFEST_PATHS {
            let url = raw_plugin_manifest_url(&repo, branch, manifest_path);
            match http_get_text(client, &url) {
                Ok(text) => {
                    let mut manifest = serde_json::from_str::<RawThrivePluginManifest>(&text)
                        .map_err(|error| {
                            format!("failed to parse plugin manifest from `{url}`: {error}")
                        })?;
                    if manifest.name.trim().is_empty() {
                        manifest.name = fallback_name.to_string();
                    }
                    validate_thrive_plugin_manifest(Path::new("."), &manifest)?;
                    return Ok((manifest, url));
                }
                Err(error) => {
                    last_error = error;
                }
            }
        }
    }
    Err(if last_error.is_empty() {
        "plugin repo does not contain a supported manifest".to_string()
    } else {
        last_error
    })
}

fn release_asset_score(asset_name: &str) -> Option<u8> {
    let lower = asset_name.to_ascii_lowercase();
    if lower.ends_with(".thriveplugin") {
        Some(0)
    } else if lower.ends_with(".rbxplugin") {
        Some(1)
    } else if lower.ends_with(".zip") {
        Some(2)
    } else {
        None
    }
}

fn github_release_urls(repo: &str, version: Option<&str>) -> Vec<String> {
    let repo = repo.trim();
    let mut urls = Vec::new();
    if let Some(version) = version.map(str::trim).filter(|value| !value.is_empty()) {
        urls.push(format!(
            "https://api.github.com/repos/{repo}/releases/tags/{version}"
        ));
        let prefixed = if version.starts_with('v') {
            version.to_string()
        } else {
            format!("v{version}")
        };
        if prefixed != version {
            urls.push(format!(
                "https://api.github.com/repos/{repo}/releases/tags/{prefixed}"
            ));
        }
    }
    urls.push(format!(
        "https://api.github.com/repos/{repo}/releases/latest"
    ));
    urls
}

fn find_marketplace_release_asset(
    client: &reqwest::blocking::Client,
    repo: &str,
    version: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let repo = normalize_github_repo(repo)?;
    let mut last_error = None;
    for url in github_release_urls(&repo, version) {
        match http_get_json::<GitHubReleaseResponse>(client, &url) {
            Ok(release) => {
                let mut assets = release
                    .assets
                    .into_iter()
                    .filter_map(|asset| {
                        release_asset_score(&asset.name).map(|score| (score, asset))
                    })
                    .collect::<Vec<_>>();
                assets.sort_by_key(|(score, asset)| (*score, asset.name.clone()));
                if let Some((_score, asset)) = assets.into_iter().next() {
                    return Ok(Some((asset.browser_download_url, asset.name)));
                }
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }
    if let Some(error) = last_error {
        if error.contains("HTTP 404") {
            return Ok(None);
        }
        return Err(error);
    }
    Ok(None)
}

fn list_thrive_plugin_marketplace(
    state: &State<'_, AppState>,
    request: ThrivePluginMarketplaceRequest,
) -> Result<Value, String> {
    let registry_url = marketplace_registry_url(&request)?;
    let client = plugin_http_client()?;
    let entries = http_get_json::<Vec<ThrivePluginMarketplaceEntry>>(&client, &registry_url)?;
    let index = load_thrive_plugin_index(state)?;
    let mut plugins = Vec::new();
    for entry in entries {
        let mut item = ThrivePluginMarketplaceItem {
            id: entry.id.clone(),
            name: entry.name.clone(),
            author: entry.author.clone(),
            description: entry.description.clone(),
            repo: entry.repo.clone(),
            ..ThrivePluginMarketplaceItem::default()
        };

        match normalize_github_repo(&entry.repo) {
            Ok(repo) => {
                match load_marketplace_manifest(&client, &repo, &entry.id) {
                    Ok((manifest, manifest_url)) => {
                        let plugin_id =
                            plugin_id_for_manifest(&manifest, THRIVE_PLUGIN_COMMUNITY_MARKETPLACE);
                        item.version = manifest.version.clone();
                        item.display_name = Some(display_name_for_manifest(&manifest));
                        item.capabilities = manifest.permissions.capabilities.clone();
                        item.manifest_url = Some(manifest_url);
                        item.installed = index.plugins.contains_key(&plugin_id);
                        item.installed_plugin_id = Some(plugin_id);
                        match find_marketplace_release_asset(
                            &client,
                            &repo,
                            manifest.version.as_deref(),
                        ) {
                            Ok(Some((package_url, asset_name))) => {
                                item.package_url = Some(package_url);
                                item.package_asset_name = Some(asset_name);
                            }
                            Ok(None) => {}
                            Err(error) => {
                                item.error = Some(error);
                            }
                        }
                    }
                    Err(error) => {
                        item.installed = index.plugins.contains_key(&format!(
                            "{}@{}",
                            entry.id, THRIVE_PLUGIN_COMMUNITY_MARKETPLACE
                        ));
                        item.error = Some(error);
                    }
                }
                plugins.push(item);
            }
            Err(error) => {
                item.error = Some(error);
                plugins.push(item);
            }
        }
    }

    Ok(json!({
        "success": true,
        "registryUrl": registry_url,
        "plugins": plugins,
    }))
}

fn install_thrive_plugin_from_marketplace(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: ThrivePluginInstallMarketplaceRequest,
) -> Result<Value, String> {
    let repo = normalize_github_repo(&request.repo)?;
    let client = plugin_http_client()?;
    let fallback_name = request.id.as_deref().unwrap_or("plugin");
    let version = request
        .version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let package_url = if let Some(package_url) = request
        .package_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        package_url.to_string()
    } else {
        let (manifest, _manifest_url) = load_marketplace_manifest(&client, &repo, fallback_name)?;
        let resolved_version = version.or(manifest.version.as_deref());
        find_marketplace_release_asset(&client, &repo, resolved_version)?
            .map(|(package_url, _asset_name)| package_url)
            .ok_or_else(|| {
                format!(
                    "plugin repo `{repo}` does not have a supported release asset (.thriveplugin, .rbxplugin, .zip)"
                )
            })?
    };

    let temp_root = thrive_plugins_root(state)?
        .join(".tmp")
        .join(format!("marketplace-{}", now_ms()));
    remove_path_if_exists(&temp_root)?;
    fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
    let package_path = temp_root.join("plugin-package.zip");
    let install_result = (|| -> Result<Value, String> {
        http_download_file(&client, &package_url, &package_path)?;
        install_thrive_plugin_from_path_for_marketplace(
            app,
            state,
            &package_path,
            THRIVE_PLUGIN_COMMUNITY_MARKETPLACE,
        )
    })();
    let _ = remove_path_if_exists(&temp_root);
    install_result
}

fn enabled_thrive_plugin_manifest_by_id(
    state: &State<'_, AppState>,
    plugin_id: &str,
) -> Result<(ThrivePluginIndexEntry, RawThrivePluginManifest), String> {
    validate_plugin_id(plugin_id)?;
    let index = load_thrive_plugin_index(state)?;
    let entry = index
        .plugins
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| format!("plugin `{plugin_id}` is not installed"))?;
    if !entry.enabled {
        return Err(format!("plugin `{plugin_id}` is disabled"));
    }
    let manifest = load_thrive_plugin_manifest(&PathBuf::from(&entry.root))?;
    Ok((entry, manifest))
}

fn plugin_has_capability(manifest: &RawThrivePluginManifest, capability: &str) -> bool {
    manifest
        .permissions
        .capabilities
        .iter()
        .any(|item| item == capability)
}

fn require_plugin_capability(
    manifest: &RawThrivePluginManifest,
    capability: &str,
) -> Result<(), String> {
    if plugin_has_capability(manifest, capability) {
        Ok(())
    } else {
        Err(format!(
            "plugin `{}` requires `{capability}` capability",
            manifest.name
        ))
    }
}

fn require_plugin_data_source_capability(
    manifest: &RawThrivePluginManifest,
    source: &str,
) -> Result<(), String> {
    match source {
        source if source.starts_with("knowledge.") => {
            require_plugin_capability(manifest, "knowledge.read")
        }
        source if source.starts_with("manuscripts.") => {
            require_plugin_capability(manifest, "manuscripts.read")
        }
        source if source.starts_with("media.") => require_plugin_capability(manifest, "media.read"),
        source if source.starts_with("subjects.") => {
            if plugin_has_capability(manifest, "subjects.read")
                || plugin_has_capability(manifest, "assets.read")
            {
                Ok(())
            } else {
                Err(format!(
                    "plugin `{}` requires `subjects.read` or `assets.read` capability",
                    manifest.name
                ))
            }
        }
        _ => Err(format!("unknown plugin data source `{source}`")),
    }
}

fn manuscripts_root_for_plugins(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join("manuscripts");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn manuscript_tree_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let root = manuscripts_root_for_plugins(state)?;
    serde_json::to_value(list_tree(&root, &root)?).map_err(|error| error.to_string())
}

fn count_manuscript_file_values(value: &Value) -> usize {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let is_directory = item
                        .get("isDirectory")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if is_directory {
                        count_manuscript_file_values(item.get("children").unwrap_or(&Value::Null))
                    } else {
                        1
                    }
                })
                .sum()
        })
        .unwrap_or_default()
}

fn collect_manuscript_file_values(value: &Value, out: &mut Vec<Value>) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        let is_directory = item
            .get("isDirectory")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_directory {
            collect_manuscript_file_values(item.get("children").unwrap_or(&Value::Null), out);
        } else {
            out.push(item.clone());
        }
    }
}

fn sort_json_items_by_updated_at(items: &mut [Value]) {
    items.sort_by(|left, right| {
        let left_at = left
            .get("updatedAt")
            .or_else(|| left.get("createdAt"))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or_default();
        let right_at = right
            .get("updatedAt")
            .or_else(|| right.get("createdAt"))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or_default();
        right_at.cmp(&left_at)
    });
}

fn plugin_data_source_value(
    state: &State<'_, AppState>,
    manifest: &RawThrivePluginManifest,
    source: &str,
    limit: usize,
    kind: Option<&str>,
    query: Option<&str>,
) -> Result<Value, String> {
    if !is_known_plugin_home_source(source) {
        return Err(format!("unknown plugin data source `{source}`"));
    }
    require_plugin_data_source_capability(manifest, source)?;

    match source {
        "knowledge.count" => {
            let page =
                crate::knowledge_index::catalog::list_page(state, None, 1, kind, query, None)?;
            Ok(
                json!({ "success": true, "source": source, "total": page.total, "kindCounts": page.kind_counts }),
            )
        }
        "knowledge.recent" | "knowledge.items" => {
            let page = crate::knowledge_index::catalog::list_page(
                state,
                None,
                limit,
                kind,
                query,
                Some("updated"),
            )?;
            serde_json::to_value(page).map_err(|error| error.to_string())
        }
        "manuscripts.tree" => Ok(json!({
            "success": true,
            "source": source,
            "items": manuscript_tree_value(state)?,
        })),
        "manuscripts.count" => {
            let tree = manuscript_tree_value(state)?;
            Ok(json!({
                "success": true,
                "source": source,
                "total": count_manuscript_file_values(&tree),
            }))
        }
        "manuscripts.recent" => {
            let tree = manuscript_tree_value(state)?;
            let mut items = Vec::new();
            collect_manuscript_file_values(&tree, &mut items);
            sort_json_items_by_updated_at(&mut items);
            items.truncate(limit);
            Ok(json!({ "success": true, "source": source, "items": items }))
        }
        "media.count" => with_store(state, |store| {
            Ok(json!({
                "success": true,
                "source": source,
                "total": store.media_assets.len(),
            }))
        }),
        "media.recent" | "media.assets" => with_store(state, |store| {
            let mut assets = store.media_assets.clone();
            assets.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            assets.truncate(limit);
            Ok(json!({ "success": true, "source": source, "assets": assets }))
        }),
        "subjects.count" => with_store(state, |store| {
            Ok(json!({
                "success": true,
                "source": source,
                "total": store.subjects.len(),
            }))
        }),
        "subjects.recent" | "subjects.list" => with_store(state, |store| {
            let mut subjects = store.subjects.clone();
            subjects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            subjects.truncate(limit);
            Ok(json!({ "success": true, "source": source, "subjects": subjects }))
        }),
        _ => Err(format!("unsupported plugin data source `{source}`")),
    }
}

fn read_thrive_plugin_data(
    state: &State<'_, AppState>,
    request: ThrivePluginReadDataRequest,
) -> Result<Value, String> {
    let (_entry, manifest) = enabled_thrive_plugin_manifest_by_id(state, &request.plugin_id)?;
    let source = request.source.trim();
    let limit = normalize_plugin_home_limit(request.limit);
    let data = plugin_data_source_value(
        state,
        &manifest,
        source,
        limit,
        request.kind.as_deref(),
        request.query.as_deref(),
    )?;
    Ok(json!({
        "success": true,
        "pluginId": request.plugin_id,
        "source": source,
        "data": data,
    }))
}

fn plugin_home_widget_value(
    state: &State<'_, AppState>,
    plugin_id: &str,
    manifest: &RawThrivePluginManifest,
    widget: &RawThrivePluginHomeWidget,
    zone: &str,
) -> Value {
    let source = widget
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let data = source.map(|source| {
        plugin_data_source_value(
            state,
            manifest,
            source,
            normalize_plugin_home_limit(widget.limit),
            None,
            None,
        )
        .unwrap_or_else(|error| json!({ "success": false, "error": error }))
    });
    json!({
        "id": format!("{plugin_id}:{}", widget.id),
        "pluginId": plugin_id,
        "pluginName": manifest.name,
        "zone": zone,
        "title": widget.title,
        "subtitle": widget.subtitle,
        "kind": widget.kind,
        "source": source,
        "label": widget.label,
        "prompt": widget.prompt,
        "icon": widget.icon,
        "tone": widget.tone,
        "order": widget.order.unwrap_or(0),
        "limit": normalize_plugin_home_limit(widget.limit),
        "data": data,
    })
}

fn plugin_home_action_value(
    plugin_id: &str,
    manifest: &RawThrivePluginManifest,
    action: &RawThrivePluginHomeAction,
) -> Value {
    json!({
        "id": format!("{plugin_id}:{}", action.id),
        "pluginId": plugin_id,
        "pluginName": manifest.name,
        "label": action.label,
        "prompt": action.prompt,
        "target": action.target,
        "mode": action.mode,
        "icon": action.icon,
        "tone": action.tone,
        "order": action.order.unwrap_or(0),
    })
}

fn list_thrive_plugin_home(state: &State<'_, AppState>) -> Result<Value, String> {
    let enabled_plugins = enabled_thrive_plugin_entries(state)?;
    let mut widgets = Vec::new();
    let mut sidebar_sections = Vec::new();
    let mut quick_actions = Vec::new();
    for (plugin_id, _entry, manifest) in enabled_plugins {
        if !plugin_has_capability(&manifest, "ui.home") {
            continue;
        }
        widgets.extend(
            manifest.home.widgets.iter().map(|widget| {
                plugin_home_widget_value(state, &plugin_id, &manifest, widget, "main")
            }),
        );
        sidebar_sections.extend(manifest.home.sidebar_sections.iter().map(|widget| {
            plugin_home_widget_value(state, &plugin_id, &manifest, widget, "sidebar")
        }));
        quick_actions.extend(
            manifest
                .home
                .quick_actions
                .iter()
                .map(|action| plugin_home_action_value(&plugin_id, &manifest, action)),
        );
    }
    widgets.sort_by_key(|item| {
        item.get("order")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    sidebar_sections.sort_by_key(|item| {
        item.get("order")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    quick_actions.sort_by_key(|item| {
        item.get("order")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    Ok(json!({
        "success": true,
        "widgets": widgets,
        "sidebarSections": sidebar_sections,
        "quickActions": quick_actions,
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
