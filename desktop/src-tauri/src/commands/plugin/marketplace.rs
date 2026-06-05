use super::*;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginMarketplaceRequest {
    #[serde(default)]
    pub(super) url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginInstallMarketplaceRequest {
    #[serde(default)]
    pub(super) id: Option<String>,
    pub(super) repo: String,
    #[serde(default)]
    pub(super) version: Option<String>,
    #[serde(default)]
    pub(super) package_url: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubReleaseResponse {
    assets: Vec<GitHubReleaseAsset>,
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

fn github_repo_archive_url(repo: &str, branch: &str) -> String {
    format!("https://github.com/{repo}/archive/refs/heads/{branch}.zip")
}

fn load_marketplace_manifest(
    client: &reqwest::blocking::Client,
    repo: &str,
    fallback_name: &str,
) -> Result<(RawThrivePluginManifest, String, String), String> {
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
                    return Ok((manifest, url, branch.to_string()));
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

pub(super) fn list_thrive_plugin_marketplace(
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
                    Ok((manifest, manifest_url, branch)) => {
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
                            Ok(None) => {
                                item.package_url = Some(github_repo_archive_url(&repo, &branch));
                                item.package_asset_name = Some(format!("{branch} source archive"));
                            }
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

pub(super) fn install_thrive_plugin_from_marketplace(
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
        let (manifest, _manifest_url, branch) =
            load_marketplace_manifest(&client, &repo, fallback_name)?;
        let resolved_version = version.or(manifest.version.as_deref());
        find_marketplace_release_asset(&client, &repo, resolved_version)?
            .map(|(package_url, _asset_name)| package_url)
            .unwrap_or_else(|| github_repo_archive_url(&repo, &branch))
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
