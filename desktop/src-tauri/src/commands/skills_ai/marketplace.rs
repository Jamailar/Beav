use super::*;
use serde::{Deserialize, Serialize};

const THRIVE_SKILL_DEFAULT_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/ThrivingOS/Thrive-release/main/community-skills.json";
const THRIVE_SKILL_HTTP_USER_AGENT: &str =
    "Thrive/SkillMarketplace (+https://github.com/ThrivingOS/Thrive-release)";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ThriveSkillMarketplaceRequest {
    url: Option<String>,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThriveSkillMarketplaceEntry {
    pub(super) id: String,
    name: String,
    author: String,
    description: String,
    pub(super) repo: String,
}

fn skill_marketplace_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(THRIVE_SKILL_HTTP_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|error| error.to_string())
}

fn is_safe_skill_marketplace_url(url: &str) -> bool {
    url.starts_with("https://raw.githubusercontent.com/")
        || url.starts_with("https://github.com/")
        || url.starts_with("https://api.github.com/")
}

fn skill_marketplace_registry_url(
    request: &ThriveSkillMarketplaceRequest,
) -> Result<String, String> {
    let url = request
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(THRIVE_SKILL_DEFAULT_REGISTRY_URL);
    if !is_safe_skill_marketplace_url(url) {
        return Err("skill marketplace registry must be a GitHub HTTPS URL".to_string());
    }
    Ok(url.to_string())
}

fn http_get_skill_marketplace_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    if !is_safe_skill_marketplace_url(url) {
        return Err("skill marketplace request must use a GitHub HTTPS URL".to_string());
    }
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

fn load_skill_marketplace_entries(
    request: &ThriveSkillMarketplaceRequest,
) -> Result<(String, Vec<ThriveSkillMarketplaceEntry>), String> {
    let registry_url = skill_marketplace_registry_url(request)?;
    let entries =
        http_get_skill_marketplace_json::<Vec<ThriveSkillMarketplaceEntry>>(&registry_url)?;
    Ok((registry_url, entries))
}

pub(super) fn list_skill_marketplace(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let request: ThriveSkillMarketplaceRequest = serde_json::from_value(payload.clone())
        .map_err(|error| format!("skills:marketplace payload invalid: {error}"))?;
    let (registry_url, entries) = load_skill_marketplace_entries(&request)?;
    let installed_names = with_store(state, |store| {
        Ok(store
            .skills
            .iter()
            .map(|skill| skill.name.to_ascii_lowercase())
            .collect::<std::collections::HashSet<_>>())
    })?;
    let skills = entries
        .into_iter()
        .map(|entry| {
            let installed = installed_names.contains(&entry.id.to_ascii_lowercase())
                || installed_names.contains(&entry.name.to_ascii_lowercase());
            json!({
                "id": entry.id,
                "name": entry.name,
                "author": entry.author,
                "description": entry.description,
                "repo": entry.repo,
                "installed": installed,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "success": true,
        "registryUrl": registry_url,
        "skills": skills,
    }))
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
    let (_registry_url, entries) =
        load_skill_marketplace_entries(&ThriveSkillMarketplaceRequest::default())?;
    Ok(entries.into_iter().find(|entry| entry.id == id))
}
