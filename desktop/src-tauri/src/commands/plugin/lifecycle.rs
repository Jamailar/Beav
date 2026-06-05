use super::*;

pub(super) fn install_thrive_plugin_from_path(
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

pub(super) fn install_thrive_plugin_from_path_for_marketplace(
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

pub(super) fn set_thrive_plugin_enabled(
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

pub(super) fn uninstall_thrive_plugin(
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

pub(super) fn open_thrive_plugin_data_dir(
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
