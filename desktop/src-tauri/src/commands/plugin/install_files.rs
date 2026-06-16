use super::*;

pub(super) fn copy_plugin_dir_secure(source: &Path, target: &Path) -> Result<(), String> {
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

pub(super) fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

pub(super) fn extract_plugin_archive(
    source_path: &Path,
    temp_root: &Path,
    requested_plugin: Option<&str>,
) -> Result<PathBuf, String> {
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
    resolve_plugin_source_root_for_install(&extract_root, requested_plugin)
}

pub(super) fn resolve_plugin_source_root_for_install(
    source_root: &Path,
    requested_plugin: Option<&str>,
) -> Result<PathBuf, String> {
    if find_thrive_plugin_manifest_path(source_root).is_some() {
        return Ok(source_root.to_path_buf());
    }
    let mut matches = Vec::new();
    if let Some(path) = resolve_codex_marketplace_plugin_root(source_root, requested_plugin)? {
        matches.push(path);
    }
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
        0 => Err("plugin source does not contain .codex-plugin/plugin.json".to_string()),
        _ => Err(
            "plugin source contains multiple plugin roots; pass `pluginName` to choose one"
                .to_string(),
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCodexMarketplaceManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    plugins: Vec<RawCodexMarketplacePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCodexMarketplacePlugin {
    name: String,
    source: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexLocalPluginCandidate {
    name: String,
    source_path: Option<String>,
    plugin_root: Option<String>,
    valid: bool,
    version: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    error: Option<String>,
}

pub(super) fn discover_local_codex_plugin_sources(source_root: &Path) -> Result<Value, String> {
    let source_root = source_root
        .canonicalize()
        .unwrap_or_else(|_| source_root.to_path_buf());
    let mut candidates = Vec::<CodexLocalPluginCandidate>::new();

    if find_thrive_plugin_manifest_path(&source_root).is_some() {
        candidates.push(local_plugin_candidate(
            source_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("plugin"),
            None,
            source_root.clone(),
        ));
        return Ok(json!({
            "success": true,
            "sourceRoot": source_root.display().to_string(),
            "kind": "plugin",
            "plugins": candidates,
        }));
    }

    if let Some(marketplace_path) = find_codex_marketplace_manifest_path(&source_root) {
        let raw = fs::read_to_string(&marketplace_path)
            .map_err(|error| format!("failed to read Codex marketplace manifest: {error}"))?;
        let manifest = serde_json::from_str::<RawCodexMarketplaceManifest>(&raw)
            .map_err(|error| format!("failed to parse Codex marketplace manifest: {error}"))?;
        let marketplace_root = codex_marketplace_root_dir(&marketplace_path)?;
        for plugin in manifest.plugins {
            let source_path = codex_marketplace_local_source_path(&plugin.source)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let Some(relative_source) = source_path.as_deref() else {
                candidates.push(CodexLocalPluginCandidate {
                    name: plugin.name,
                    source_path,
                    plugin_root: None,
                    valid: false,
                    version: None,
                    display_name: None,
                    description: None,
                    error: Some("plugin source is not local".to_string()),
                });
                continue;
            };
            match resolve_codex_marketplace_local_path(
                &marketplace_path,
                &marketplace_root,
                relative_source,
            ) {
                Ok(plugin_root) => {
                    candidates.push(local_plugin_candidate(
                        &plugin.name,
                        source_path,
                        plugin_root,
                    ));
                }
                Err(error) => candidates.push(CodexLocalPluginCandidate {
                    name: plugin.name,
                    source_path,
                    plugin_root: None,
                    valid: false,
                    version: None,
                    display_name: None,
                    description: None,
                    error: Some(error),
                }),
            }
        }
        return Ok(json!({
            "success": true,
            "sourceRoot": source_root.display().to_string(),
            "kind": "codex-marketplace",
            "marketplacePath": marketplace_path.display().to_string(),
            "marketplaceName": manifest.name,
            "plugins": candidates,
        }));
    }

    for entry in fs::read_dir(&source_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
            && find_thrive_plugin_manifest_path(&entry.path()).is_some()
        {
            candidates.push(local_plugin_candidate(
                entry
                    .file_name()
                    .to_str()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("plugin"),
                None,
                entry.path(),
            ));
        }
    }

    Ok(json!({
        "success": true,
        "sourceRoot": source_root.display().to_string(),
        "kind": "directory",
        "plugins": candidates,
    }))
}

fn local_plugin_candidate(
    fallback_name: &str,
    source_path: Option<String>,
    plugin_root: PathBuf,
) -> CodexLocalPluginCandidate {
    match load_thrive_plugin_manifest(&plugin_root) {
        Ok(manifest) => CodexLocalPluginCandidate {
            name: manifest.name.clone(),
            source_path,
            plugin_root: Some(plugin_root.display().to_string()),
            valid: true,
            version: manifest.version.clone(),
            display_name: Some(display_name_for_manifest(&manifest)),
            description: manifest.description.clone(),
            error: None,
        },
        Err(error) => CodexLocalPluginCandidate {
            name: fallback_name.to_string(),
            source_path,
            plugin_root: Some(plugin_root.display().to_string()),
            valid: false,
            version: None,
            display_name: None,
            description: None,
            error: Some(error),
        },
    }
}

fn resolve_codex_marketplace_plugin_root(
    source_root: &Path,
    requested_plugin: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(marketplace_path) = find_codex_marketplace_manifest_path(source_root) else {
        return Ok(None);
    };
    let raw = fs::read_to_string(&marketplace_path)
        .map_err(|error| format!("failed to read Codex marketplace manifest: {error}"))?;
    let manifest = serde_json::from_str::<RawCodexMarketplaceManifest>(&raw)
        .map_err(|error| format!("failed to parse Codex marketplace manifest: {error}"))?;
    let marketplace_root = codex_marketplace_root_dir(&marketplace_path)?;
    let requested_plugin = requested_plugin.map(|value| {
        value
            .rsplit_once('@')
            .map(|(name, _)| name)
            .unwrap_or(value)
            .trim()
            .to_string()
    });
    let mut matches = Vec::<PathBuf>::new();
    for plugin in manifest.plugins {
        if let Some(requested) = requested_plugin.as_deref() {
            if plugin.name != requested {
                continue;
            }
        }
        let Some(relative_source) = codex_marketplace_local_source_path(&plugin.source) else {
            continue;
        };
        let plugin_root = resolve_codex_marketplace_local_path(
            &marketplace_path,
            &marketplace_root,
            relative_source,
        )?;
        if find_thrive_plugin_manifest_path(&plugin_root).is_none() {
            return Err(format!(
                "Codex marketplace plugin `{}` does not contain .codex-plugin/plugin.json at {}",
                plugin.name,
                plugin_root.display()
            ));
        }
        matches.push(plugin_root);
    }
    if matches.is_empty() {
        if let Some(requested) = requested_plugin {
            return Err(format!(
                "Codex marketplace `{}` does not contain a local plugin named `{requested}`",
                if manifest.name.trim().is_empty() {
                    marketplace_path.display().to_string()
                } else {
                    manifest.name
                }
            ));
        }
        return Ok(None);
    }
    if matches.len() > 1 {
        return Err(
            "Codex marketplace contains multiple local plugins; pass `pluginName` to choose one"
                .to_string(),
        );
    }
    Ok(matches.pop())
}

fn find_codex_marketplace_manifest_path(source_root: &Path) -> Option<PathBuf> {
    CODEX_PLUGIN_MARKETPLACE_PATHS
        .iter()
        .map(|relative_path| source_root.join(relative_path))
        .find(|path| path.is_file())
}

fn codex_marketplace_root_dir(marketplace_path: &Path) -> Result<PathBuf, String> {
    for relative_path in CODEX_PLUGIN_MARKETPLACE_PATHS {
        let mut current = marketplace_path;
        let mut valid = true;
        for component in Path::new(relative_path).components().rev() {
            let expected = match component {
                Component::Normal(expected) => expected,
                _ => {
                    valid = false;
                    break;
                }
            };
            if current.file_name() != Some(expected) {
                valid = false;
                break;
            }
            let Some(parent) = current.parent() else {
                valid = false;
                break;
            };
            current = parent;
        }
        if valid {
            return Ok(current.to_path_buf());
        }
    }
    Err("Codex marketplace file is not in a supported location".to_string())
}

fn codex_marketplace_local_source_path(source: &Value) -> Option<&str> {
    if let Some(path) = source.as_str() {
        return Some(path);
    }
    let object = source.as_object()?;
    let source_kind = object
        .get("source")
        .or_else(|| object.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("local");
    if source_kind != "local" {
        return None;
    }
    object.get("path").and_then(Value::as_str)
}

fn resolve_codex_marketplace_local_path(
    marketplace_path: &Path,
    marketplace_root: &Path,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let Some(relative_path) = raw_path.trim().strip_prefix("./") else {
        return Err(format!(
            "local plugin source path in `{}` must start with `./`",
            marketplace_path.display()
        ));
    };
    if relative_path.is_empty() {
        return Err("local plugin source path must not be empty".to_string());
    }
    let relative_source_path = Path::new(relative_path);
    if relative_source_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("local plugin source path must stay within the marketplace root".to_string());
    }
    Ok(marketplace_root.join(relative_source_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-plugin-source-test-{name}-{nonce}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn write_plugin(root: &Path, name: &str) {
        fs::create_dir_all(root.join(".codex-plugin")).expect("create manifest dir");
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            format!(r#"{{"name":"{name}","version":"1.0.0"}}"#),
        )
        .expect("write plugin manifest");
    }

    #[test]
    fn resolves_single_codex_marketplace_plugin_root() {
        let root = temp_root("single-marketplace");
        fs::create_dir_all(root.join(".agents/plugins")).expect("create marketplace dir");
        let plugin_root = root.join("plugins/demo");
        write_plugin(&plugin_root, "demo");
        fs::write(
            root.join(".agents/plugins/marketplace.json"),
            r#"{
  "name": "personal",
  "plugins": [
    {"name": "demo", "source": {"source": "local", "path": "./plugins/demo"}}
  ]
}"#,
        )
        .expect("write marketplace");

        let resolved = resolve_plugin_source_root_for_install(&root, None).expect("resolve root");

        assert_eq!(resolved, plugin_root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_named_codex_marketplace_plugin_root() {
        let root = temp_root("multi-marketplace");
        fs::create_dir_all(root.join(".agents/plugins")).expect("create marketplace dir");
        let alpha_root = root.join("plugins/alpha");
        let beta_root = root.join("plugins/beta");
        write_plugin(&alpha_root, "alpha");
        write_plugin(&beta_root, "beta");
        fs::write(
            root.join(".agents/plugins/marketplace.json"),
            r#"{
  "name": "personal",
  "plugins": [
    {"name": "alpha", "source": "./plugins/alpha"},
    {"name": "beta", "source": {"source": "local", "path": "./plugins/beta"}}
  ]
}"#,
        )
        .expect("write marketplace");

        let resolved =
            resolve_plugin_source_root_for_install(&root, Some("beta")).expect("resolve root");

        assert_eq!(resolved, beta_root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_local_codex_marketplace_plugins() {
        let root = temp_root("discover-marketplace");
        fs::create_dir_all(root.join(".agents/plugins")).expect("create marketplace dir");
        write_plugin(&root.join("plugins/alpha"), "alpha");
        write_plugin(&root.join("plugins/beta"), "beta");
        fs::write(
            root.join(".agents/plugins/marketplace.json"),
            r#"{
  "name": "local-codex",
  "plugins": [
    {"name": "alpha", "source": "./plugins/alpha"},
    {"name": "beta", "source": {"source": "local", "path": "./plugins/beta"}}
  ]
}"#,
        )
        .expect("write marketplace");

        let result = discover_local_codex_plugin_sources(&root).expect("discover marketplace");

        assert_eq!(
            result.get("kind").and_then(Value::as_str),
            Some("codex-marketplace")
        );
        let plugins = result
            .get("plugins")
            .and_then(Value::as_array)
            .expect("plugins");
        assert_eq!(plugins.len(), 2);
        assert_eq!(
            plugins[0].get("name").and_then(Value::as_str),
            Some("alpha")
        );
        assert_eq!(plugins[0].get("valid").and_then(Value::as_bool), Some(true));
        assert_eq!(plugins[1].get("name").and_then(Value::as_str), Some("beta"));
        assert_eq!(plugins[1].get("valid").and_then(Value::as_bool), Some(true));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_ambiguous_codex_marketplace_plugin_root() {
        let root = temp_root("ambiguous-marketplace");
        fs::create_dir_all(root.join(".agents/plugins")).expect("create marketplace dir");
        write_plugin(&root.join("plugins/alpha"), "alpha");
        write_plugin(&root.join("plugins/beta"), "beta");
        fs::write(
            root.join(".agents/plugins/marketplace.json"),
            r#"{
  "name": "personal",
  "plugins": [
    {"name": "alpha", "source": "./plugins/alpha"},
    {"name": "beta", "source": "./plugins/beta"}
  ]
}"#,
        )
        .expect("write marketplace");

        let error = resolve_plugin_source_root_for_install(&root, None)
            .expect_err("ambiguous marketplace should fail");

        assert!(error.contains("multiple local plugins"));
        let _ = fs::remove_dir_all(root);
    }
}
