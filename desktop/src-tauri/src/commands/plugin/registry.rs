use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginIndex {
    pub(super) schema_version: u32,
    #[serde(default)]
    pub(super) plugins: BTreeMap<String, ThrivePluginIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginIndexEntry {
    pub(super) enabled: bool,
    pub(super) active_version: String,
    pub(super) marketplace: String,
    pub(super) installed_at: String,
    pub(super) updated_at: String,
    pub(super) root: String,
    #[serde(default)]
    pub(super) granted_capabilities: Vec<String>,
    #[serde(default)]
    pub(super) approval_required: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginSummary {
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

pub(super) fn thrive_plugins_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = store_root(state)?.join("thrive-plugins");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(super) fn thrive_plugin_cache_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = thrive_plugins_root(state)?.join("cache");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(super) fn thrive_plugin_data_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = thrive_plugins_root(state)?.join("data");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn thrive_plugin_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(thrive_plugins_root(state)?.join(THRIVE_PLUGIN_INDEX_FILE))
}

pub(super) fn load_thrive_plugin_index(
    state: &State<'_, AppState>,
) -> Result<ThrivePluginIndex, String> {
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

pub(super) fn write_thrive_plugin_index(
    state: &State<'_, AppState>,
    index: &ThrivePluginIndex,
) -> Result<(), String> {
    let path = thrive_plugin_index_path(state)?;
    write_json_value(&path, &json!(index))
}

pub(super) fn plugin_id_for_manifest(
    manifest: &RawThrivePluginManifest,
    marketplace: &str,
) -> String {
    format!("{}@{}", manifest.name, marketplace)
}

pub(super) fn thrive_plugin_source_scope(plugin_id: &str) -> String {
    format!("thrive-plugin:{plugin_id}")
}

pub(super) fn display_name_for_manifest(manifest: &RawThrivePluginManifest) -> String {
    manifest
        .interface
        .as_ref()
        .and_then(|interface| interface.display_name.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&manifest.name)
        .to_string()
}

pub(super) fn plugin_data_dir_for_id(
    state: &State<'_, AppState>,
    plugin_id: &str,
) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let dir = thrive_plugin_data_root(state)?.join(plugin_id.replace('@', "__"));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub(super) fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    let Some((name, marketplace)) = plugin_id.rsplit_once('@') else {
        return Err("plugin id must use `<name>@<marketplace>`".to_string());
    };
    validate_plugin_segment(name, "plugin name")?;
    validate_plugin_segment(marketplace, "plugin marketplace")?;
    Ok(())
}

pub(super) fn thrive_plugin_summary(
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

pub(super) fn list_thrive_plugins(state: &State<'_, AppState>) -> Result<Value, String> {
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
