use super::*;

pub(super) fn validate_manifest_relative_path(
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

pub(super) fn find_thrive_plugin_manifest_path(plugin_root: &Path) -> Option<PathBuf> {
    THRIVE_PLUGIN_MANIFEST_PATHS
        .iter()
        .map(|relative_path| plugin_root.join(relative_path))
        .find(|path| path.is_file())
}

pub(super) fn load_thrive_plugin_manifest(
    plugin_root: &Path,
) -> Result<RawThrivePluginManifest, String> {
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

pub(super) fn validate_thrive_plugin_manifest(
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
