use reqwest::blocking::RequestBuilder;
use reqwest::header::{HeaderValue, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::{model_list_candidates, AuthStrategy, EndpointPolicy};

const FETCH_TIMEOUT_SECS: u64 = 15;
const ERROR_BODY_MAX_CHARS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchModelsInput {
    pub base_url: String,
    pub api_key: String,
    pub is_full_url: bool,
    pub models_url_override: Option<String>,
    pub user_agent: Option<String>,
    pub auth_strategy: AuthStrategy,
    pub endpoint_policy: EndpointPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FetchModelsReport {
    pub success: bool,
    pub models: Vec<FetchedModel>,
    pub attempted_urls: Vec<String>,
    pub resolved_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelEntry>>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    owned_by: Option<String>,
}

pub(crate) fn fetch_models_blocking(input: FetchModelsInput) -> Result<FetchModelsReport, String> {
    if input.api_key.trim().is_empty() {
        return Err("API Key is required to fetch models".to_string());
    }
    let candidates = model_list_candidates(
        &input.base_url,
        input.is_full_url,
        &input.endpoint_policy,
        input.models_url_override.as_deref(),
    )?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let mut last_err: Option<String> = None;

    for url in &candidates {
        let mut request = client
            .get(url)
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS));
        request = apply_auth(request, input.auth_strategy, &input.api_key);
        if let Some(user_agent) = input
            .user_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let value = HeaderValue::from_str(user_agent)
                .map_err(|error| format!("Invalid User-Agent header: {error}"))?;
            request = request.header(USER_AGENT, value);
        }
        let response = request
            .send()
            .map_err(|error| format!("Request failed: {error}"))?;
        let status = response.status();
        if status.is_success() {
            let resp: ModelsResponse = response
                .json()
                .map_err(|error| format!("Failed to parse response: {error}"))?;
            let mut models = resp
                .data
                .unwrap_or_default()
                .into_iter()
                .map(|model| FetchedModel {
                    id: model.id,
                    owned_by: model.owned_by,
                })
                .filter(|model| !model.id.trim().is_empty())
                .collect::<Vec<_>>();
            models.sort_by(|left, right| left.id.cmp(&right.id));
            return Ok(FetchModelsReport {
                success: true,
                models,
                attempted_urls: candidates.clone(),
                resolved_url: Some(url.clone()),
                error: None,
            });
        }
        let body = truncate_body(response.text().unwrap_or_default());
        let error = format!("HTTP {status}: {body}");
        if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
            last_err = Some(error);
            continue;
        }
        return Ok(FetchModelsReport {
            success: false,
            models: Vec::new(),
            attempted_urls: candidates.clone(),
            resolved_url: Some(url.clone()),
            error: Some(error),
        });
    }

    Ok(FetchModelsReport {
        success: false,
        models: Vec::new(),
        attempted_urls: candidates,
        resolved_url: None,
        error: Some(last_err.unwrap_or_else(|| "All candidates failed".to_string())),
    })
}

fn apply_auth(
    request: RequestBuilder,
    auth_strategy: AuthStrategy,
    api_key: &str,
) -> RequestBuilder {
    match auth_strategy {
        AuthStrategy::Bearer | AuthStrategy::Custom => {
            request.header("Authorization", format!("Bearer {api_key}"))
        }
        AuthStrategy::XApiKey => request.header("x-api-key", api_key),
        AuthStrategy::QueryKey => request.query(&[("key", api_key)]),
    }
}

fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}
