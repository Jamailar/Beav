use super::*;
use base64::Engine;
use flate2::read::GzDecoder;
use std::io::Read;
use tar::Archive;
use url::Url;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThrivePluginMarketplaceRequest {
    #[serde(default)]
    pub(super) url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexPluginMarketplaceRequest {
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) codex_root: Option<String>,
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
pub(super) struct CodexRemotePluginInstallRequest {
    #[serde(default)]
    pub(super) remote_plugin_id: Option<String>,
    #[serde(default)]
    pub(super) remote_marketplace_name: Option<String>,
    #[serde(default)]
    pub(super) plugin_name: Option<String>,
    #[serde(default)]
    pub(super) codex_root: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexPluginMarketplaceItem {
    id: String,
    name: String,
    remote_plugin_id: Option<String>,
    version: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    short_description: Option<String>,
    category: Option<String>,
    logo_url: Option<String>,
    keywords: Vec<String>,
    capabilities: Vec<String>,
    app_connector_ids: Vec<String>,
    source_root: Option<String>,
    source_label: String,
    remote: bool,
    installable: bool,
    installed: bool,
    installed_plugin_id: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CodexRemotePluginCatalog {
    schema_version: u8,
    plugins: Vec<CodexRemotePlugin>,
}

#[derive(Debug, Clone, Deserialize)]
struct CodexRemotePlugin {
    id: String,
    name: String,
    #[serde(default)]
    installation_policy: Option<String>,
    #[serde(default)]
    status: Option<String>,
    release: CodexRemotePluginRelease,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexRemotePluginRelease {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    app_ids: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    interface: Option<CodexRemotePluginInterface>,
    #[serde(default)]
    bundle_download_url: Option<String>,
    #[serde(default)]
    app_manifest: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexRemotePluginInterface {
    #[serde(default)]
    short_description: Option<String>,
    #[serde(default)]
    long_description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    logo_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

const CODEX_PLUGIN_MARKETPLACE: &str = "codex";
const CODEX_REMOTE_MARKETPLACE: &str = "openai-curated-remote";
const CODEX_DEFAULT_CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const CODEX_REMOTE_BUNDLE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CODEX_REMOTE_BUNDLE_MAX_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
const CODEX_REMOTE_ERROR_BODY_MAX_BYTES: u64 = 64 * 1024;

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

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexAuthJson {
    #[serde(default)]
    tokens: Option<CodexAuthTokens>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexAuthTokens {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    id_token: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexJwtClaims {
    #[serde(rename = "https://api.openai.com/auth", default)]
    auth: Option<CodexJwtAuthClaims>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexJwtAuthClaims {
    #[serde(default)]
    chatgpt_account_id: Option<String>,
    #[serde(default)]
    chatgpt_account_is_fedramp: bool,
}

fn default_codex_home() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let home = PathBuf::from(codex_home);
        if home.is_dir() {
            return Some(home);
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .filter(|home| home.is_dir())
}

fn codex_home_from_request(request: &CodexRemotePluginInstallRequest) -> Result<PathBuf, String> {
    if let Some(path) = request
        .codex_root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let home = PathBuf::from(path);
        if home.is_dir() {
            return Ok(home);
        }
        return Err(format!("Codex home does not exist: {}", home.display()));
    }
    default_codex_home().ok_or_else(|| {
        "Codex home not found; set CODEX_HOME or pass `codexRoot` to install remote Codex plugins"
            .to_string()
    })
}

fn codex_chatgpt_base_url(codex_home: &Path) -> String {
    let config_path = codex_home.join("config.toml");
    let Ok(raw) = fs::read_to_string(config_path) else {
        return CODEX_DEFAULT_CHATGPT_BASE_URL.to_string();
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("chatgpt_base_url") {
            continue;
        }
        let Some((_, value)) = trimmed.split_once('=') else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim_end_matches('/')
            .to_string();
        if !value.is_empty() {
            return value;
        }
    }
    CODEX_DEFAULT_CHATGPT_BASE_URL.to_string()
}

fn decode_codex_jwt_claims(jwt: &str) -> Option<CodexJwtClaims> {
    let mut parts = jwt.split('.');
    let (_header, payload, _signature) = match (parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(payload), Some(signature))
            if !header.is_empty() && !payload.is_empty() && !signature.is_empty() =>
        {
            (header, payload, signature)
        }
        _ => return None,
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<CodexJwtClaims>(&bytes).ok()
}

fn load_codex_auth(codex_home: &Path) -> Result<CodexAuthTokens, String> {
    let auth_path = codex_home.join("auth.json");
    let raw = fs::read_to_string(&auth_path).map_err(|error| {
        format!(
            "failed to read Codex auth at `{}`: {error}",
            auth_path.display()
        )
    })?;
    let auth = serde_json::from_str::<CodexAuthJson>(&raw).map_err(|error| {
        format!(
            "failed to parse Codex auth at `{}`: {error}",
            auth_path.display()
        )
    })?;
    let mut tokens = auth.tokens.ok_or_else(|| {
        "Codex ChatGPT auth is required to install remote Codex plugins; auth.json has no tokens"
            .to_string()
    })?;
    if tokens.access_token.trim().is_empty() {
        return Err("Codex ChatGPT auth token is empty; sign in with Codex again".to_string());
    }
    if tokens
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        tokens.account_id = decode_codex_jwt_claims(&tokens.id_token)
            .and_then(|claims| claims.auth)
            .and_then(|auth| auth.chatgpt_account_id);
    }
    Ok(tokens)
}

fn codex_remote_request(
    client: &reqwest::blocking::Client,
    method: &str,
    url: &str,
    auth: &CodexAuthTokens,
) -> reqwest::blocking::RequestBuilder {
    let request = match method {
        "POST" => client.post(url),
        _ => client.get(url),
    }
    .header(
        "Authorization",
        format!("Bearer {}", auth.access_token.trim()),
    )
    .header("OAI-Product-Sku", "codex");

    let request = if let Some(account_id) = auth
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request.header("ChatGPT-Account-ID", account_id)
    } else {
        request
    };

    let request = if decode_codex_jwt_claims(&auth.id_token)
        .and_then(|claims| claims.auth)
        .map(|auth| auth.chatgpt_account_is_fedramp)
        .unwrap_or(false)
    {
        request.header("X-OpenAI-Fedramp", "true")
    } else {
        request
    };

    request
}

fn default_codex_plugin_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let root = PathBuf::from(codex_home).join("plugins").join("cache");
        if root.is_dir() {
            roots.push(root);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let root = home.join(".codex").join("plugins").join("cache");
        if root.is_dir() && !roots.iter().any(|existing| existing == &root) {
            roots.push(root);
        }
    }
    roots
}

fn default_codex_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let home = PathBuf::from(codex_home);
        if home.is_dir() {
            homes.push(home);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let codex_home = home.join(".codex");
        if codex_home.is_dir() && !homes.iter().any(|existing| existing == &codex_home) {
            homes.push(codex_home);
        }
    }
    homes
}

fn codex_marketplace_scan_roots(request: &CodexPluginMarketplaceRequest) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for value in [request.path.as_deref(), request.codex_root.as_deref()]
        .into_iter()
        .flatten()
    {
        let path = PathBuf::from(value.trim());
        if path.is_dir() && !roots.iter().any(|existing| existing == &path) {
            roots.push(path);
        }
    }
    for root in default_codex_plugin_roots() {
        if !roots.iter().any(|existing| existing == &root) {
            roots.push(root);
        }
    }
    roots
}

fn codex_remote_catalog_roots(request: &CodexPluginMarketplaceRequest) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for value in [request.path.as_deref(), request.codex_root.as_deref()]
        .into_iter()
        .flatten()
    {
        let path = PathBuf::from(value.trim());
        let candidates = [
            path.clone(),
            path.join("cache").join("remote_plugin_catalog"),
            path.join(".codex")
                .join("cache")
                .join("remote_plugin_catalog"),
        ];
        for candidate in candidates {
            if candidate.is_dir() && !roots.iter().any(|existing| existing == &candidate) {
                roots.push(candidate);
            }
        }
    }
    for home in default_codex_homes() {
        let cache = home.join("cache").join("remote_plugin_catalog");
        if cache.is_dir() && !roots.iter().any(|existing| existing == &cache) {
            roots.push(cache);
        }
    }
    roots
}

fn codex_source_label(root: &Path, plugin_root: &Path) -> String {
    plugin_root
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("codex")
        .to_string()
}

fn codex_source_rank(label: &str) -> u8 {
    match label {
        "openai-curated-remote" => 0,
        "openai-primary-runtime" => 1,
        "openai-bundled" => 2,
        "openai-curated" => 3,
        _ => 4,
    }
}

fn collect_codex_marketplace_items(
    root: &Path,
    index: &ThrivePluginIndex,
) -> Result<Vec<CodexPluginMarketplaceItem>, String> {
    if find_thrive_plugin_manifest_path(root).is_some() {
        return Ok(vec![codex_marketplace_item_for_plugin(
            root,
            root,
            index,
            "codex".to_string(),
        )]);
    }

    let mut items = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let manifest_path = current.join(".codex-plugin").join("plugin.json");
        if manifest_path.is_file() {
            items.push(codex_marketplace_item_for_plugin(
                root,
                &current,
                index,
                codex_source_label(root, &current),
            ));
            continue;
        }
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                stack.push(entry.path());
            }
        }
    }
    Ok(items)
}

fn codex_marketplace_item_for_plugin(
    scan_root: &Path,
    plugin_root: &Path,
    index: &ThrivePluginIndex,
    source_label: String,
) -> CodexPluginMarketplaceItem {
    match load_thrive_plugin_manifest(plugin_root) {
        Ok(manifest) => {
            let installed_plugin_id = plugin_id_for_manifest(&manifest, CODEX_PLUGIN_MARKETPLACE);
            CodexPluginMarketplaceItem {
                id: manifest.name.clone(),
                name: manifest.name.clone(),
                version: manifest.version.clone(),
                display_name: Some(display_name_for_manifest(&manifest)),
                description: manifest.description.clone(),
                short_description: manifest
                    .interface
                    .as_ref()
                    .and_then(|interface| interface.short_description.clone()),
                category: manifest
                    .interface
                    .as_ref()
                    .and_then(|interface| interface.category.clone()),
                logo_url: None,
                keywords: manifest.keywords.clone(),
                capabilities: manifest.permissions.capabilities.clone(),
                app_connector_ids: Vec::new(),
                source_root: Some(plugin_root.display().to_string()),
                source_label,
                remote: false,
                installable: true,
                installed: index.plugins.contains_key(&installed_plugin_id),
                installed_plugin_id,
                remote_plugin_id: None,
                error: None,
            }
        }
        Err(error) => CodexPluginMarketplaceItem {
            id: plugin_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("codex-plugin")
                .to_string(),
            name: plugin_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("codex-plugin")
                .to_string(),
            source_root: Some(plugin_root.display().to_string()),
            source_label: if source_label.is_empty() {
                scan_root.display().to_string()
            } else {
                source_label
            },
            installable: false,
            error: Some(error),
            ..CodexPluginMarketplaceItem::default()
        },
    }
}

fn collect_codex_remote_catalog_items(
    cache_root: &Path,
    index: &ThrivePluginIndex,
) -> Result<Vec<CodexPluginMarketplaceItem>, String> {
    let mut items = Vec::new();
    for entry in fs::read_dir(cache_root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read Codex remote catalog cache: {error}"))?;
        let catalog = serde_json::from_str::<CodexRemotePluginCatalog>(&raw).map_err(|error| {
            format!(
                "failed to parse Codex remote catalog cache `{}`: {error}",
                path.display()
            )
        })?;
        if catalog.schema_version != 1 {
            continue;
        }
        items.extend(
            catalog
                .plugins
                .into_iter()
                .map(|plugin| codex_remote_catalog_item(plugin, index)),
        );
    }
    Ok(items)
}

fn codex_remote_catalog_item(
    plugin: CodexRemotePlugin,
    index: &ThrivePluginIndex,
) -> CodexPluginMarketplaceItem {
    let installed_plugin_id = format!("{}@{}", plugin.name, CODEX_PLUGIN_MARKETPLACE);
    let interface = plugin.release.interface;
    let capabilities = interface
        .as_ref()
        .map(|interface| interface.capabilities.clone())
        .unwrap_or_default();
    let description = plugin
        .release
        .description
        .clone()
        .or_else(|| {
            interface
                .as_ref()
                .and_then(|interface| interface.long_description.clone())
        })
        .or_else(|| {
            interface
                .as_ref()
                .and_then(|interface| interface.short_description.clone())
        });
    CodexPluginMarketplaceItem {
        id: format!("{}@openai-curated-remote", plugin.name),
        name: plugin.name,
        remote_plugin_id: Some(plugin.id),
        version: plugin.release.version,
        display_name: plugin.release.display_name,
        description,
        short_description: interface
            .as_ref()
            .and_then(|interface| interface.short_description.clone()),
        category: interface
            .as_ref()
            .and_then(|interface| interface.category.clone()),
        logo_url: interface.and_then(|interface| interface.logo_url),
        keywords: plugin.release.keywords,
        capabilities,
        app_connector_ids: plugin.release.app_ids,
        source_root: None,
        source_label: "openai-curated-remote".to_string(),
        remote: true,
        installable: match (
            plugin.installation_policy.as_deref(),
            plugin.status.as_deref(),
        ) {
            (Some("NOT_AVAILABLE"), _) | (_, Some("DISABLED_BY_ADMIN")) => false,
            _ => true,
        },
        installed: index.plugins.contains_key(&installed_plugin_id),
        installed_plugin_id,
        error: match (
            plugin.installation_policy.as_deref(),
            plugin.status.as_deref(),
        ) {
            (Some("NOT_AVAILABLE"), _) => {
                Some("remote plugin is not available for install".to_string())
            }
            (_, Some("DISABLED_BY_ADMIN")) => {
                Some("remote plugin is disabled by admin".to_string())
            }
            _ => None,
        },
    }
}

fn merge_codex_marketplace_item(
    existing: &mut CodexPluginMarketplaceItem,
    candidate: CodexPluginMarketplaceItem,
) {
    if existing.source_root.is_none() && candidate.source_root.is_some() {
        existing.source_root = candidate.source_root;
        existing.source_label = candidate.source_label;
        existing.installable = candidate.installable;
        existing.installed = existing.installed || candidate.installed;
    }
    if existing.version.is_none() {
        existing.version = candidate.version;
    }
    if existing.display_name.is_none() {
        existing.display_name = candidate.display_name;
    }
    if existing.description.is_none() {
        existing.description = candidate.description;
    }
    if existing.short_description.is_none() {
        existing.short_description = candidate.short_description;
    }
    if existing.category.is_none() {
        existing.category = candidate.category;
    }
    if existing.logo_url.is_none() {
        existing.logo_url = candidate.logo_url;
    }
    if existing.keywords.is_empty() {
        existing.keywords = candidate.keywords;
    }
    if existing.capabilities.is_empty() {
        existing.capabilities = candidate.capabilities;
    }
    if existing.app_connector_ids.is_empty() {
        existing.app_connector_ids = candidate.app_connector_ids;
    }
    if existing.error.is_none() {
        existing.error = candidate.error;
    }
}

fn dedupe_codex_marketplace_items(
    items: Vec<CodexPluginMarketplaceItem>,
) -> Vec<CodexPluginMarketplaceItem> {
    let mut by_name = BTreeMap::<String, CodexPluginMarketplaceItem>::new();
    for item in items {
        let key = item.name.clone();
        match by_name.get_mut(&key) {
            Some(existing) if existing.remote && !item.remote => {
                merge_codex_marketplace_item(existing, item);
            }
            Some(existing) if item.remote => {
                merge_codex_marketplace_item(existing, item);
            }
            Some(existing)
                if codex_source_rank(&existing.source_label)
                    > codex_source_rank(&item.source_label) =>
            {
                by_name.insert(key, item);
            }
            Some(_) => {}
            None => {
                by_name.insert(key, item);
            }
        }
    }
    by_name.into_values().collect()
}

pub(super) fn list_codex_plugin_marketplace(
    state: &State<'_, AppState>,
    request: CodexPluginMarketplaceRequest,
) -> Result<Value, String> {
    let index = load_thrive_plugin_index(state)?;
    let roots = codex_marketplace_scan_roots(&request);
    let remote_catalog_roots = codex_remote_catalog_roots(&request);
    let mut plugins = Vec::new();
    let mut errors = Vec::new();
    for root in &remote_catalog_roots {
        match collect_codex_remote_catalog_items(root, &index) {
            Ok(items) => plugins.extend(items),
            Err(error) => errors.push(json!({
                "path": root.display().to_string(),
                "error": error,
            })),
        }
    }
    for root in &roots {
        match collect_codex_marketplace_items(root, &index) {
            Ok(items) => plugins.extend(items),
            Err(error) => errors.push(json!({
                "path": root.display().to_string(),
                "error": error,
            })),
        }
    }
    let plugins = dedupe_codex_marketplace_items(plugins);
    Ok(json!({
        "success": true,
        "sourceRoots": roots
            .iter()
            .map(|root| root.display().to_string())
            .collect::<Vec<_>>(),
        "remoteCatalogRoots": remote_catalog_roots
            .iter()
            .map(|root| root.display().to_string())
            .collect::<Vec<_>>(),
        "plugins": plugins,
        "errors": errors,
    }))
}

pub(super) fn install_codex_marketplace_plugin(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source_path: &Path,
    requested_plugin: Option<&str>,
) -> Result<Value, String> {
    install_thrive_plugin_from_path_for_marketplace(
        app,
        state,
        source_path,
        CODEX_PLUGIN_MARKETPLACE,
        requested_plugin,
    )
}

fn codex_remote_plugin_detail_url(base_url: &str, remote_plugin_id: &str) -> String {
    format!(
        "{}/ps/plugins/{}",
        base_url.trim_end_matches('/'),
        remote_plugin_id
    )
}

fn codex_remote_install_url(base_url: &str, remote_plugin_id: &str) -> String {
    format!(
        "{}/ps/plugins/{}/install",
        base_url.trim_end_matches('/'),
        remote_plugin_id
    )
}

fn fetch_codex_remote_plugin_detail(
    client: &reqwest::blocking::Client,
    base_url: &str,
    auth: &CodexAuthTokens,
    remote_plugin_id: &str,
) -> Result<CodexRemotePlugin, String> {
    let url = codex_remote_plugin_detail_url(base_url, remote_plugin_id);
    let response = codex_remote_request(client, "GET", &url, auth)
        .query(&[("includeDownloadUrls", "true")])
        .send()
        .map_err(|error| format!("failed to request Codex remote plugin detail: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("failed to read Codex remote plugin detail: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Codex remote plugin detail request failed with HTTP {status}: {}",
            truncate_error_body(&body)
        ));
    }
    let plugin = serde_json::from_str::<CodexRemotePlugin>(&body)
        .map_err(|error| format!("failed to parse Codex remote plugin detail: {error}"))?;
    if plugin.id != remote_plugin_id {
        return Err(format!(
            "Codex remote plugin detail returned `{}` for requested `{remote_plugin_id}`",
            plugin.id
        ));
    }
    Ok(plugin)
}

fn mark_codex_remote_plugin_installed(
    client: &reqwest::blocking::Client,
    base_url: &str,
    auth: &CodexAuthTokens,
    remote_plugin_id: &str,
) -> Result<Value, String> {
    let url = codex_remote_install_url(base_url, remote_plugin_id);
    let response = codex_remote_request(client, "POST", &url, auth)
        .query(&[("includeAppsNeedingAuth", "true")])
        .send()
        .map_err(|error| format!("failed to mark Codex remote plugin installed: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("failed to read Codex remote install response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Codex remote install request failed with HTTP {status}: {}",
            truncate_error_body(&body)
        ));
    }
    serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("failed to parse Codex remote install response: {error}"))
}

fn truncate_error_body(body: &str) -> String {
    let max = CODEX_REMOTE_ERROR_BODY_MAX_BYTES as usize;
    if body.len() <= max {
        body.to_string()
    } else {
        format!("{}...", &body[..max])
    }
}

fn validate_codex_bundle_download_url(url: &str) -> Result<(), String> {
    let parsed =
        Url::parse(url).map_err(|error| format!("invalid Codex bundle download URL: {error}"))?;
    if parsed.scheme() == "https" {
        return Ok(());
    }
    #[cfg(debug_assertions)]
    {
        if parsed.scheme() == "http"
            && std::env::var("REDBOX_ALLOW_LOOPBACK_CODEX_PLUGIN_BUNDLES")
                .ok()
                .as_deref()
                == Some("1")
            && parsed
                .host_str()
                .map(|host| host == "localhost" || host == "127.0.0.1" || host == "::1")
                .unwrap_or(false)
        {
            return Ok(());
        }
    }
    Err("Codex plugin bundle downloads must use HTTPS".to_string())
}

fn download_codex_remote_plugin_bundle(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    validate_codex_bundle_download_url(url)?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("failed to download Codex plugin bundle: {error}"))?;
    validate_codex_bundle_download_url(response.url().as_str())?;
    let status = response.status();
    if !status.is_success() {
        let mut body = Vec::new();
        response
            .take(CODEX_REMOTE_ERROR_BODY_MAX_BYTES)
            .read_to_end(&mut body)
            .map_err(|error| format!("failed to read Codex plugin bundle error body: {error}"))?;
        return Err(format!(
            "Codex plugin bundle download failed with HTTP {status}: {}",
            String::from_utf8_lossy(&body)
        ));
    }
    if let Some(content_length) = response.content_length() {
        if content_length > CODEX_REMOTE_BUNDLE_MAX_BYTES {
            return Err(format!(
                "Codex plugin bundle is too large: {content_length} bytes"
            ));
        }
    }
    let mut body = Vec::new();
    let mut limited = response.take(CODEX_REMOTE_BUNDLE_MAX_BYTES + 1);
    limited
        .read_to_end(&mut body)
        .map_err(|error| format!("failed to read Codex plugin bundle: {error}"))?;
    if body.len() as u64 > CODEX_REMOTE_BUNDLE_MAX_BYTES {
        return Err(format!(
            "Codex plugin bundle exceeds {} bytes",
            CODEX_REMOTE_BUNDLE_MAX_BYTES
        ));
    }
    Ok(body)
}

fn extract_codex_remote_plugin_bundle(bytes: &[u8], temp_root: &Path) -> Result<PathBuf, String> {
    let extract_root = temp_root.join("bundle");
    fs::create_dir_all(&extract_root).map_err(|error| error.to_string())?;
    let decoder = GzDecoder::new(bytes);
    let mut archive = Archive::new(decoder);
    let mut extracted_bytes = 0u64;
    for entry in archive
        .entries()
        .map_err(|error| format!("failed to read Codex plugin bundle: {error}"))?
    {
        let mut entry =
            entry.map_err(|error| format!("failed to read Codex plugin bundle entry: {error}"))?;
        if entry.header().entry_type().is_symlink() || entry.header().entry_type().is_hard_link() {
            return Err("Codex plugin bundles must not contain links".to_string());
        }
        let entry_size = entry.header().size().map_err(|error| error.to_string())?;
        extracted_bytes = extracted_bytes.saturating_add(entry_size);
        if extracted_bytes > CODEX_REMOTE_BUNDLE_MAX_EXTRACTED_BYTES {
            return Err(format!(
                "Codex plugin bundle expands beyond {} bytes",
                CODEX_REMOTE_BUNDLE_MAX_EXTRACTED_BYTES
            ));
        }
        let path = entry
            .path()
            .map_err(|error| format!("failed to read Codex plugin bundle path: {error}"))?;
        let output_path = safe_archive_output_path(&extract_root, path.as_ref())?;
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| error.to_string())?;
        } else if entry.header().entry_type().is_file() {
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            entry
                .unpack(&output_path)
                .map_err(|error| format!("failed to extract Codex plugin bundle: {error}"))?;
        }
    }
    resolve_plugin_source_root_for_install(&extract_root, None)
}

fn safe_archive_output_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut output = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => output.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "Codex plugin bundle contains an unsafe path: {}",
                    relative.display()
                ));
            }
        }
    }
    Ok(output)
}

fn write_codex_remote_json_override(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Codex plugin JSON path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize Codex plugin JSON override: {error}"))?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn prepare_codex_remote_plugin_root(
    plugin_root: &Path,
    release: &CodexRemotePluginRelease,
) -> Result<(), String> {
    if let Some(version) = release
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let manifest_path = find_thrive_plugin_manifest_path(plugin_root).ok_or_else(|| {
            "Codex remote plugin bundle does not contain .codex-plugin/plugin.json".to_string()
        })?;
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|error| format!("failed to read Codex plugin manifest: {error}"))?;
        let mut manifest = serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("failed to parse Codex plugin manifest: {error}"))?;
        let object = manifest
            .as_object_mut()
            .ok_or_else(|| "Codex plugin manifest must be a JSON object".to_string())?;
        object.insert("version".to_string(), Value::String(version.to_string()));
        write_codex_remote_json_override(&manifest_path, &manifest)?;
    }
    if let Some(app_manifest) = &release.app_manifest {
        let manifest = load_thrive_plugin_manifest(plugin_root)?;
        let app_manifest_path =
            validate_manifest_relative_path(plugin_root, "apps", manifest.apps.as_deref())
                .ok()
                .flatten()
                .unwrap_or_else(|| plugin_root.join(".app.json"));
        write_codex_remote_json_override(&app_manifest_path, app_manifest)?;
    }
    Ok(())
}

pub(super) fn install_codex_remote_marketplace_plugin(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: CodexRemotePluginInstallRequest,
) -> Result<Value, String> {
    let remote_plugin_id = request
        .remote_plugin_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "plugins:install-codex requires `remotePluginId` or `path`".to_string())?;
    if !remote_plugin_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '~')
    {
        return Err("invalid Codex remote plugin id".to_string());
    }
    let remote_marketplace_name = request
        .remote_marketplace_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(CODEX_REMOTE_MARKETPLACE);
    let codex_home = codex_home_from_request(&request)?;
    let auth = load_codex_auth(&codex_home)?;
    let base_url = codex_chatgpt_base_url(&codex_home);
    let client = plugin_http_client()?;
    let detail = fetch_codex_remote_plugin_detail(&client, &base_url, &auth, remote_plugin_id)?;
    if matches!(detail.installation_policy.as_deref(), Some("NOT_AVAILABLE")) {
        return Err("Codex remote plugin is not available for install".to_string());
    }
    if matches!(detail.status.as_deref(), Some("DISABLED_BY_ADMIN")) {
        return Err("Codex remote plugin is disabled by admin".to_string());
    }
    let plugin_name = request
        .plugin_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&detail.name);
    validate_plugin_segment(plugin_name, "Codex plugin name")?;
    let release_version = detail
        .release
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Codex remote plugin detail did not include a release version".to_string()
        })?;
    validate_plugin_version(release_version)?;
    let bundle_url = detail
        .release
        .bundle_download_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Codex remote plugin detail did not include a bundle download URL; refresh Codex auth/cache and try again"
                .to_string()
        })?;

    let temp_root = thrive_plugins_root(state)?
        .join(".tmp")
        .join(format!("codex-remote-{}", now_ms()));
    remove_path_if_exists(&temp_root)?;
    fs::create_dir_all(&temp_root).map_err(|error| error.to_string())?;
    let result = (|| -> Result<Value, String> {
        let bytes = download_codex_remote_plugin_bundle(&client, bundle_url)?;
        let plugin_root = extract_codex_remote_plugin_bundle(&bytes, &temp_root)?;
        prepare_codex_remote_plugin_root(&plugin_root, &detail.release)?;
        let install_result = install_thrive_plugin_from_path_for_marketplace(
            app,
            state,
            &plugin_root,
            CODEX_PLUGIN_MARKETPLACE,
            Some(plugin_name),
        )?;
        let remote_install =
            mark_codex_remote_plugin_installed(&client, &base_url, &auth, remote_plugin_id)?;
        Ok(json!({
            "success": true,
            "plugin": install_result.get("plugin").cloned(),
            "sync": install_result.get("sync").cloned(),
            "codexRemote": {
                "remotePluginId": remote_plugin_id,
                "remoteMarketplaceName": remote_marketplace_name,
                "install": remote_install,
            }
        }))
    })();
    let _ = remove_path_if_exists(&temp_root);
    result
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
            request.id.as_deref(),
        )
    })();
    let _ = remove_path_if_exists(&temp_root);
    install_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn empty_index() -> ThrivePluginIndex {
        ThrivePluginIndex {
            schema_version: THRIVE_PLUGIN_SCHEMA_VERSION,
            plugins: BTreeMap::new(),
        }
    }

    fn temp_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("redbox-{label}-{}", crate::now_i64()))
    }

    fn codex_plugin_bundle(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (path, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, *path, *body)
                .expect("append tar entry");
        }
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish gzip")
    }

    fn unsafe_codex_plugin_bundle(path: &str, body: &[u8]) -> Vec<u8> {
        let mut tar_bytes = vec![0u8; 512];
        let path_bytes = path.as_bytes();
        tar_bytes[..path_bytes.len()].copy_from_slice(path_bytes);
        tar_bytes[100..108].copy_from_slice(b"0000644\0");
        tar_bytes[108..116].copy_from_slice(b"0000000\0");
        tar_bytes[116..124].copy_from_slice(b"0000000\0");
        let size = format!("{:011o}\0", body.len());
        tar_bytes[124..136].copy_from_slice(size.as_bytes());
        tar_bytes[136..148].copy_from_slice(b"00000000000\0");
        for byte in &mut tar_bytes[148..156] {
            *byte = b' ';
        }
        tar_bytes[156] = b'0';
        tar_bytes[257..263].copy_from_slice(b"ustar\0");
        tar_bytes[263..265].copy_from_slice(b"00");
        let checksum: u32 = tar_bytes.iter().map(|byte| u32::from(*byte)).sum();
        let checksum = format!("{checksum:06o}\0 ");
        tar_bytes[148..156].copy_from_slice(checksum.as_bytes());
        tar_bytes.extend_from_slice(body);
        let padding = (512 - (body.len() % 512)) % 512;
        tar_bytes.extend(std::iter::repeat_n(0, padding));
        tar_bytes.extend(std::iter::repeat_n(0, 1024));

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&tar_bytes).expect("write gzip");
        encoder.finish().expect("finish gzip")
    }

    #[test]
    fn reads_codex_remote_catalog_cache_items() {
        let root =
            std::env::temp_dir().join(format!("redbox-codex-remote-catalog-{}", crate::now_i64()));
        fs::create_dir_all(&root).expect("create cache dir");
        fs::write(
            root.join("catalog.json"),
            json!({
                "schema_version": 1,
                "plugins": [
                    {
                        "id": "plugin_remote_1",
                        "name": "linear",
                        "installation_policy": "AVAILABLE",
                        "authentication_policy": "ON_USE",
                        "status": "AVAILABLE",
                        "release": {
                            "version": "1.2.3",
                            "display_name": "Linear",
                            "description": "Track work in Linear",
                            "app_ids": ["connector_linear"],
                            "keywords": ["issues"],
                            "interface": {
                                "short_description": "Plan and track work",
                                "category": "Productivity",
                                "capabilities": ["Read"],
                                "logo_url": "https://example.com/logo.png"
                            }
                        }
                    }
                ]
            })
            .to_string(),
        )
        .expect("write cache");

        let items = collect_codex_remote_catalog_items(&root, &empty_index()).expect("items");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "linear");
        assert_eq!(
            items[0].remote_plugin_id.as_deref(),
            Some("plugin_remote_1")
        );
        assert_eq!(items[0].source_label, "openai-curated-remote");
        assert!(items[0].remote);
        assert!(items[0].installable);
        assert_eq!(items[0].app_connector_ids, vec!["connector_linear"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dedupe_codex_marketplace_items_merges_remote_metadata_with_local_source() {
        let mut remote = CodexPluginMarketplaceItem {
            id: "linear@openai-curated-remote".to_string(),
            name: "linear".to_string(),
            remote_plugin_id: Some("plugin_remote_1".to_string()),
            display_name: Some("Linear".to_string()),
            source_label: "openai-curated-remote".to_string(),
            remote: true,
            installed_plugin_id: "linear@codex".to_string(),
            ..CodexPluginMarketplaceItem::default()
        };
        remote
            .app_connector_ids
            .push("connector_linear".to_string());
        let local = CodexPluginMarketplaceItem {
            id: "linear".to_string(),
            name: "linear".to_string(),
            source_root: Some("/tmp/linear".to_string()),
            source_label: "openai-curated".to_string(),
            installable: true,
            installed_plugin_id: "linear@codex".to_string(),
            ..CodexPluginMarketplaceItem::default()
        };

        let items = dedupe_codex_marketplace_items(vec![remote, local]);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].display_name.as_deref(), Some("Linear"));
        assert_eq!(
            items[0].remote_plugin_id.as_deref(),
            Some("plugin_remote_1")
        );
        assert_eq!(items[0].source_root.as_deref(), Some("/tmp/linear"));
        assert!(items[0].installable);
        assert_eq!(items[0].app_connector_ids, vec!["connector_linear"]);
    }

    #[test]
    fn codex_bundle_download_url_requires_https() {
        assert!(validate_codex_bundle_download_url("https://example.com/plugin.tar.gz").is_ok());
        assert!(validate_codex_bundle_download_url("file:///tmp/plugin.tar.gz").is_err());
        assert!(validate_codex_bundle_download_url("http://example.com/plugin.tar.gz").is_err());
    }

    #[test]
    fn extract_codex_remote_plugin_bundle_rejects_unsafe_paths() {
        let temp_root = temp_test_root("codex-unsafe-bundle");
        fs::create_dir_all(&temp_root).expect("create temp root");
        let bytes = unsafe_codex_plugin_bundle("../escape.txt", b"nope");

        let error = extract_codex_remote_plugin_bundle(&bytes, &temp_root)
            .expect_err("unsafe archive path should fail");

        assert!(error.contains("unsafe path"));
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn extract_and_prepare_codex_remote_plugin_bundle() {
        let temp_root = temp_test_root("codex-remote-bundle");
        fs::create_dir_all(&temp_root).expect("create temp root");
        let manifest = br#"{
            "name": "linear",
            "version": "0.0.1",
            "skills": "./skills",
            "apps": "./apps.json",
            "permissions": { "capabilities": [] }
        }"#;
        let bytes = codex_plugin_bundle(&[
            ("linear/.codex-plugin/plugin.json", manifest.as_slice()),
            (
                "linear/skills/linear/SKILL.md",
                b"---\ndescription: Linear\n---\n",
            ),
        ]);

        let plugin_root =
            extract_codex_remote_plugin_bundle(&bytes, &temp_root).expect("extract bundle");
        prepare_codex_remote_plugin_root(
            &plugin_root,
            &CodexRemotePluginRelease {
                version: Some("1.2.3".to_string()),
                app_manifest: Some(json!({
                    "apps": {
                        "Linear": {
                            "id": "connector_linear",
                            "category": "Productivity"
                        }
                    }
                })),
                ..CodexRemotePluginRelease::default()
            },
        )
        .expect("prepare plugin root");

        let manifest_value: Value = serde_json::from_str(
            &fs::read_to_string(plugin_root.join(".codex-plugin/plugin.json"))
                .expect("read manifest"),
        )
        .expect("parse manifest");
        let app_value: Value = serde_json::from_str(
            &fs::read_to_string(plugin_root.join("apps.json")).expect("read app manifest"),
        )
        .expect("parse app manifest");

        assert_eq!(manifest_value.get("version"), Some(&json!("1.2.3")));
        assert_eq!(
            app_value.pointer("/apps/Linear/id").and_then(Value::as_str),
            Some("connector_linear")
        );

        let _ = fs::remove_dir_all(temp_root);
    }
}
