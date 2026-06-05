use super::*;

fn normalize_plugin_skill_name(plugin_name: &str, skill_name: &str) -> String {
    let prefix = format!("{plugin_name}:");
    if skill_name.starts_with(&prefix) {
        skill_name.to_string()
    } else {
        format!("{prefix}{skill_name}")
    }
}

pub(super) fn enabled_thrive_plugin_entries(
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
