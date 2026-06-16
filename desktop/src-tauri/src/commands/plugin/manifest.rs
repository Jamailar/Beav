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
        .ok_or_else(|| "missing .codex-plugin/plugin.json".to_string())?;
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
        let _ = validate_manifest_relative_path(plugin_root, field, raw_path);
    }
    validate_manifest_hooks(plugin_root, manifest.hooks.as_ref())?;
    if let Some(interface) = manifest.interface.as_ref() {
        if let Some(composer_icon) = interface.composer_icon.as_deref() {
            let _ = validate_manifest_relative_path(
                plugin_root,
                "interface.composerIcon",
                Some(composer_icon),
            );
        }
        if let Some(logo) = interface.logo.as_deref() {
            let _ = validate_manifest_relative_path(plugin_root, "interface.logo", Some(logo));
        }
        for screenshot in &interface.screenshots {
            let _ = validate_manifest_relative_path(
                plugin_root,
                "interface.screenshots",
                Some(screenshot),
            );
        }
        if let Some(default_prompt) = interface.default_prompt.as_ref() {
            validate_default_prompts(default_prompt)?;
        }
    }
    validate_plugin_home(manifest)?;
    Ok(())
}

fn validate_manifest_hooks(plugin_root: &Path, hooks: Option<&Value>) -> Result<(), String> {
    let Some(hooks) = hooks else {
        return Ok(());
    };
    if let Some(path) = hooks.as_str() {
        let _ = validate_manifest_relative_path(plugin_root, "hooks", Some(path));
        return Ok(());
    }
    if let Some(paths) = hooks
        .as_array()
        .and_then(|items| items.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
    {
        for path in paths {
            let _ = validate_manifest_relative_path(plugin_root, "hooks", Some(path));
        }
        return Ok(());
    }
    if hooks.is_object()
        || hooks
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_object))
    {
        return Ok(());
    }
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
        items
            .iter()
            .filter_map(Value::as_str)
            .take(3)
            .collect::<Vec<_>>()
    } else {
        return Ok(());
    };
    for prompt in prompts {
        let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.is_empty() {
            continue;
        }
        if normalized.chars().count() > 128 {
            continue;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_plugin_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-plugin-test-{name}-{nonce}"));
        fs::create_dir_all(&root).expect("create temp plugin root");
        root
    }

    #[test]
    fn loads_codex_plugin_manifest_fields_and_paths() {
        let root = temp_plugin_root("codex-manifest");
        fs::create_dir_all(root.join(".codex-plugin")).expect("create manifest dir");
        fs::create_dir_all(root.join("assets")).expect("create assets dir");
        fs::write(root.join("assets/icon.png"), "").expect("write icon");
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r##"{
  "name": "demo-plugin",
  "version": "1.2.3",
  "description": "Demo",
  "keywords": ["codex", "mcp"],
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks.json",
  "interface": {
    "displayName": "Demo Plugin",
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "brandColor": "#3B82F6",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/icon.png",
    "screenshots": ["./assets/icon.png"],
    "defaultPrompt": ["Summarize this"]
  }
}"##,
        )
        .expect("write manifest");

        let manifest = load_thrive_plugin_manifest(&root).expect("load manifest");

        assert_eq!(manifest.name, "demo-plugin");
        assert_eq!(manifest.version.as_deref(), Some("1.2.3"));
        assert_eq!(manifest.keywords, vec!["codex", "mcp"]);
        assert_eq!(manifest.mcp_servers.as_deref(), Some("./.mcp.json"));
        assert_eq!(manifest.apps.as_deref(), Some("./.app.json"));
        assert_eq!(
            manifest
                .interface
                .as_ref()
                .and_then(|interface| interface.website_url.as_deref()),
            Some("https://example.com")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_invalid_optional_codex_manifest_resources() {
        let root = temp_plugin_root("codex-invalid-optional");
        fs::create_dir_all(root.join(".codex-plugin")).expect("create manifest dir");
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{
  "name": "demo-plugin",
  "skills": "skills",
  "mcpServers": "../outside/.mcp.json",
  "apps": "/tmp/.app.json",
  "hooks": true,
  "interface": {
    "displayName": "Demo",
    "composerIcon": "assets/icon.png",
    "logo": "/tmp/logo.png",
    "screenshots": ["assets/shot1.png"],
    "defaultPrompt": ["Summarize this", {"prompt": "ignored object"}, ""]
  }
}"#,
        )
        .expect("write manifest");

        let manifest = load_thrive_plugin_manifest(&root).expect("load manifest");

        assert_eq!(manifest.name, "demo-plugin");
        assert_eq!(
            manifest
                .interface
                .as_ref()
                .and_then(|interface| interface.display_name.as_deref()),
            Some("Demo")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prefers_codex_manifest_over_legacy_manifest() {
        let root = temp_plugin_root("manifest-priority");
        fs::create_dir_all(root.join(".codex-plugin")).expect("create codex dir");
        fs::create_dir_all(root.join(".redbox-plugin")).expect("create legacy dir");
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"codex-plugin","version":"1.0.0"}"#,
        )
        .expect("write codex manifest");
        fs::write(
            root.join(".redbox-plugin/plugin.json"),
            r#"{"name":"legacy-plugin","version":"1.0.0"}"#,
        )
        .expect("write legacy manifest");

        let manifest = load_thrive_plugin_manifest(&root).expect("load manifest");

        assert_eq!(manifest.name, "codex-plugin");

        let _ = fs::remove_dir_all(root);
    }
}
