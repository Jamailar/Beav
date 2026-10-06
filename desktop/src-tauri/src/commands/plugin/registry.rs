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
    app_connector_ids: Vec<String>,
    app_connectors: Vec<CodexPluginAppDeclaration>,
    mcp_servers_path: Option<String>,
    skills_path: Option<String>,
    apps_path: Option<String>,
    hooks_path: Option<String>,
    actions_path: Option<String>,
    media_path: Option<String>,
    home_widgets: usize,
    home_quick_actions: usize,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexConnectorAppInfo {
    id: String,
    name: String,
    description: Option<String>,
    logo_url: Option<String>,
    logo_url_dark: Option<String>,
    distribution_channel: Option<String>,
    branding: Option<Value>,
    app_metadata: Option<Value>,
    labels: Option<Value>,
    install_url: Option<String>,
    is_accessible: bool,
    is_enabled: bool,
    plugin_display_names: Vec<String>,
    category: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPluginAppFile {
    #[serde(default)]
    apps: BTreeMap<String, CodexPluginAppConfig>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CodexPluginAppDeclaration {
    name: String,
    id: String,
    category: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CodexPluginAppConfig {
    id: String,
    category: Option<String>,
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

fn plugin_app_config_path(root: &Path, manifest: &RawThrivePluginManifest) -> Option<PathBuf> {
    validate_manifest_relative_path(root, "apps", manifest.apps.as_deref())
        .ok()
        .flatten()
        .or_else(|| {
            let default_path = root.join(".app.json");
            default_path.is_file().then_some(default_path)
        })
}

fn plugin_app_declarations(
    root: &Path,
    manifest: &RawThrivePluginManifest,
) -> Vec<CodexPluginAppDeclaration> {
    let Some(path) = plugin_app_config_path(root, manifest) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<CodexPluginAppFile>(&raw) else {
        return Vec::new();
    };
    let mut apps = parsed
        .apps
        .into_iter()
        .filter_map(|(name, app)| {
            let name = name.trim().to_string();
            let id = app.id.trim().to_string();
            (!name.is_empty() && !id.is_empty()).then_some(CodexPluginAppDeclaration {
                name,
                id,
                category: app
                    .category
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
        })
        .collect::<Vec<_>>();
    apps.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    apps.dedup_by(|left, right| left.name == right.name && left.id == right.id);
    apps
}

fn plugin_app_connector_ids(apps: &[CodexPluginAppDeclaration]) -> Vec<String> {
    let mut ids = apps.iter().map(|app| app.id.clone()).collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn connector_install_url(name: &str, connector_id: &str) -> String {
    let slug = connector_name_slug(name);
    format!("https://chatgpt.com/apps/{slug}/{connector_id}")
}

fn connector_name_slug(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push('-');
        }
    }
    let normalized = normalized.trim_matches('-');
    if normalized.is_empty() {
        "app".to_string()
    } else {
        normalized.to_string()
    }
}

pub(super) fn list_thrive_plugin_connector_apps(
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let index = load_thrive_plugin_index(state)?;
    let mut connectors = BTreeMap::<String, CodexConnectorAppInfo>::new();
    for (_plugin_id, entry) in index.plugins {
        if !entry.enabled {
            continue;
        }
        let root = PathBuf::from(&entry.root);
        let manifest = match load_thrive_plugin_manifest(&root) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };
        let display_name = display_name_for_manifest(&manifest);
        for app in plugin_app_declarations(&root, &manifest) {
            let entry = connectors
                .entry(app.id.clone())
                .or_insert_with(|| CodexConnectorAppInfo {
                    id: app.id.clone(),
                    name: app.name.clone(),
                    description: None,
                    logo_url: None,
                    logo_url_dark: None,
                    distribution_channel: None,
                    branding: None,
                    app_metadata: None,
                    labels: app
                        .category
                        .as_ref()
                        .map(|category| json!({ "category": category })),
                    install_url: Some(connector_install_url(&app.name, &app.id)),
                    is_accessible: false,
                    is_enabled: true,
                    plugin_display_names: Vec::new(),
                    category: app.category.clone(),
                });
            if !entry.plugin_display_names.contains(&display_name) {
                entry.plugin_display_names.push(display_name.clone());
                entry.plugin_display_names.sort();
            }
            if entry.category.is_none() {
                entry.category = app.category.clone();
            }
            if entry.app_metadata.is_none() {
                entry.app_metadata = Some(json!({
                    "source": "plugin",
                    "appConnectorId": app.id,
                }));
            }
        }
    }
    Ok(json!({
        "success": true,
        "connectors": connectors.into_values().collect::<Vec<_>>(),
    }))
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
        let app_connectors = plugin_app_declarations(&root, &manifest);
        let app_connector_ids = plugin_app_connector_ids(&app_connectors);
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
            app_connector_ids,
            app_connectors,
            mcp_servers_path: paths(manifest.mcp_servers.as_deref()),
            skills_path: paths(manifest.skills.as_deref()),
            apps_path: plugin_app_config_path(&root, &manifest)
                .map(|path| path.display().to_string()),
            hooks_path: manifest
                .hooks
                .as_ref()
                .and_then(Value::as_str)
                .and_then(|path| paths(Some(path)))
                .or_else(|| {
                    let default_path = root.join("hooks").join("hooks.json");
                    default_path
                        .is_file()
                        .then(|| default_path.display().to_string())
                }),
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
            app_connector_ids: Vec::new(),
            app_connectors: Vec::new(),
            mcp_servers_path: None,
            skills_path: None,
            apps_path: None,
            hooks_path: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_with_apps(path: Option<&str>) -> RawThrivePluginManifest {
        RawThrivePluginManifest {
            name: "demo-plugin".to_string(),
            version: Some("1.0.0".to_string()),
            description: None,
            keywords: Vec::new(),
            min_app_version: None,
            platforms: Vec::new(),
            skills: None,
            mcp_servers: None,
            apps: path.map(ToString::to_string),
            hooks: None,
            actions: None,
            media: None,
            ui: BTreeMap::new(),
            permissions: RawThrivePluginPermissions::default(),
            interface: None,
            home: RawThrivePluginHome::default(),
        }
    }

    #[test]
    fn reads_codex_app_connector_declarations() {
        let root =
            std::env::temp_dir().join(format!("redbox-plugin-app-test-{}", crate::now_i64()));
        fs::create_dir_all(&root).expect("create root");
        fs::write(
            root.join(".app.json"),
            r#"{
  "apps": {
    "calendar": { "id": "connector_calendar", "category": "productivity" },
    "drive": { "id": "connector_drive" }
  }
}"#,
        )
        .expect("write app config");

        let apps = plugin_app_declarations(&root, &manifest_with_apps(None));

        assert_eq!(
            apps,
            vec![
                CodexPluginAppDeclaration {
                    name: "calendar".to_string(),
                    id: "connector_calendar".to_string(),
                    category: Some("productivity".to_string()),
                },
                CodexPluginAppDeclaration {
                    name: "drive".to_string(),
                    id: "connector_drive".to_string(),
                    category: None,
                },
            ]
        );
        assert_eq!(
            plugin_app_connector_ids(&apps),
            vec![
                "connector_calendar".to_string(),
                "connector_drive".to_string()
            ]
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn builds_codex_connector_app_infos_from_plugin_apps() {
        let root =
            std::env::temp_dir().join(format!("redbox-plugin-connector-test-{}", crate::now_i64()));
        fs::create_dir_all(&root).expect("create root");
        let apps = vec![CodexPluginAppDeclaration {
            name: "Google Calendar".to_string(),
            id: "connector_calendar".to_string(),
            category: Some("productivity".to_string()),
        }];

        assert_eq!(
            connector_install_url(&apps[0].name, &apps[0].id),
            "https://chatgpt.com/apps/google-calendar/connector_calendar"
        );

        let _ = fs::remove_dir_all(root);
    }
}
