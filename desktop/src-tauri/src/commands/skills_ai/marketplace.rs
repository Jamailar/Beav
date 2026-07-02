use super::*;
use crate::skills::{InstallSkillsFromRepoOutcome, InstalledRepoSkill};
use crate::store::settings as settings_store;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const SETTINGS_SKILL_MARKET_SOURCES_KEY: &str = "skill_market_sources";
const REDBOX_MARKET_KIND_SKILL_PACK: &str = "skill-pack";
const MARKET_PROVENANCE_FILENAME: &str = ".redbox-market.json";
const REDBOX_SERVER_SKILL_MARKET_URL: &str = "https://api.ziz.hk/api/v1/skill-market";
const LEGACY_THRIVE_MARKET_SOURCE_ID: &str = "thrive-community";
const RED_SKILL_TAG_LABEL: &str = "RED skill";
const THRIVE_SKILL_DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/ThrivingOS/Thrive-release/main/community-skills.json";
const REDSKILL_INSTALL_SCRIPT_URL: &str =
    "https://fe-video-qc.xhscdn.com/fe-platform-file/104101b8320fbjem2620653u0hejenq0004pf88g6ask5i.sh";
const THRIVE_SKILL_HTTP_USER_AGENT: &str =
    "RedBox/SkillMarketplace (+https://github.com/ThrivingOS/Thrive-release)";
const MARKETPLACE_AVATAR_CACHE_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SkillMarketplaceListRequest {
    url: Option<String>,
    market_id: Option<String>,
    query: Option<String>,
    include_disabled_sources: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SkillMarketplaceSourceRequest {
    id: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    source: Option<String>,
    registry_url: Option<String>,
    repo: Option<String>,
    ref_name: Option<String>,
    #[serde(rename = "ref")]
    ref_alias: Option<String>,
    enabled: Option<bool>,
    priority: Option<i64>,
    trust_level: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ThriveSkillMarketInstallRequest {
    pub(super) slug: Option<String>,
    pub(super) id: Option<String>,
    pub(super) repo: Option<String>,
    pub(super) ref_name: Option<String>,
    #[serde(rename = "ref")]
    pub(super) ref_alias: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SkillMarketplaceInstallRequest {
    slug: Option<String>,
    id: Option<String>,
    package_id: Option<String>,
    market_id: Option<String>,
    repo: Option<String>,
    ref_name: Option<String>,
    #[serde(rename = "ref")]
    ref_alias: Option<String>,
    paths: Vec<String>,
    scope: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SkillMarketplaceAvatarCacheRequest {
    url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThriveSkillMarketplaceEntry {
    pub(super) id: String,
    name: String,
    author: String,
    description: String,
    #[serde(alias = "avatar_url")]
    avatar_url: Option<String>,
    #[serde(alias = "icon_url")]
    icon_url: Option<String>,
    #[serde(alias = "logo_url")]
    logo_url: Option<String>,
    #[serde(alias = "image_url")]
    image_url: Option<String>,
    #[serde(alias = "thumbnail_url")]
    thumbnail_url: Option<String>,
    pub(super) repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SkillMarketSource {
    id: String,
    name: String,
    kind: String,
    enabled: bool,
    priority: i64,
    trust_level: String,
    source: Option<String>,
    registry_url: Option<String>,
    repo: Option<String>,
    ref_name: Option<String>,
    description: Option<String>,
}

impl Default for SkillMarketSource {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "legacy-thrive".to_string(),
            enabled: true,
            priority: 100,
            trust_level: "community".to_string(),
            source: None,
            registry_url: None,
            repo: None,
            ref_name: None,
            description: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillMarketWarning {
    market_id: String,
    market_name: String,
    error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillMarketItem {
    id: String,
    package_id: String,
    market_id: String,
    market_name: String,
    source_kind: String,
    name: String,
    author: String,
    author_avatar_url: Option<String>,
    author_homepage_url: Option<String>,
    author_bio: Option<String>,
    author_verified: bool,
    intro_note: Option<Value>,
    description: String,
    avatar_url: Option<String>,
    repo: Option<String>,
    ref_name: Option<String>,
    paths: Vec<String>,
    version: Option<String>,
    kind: String,
    channel: Option<String>,
    tags: Vec<String>,
    risk_level: Option<String>,
    trust_level: String,
    manifest_path: Option<String>,
    package_path: Option<String>,
    installed: bool,
    installed_skill_names: Vec<String>,
    installed_version: Option<String>,
    update_available: bool,
    installable: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillMarketCollection {
    id: String,
    collection_key: String,
    market_id: String,
    market_name: String,
    source_kind: String,
    title: String,
    subtitle: Option<String>,
    description: Option<String>,
    avatar_url: Option<String>,
    cover_url: Option<String>,
    homepage_url: Option<String>,
    external_url: Option<String>,
    author: Option<String>,
    author_avatar_url: Option<String>,
    author_homepage_url: Option<String>,
    package_keys: Vec<String>,
    skill_count: usize,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RedboxSkillRegistryEntry {
    id: Option<String>,
    package_id: Option<String>,
    name: Option<String>,
    display_name: Option<String>,
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
    #[serde(alias = "avatar_url")]
    avatar_url: Option<String>,
    #[serde(alias = "icon_url")]
    icon_url: Option<String>,
    #[serde(alias = "logo_url")]
    logo_url: Option<String>,
    #[serde(alias = "image_url")]
    image_url: Option<String>,
    #[serde(alias = "thumbnail_url")]
    thumbnail_url: Option<String>,
    version: Option<String>,
    kind: Option<String>,
    channel: Option<String>,
    tags: Vec<String>,
    keywords: Vec<String>,
    risk_level: Option<String>,
    manifest_path: Option<String>,
    package_path: Option<String>,
    path: Option<String>,
    repo: Option<String>,
    source: Option<String>,
    ref_name: Option<String>,
    #[serde(rename = "ref")]
    ref_alias: Option<String>,
    skills: Vec<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RedboxSkillManifest {
    id: Option<String>,
    package_id: Option<String>,
    name: Option<String>,
    display_name: Option<String>,
    title: Option<String>,
    author: Option<String>,
    description: Option<String>,
    #[serde(alias = "avatar_url")]
    avatar_url: Option<String>,
    #[serde(alias = "icon_url")]
    icon_url: Option<String>,
    #[serde(alias = "logo_url")]
    logo_url: Option<String>,
    #[serde(alias = "image_url")]
    image_url: Option<String>,
    #[serde(alias = "thumbnail_url")]
    thumbnail_url: Option<String>,
    version: Option<String>,
    kind: Option<String>,
    channel: Option<String>,
    tags: Vec<String>,
    keywords: Vec<String>,
    risk_level: Option<String>,
    repo: Option<String>,
    source: Option<String>,
    ref_name: Option<String>,
    #[serde(rename = "ref")]
    ref_alias: Option<String>,
    skills: Vec<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InstalledMarketProvenance {
    market_id: Option<String>,
    market_name: Option<String>,
    package_id: Option<String>,
    version: Option<String>,
    source_kind: Option<String>,
    kind: Option<String>,
    install_root: Option<String>,
    installed_skill_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledMarketSkillVerification {
    name: String,
    requested_name: String,
    found: bool,
    activation_ready: bool,
    location: Option<String>,
    source_scope: Option<String>,
    disabled: bool,
}

pub(super) fn marketplace_channel_names() -> &'static [&'static str] {
    &[
        "skills:market-sources:list",
        "skills:market-sources:add",
        "skills:market-sources:update",
        "skills:market-sources:remove",
        "skills:market-sources:refresh",
        "skills:marketplace:list",
        "skills:marketplace:read-package",
        "skills:marketplace:cache-avatar",
        "skills:marketplace:install",
        "skills:marketplace:update-installed",
        "skills:marketplace:uninstall",
    ]
}

pub(super) fn handle_marketplace_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "skills:market-sources:list" | "skills:market-sources:refresh" => {
            list_skill_market_sources(state, payload)
        }
        "skills:market-sources:add" => add_skill_market_source(state, payload),
        "skills:market-sources:update" => update_skill_market_source(state, payload),
        "skills:market-sources:remove" => remove_skill_market_source(state, payload),
        "skills:marketplace:list" => list_skill_marketplace(state, payload),
        "skills:marketplace:read-package" => read_skill_marketplace_package(state, payload),
        "skills:marketplace:cache-avatar" => cache_skill_marketplace_avatar(state, payload),
        "skills:marketplace:install" | "skills:marketplace:update-installed" => {
            install_skill_marketplace_package(state, payload)
        }
        "skills:marketplace:uninstall" => uninstall_skill_marketplace_package(state, payload),
        _ => return None,
    };
    Some(result)
}

pub(super) fn list_skill_marketplace(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: SkillMarketplaceListRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:marketplace payload invalid: {error}"))?;
    let sources = if request
        .url
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
    {
        vec![legacy_thrive_source_for_url(request.url.clone())]
    } else {
        skill_market_sources(state)?
    };
    let installed = installed_skill_index(state)?;
    let mut items = Vec::<SkillMarketItem>::new();
    let mut collections = Vec::<SkillMarketCollection>::new();
    let mut warnings = Vec::<SkillMarketWarning>::new();
    for source in sources {
        if !request.include_disabled_sources && !source.enabled {
            continue;
        }
        if request
            .market_id
            .as_deref()
            .is_some_and(|market_id| market_id != source.id)
        {
            continue;
        }
        match load_skill_market_source_items(&source, &installed) {
            Ok(mut loaded) => items.append(&mut loaded),
            Err(error) => warnings.push(SkillMarketWarning {
                market_id: source.id.clone(),
                market_name: source.name.clone(),
                error,
            }),
        }
        match load_skill_market_source_collections(&source) {
            Ok(mut loaded) => collections.append(&mut loaded),
            Err(error) => warnings.push(SkillMarketWarning {
                market_id: source.id.clone(),
                market_name: source.name.clone(),
                error,
            }),
        }
    }
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    if let Some(query) = query {
        items.retain(|item| {
            item.name.to_ascii_lowercase().contains(&query)
                || item.id.to_ascii_lowercase().contains(&query)
                || item.description.to_ascii_lowercase().contains(&query)
                || item
                    .tags
                    .iter()
                    .any(|tag| tag.to_ascii_lowercase().contains(&query))
        });
    }
    items.sort_by(|left, right| {
        left.market_name
            .cmp(&right.market_name)
            .then(left.name.cmp(&right.name))
    });
    collections.sort_by(|left, right| {
        left.market_name
            .cmp(&right.market_name)
            .then(left.title.cmp(&right.title))
    });
    let skills = serde_json::to_value(&items).map_err(|error| error.to_string())?;
    let collections = serde_json::to_value(&collections).map_err(|error| error.to_string())?;
    Ok(json!({
        "success": true,
        "registryUrl": REDBOX_SERVER_SKILL_MARKET_URL,
        "sources": skill_market_sources(state)?,
        "collections": collections,
        "items": skills,
        "skills": skills,
        "warnings": warnings,
    }))
}

pub(super) fn install_skill_marketplace_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: SkillMarketplaceInstallRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:marketplace:install payload invalid: {error}"))?;
    let direct_package_id = request
        .package_id
        .clone()
        .or(request.id.clone())
        .or(request.slug.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(repo) = request
        .repo
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
    {
        let ref_name = request.ref_name.clone().or(request.ref_alias.clone());
        let provenance = direct_package_id.as_ref().map(|package_id| {
            json!({
                "marketId": request.market_id.clone(),
                "packageId": package_id,
                "kind": REDBOX_MARKET_KIND_SKILL_PACK,
                "sourceKind": "direct-repo",
                "repo": repo.clone(),
                "refName": ref_name.clone(),
                "paths": request.paths.clone(),
                "installedAt": now_iso(),
            })
        });
        return install_market_item_from_repo(
            state,
            &repo,
            ref_name,
            request.paths,
            request.scope,
            provenance,
        );
    }

    let package_id = direct_package_id.ok_or_else(|| "缺少技能市场 packageId".to_string())?;
    let package_id_ref = package_id.as_str();
    let sources = skill_market_sources(state)?;
    for source in sources {
        if request
            .market_id
            .as_deref()
            .is_some_and(|market_id| market_id != source.id)
        {
            continue;
        }
        if source.kind == "redbox-server" {
            return install_redbox_server_market_package(
                state,
                &source,
                &package_id,
                request.scope.clone(),
            );
        }
        if source.kind == "redskill-cli" {
            return install_redskill_market_identifier(state, &source, &package_id);
        }
        let installed = installed_skill_index(state)?;
        let items = load_skill_market_source_items(&source, &installed).unwrap_or_default();
        if let Some(item) = items
            .into_iter()
            .find(|item| item.package_id == package_id_ref || item.id == package_id_ref)
        {
            let repo = item
                .repo
                .clone()
                .or_else(|| source.repo.clone())
                .or_else(|| local_source_path_for_install(&source));
            let Some(repo) = repo else {
                return Err(format!("市场包 `{package_id}` 没有可安装 source"));
            };
            let paths = if request.paths.is_empty() {
                item.paths.clone()
            } else {
                request.paths.clone()
            };
            let ref_name = request
                .ref_name
                .clone()
                .or(request.ref_alias.clone())
                .or(item.ref_name.clone())
                .or(source.ref_name.clone());
            let provenance = json!({
                "marketId": item.market_id,
                "marketName": item.market_name,
                "packageId": item.package_id,
                "version": item.version,
                "kind": item.kind,
                "sourceKind": item.source_kind,
                "repo": repo.clone(),
                "refName": ref_name.clone(),
                "paths": paths.clone(),
                "installedAt": now_iso(),
            });
            return install_market_item_from_repo(
                state,
                &repo,
                ref_name,
                paths,
                request.scope,
                Some(provenance),
            );
        }
    }

    if let Ok(Some(entry)) = resolve_market_install_entry(&ThriveSkillMarketInstallRequest {
        slug: request.slug.clone(),
        id: request.id.clone(),
        repo: None,
        ref_name: request.ref_name.clone(),
        ref_alias: request.ref_alias.clone(),
    }) {
        return install_market_item_from_repo(
            state,
            &entry.repo,
            None,
            Vec::new(),
            request.scope,
            Some(json!({
                "marketId": "thrive-community",
                "marketName": "Thrive Community",
                "packageId": entry.id.clone(),
                "kind": REDBOX_MARKET_KIND_SKILL_PACK,
                "sourceKind": "legacy-thrive",
                "repo": entry.repo.clone(),
                "installedAt": now_iso(),
            })),
        );
    }

    Err(format!("未找到技能市场包: {package_id}"))
}

pub(super) fn resolve_market_install_entry(
    request: &ThriveSkillMarketInstallRequest,
) -> Result<Option<ThriveSkillMarketplaceEntry>, String> {
    let id = request
        .id
        .as_deref()
        .or(request.slug.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(id) = id else {
        return Ok(None);
    };
    let entries = load_legacy_thrive_entries(THRIVE_SKILL_DEFAULT_REGISTRY_URL)?;
    Ok(entries.into_iter().find(|entry| entry.id == id))
}

fn list_skill_market_sources(
    state: &State<'_, AppState>,
    _payload: &Value,
) -> Result<Value, String> {
    Ok(json!({
        "success": true,
        "sources": skill_market_sources(state)?,
    }))
}

fn add_skill_market_source(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let request: SkillMarketplaceSourceRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:market-sources:add payload invalid: {error}"))?;
    let mut sources = persisted_or_default_market_sources(state)?;
    let mut source = source_from_request(request, None)?;
    if sources.iter().any(|item| item.id == source.id) {
        source.id = unique_source_id(&sources, &source.id);
    }
    sources.push(source.clone());
    sources.sort_by_key(|item| item.priority);
    persist_skill_market_sources(state, &sources)?;
    Ok(json!({ "success": true, "source": source, "sources": sources }))
}

fn update_skill_market_source(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: SkillMarketplaceSourceRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:market-sources:update payload invalid: {error}"))?;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 market source id".to_string())?
        .to_string();
    let mut sources = persisted_or_default_market_sources(state)?;
    let index = sources
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| format!("市场源不存在: {id}"))?;
    let updated = source_from_request(request, Some(sources[index].clone()))?;
    sources[index] = updated.clone();
    sources.sort_by_key(|item| item.priority);
    persist_skill_market_sources(state, &sources)?;
    Ok(json!({ "success": true, "source": updated, "sources": sources }))
}

fn remove_skill_market_source(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let id = payload_string(payload, "id").unwrap_or_default();
    if id.trim().is_empty() {
        return Err("缺少 market source id".to_string());
    }
    let mut sources = persisted_or_default_market_sources(state)?;
    let before = sources.len();
    sources.retain(|source| source.id != id);
    if sources.len() == before {
        return Err(format!("市场源不存在: {id}"));
    }
    persist_skill_market_sources(state, &sources)?;
    Ok(json!({ "success": true, "removedId": id, "sources": sources }))
}

fn read_skill_marketplace_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: SkillMarketplaceInstallRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:marketplace:read-package payload invalid: {error}"))?;
    let package_id = request
        .package_id
        .as_deref()
        .or(request.id.as_deref())
        .or(request.slug.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少技能市场 packageId".to_string())?;
    let installed = installed_skill_index(state)?;
    for source in skill_market_sources(state)? {
        if request
            .market_id
            .as_deref()
            .is_some_and(|market_id| market_id != source.id)
        {
            continue;
        }
        let items = load_skill_market_source_items(&source, &installed).unwrap_or_default();
        if let Some(mut item) = items
            .into_iter()
            .find(|item| item.package_id == package_id || item.id == package_id)
        {
            if source.kind == "redbox-server" {
                let base = redbox_server_skill_market_base_url(&source)?;
                let detail_url = format!("{base}/skills/{}", url_path_segment(&item.package_id));
                if let Ok(detail) = http_get_redbox_server_json::<Value>(&detail_url) {
                    if let Ok(detail_item) =
                        redbox_server_entry_to_item(&source, &detail, &installed)
                    {
                        item = detail_item;
                    }
                }
            }
            let manifest = read_market_item_manifest_value(&source, &item).unwrap_or(Value::Null);
            return Ok(json!({
                "success": true,
                "item": item,
                "manifest": manifest,
            }));
        }
    }
    Err(format!("未找到技能市场包: {package_id}"))
}

fn cache_skill_marketplace_avatar(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: SkillMarketplaceAvatarCacheRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:marketplace:cache-avatar payload invalid: {error}"))?;
    let url = normalize_marketplace_avatar_url(&request.url)?;
    if url.starts_with("data:image/") {
        return Ok(json!({
            "success": true,
            "url": url,
            "dataUrl": url,
            "cached": true,
        }));
    }

    let cache_root = marketplace_avatar_cache_root(state)?;
    let cache_key = sha256_hex(url.as_bytes());
    let bytes_path = cache_root.join(format!("{cache_key}.bin"));
    let meta_path = cache_root.join(format!("{cache_key}.json"));

    if bytes_path.is_file() {
        if let Ok(bytes) = fs::read(&bytes_path) {
            if bytes.len() <= MARKETPLACE_AVATAR_CACHE_MAX_BYTES {
                let mime_type = cached_marketplace_avatar_mime_type(&meta_path)
                    .or_else(|| infer_marketplace_avatar_mime_type(&url))
                    .unwrap_or_else(|| "image/png".to_string());
                return Ok(json!({
                    "success": true,
                    "url": url,
                    "dataUrl": avatar_data_url(&mime_type, &bytes),
                    "mimeType": mime_type,
                    "byteCount": bytes.len(),
                    "cached": true,
                }));
            }
        }
    }

    let client = skill_marketplace_http_client()?;
    let response = client
        .get(&url)
        .send()
        .map_err(|error| format!("头像下载失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("头像下载失败: HTTP {}", status.as_u16()));
    }
    if let Some(length) = response.content_length() {
        if length > MARKETPLACE_AVATAR_CACHE_MAX_BYTES as u64 {
            return Err("头像文件过大".to_string());
        }
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToString::to_string);
    let mime_type = marketplace_avatar_mime_type(&url, content_type.as_deref())?;
    let bytes = response
        .bytes()
        .map_err(|error| format!("头像读取失败: {error}"))?;
    if bytes.len() > MARKETPLACE_AVATAR_CACHE_MAX_BYTES {
        return Err("头像文件过大".to_string());
    }
    fs::write(&bytes_path, bytes.as_ref()).map_err(|error| format!("头像缓存写入失败: {error}"))?;
    let _ = fs::write(
        &meta_path,
        serde_json::to_vec_pretty(&json!({
            "url": url,
            "mimeType": mime_type,
            "byteCount": bytes.len(),
            "cachedAt": now_iso(),
        }))
        .unwrap_or_default(),
    );

    Ok(json!({
        "success": true,
        "url": url,
        "dataUrl": avatar_data_url(&mime_type, bytes.as_ref()),
        "mimeType": mime_type,
        "byteCount": bytes.len(),
        "cached": false,
    }))
}

fn uninstall_skill_marketplace_package(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let name = requested_skill_name(payload);
    if name.is_empty() {
        return Ok(json!({ "success": false, "error": "技能名称不能为空" }));
    }
    let workspace = workspace_root(state).ok();
    let outcome = crate::skills::uninstall_skill(
        UninstallSkillRequest {
            name,
            scope: payload_string(payload, "scope").or_else(|| Some("user".to_string())),
            workspace_root: workspace,
        },
        &preferred_user_skill_root(),
    )?;
    let _ = refresh_skill_store_catalog(state);
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
    Ok(json!({
        "success": true,
        "name": outcome.name,
        "scope": outcome.scope,
        "installRoot": outcome.install_root,
        "removedPath": outcome.removed_path,
    }))
}

fn install_market_item_from_repo(
    state: &State<'_, AppState>,
    repo: &str,
    ref_name: Option<String>,
    paths: Vec<String>,
    scope: Option<String>,
    provenance: Option<Value>,
) -> Result<Value, String> {
    let workspace = workspace_root(state).ok();
    let outcome = install_skills_from_repo(
        InstallSkillsFromRepoRequest {
            source: repo.to_string(),
            ref_name,
            paths,
            scope: scope.or_else(|| Some("user".to_string())),
            workspace_root: workspace,
        },
        &preferred_user_skill_root(),
    )?;
    if let Some(provenance) = provenance {
        let provenance = enrich_market_install_provenance(provenance, &outcome);
        write_market_provenance_for_installed(&outcome.installed, &provenance)?;
    }
    refresh_skill_store_catalog(state)?;
    enable_installed_market_skills(state, &outcome.installed)?;
    let verified = verify_installed_market_skills(state, &outcome.installed)?;
    ensure_market_install_activation_ready(&outcome, &verified)?;
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
    Ok(json!({
        "success": true,
        "source": outcome.source,
        "refName": outcome.ref_name,
        "scope": outcome.scope,
        "installRoot": outcome.install_root,
        "installed": outcome.installed,
        "verified": verified,
        "activationReady": true,
    }))
}

fn enrich_market_install_provenance(
    mut provenance: Value,
    outcome: &InstallSkillsFromRepoOutcome,
) -> Value {
    if !provenance.is_object() {
        provenance = json!({});
    }
    let Some(object) = provenance.as_object_mut() else {
        return provenance;
    };
    object
        .entry("scope".to_string())
        .or_insert_with(|| json!(outcome.scope.clone()));
    object
        .entry("installRoot".to_string())
        .or_insert_with(|| json!(outcome.install_root.clone()));
    object
        .entry("installedAt".to_string())
        .or_insert_with(|| json!(now_iso()));
    object.insert(
        "installedSkillNames".to_string(),
        json!(outcome
            .installed
            .iter()
            .map(|skill| skill.name.clone())
            .collect::<Vec<_>>()),
    );
    object.insert(
        "installedSkillLocations".to_string(),
        json!(outcome
            .installed
            .iter()
            .map(|skill| skill.path.clone())
            .collect::<Vec<_>>()),
    );
    provenance
}

fn installed_skill_matches_record(
    installed: &InstalledRepoSkill,
    skill_name: &str,
    skill_location: &str,
) -> bool {
    if skill_name.eq_ignore_ascii_case(&installed.name) {
        return true;
    }
    let record_path = skill_location
        .strip_prefix("file:")
        .unwrap_or(skill_location);
    !record_path.is_empty() && record_path == installed.path
}

fn enable_installed_market_skills(
    state: &State<'_, AppState>,
    installed: &[InstalledRepoSkill],
) -> Result<(), String> {
    with_store_mut(state, |store| {
        for skill in &mut store.skills {
            if installed
                .iter()
                .any(|item| installed_skill_matches_record(item, &skill.name, &skill.location))
            {
                skill.disabled = Some(false);
            }
        }
        Ok(())
    })
}

fn verify_installed_market_skills(
    state: &State<'_, AppState>,
    installed: &[InstalledRepoSkill],
) -> Result<Vec<InstalledMarketSkillVerification>, String> {
    with_store(state, |store| {
        Ok(installed
            .iter()
            .map(|installed_skill| {
                let record = store.skills.iter().find(|skill| {
                    installed_skill_matches_record(installed_skill, &skill.name, &skill.location)
                });
                let disabled = record.and_then(|skill| skill.disabled).unwrap_or(false);
                InstalledMarketSkillVerification {
                    name: record
                        .map(|skill| skill.name.clone())
                        .unwrap_or_else(|| installed_skill.name.clone()),
                    requested_name: installed_skill.name.clone(),
                    found: record.is_some(),
                    activation_ready: record.is_some() && !disabled,
                    location: record.map(|skill| skill.location.clone()),
                    source_scope: record.and_then(|skill| skill.source_scope.clone()),
                    disabled,
                }
            })
            .collect())
    })
}

fn ensure_market_install_activation_ready(
    outcome: &InstallSkillsFromRepoOutcome,
    verified: &[InstalledMarketSkillVerification],
) -> Result<(), String> {
    if outcome.installed.is_empty() {
        return Err("技能安装未返回任何 SKILL.md".to_string());
    }
    if let Some(missing) = verified.iter().find(|skill| !skill.found) {
        return Err(format!(
            "技能已写入 {}，但刷新后未被技能目录识别: {}",
            outcome.install_root, missing.requested_name
        ));
    }
    if let Some(disabled) = verified.iter().find(|skill| !skill.activation_ready) {
        return Err(format!("技能已安装但未启用: {}", disabled.name));
    }
    Ok(())
}

fn skill_market_sources(state: &State<'_, AppState>) -> Result<Vec<SkillMarketSource>, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let Some(value) = settings.get(SETTINGS_SKILL_MARKET_SOURCES_KEY) else {
        return Ok(default_skill_market_sources());
    };
    let mut sources = serde_json::from_value::<Vec<SkillMarketSource>>(value.clone())
        .map_err(|error| format!("技能市场源配置无效: {error}"))?;
    sanitize_market_sources(&mut sources);
    Ok(sources)
}

fn persisted_or_default_market_sources(
    state: &State<'_, AppState>,
) -> Result<Vec<SkillMarketSource>, String> {
    skill_market_sources(state)
}

fn persist_skill_market_sources(
    state: &State<'_, AppState>,
    sources: &[SkillMarketSource],
) -> Result<(), String> {
    with_store_mut(state, |store| {
        settings_store::update_settings(store, |settings| {
            if !settings.is_object() {
                *settings = json!({});
            }
            if let Some(object) = settings.as_object_mut() {
                object.insert(
                    SETTINGS_SKILL_MARKET_SOURCES_KEY.to_string(),
                    serde_json::to_value(sources).unwrap_or_else(|_| json!([])),
                );
            }
        });
        Ok(())
    })
}

fn default_skill_market_sources() -> Vec<SkillMarketSource> {
    vec![
        SkillMarketSource {
            id: "redbox-official".to_string(),
            name: "RedBox 精选市场".to_string(),
            kind: "redbox-server".to_string(),
            enabled: true,
            priority: 0,
            trust_level: "official".to_string(),
            source: Some(REDBOX_SERVER_SKILL_MARKET_URL.to_string()),
            registry_url: None,
            repo: None,
            ref_name: None,
            description: Some("RedBox 官方精选技能市场".to_string()),
        },
        SkillMarketSource {
            id: "redskill-official".to_string(),
            name: "小红书 RedSkill 官方".to_string(),
            kind: "redskill-cli".to_string(),
            enabled: true,
            priority: 20,
            trust_level: "official".to_string(),
            source: Some(REDSKILL_INSTALL_SCRIPT_URL.to_string()),
            registry_url: None,
            repo: None,
            ref_name: None,
            description: Some(
                "Install official RedSkill packages by identifier through the redskill CLI"
                    .to_string(),
            ),
        },
    ]
}

fn legacy_thrive_source_for_url(url: Option<String>) -> SkillMarketSource {
    SkillMarketSource {
        id: "legacy-thrive-url".to_string(),
        name: "Legacy Thrive".to_string(),
        kind: "legacy-thrive".to_string(),
        enabled: true,
        priority: 100,
        trust_level: "community".to_string(),
        source: None,
        registry_url: url.or_else(|| Some(THRIVE_SKILL_DEFAULT_REGISTRY_URL.to_string())),
        repo: None,
        ref_name: None,
        description: Some("Legacy Thrive compatibility registry".to_string()),
    }
}

fn sanitize_market_sources(sources: &mut Vec<SkillMarketSource>) {
    for source in sources.iter_mut() {
        source.id = slugish(&source.id);
        if source.id.is_empty() {
            source.id = slugish(&source.name);
        }
        if source.name.trim().is_empty() {
            source.name = source.id.clone();
        }
        if source.kind.trim().is_empty() {
            source.kind = "url".to_string();
        }
        if source.trust_level.trim().is_empty() {
            source.trust_level = "community".to_string();
        }
    }
    sources.retain(|source| !is_retired_builtin_market_source(source));
    sources.sort_by_key(|item| item.priority);
    sources.dedup_by(|left, right| left.id == right.id);
}

fn is_retired_builtin_market_source(source: &SkillMarketSource) -> bool {
    if source.id == LEGACY_THRIVE_MARKET_SOURCE_ID {
        return true;
    }
    source.kind == "legacy-thrive"
        && source
            .registry_url
            .as_deref()
            .or(source.source.as_deref())
            .is_some_and(|url| url.trim() == THRIVE_SKILL_DEFAULT_REGISTRY_URL)
}

fn source_from_request(
    request: SkillMarketplaceSourceRequest,
    existing: Option<SkillMarketSource>,
) -> Result<SkillMarketSource, String> {
    let mut source = existing.unwrap_or_default();
    if let Some(name) = request.name {
        source.name = name.trim().to_string();
    }
    if let Some(kind) = request.kind {
        source.kind = kind.trim().to_ascii_lowercase();
    }
    if let Some(value) = request.enabled {
        source.enabled = value;
    }
    if let Some(value) = request.priority {
        source.priority = value;
    }
    if let Some(value) = request.trust_level {
        source.trust_level = value.trim().to_ascii_lowercase();
    }
    if let Some(value) = request.description {
        source.description = non_empty_string(&value);
    }
    if let Some(value) = request.source {
        source.source = non_empty_string(&value);
    }
    if let Some(value) = request.registry_url {
        source.registry_url = non_empty_string(&value);
    }
    if let Some(value) = request.repo {
        source.repo = non_empty_string(&value);
    }
    if let Some(value) = request.ref_name.or(request.ref_alias) {
        source.ref_name = non_empty_string(&value);
    }
    source.id = request
        .id
        .as_deref()
        .map(slugish)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| slugish(&source.name));
    if source.id.is_empty() {
        source.id = slugish(
            source
                .repo
                .as_deref()
                .or(source.source.as_deref())
                .or(source.registry_url.as_deref())
                .unwrap_or("skill-market"),
        );
    }
    validate_market_source(&source)?;
    Ok(source)
}

fn validate_market_source(source: &SkillMarketSource) -> Result<(), String> {
    if source.id.trim().is_empty() {
        return Err("市场源 id 不能为空".to_string());
    }
    match source.kind.as_str() {
        "legacy-thrive" | "url" => {
            if let Some(url) = source.registry_url.as_deref().or(source.source.as_deref()) {
                validate_safe_market_url(url)?;
            }
        }
        "github" | "git" => {
            if source
                .repo
                .as_deref()
                .or(source.source.as_deref())
                .is_none()
            {
                return Err("GitHub 市场源必须提供 repo 或 source".to_string());
            }
        }
        "redbox-server" => {
            validate_redbox_server_market_url(&redbox_server_skill_market_base_url(source)?)?;
        }
        "redskill-cli" => {}
        "local" => {
            let path = source
                .source
                .as_deref()
                .ok_or_else(|| "本地市场源必须提供 source 路径".to_string())?;
            if !resolve_local_market_root(path)?.is_dir() {
                return Err("本地市场源路径不存在".to_string());
            }
        }
        other => return Err(format!("不支持的技能市场源类型: {other}")),
    }
    Ok(())
}

fn unique_source_id(existing: &[SkillMarketSource], desired: &str) -> String {
    let base = if desired.trim().is_empty() {
        "skill-market".to_string()
    } else {
        desired.to_string()
    };
    let existing_ids = existing
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    if !existing_ids.contains(base.as_str()) {
        return base;
    }
    for index in 2..200 {
        let candidate = format!("{base}-{index}");
        if !existing_ids.contains(candidate.as_str()) {
            return candidate;
        }
    }
    format!("{base}-{}", now_ms())
}

fn load_skill_market_source_items(
    source: &SkillMarketSource,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    match source.kind.as_str() {
        "legacy-thrive" => {
            let url = source
                .registry_url
                .as_deref()
                .or(source.source.as_deref())
                .unwrap_or(THRIVE_SKILL_DEFAULT_REGISTRY_URL);
            legacy_entries_to_items(source, load_legacy_thrive_entries(url)?, installed)
        }
        "local" => load_local_redbox_market_items(source, installed),
        "github" | "git" => load_github_redbox_market_items(source, installed),
        "redbox-server" => load_redbox_server_market_items(source, installed),
        "redskill-cli" => Ok(Vec::new()),
        "url" => load_url_market_items(source, installed),
        other => Err(format!("不支持的技能市场源类型: {other}")),
    }
}

fn load_skill_market_source_collections(
    source: &SkillMarketSource,
) -> Result<Vec<SkillMarketCollection>, String> {
    match source.kind.as_str() {
        "redbox-server" => load_redbox_server_market_collections(source),
        _ => Ok(Vec::new()),
    }
}

fn load_redbox_server_market_collections(
    source: &SkillMarketSource,
) -> Result<Vec<SkillMarketCollection>, String> {
    let base = redbox_server_skill_market_base_url(source)?;
    let value =
        match http_get_redbox_server_json::<Value>(&format!("{base}/collections?page_size=50")) {
            Ok(value) => value,
            Err(error) if error.contains("HTTP 404") => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
    let entries = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "RedBox skill collection response is missing items".to_string())?;
    Ok(entries
        .iter()
        .filter_map(|entry| redbox_server_collection_to_item(source, entry).ok())
        .collect())
}

fn redbox_server_collection_to_item(
    source: &SkillMarketSource,
    entry: &Value,
) -> Result<SkillMarketCollection, String> {
    let collection_key = value_first_string(entry, &["collection_key", "collectionKey", "id"])
        .ok_or_else(|| "RedBox skill collection missing collection_key".to_string())?;
    let title =
        value_first_string(entry, &["title", "name"]).unwrap_or_else(|| collection_key.clone());
    let package_keys = value_string_list(
        entry
            .get("package_keys")
            .or_else(|| entry.get("packageKeys"))
            .or_else(|| entry.get("packages")),
    );
    let publisher = entry.get("publisher");
    let xiaohongshu_profile = publisher.and_then(|publisher| {
        publisher
            .get("xiaohongshu_profile")
            .or_else(|| publisher.get("xiaohongshuProfile"))
    });
    let author = xiaohongshu_profile
        .and_then(|profile| {
            value_first_string(profile, &["nickname", "display_name", "displayName"])
        })
        .or_else(|| {
            publisher.and_then(|publisher| {
                value_first_string(
                    publisher,
                    &[
                        "display_name",
                        "displayName",
                        "publisher_key",
                        "publisherKey",
                    ],
                )
            })
        });
    let author_avatar_url = xiaohongshu_profile
        .and_then(|profile| {
            value_first_string(
                profile,
                &["avatar_url", "avatarUrl", "image_url", "imageUrl"],
            )
        })
        .or_else(|| {
            publisher.and_then(|publisher| {
                value_first_string(
                    publisher,
                    &[
                        "avatar_url",
                        "avatarUrl",
                        "logo_url",
                        "logoUrl",
                        "image_url",
                        "imageUrl",
                    ],
                )
            })
        });
    let author_homepage_url = xiaohongshu_profile
        .and_then(|profile| {
            value_first_string(
                profile,
                &[
                    "profile_url",
                    "profileUrl",
                    "homepage_url",
                    "homepageUrl",
                    "url",
                ],
            )
        })
        .or_else(|| {
            publisher.and_then(|publisher| {
                value_first_string(
                    publisher,
                    &[
                        "homepage_url",
                        "homepageUrl",
                        "profile_url",
                        "profileUrl",
                        "url",
                    ],
                )
            })
        });
    let source_value = entry.get("source");
    let market_name = source_value
        .and_then(|source_value| value_first_string(source_value, &["display_name", "displayName"]))
        .unwrap_or_else(|| source.name.clone());
    Ok(SkillMarketCollection {
        id: scoped_market_item_id(&source.id, &collection_key),
        collection_key,
        market_id: source.id.clone(),
        market_name,
        source_kind: source.kind.clone(),
        title,
        subtitle: value_first_string(
            entry,
            &["subtitle", "short_description", "shortDescription"],
        ),
        description: value_first_string(entry, &["description"]),
        avatar_url: value_first_string(
            entry,
            &["avatar_url", "avatarUrl", "image_url", "imageUrl"],
        ),
        cover_url: value_first_string(
            entry,
            &["cover_url", "coverUrl", "thumbnail_url", "thumbnailUrl"],
        ),
        homepage_url: value_first_string(entry, &["homepage_url", "homepageUrl"]),
        external_url: value_first_string(entry, &["external_url", "externalUrl", "url"]),
        author,
        author_avatar_url,
        author_homepage_url,
        skill_count: value_first_usize(entry, &["skill_count", "skillCount"])
            .unwrap_or(package_keys.len()),
        package_keys,
        tags: value_string_list(entry.get("tags")),
    })
}

fn installed_market_state<'a>(
    installed: &'a HashMap<String, InstalledMarketProvenance>,
    market_id: &str,
    skill_name: &str,
    package_id: &str,
) -> Option<&'a InstalledMarketProvenance> {
    installed
        .get(&scoped_market_item_id(market_id, package_id).to_ascii_lowercase())
        .or_else(|| installed.get(&package_id.to_ascii_lowercase()))
        .or_else(|| installed.get(&skill_name.to_ascii_lowercase()))
}

fn installed_market_skill_names(state: Option<&InstalledMarketProvenance>) -> Vec<String> {
    state
        .map(|value| {
            value
                .installed_skill_names
                .iter()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn load_url_market_items(
    source: &SkillMarketSource,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    let url = source
        .registry_url
        .as_deref()
        .or(source.source.as_deref())
        .ok_or_else(|| "URL 市场源缺少 registryUrl".to_string())?;
    let value = http_get_skill_marketplace_json::<Value>(url)?;
    if let Ok(entries) = serde_json::from_value::<Vec<ThriveSkillMarketplaceEntry>>(value.clone()) {
        return legacy_entries_to_items(source, entries, installed);
    }
    let entries = redbox_registry_entries_from_value(value)?;
    redbox_entries_to_items(source, entries, None, installed)
}

fn load_legacy_thrive_entries(url: &str) -> Result<Vec<ThriveSkillMarketplaceEntry>, String> {
    http_get_skill_marketplace_json::<Vec<ThriveSkillMarketplaceEntry>>(url)
}

fn legacy_entries_to_items(
    source: &SkillMarketSource,
    entries: Vec<ThriveSkillMarketplaceEntry>,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    Ok(entries
        .into_iter()
        .map(|entry| {
            let package_id = entry.id.clone();
            let installed_state =
                installed_market_state(installed, &source.id, &entry.name, &package_id);
            let installed_version = installed_state.and_then(|value| value.version.clone());
            let installed_skill_names = installed_market_skill_names(installed_state);
            let installed = installed_state.is_some();
            SkillMarketItem {
                id: scoped_market_item_id(&source.id, &package_id),
                package_id,
                market_id: source.id.clone(),
                market_name: source.name.clone(),
                source_kind: source.kind.clone(),
                name: entry.name,
                author: entry.author,
                author_avatar_url: None,
                author_homepage_url: None,
                author_bio: None,
                author_verified: false,
                intro_note: None,
                description: entry.description,
                avatar_url: first_avatar_url(&[
                    entry.avatar_url.as_deref(),
                    entry.icon_url.as_deref(),
                    entry.logo_url.as_deref(),
                    entry.image_url.as_deref(),
                    entry.thumbnail_url.as_deref(),
                ]),
                repo: Some(entry.repo),
                ref_name: source.ref_name.clone(),
                paths: Vec::new(),
                version: None,
                kind: REDBOX_MARKET_KIND_SKILL_PACK.to_string(),
                channel: None,
                tags: Vec::new(),
                risk_level: Some("high".to_string()),
                trust_level: source.trust_level.clone(),
                manifest_path: None,
                package_path: None,
                installed,
                installed_skill_names,
                installed_version,
                update_available: false,
                installable: true,
                error: None,
            }
        })
        .collect())
}

fn load_local_redbox_market_items(
    source: &SkillMarketSource,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    let root = resolve_local_market_root(
        source
            .source
            .as_deref()
            .ok_or_else(|| "本地市场源缺少 source".to_string())?,
    )?;
    let path = root
        .join("registry")
        .join("kinds")
        .join(format!("{REDBOX_MARKET_KIND_SKILL_PACK}.json"));
    let raw = fs::read_to_string(&path).map_err(|error| {
        format!(
            "failed to read RedBox skill registry `{}`: {error}",
            path.display()
        )
    })?;
    let entries = redbox_registry_entries_from_value(
        serde_json::from_str::<Value>(&raw)
            .map_err(|error| format!("failed to parse `{}`: {error}", path.display()))?,
    )?;
    redbox_entries_to_items(source, entries, Some(root), installed)
}

fn load_github_redbox_market_items(
    source: &SkillMarketSource,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    let base = github_raw_base(source)?;
    let registry_url = format!("{base}/registry/kinds/{REDBOX_MARKET_KIND_SKILL_PACK}.json");
    let entries = redbox_registry_entries_from_value(http_get_skill_marketplace_json::<Value>(
        &registry_url,
    )?)?;
    redbox_entries_to_items(source, entries, None, installed)
}

fn load_redbox_server_market_items(
    source: &SkillMarketSource,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    let base = redbox_server_skill_market_base_url(source)?;
    let value = http_get_redbox_server_json::<Value>(&format!("{base}/skills?page_size=200"))?;
    let entries = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "RedBox skill market response is missing items".to_string())?;
    let mut items = Vec::new();
    for entry in entries {
        items.push(redbox_server_entry_to_item(source, entry, installed)?);
    }
    Ok(items)
}

fn redbox_server_entry_to_item(
    source: &SkillMarketSource,
    entry: &Value,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<SkillMarketItem, String> {
    let package_id = value_first_string(entry, &["package_key", "packageKey", "id"])
        .ok_or_else(|| "RedBox skill entry missing package_key".to_string())?;
    let name = value_first_string(entry, &["title", "name"]).unwrap_or_else(|| package_id.clone());
    let description = value_first_string(entry, &["short_description", "shortDescription"])
        .or_else(|| value_first_string(entry, &["description"]))
        .unwrap_or_default();
    let version = value_first_string(entry, &["latest_version", "latestVersion"]);
    let publisher = entry.get("publisher");
    let xiaohongshu_profile = publisher.and_then(|publisher| {
        publisher
            .get("xiaohongshu_profile")
            .or_else(|| publisher.get("xiaohongshuProfile"))
    });
    let author = xiaohongshu_profile
        .and_then(|profile| {
            value_first_string(profile, &["nickname", "display_name", "displayName"])
        })
        .or_else(|| {
            publisher.and_then(|publisher| {
                value_first_string(
                    publisher,
                    &[
                        "display_name",
                        "displayName",
                        "publisher_key",
                        "publisherKey",
                    ],
                )
            })
        })
        .unwrap_or_else(|| "RedBox".to_string());
    let author_avatar_url = xiaohongshu_profile
        .and_then(|profile| {
            value_first_string(
                profile,
                &["avatar_url", "avatarUrl", "image_url", "imageUrl"],
            )
        })
        .or_else(|| {
            publisher.and_then(|publisher| {
                value_first_string(
                    publisher,
                    &[
                        "avatar_url",
                        "avatarUrl",
                        "logo_url",
                        "logoUrl",
                        "image_url",
                        "imageUrl",
                    ],
                )
            })
        });
    let author_homepage_url = xiaohongshu_profile
        .and_then(|profile| {
            value_first_string(
                profile,
                &[
                    "profile_url",
                    "profileUrl",
                    "homepage_url",
                    "homepageUrl",
                    "url",
                ],
            )
        })
        .or_else(|| {
            publisher.and_then(|publisher| {
                value_first_string(
                    publisher,
                    &[
                        "homepage_url",
                        "homepageUrl",
                        "profile_url",
                        "profileUrl",
                        "url",
                    ],
                )
            })
        });
    let author_bio = xiaohongshu_profile
        .and_then(|profile| value_first_string(profile, &["bio", "description"]))
        .or_else(|| {
            publisher.and_then(|publisher| value_first_string(publisher, &["bio", "description"]))
        });
    let author_verified = publisher
        .and_then(|publisher| {
            value_first_bool(publisher, &["verified", "is_verified", "isVerified"])
        })
        .unwrap_or(false);
    let avatar_url = value_first_string(
        entry,
        &[
            "avatar_url",
            "avatarUrl",
            "icon_url",
            "iconUrl",
            "logo_url",
            "logoUrl",
            "image_url",
            "imageUrl",
            "thumbnail_url",
            "thumbnailUrl",
        ],
    )
    .or_else(|| author_avatar_url.clone());
    let source_value = entry.get("source");
    let source_key = source_value.and_then(|source_value| {
        value_first_string(source_value, &["source_key", "sourceKey", "key"])
    });
    let market_name = source_value
        .and_then(|source_value| value_first_string(source_value, &["display_name", "displayName"]))
        .unwrap_or_else(|| source.name.clone());
    let mut tags = value_string_list(entry.get("tags"));
    let is_redskill_entry = source_key.as_deref().is_some_and(is_redskill_market_label)
        || is_redskill_market_label(&market_name)
        || is_redskill_market_label(&source.id)
        || is_redskill_market_label(&source.name);
    if is_redskill_entry {
        canonicalize_redskill_tags(&mut tags);
    }
    tags.sort();
    tags.dedup();
    let installed_state = installed_market_state(installed, &source.id, &name, &package_id);
    let installed_version = installed_state.and_then(|value| value.version.clone());
    let installed_skill_names = installed_market_skill_names(installed_state);
    let update_available = installed_version
        .as_deref()
        .zip(version.as_deref())
        .is_some_and(|(left, right)| left != right);
    Ok(SkillMarketItem {
        id: scoped_market_item_id(&source.id, &package_id),
        package_id,
        market_id: source.id.clone(),
        market_name,
        source_kind: source.kind.clone(),
        name,
        author,
        author_avatar_url,
        author_homepage_url,
        author_bio,
        author_verified,
        intro_note: entry
            .get("intro_note")
            .or_else(|| entry.get("introNote"))
            .cloned(),
        description,
        avatar_url,
        repo: None,
        ref_name: None,
        paths: Vec::new(),
        version,
        kind: REDBOX_MARKET_KIND_SKILL_PACK.to_string(),
        channel: Some("official".to_string()),
        tags,
        risk_level: value_first_string(entry, &["risk_level", "riskLevel"])
            .or_else(|| Some("low".to_string())),
        trust_level: source.trust_level.clone(),
        manifest_path: None,
        package_path: None,
        installed: installed_state.is_some(),
        installed_skill_names,
        installed_version,
        update_available,
        installable: true,
        error: None,
    })
}

fn redbox_registry_entries_from_value(
    value: Value,
) -> Result<Vec<RedboxSkillRegistryEntry>, String> {
    if value.is_array() {
        return serde_json::from_value(value).map_err(|error| error.to_string());
    }
    if let Some(packages) = value.get("packages").cloned().filter(Value::is_array) {
        return serde_json::from_value(packages).map_err(|error| error.to_string());
    }
    if let Some(items) = value.get("items").cloned().filter(Value::is_array) {
        return serde_json::from_value(items).map_err(|error| error.to_string());
    }
    Err("RedBox skill registry must be an array or contain packages/items".to_string())
}

fn redbox_entries_to_items(
    source: &SkillMarketSource,
    entries: Vec<RedboxSkillRegistryEntry>,
    local_root: Option<PathBuf>,
    installed: &HashMap<String, InstalledMarketProvenance>,
) -> Result<Vec<SkillMarketItem>, String> {
    let mut items = Vec::new();
    for entry in entries {
        let manifest = read_redbox_manifest_for_entry(source, &entry, local_root.as_deref())
            .ok()
            .flatten()
            .unwrap_or_default();
        let package_id = first_non_empty([
            manifest.package_id.as_deref(),
            manifest.id.as_deref(),
            entry.package_id.as_deref(),
            entry.id.as_deref(),
            entry.package_path.as_deref(),
            entry.manifest_path.as_deref(),
            entry.path.as_deref(),
        ])
        .ok_or_else(|| "skill-pack registry entry is missing id".to_string())?;
        let name = first_non_empty([
            manifest.display_name.as_deref(),
            manifest.title.as_deref(),
            manifest.name.as_deref(),
            entry.display_name.as_deref(),
            entry.title.as_deref(),
            entry.name.as_deref(),
            Some(package_id.as_str()),
        ])
        .unwrap_or(package_id.clone());
        let version = manifest.version.clone().or(entry.version.clone());
        let manifest_path = entry.manifest_path.clone().or_else(|| {
            entry
                .package_path
                .as_deref()
                .map(|path| format!("{}/manifest.json", path.trim_end_matches('/')))
        });
        let package_path = entry.package_path.clone().or_else(|| {
            manifest_path
                .as_deref()
                .and_then(|path| path.rsplit_once('/').map(|(dir, _)| dir.to_string()))
        });
        let paths = skill_paths_for_redbox_package(&entry, &manifest, package_path.as_deref());
        let repo = manifest
            .repo
            .clone()
            .or(manifest.source.clone())
            .or(entry.repo.clone())
            .or(entry.source.clone());
        let avatar_url = first_avatar_url(&[
            manifest.avatar_url.as_deref(),
            manifest.icon_url.as_deref(),
            manifest.logo_url.as_deref(),
            manifest.image_url.as_deref(),
            manifest.thumbnail_url.as_deref(),
            entry.avatar_url.as_deref(),
            entry.icon_url.as_deref(),
            entry.logo_url.as_deref(),
            entry.image_url.as_deref(),
            entry.thumbnail_url.as_deref(),
        ]);
        let installed_state = installed_market_state(installed, &source.id, &name, &package_id);
        let installed_version = installed_state.and_then(|value| value.version.clone());
        let installed_skill_names = installed_market_skill_names(installed_state);
        let installed_match = installed_state.is_some();
        let update_available = installed_version
            .as_deref()
            .zip(version.as_deref())
            .is_some_and(|(left, right)| left != right);
        let mut tags = entry.tags.clone();
        tags.extend(entry.keywords.clone());
        tags.extend(manifest.tags.clone());
        tags.extend(manifest.keywords.clone());
        tags.sort();
        tags.dedup();
        items.push(SkillMarketItem {
            id: scoped_market_item_id(&source.id, &package_id),
            package_id,
            market_id: source.id.clone(),
            market_name: source.name.clone(),
            source_kind: source.kind.clone(),
            name,
            author: manifest
                .author
                .clone()
                .or(entry.author)
                .clone()
                .unwrap_or_else(|| "Unknown".to_string()),
            author_avatar_url: None,
            author_homepage_url: None,
            author_bio: None,
            author_verified: false,
            intro_note: None,
            description: manifest
                .description
                .clone()
                .or(entry.description.clone())
                .unwrap_or_default(),
            avatar_url,
            repo,
            ref_name: manifest
                .ref_name
                .clone()
                .or(manifest.ref_alias.clone())
                .or(entry.ref_name.clone())
                .or(entry.ref_alias.clone()),
            paths,
            version,
            kind: manifest
                .kind
                .clone()
                .or(entry.kind)
                .clone()
                .unwrap_or_else(|| REDBOX_MARKET_KIND_SKILL_PACK.to_string()),
            channel: manifest.channel.clone().or(entry.channel.clone()),
            tags,
            risk_level: manifest
                .risk_level
                .clone()
                .or(entry.risk_level.clone())
                .or_else(|| Some("high".to_string())),
            trust_level: source.trust_level.clone(),
            manifest_path,
            package_path,
            installed: installed_match,
            installed_skill_names,
            installed_version,
            update_available,
            installable: true,
            error: None,
        });
    }
    Ok(items)
}

fn read_redbox_manifest_for_entry(
    source: &SkillMarketSource,
    entry: &RedboxSkillRegistryEntry,
    local_root: Option<&Path>,
) -> Result<Option<RedboxSkillManifest>, String> {
    let manifest_path = entry.manifest_path.clone().or_else(|| {
        entry
            .package_path
            .as_deref()
            .map(|path| format!("{}/manifest.json", path.trim_end_matches('/')))
    });
    let Some(manifest_path) = manifest_path else {
        return Ok(None);
    };
    let value = match local_root {
        Some(root) => {
            let path = safe_join(root, &manifest_path)?;
            if !path.is_file() {
                return Ok(None);
            }
            let raw = fs::read_to_string(&path).map_err(|error| {
                format!("failed to read manifest `{}`: {error}", path.display())
            })?;
            serde_json::from_str::<Value>(&raw).map_err(|error| {
                format!("failed to parse manifest `{}`: {error}", path.display())
            })?
        }
        None => {
            let base = github_raw_base(source)?;
            http_get_skill_marketplace_json::<Value>(&format!(
                "{}/{}",
                base,
                manifest_path.trim_start_matches('/')
            ))?
        }
    };
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| format!("failed to parse skill-pack manifest: {error}"))
}

fn read_market_item_manifest_value(
    source: &SkillMarketSource,
    item: &SkillMarketItem,
) -> Result<Value, String> {
    let Some(manifest_path) = item.manifest_path.as_deref() else {
        return Ok(Value::Null);
    };
    match source.kind.as_str() {
        "local" => {
            let root = resolve_local_market_root(
                source
                    .source
                    .as_deref()
                    .ok_or_else(|| "本地市场源缺少 source".to_string())?,
            )?;
            let path = safe_join(&root, manifest_path)?;
            let raw = fs::read_to_string(&path).map_err(|error| {
                format!("failed to read manifest `{}`: {error}", path.display())
            })?;
            serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())
        }
        "github" | "git" => {
            let base = github_raw_base(source)?;
            http_get_skill_marketplace_json::<Value>(&format!(
                "{}/{}",
                base,
                manifest_path.trim_start_matches('/')
            ))
        }
        _ => Ok(Value::Null),
    }
}

fn skill_paths_for_redbox_package(
    entry: &RedboxSkillRegistryEntry,
    manifest: &RedboxSkillManifest,
    package_path: Option<&str>,
) -> Vec<String> {
    let mut paths = Vec::new();
    for value in entry.skills.iter().chain(manifest.skills.iter()) {
        if let Some(path) = value.as_str() {
            paths.push(path.to_string());
        } else if let Some(path) = value
            .get("path")
            .or_else(|| value.get("skillPath"))
            .or_else(|| value.get("root"))
            .and_then(Value::as_str)
        {
            paths.push(path.to_string());
        }
    }
    if paths.is_empty() {
        if let Some(package_path) = package_path {
            paths.push(package_path.to_string());
        }
    }
    paths
        .into_iter()
        .filter_map(|path| normalize_registry_path(&path))
        .collect()
}

fn installed_skill_index(
    state: &State<'_, AppState>,
) -> Result<HashMap<String, InstalledMarketProvenance>, String> {
    let skills = with_store(state, |store| Ok(store.skills.clone()))?;
    let workspace = workspace_root(state).ok();
    let mut index = HashMap::new();
    for skill in &skills {
        let provenance = skill_market_provenance_path(skill, workspace.as_deref())
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<InstalledMarketProvenance>(&raw).ok())
            .unwrap_or_default();
        for key in installed_skill_aliases(&skill.name, &provenance) {
            index.insert(key, provenance.clone());
        }
    }
    Ok(index)
}

fn skill_market_provenance_path(
    skill: &crate::runtime::SkillRecord,
    workspace_root: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = skill.location.strip_prefix("file:") {
        return PathBuf::from(path)
            .parent()
            .map(|dir| dir.join(MARKET_PROVENANCE_FILENAME));
    }
    resolve_skill_file_path(skill, workspace_root).and_then(|path| {
        path.parent()
            .map(|dir| dir.join(MARKET_PROVENANCE_FILENAME))
    })
}

fn installed_skill_aliases(
    skill_name: &str,
    provenance: &InstalledMarketProvenance,
) -> Vec<String> {
    let mut aliases = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();
    let mut push_alias = |value: Option<&str>| {
        let Some(alias) = value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase())
        else {
            return;
        };
        if seen.insert(alias.clone()) {
            aliases.push(alias);
        }
    };

    push_alias(Some(skill_name));
    push_alias(provenance.package_id.as_deref());
    for installed_name in &provenance.installed_skill_names {
        push_alias(Some(installed_name));
    }
    if let (Some(market_id), Some(package_id)) = (
        provenance.market_id.as_deref(),
        provenance.package_id.as_deref(),
    ) {
        push_alias(Some(scoped_market_item_id(market_id, package_id).as_str()));
    }
    aliases
}

fn write_market_provenance_for_installed(
    installed: &[InstalledRepoSkill],
    provenance: &Value,
) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(provenance).map_err(|error| error.to_string())?;
    for skill in installed {
        let path = PathBuf::from(&skill.path);
        let Some(parent) = path.parent() else {
            continue;
        };
        fs::write(parent.join(MARKET_PROVENANCE_FILENAME), &raw).map_err(|error| {
            format!(
                "failed to write skill market provenance for {}: {error}",
                skill.name
            )
        })?;
    }
    Ok(())
}

fn install_redbox_server_market_package(
    state: &State<'_, AppState>,
    source: &SkillMarketSource,
    package_id: &str,
    scope: Option<String>,
) -> Result<Value, String> {
    let base = redbox_server_skill_market_base_url(source)?;
    let package_segment = url_path_segment(package_id);
    let plan_url = format!("{base}/skills/{package_segment}/install-plan");
    let plan = http_post_redbox_server_json::<Value>(&plan_url, &json!({}))?;
    let version = plan.get("version").cloned().unwrap_or_else(|| json!({}));
    let artifact = plan.get("artifact").cloned().unwrap_or_else(|| json!({}));
    let download_url = value_first_string(&artifact, &["download_url", "downloadUrl"])
        .ok_or_else(|| "install plan missing artifact download_url".to_string())?;
    validate_redbox_artifact_url(&download_url)?;
    let expected_sha256 =
        value_first_string(&artifact, &["sha256", "artifact_sha256", "artifactSha256"]);
    let version_id = value_first_string(&version, &["id"]);
    let version_label = value_first_string(&version, &["version"]);
    record_redbox_server_install_event(source, package_id, version_id.as_deref(), "started", None);

    let install_result = (|| -> Result<Value, String> {
        let bytes = download_redbox_server_artifact(&download_url)?;
        if let Some(expected) = expected_sha256.as_deref().filter(|value| !value.is_empty()) {
            let actual = sha256_hex(&bytes);
            if !actual.eq_ignore_ascii_case(expected) {
                return Err("技能包 SHA256 校验失败".to_string());
            }
        }
        let staging_root = unique_market_download_root(package_id)?;
        let extracted_root = staging_root.join("extracted");
        fs::create_dir_all(&extracted_root)
            .map_err(|error| format!("failed to create skill market staging dir: {error}"))?;
        extract_redbox_server_artifact(
            &extracted_root,
            package_id,
            &download_url,
            &artifact,
            &bytes,
        )?;
        let provenance = json!({
            "marketId": source.id,
            "marketName": source.name,
            "packageId": package_id,
            "version": version_label,
            "kind": REDBOX_MARKET_KIND_SKILL_PACK,
            "sourceKind": source.kind.clone(),
            "serverBaseUrl": base,
            "artifactSha256": expected_sha256,
            "installedAt": now_iso(),
        });
        let outcome = install_market_item_from_repo(
            state,
            &extracted_root.display().to_string(),
            None,
            Vec::new(),
            scope,
            Some(provenance),
        );
        let _ = fs::remove_dir_all(&staging_root);
        let mut value = outcome?;
        if let Some(object) = value.as_object_mut() {
            object.insert("marketId".to_string(), json!(source.id));
            object.insert("marketName".to_string(), json!(source.name));
            object.insert("packageId".to_string(), json!(package_id));
            object.insert("installPlan".to_string(), plan.clone());
        }
        Ok(value)
    })();

    match install_result {
        Ok(value) => {
            record_redbox_server_install_event(
                source,
                package_id,
                version_id.as_deref(),
                "success",
                None,
            );
            Ok(value)
        }
        Err(error) => {
            record_redbox_server_install_event(
                source,
                package_id,
                version_id.as_deref(),
                "failed",
                Some(error.as_str()),
            );
            Err(error)
        }
    }
}

fn install_redskill_market_identifier(
    state: &State<'_, AppState>,
    source: &SkillMarketSource,
    identifier: &str,
) -> Result<Value, String> {
    validate_redskill_identifier(identifier)?;
    let workspace = workspace_root(state)?;
    let install_root = workspace.join("skills");
    let before_skill_files = skill_file_snapshot(&install_root);
    let started_at = SystemTime::now();
    let program = redskill_program();
    let mut command = background_command(&program);
    command
        .arg("install")
        .arg(identifier)
        .current_dir(&workspace);
    command.env("PATH", path_with_local_bin());
    let output = command.output().map_err(|error| {
        format!(
            "failed to run redskill. Install CLI first: curl -fsSL {} | bash. Error: {error}",
            source
                .source
                .as_deref()
                .unwrap_or(REDSKILL_INSTALL_SCRIPT_URL)
        )
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(format!(
            "redskill install {identifier} failed with status {}\nstdout:\n{}\nstderr:\n{}",
            output.status, stdout, stderr
        ));
    }
    refresh_skill_store_catalog(state)?;
    let candidate_files =
        redskill_candidate_skill_files(&install_root, &before_skill_files, started_at, identifier);
    let source_path = format!("redskill:{identifier}");
    let mut installed = installed_repo_skills_for_file_paths(
        state,
        &candidate_files,
        &source_path,
        &before_skill_files,
    )?;
    if installed.is_empty() {
        installed = installed_repo_skill_for_identifier(state, identifier, &source_path)?;
    }
    if installed.is_empty() {
        return Err(format!(
            "redskill install {identifier} completed, but RedBox could not discover the installed skill"
        ));
    }
    let outcome = InstallSkillsFromRepoOutcome {
        source: source.id.clone(),
        ref_name: None,
        scope: "workspace".to_string(),
        install_root: install_root.display().to_string(),
        installed,
    };
    let provenance = enrich_market_install_provenance(
        json!({
            "marketId": source.id.clone(),
            "marketName": source.name.clone(),
            "packageId": identifier,
            "kind": REDBOX_MARKET_KIND_SKILL_PACK,
            "sourceKind": source.kind.clone(),
            "identifier": identifier,
            "installedAt": now_iso(),
        }),
        &outcome,
    );
    write_market_provenance_for_installed(&outcome.installed, &provenance)?;
    enable_installed_market_skills(state, &outcome.installed)?;
    let verified = verify_installed_market_skills(state, &outcome.installed)?;
    ensure_market_install_activation_ready(&outcome, &verified)?;
    let _ = refresh_runtime_warm_state(state, &["wander", "redclaw", "team"]);
    Ok(json!({
        "success": true,
        "source": source.id,
        "marketId": source.id,
        "marketName": source.name,
        "packageId": identifier,
        "identifier": identifier,
        "scope": "workspace",
        "installRoot": outcome.install_root,
        "stdout": stdout,
        "stderr": stderr,
        "requiresAgentRestart": false,
        "installed": outcome.installed,
        "verified": verified,
        "activationReady": true,
    }))
}

fn skill_file_snapshot(root: &Path) -> HashSet<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return HashSet::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path().join("SKILL.md");
            path.is_file().then_some(path)
        })
        .collect()
}

fn redskill_candidate_skill_files(
    install_root: &Path,
    before: &HashSet<PathBuf>,
    started_at: SystemTime,
    identifier: &str,
) -> Vec<PathBuf> {
    let after = skill_file_snapshot(install_root);
    let threshold = started_at
        .checked_sub(Duration::from_secs(2))
        .unwrap_or(started_at);
    let mut candidates = Vec::<PathBuf>::new();
    let mut seen = HashSet::<PathBuf>::new();
    let mut push_candidate = |path: PathBuf| {
        if seen.insert(path.clone()) {
            candidates.push(path);
        }
    };
    for path in after {
        let recent = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map(|modified| modified >= threshold)
            .unwrap_or(false);
        if !before.contains(&path) || recent {
            push_candidate(path);
        }
    }
    let identifier_path = install_root
        .join(crate::slug_from_relative_path(identifier))
        .join("SKILL.md");
    if identifier_path.is_file() {
        push_candidate(identifier_path);
    }
    candidates
}

fn installed_repo_skills_for_file_paths(
    state: &State<'_, AppState>,
    skill_files: &[PathBuf],
    source_path: &str,
    before: &HashSet<PathBuf>,
) -> Result<Vec<InstalledRepoSkill>, String> {
    if skill_files.is_empty() {
        return Ok(Vec::new());
    }
    let path_keys = skill_files
        .iter()
        .map(|path| path.display().to_string())
        .collect::<HashSet<_>>();
    with_store(state, |store| {
        Ok(store
            .skills
            .iter()
            .filter_map(|skill| {
                let path = skill.location.strip_prefix("file:")?;
                if !path_keys.contains(path) {
                    return None;
                }
                Some(InstalledRepoSkill {
                    name: skill.name.clone(),
                    source_path: source_path.to_string(),
                    path: path.to_string(),
                    replaced: before.contains(&PathBuf::from(path)),
                })
            })
            .collect())
    })
}

fn installed_repo_skill_for_identifier(
    state: &State<'_, AppState>,
    identifier: &str,
    source_path: &str,
) -> Result<Vec<InstalledRepoSkill>, String> {
    let slug = crate::slug_from_relative_path(identifier);
    let suffix = format!("/{slug}/SKILL.md");
    with_store(state, |store| {
        Ok(store
            .skills
            .iter()
            .filter_map(|skill| {
                let path = skill.location.strip_prefix("file:")?;
                if !skill.name.eq_ignore_ascii_case(identifier) && !path.ends_with(&suffix) {
                    return None;
                }
                Some(InstalledRepoSkill {
                    name: skill.name.clone(),
                    source_path: source_path.to_string(),
                    path: path.to_string(),
                    replaced: true,
                })
            })
            .collect())
    })
}

fn validate_redskill_identifier(identifier: &str) -> Result<(), String> {
    let identifier = identifier.trim();
    if identifier.is_empty() {
        return Err("RedSkill identifier 不能为空".to_string());
    }
    if identifier.len() > 128 {
        return Err("RedSkill identifier 过长".to_string());
    }
    if !identifier
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':'))
    {
        return Err("RedSkill identifier 只能包含字母、数字、-、_、.、/、:".to_string());
    }
    Ok(())
}

fn redskill_program() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".local").join("bin").join("redskill"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("redskill"))
}

fn path_with_local_bin() -> String {
    let mut parts = Vec::<String>::new();
    if let Some(home) = dirs::home_dir() {
        parts.push(home.join(".local").join("bin").display().to_string());
    }
    if let Ok(path) = std::env::var("PATH") {
        parts.push(path);
    }
    parts.join(":")
}

fn local_source_path_for_install(source: &SkillMarketSource) -> Option<String> {
    if source.kind == "local" {
        source
            .source
            .as_deref()
            .and_then(|path| resolve_local_market_root(path).ok())
            .map(|path| path.display().to_string())
    } else {
        None
    }
}

fn resolve_local_market_root(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("本地市场源路径不能为空".to_string());
    }
    let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| "无法解析 home 目录".to_string())?
            .join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    fs::canonicalize(&expanded).map_err(|error| {
        format!(
            "failed to resolve local marketplace path `{}`: {error}",
            expanded.display()
        )
    })
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = normalize_registry_path(relative)
        .ok_or_else(|| format!("registry path escapes root: {relative}"))?;
    Ok(root.join(normalized))
}

fn normalize_registry_path(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_start_matches("./").trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn github_raw_base(source: &SkillMarketSource) -> Result<String, String> {
    let repo = source
        .repo
        .as_deref()
        .or(source.source.as_deref())
        .ok_or_else(|| "GitHub 市场源缺少 repo".to_string())?;
    let (owner, repo_name) = parse_github_owner_repo(repo)?;
    let ref_name = source.ref_name.as_deref().unwrap_or("main");
    Ok(format!(
        "https://raw.githubusercontent.com/{owner}/{repo_name}/{ref_name}"
    ))
}

fn parse_github_owner_repo(source: &str) -> Result<(String, String), String> {
    let mut value = source.trim().trim_end_matches('/').trim_end_matches(".git");
    if let Some(rest) = value.strip_prefix("https://github.com/") {
        value = rest;
    }
    if let Some(rest) = value.strip_prefix("git@github.com:") {
        value = rest;
    }
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return Err("GitHub 市场源 repo 必须是 owner/repo 或 github.com URL".to_string());
    }
    Ok((owner.to_string(), repo.to_string()))
}

fn skill_marketplace_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(THRIVE_SKILL_HTTP_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())
}

fn redbox_server_skill_market_base_url(source: &SkillMarketSource) -> Result<String, String> {
    let url = source
        .registry_url
        .as_deref()
        .or(source.source.as_deref())
        .unwrap_or(REDBOX_SERVER_SKILL_MARKET_URL)
        .trim()
        .trim_end_matches('/')
        .to_string();
    if url.is_empty() {
        return Err("RedBox 技能市场地址不能为空".to_string());
    }
    if url.ends_with("/skill-market") {
        return Ok(url);
    }
    if url.ends_with("/api/v1") {
        return Ok(format!("{url}/skill-market"));
    }
    Ok(format!("{url}/api/v1/skill-market"))
}

fn validate_safe_market_url(url: &str) -> Result<(), String> {
    if is_safe_skill_marketplace_url(url) {
        Ok(())
    } else {
        Err("skill marketplace registry must be a GitHub HTTPS URL".to_string())
    }
}

fn is_safe_skill_marketplace_url(url: &str) -> bool {
    url.starts_with("https://raw.githubusercontent.com/")
        || url.starts_with("https://github.com/")
        || url.starts_with("https://api.github.com/")
}

fn validate_redbox_server_market_url(url: &str) -> Result<(), String> {
    validate_https_non_private_url(url, "RedBox skill marketplace")
}

fn validate_redbox_artifact_url(url: &str) -> Result<(), String> {
    validate_https_non_private_url(url, "skill artifact")
}

fn validate_https_non_private_url(url: &str, label: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| format!("{label} URL 无效"))?;
    if parsed.scheme() != "https" {
        return Err(format!("{label} URL 必须使用 HTTPS"));
    }
    let Some(host) = parsed.host_str().map(|value| value.to_ascii_lowercase()) else {
        return Err(format!("{label} URL 缺少 host"));
    };
    if host == "localhost"
        || host.ends_with(".local")
        || host == "metadata.google.internal"
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || is_private_172_host(&host)
    {
        return Err(format!("{label} URL 不能指向内网地址"));
    }
    Ok(())
}

fn is_private_172_host(host: &str) -> bool {
    let Some(rest) = host.strip_prefix("172.") else {
        return false;
    };
    let Some(first) = rest.split('.').next() else {
        return false;
    };
    first
        .parse::<u8>()
        .is_ok_and(|value| (16..=31).contains(&value))
}

fn http_get_skill_marketplace_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    validate_safe_market_url(url)?;
    let response = skill_marketplace_http_client()?
        .get(url)
        .send()
        .map_err(|error| format!("failed to request `{url}`: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("request `{url}` failed with HTTP {status}"));
    }
    response
        .json::<T>()
        .map_err(|error| format!("failed to parse `{url}`: {error}"))
}

fn http_get_redbox_server_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    validate_redbox_server_market_url(url)?;
    let response = skill_marketplace_http_client()?
        .get(url)
        .send()
        .map_err(|error| format!("failed to request `{url}`: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("request `{url}` failed with HTTP {status}"));
    }
    response
        .json::<T>()
        .map_err(|error| format!("failed to parse `{url}`: {error}"))
}

fn http_post_redbox_server_json<T: for<'de> Deserialize<'de>>(
    url: &str,
    payload: &Value,
) -> Result<T, String> {
    validate_redbox_server_market_url(url)?;
    let response = skill_marketplace_http_client()?
        .post(url)
        .json(payload)
        .send()
        .map_err(|error| format!("failed to request `{url}`: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("request `{url}` failed with HTTP {status}"));
    }
    response
        .json::<T>()
        .map_err(|error| format!("failed to parse `{url}`: {error}"))
}

fn record_redbox_server_install_event(
    source: &SkillMarketSource,
    package_id: &str,
    version_id: Option<&str>,
    status: &str,
    error_code: Option<&str>,
) {
    let Ok(base) = redbox_server_skill_market_base_url(source) else {
        return;
    };
    let payload = json!({
        "package_key": package_id,
        "version_id": version_id,
        "status": status,
        "event_type": match status {
            "started" => "install_started",
            "failed" => "install_failed",
            _ => "install_success",
        },
        "client_kind": "desktop",
        "install_target": "local-skill-root",
        "request_id": format!("desktop-skill-market-{}-{}", package_id, now_ms()),
        "idempotency_key": format!("desktop:{}:{}:{}", package_id, status, now_ms()),
        "error_code": error_code,
    });
    let _ = http_post_redbox_server_json::<Value>(&format!("{base}/install-events"), &payload);
}

fn download_redbox_server_artifact(url: &str) -> Result<Vec<u8>, String> {
    validate_redbox_artifact_url(url)?;
    let response = skill_marketplace_http_client()?
        .get(url)
        .send()
        .map_err(|error| format!("failed to download skill artifact: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("skill artifact download failed with HTTP {status}"));
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("failed to read skill artifact: {error}"))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("技能包超过 25MB".to_string());
    }
    Ok(bytes.to_vec())
}

fn extract_redbox_server_artifact(
    target_root: &Path,
    package_id: &str,
    download_url: &str,
    artifact: &Value,
    bytes: &[u8],
) -> Result<(), String> {
    let content_type =
        value_first_string(artifact, &["content_type", "contentType"]).unwrap_or_default();
    let filename = value_first_string(artifact, &["filename", "file_name", "fileName"])
        .or_else(|| download_url.rsplit('/').next().map(ToString::to_string))
        .unwrap_or_else(|| "skill.zip".to_string());
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".md") || content_type.contains("markdown") {
        let dir = target_root.join(slugish(package_id));
        fs::create_dir_all(&dir).map_err(|error| format!("failed to create skill dir: {error}"))?;
        fs::write(dir.join("SKILL.md"), bytes)
            .map_err(|error| format!("failed to write SKILL.md: {error}"))?;
        return Ok(());
    }
    if lower.ends_with(".zip") || content_type.contains("zip") || bytes.starts_with(b"PK") {
        extract_zip_bytes(target_root, bytes)?;
        return Ok(());
    }
    if lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || content_type.contains("gzip")
        || bytes.starts_with(&[0x1f, 0x8b])
    {
        extract_tar_gz_bytes(target_root, bytes)?;
        return Ok(());
    }
    Err("不支持的技能包格式".to_string())
}

fn extract_zip_bytes(target_root: &Path, bytes: &[u8]) -> Result<(), String> {
    let reader = io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed) = file.enclosed_name().map(PathBuf::from) else {
            continue;
        };
        let target = safe_archive_target(target_root, &enclosed)?;
        if file.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|error| error.to_string())?;
        io::copy(&mut file, &mut out).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn extract_tar_gz_bytes(target_root: &Path, bytes: &[u8]) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(io::Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let entry_type = entry.header().entry_type();
        if !(entry_type.is_file() || entry_type.is_dir()) {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        let target = safe_archive_target(target_root, &path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        entry.unpack(&target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn safe_archive_target(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("技能包包含非法路径".to_string());
    }
    Ok(root.join(relative))
}

fn unique_market_download_root(package_id: &str) -> Result<PathBuf, String> {
    let root = preferred_user_skill_root()
        .join(".market-downloads")
        .join(format!("{}-{}", slugish(package_id), now_ms()));
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to create market download root: {error}"))?;
    Ok(root)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    format!("{digest:x}")
}

fn url_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => vec![byte as char],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn scoped_market_item_id(market_id: &str, package_id: &str) -> String {
    format!("{market_id}:{package_id}")
}

fn value_first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn value_first_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
}

fn value_first_usize(value: &Value, keys: &[&str]) -> Option<usize> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_u64)
            .and_then(|number| usize::try_from(number).ok())
    })
}

fn value_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn first_avatar_url(values: &[Option<&str>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn redskill_market_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-' && *character != '_')
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn is_redskill_market_label(value: &str) -> bool {
    redskill_market_key(value).contains("redskill")
}

fn is_redskill_tag_value(value: &str) -> bool {
    redskill_market_key(value) == "redskill"
}

fn canonicalize_redskill_tags(tags: &mut Vec<String>) {
    let mut has_redskill_tag = false;
    for tag in tags.iter_mut() {
        if is_redskill_tag_value(tag) {
            *tag = RED_SKILL_TAG_LABEL.to_string();
            has_redskill_tag = true;
        }
    }
    if !has_redskill_tag {
        tags.push(RED_SKILL_TAG_LABEL.to_string());
    }
}

fn marketplace_avatar_cache_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = state
        .store_path
        .parent()
        .ok_or_else(|| "store root is unavailable".to_string())?
        .join("skill-marketplace")
        .join("avatar-cache");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn normalize_marketplace_avatar_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("头像 URL 不能为空".to_string());
    }
    if trimmed.starts_with("data:image/") {
        if trimmed.len() > MARKETPLACE_AVATAR_CACHE_MAX_BYTES * 2 {
            return Err("头像 data URL 过大".to_string());
        }
        return Ok(trimmed.to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| "头像 URL 无效".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed.to_string()),
        _ => Err("头像 URL 必须是 http 或 https".to_string()),
    }
}

fn cached_marketplace_avatar_mime_type(meta_path: &Path) -> Option<String> {
    let raw = fs::read_to_string(meta_path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    value
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with("image/"))
        .map(ToString::to_string)
}

fn marketplace_avatar_mime_type(url: &str, content_type: Option<&str>) -> Result<String, String> {
    if let Some(mime_type) = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if mime_type.starts_with("image/") {
            return Ok(mime_type.to_string());
        }
        if mime_type != "application/octet-stream" {
            return Err("头像响应不是图片".to_string());
        }
    }
    infer_marketplace_avatar_mime_type(url).ok_or_else(|| "无法识别头像图片类型".to_string())
}

fn infer_marketplace_avatar_mime_type(url: &str) -> Option<String> {
    let path = reqwest::Url::parse(url)
        .ok()
        .map(|parsed| parsed.path().to_ascii_lowercase())
        .unwrap_or_else(|| url.to_ascii_lowercase());
    let mime = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".avif") {
        "image/avif"
    } else {
        return None;
    };
    Some(mime.to_string())
}

fn avatar_data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn first_non_empty(values: [Option<&str>; 7]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn non_empty_string(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn slugish(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in value.trim().chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_skill_aliases_include_market_package_identity() {
        let provenance = InstalledMarketProvenance {
            market_id: Some("redbox-official".to_string()),
            package_id: Some("yuelaoskill".to_string()),
            version: Some("1.0.0".to_string()),
            installed_skill_names: vec!["yuelao-report".to_string()],
            ..Default::default()
        };

        let aliases = installed_skill_aliases("yuelao", &provenance);

        assert!(aliases.contains(&"yuelao".to_string()));
        assert!(aliases.contains(&"yuelao-report".to_string()));
        assert!(aliases.contains(&"yuelaoskill".to_string()));
        assert!(aliases.contains(&"redbox-official:yuelaoskill".to_string()));
    }

    #[test]
    fn installed_market_state_prefers_scoped_package_identity() {
        let mut installed = HashMap::new();
        installed.insert(
            "yuelaoskill".to_string(),
            InstalledMarketProvenance {
                package_id: Some("yuelaoskill".to_string()),
                version: Some("old".to_string()),
                ..Default::default()
            },
        );
        installed.insert(
            "redbox-official:yuelaoskill".to_string(),
            InstalledMarketProvenance {
                market_id: Some("redbox-official".to_string()),
                package_id: Some("yuelaoskill".to_string()),
                version: Some("1.0.0".to_string()),
                ..Default::default()
            },
        );

        let state =
            installed_market_state(&installed, "redbox-official", "YuelaoSkill", "yuelaoskill");

        assert_eq!(
            state.and_then(|item| item.version.as_deref()),
            Some("1.0.0")
        );
    }

    #[test]
    fn default_skill_market_sources_exclude_retired_thrive_community() {
        let sources = default_skill_market_sources();

        assert!(sources.iter().any(|source| source.id == "redbox-official"));
        assert!(sources
            .iter()
            .any(|source| source.id == "redskill-official"));
        assert!(!sources
            .iter()
            .any(|source| source.id == LEGACY_THRIVE_MARKET_SOURCE_ID));
    }

    #[test]
    fn sanitize_market_sources_removes_retired_thrive_community() {
        let mut sources = vec![
            SkillMarketSource {
                id: LEGACY_THRIVE_MARKET_SOURCE_ID.to_string(),
                name: "Thrive Community".to_string(),
                kind: "legacy-thrive".to_string(),
                enabled: true,
                priority: 30,
                trust_level: "community".to_string(),
                source: None,
                registry_url: Some(THRIVE_SKILL_DEFAULT_REGISTRY_URL.to_string()),
                repo: None,
                ref_name: None,
                description: None,
            },
            SkillMarketSource {
                id: "custom".to_string(),
                name: "Custom".to_string(),
                kind: "url".to_string(),
                enabled: true,
                priority: 40,
                trust_level: "community".to_string(),
                source: None,
                registry_url: Some(
                    "https://github.com/acme/skills/raw/main/registry.json".to_string(),
                ),
                repo: None,
                ref_name: None,
                description: None,
            },
        ];

        sanitize_market_sources(&mut sources);

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "custom");
    }

    #[test]
    fn explicit_legacy_thrive_url_keeps_compatibility_adapter() {
        let source = legacy_thrive_source_for_url(Some(
            "https://github.com/acme/skills/raw/main/community-skills.json".to_string(),
        ));

        assert_eq!(source.kind, "legacy-thrive");
        assert_eq!(source.id, "legacy-thrive-url");
        assert_eq!(
            source.registry_url.as_deref(),
            Some("https://github.com/acme/skills/raw/main/community-skills.json")
        );
    }

    #[test]
    fn skill_market_provenance_path_resolves_user_skill_uri() {
        let skill = crate::runtime::SkillRecord {
            name: "yuelao".to_string(),
            description: String::new(),
            location: "skills://yuelao".to_string(),
            body: String::new(),
            source_scope: Some("user".to_string()),
            is_builtin: Some(false),
            disabled: Some(false),
        };

        let path = skill_market_provenance_path(&skill, None);

        assert_eq!(
            path,
            Some(
                preferred_user_skill_root()
                    .join("yuelao")
                    .join(MARKET_PROVENANCE_FILENAME)
            )
        );
    }
}
