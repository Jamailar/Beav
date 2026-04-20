use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter};

use crate::{
    escape_html, normalize_base_url, now_ms, payload_field, payload_string, run_curl_json,
    run_curl_json_with_timeout,
};

pub(crate) const REDBOX_OFFICIAL_BASE_URL: &str = "https://api.ziz.hk/redbox/v1";
const REDBOX_APP_SLUG: &str = "redbox";
pub(crate) const REDBOX_AUTH_SESSION_UPDATED_EVENT: &str = "redbox-auth:session-updated";
pub(crate) const REDBOX_AUTH_DATA_UPDATED_EVENT: &str = "redbox-auth:data-updated";
const OFFICIAL_HTTP_TIMEOUT_SECONDS: u64 = 15;

pub(crate) fn gemini_url(base_url: &str, path: &str, api_key: Option<&str>) -> String {
    let base = normalize_base_url(base_url);
    match api_key.map(str::trim).filter(|value| !value.is_empty()) {
        Some(key) => format!("{base}{path}?key={key}"),
        None => format!("{base}{path}"),
    }
}

fn build_openai_model_endpoint_candidates(base_url: &str) -> Vec<String> {
    let normalized = normalize_base_url(base_url);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut candidates = vec![
        format!("{normalized}/models"),
        format!("{normalized}/v1/models"),
    ];
    if let Ok(parsed) = url::Url::parse(&normalized) {
        let origin = format!(
            "{}://{}",
            parsed.scheme(),
            parsed.host_str().unwrap_or_default()
        );
        let path = parsed.path().trim_end_matches('/');
        for hint in [
            "/v1",
            "/openai",
            "/api/v1",
            "/openai/v1",
            "/compatible-mode/v1",
            "/compatible-mode",
            "/compatibility/v1",
            "/v2",
            "/api/v3",
            "/v1beta/openai",
            "/api/paas/v4",
        ] {
            candidates.push(format!("{origin}{hint}/models"));
        }
        if !path.is_empty() && path != "/" {
            candidates.push(format!("{origin}{path}/models"));
        }
    }
    candidates.retain(|item| !item.trim().is_empty());
    candidates.dedup();
    candidates
}

fn response_model_items(response: &Value) -> Vec<Value> {
    let data_items = response
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let fallback_items = response
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    data_items.into_iter().chain(fallback_items).collect()
}

pub(crate) fn fetch_openai_models(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut last_error = String::new();
    for endpoint in build_openai_model_endpoint_candidates(base_url) {
        match run_curl_json("GET", &endpoint, api_key, &[], None) {
            Ok(response) => {
                let models = response_model_items(&response)
                    .into_iter()
                    .filter_map(|item| {
                        let id = item
                            .get("id")
                            .or_else(|| item.get("name"))
                            .or_else(|| item.get("model"))
                            .and_then(Value::as_str)?
                            .trim()
                            .to_string();
                        if id.is_empty() {
                            return None;
                        }
                        Some(json!({ "id": id }))
                    })
                    .collect::<Vec<_>>();
                if !models.is_empty() {
                    return Ok(models);
                }
                last_error = format!("empty model list from {endpoint}");
            }
            Err(error) => {
                last_error = format!("{endpoint}: {error}");
            }
        }
    }
    Err(if last_error.is_empty() {
        "failed to fetch OpenAI-compatible models".to_string()
    } else {
        format!("failed to fetch OpenAI-compatible models: {last_error}")
    })
}

pub(crate) fn fetch_anthropic_models(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    let response = run_curl_json(
        "GET",
        &format!("{}/models", normalize_base_url(base_url)),
        None,
        &[
            ("x-api-key", api_key.unwrap_or_default().to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        None,
    )?;
    let items = response
        .get("data")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(|value| value.as_str())?
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            Some(json!({ "id": id }))
        })
        .collect())
}

pub(crate) fn fetch_gemini_models(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    let response = run_curl_json(
        "GET",
        &gemini_url(base_url, "/models", api_key),
        None,
        &[],
        None,
    )?;
    let items = response
        .get("models")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let raw_name = item.get("name").and_then(|value| value.as_str())?.trim();
            let id = raw_name
                .strip_prefix("models/")
                .unwrap_or(raw_name)
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            Some(json!({ "id": id }))
        })
        .collect())
}

pub(crate) fn invoke_openai_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let response = run_curl_json_with_timeout(
        "POST",
        &format!("{}/chat/completions", normalize_base_url(base_url)),
        api_key,
        &[],
        Some(json!({
            "model": model_name,
            "messages": [
                { "role": "user", "content": message }
            ],
            "stream": false
        })),
        Some(45),
    )?;
    let content = response
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if content.trim().is_empty() {
        return Err("模型返回了空响应".to_string());
    }
    Ok(content)
}

pub(crate) fn invoke_openai_structured_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    let mut body = json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "stream": false
    });
    if require_json {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let response = run_curl_json_with_timeout(
        "POST",
        &format!("{}/chat/completions", normalize_base_url(base_url)),
        api_key,
        &[],
        Some(body),
        Some(45),
    )?;
    let content = response
        .get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if content.trim().is_empty() {
        return Err("模型返回了空响应".to_string());
    }
    Ok(content)
}

pub(crate) fn invoke_anthropic_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let response = run_curl_json_with_timeout(
        "POST",
        &format!("{}/messages", normalize_base_url(base_url)),
        None,
        &[
            ("x-api-key", api_key.unwrap_or_default().to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        Some(json!({
            "model": model_name,
            "max_tokens": 1024,
            "messages": [
                { "role": "user", "content": message }
            ]
        })),
        Some(45),
    )?;
    let text = response
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Anthropic returned an empty response".to_string());
    }
    Ok(text)
}

pub(crate) fn invoke_anthropic_structured_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    _require_json: bool,
) -> Result<String, String> {
    let response = run_curl_json_with_timeout(
        "POST",
        &format!("{}/messages", normalize_base_url(base_url)),
        None,
        &[
            ("x-api-key", api_key.unwrap_or_default().to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        Some(json!({
            "model": model_name,
            "system": system_prompt,
            "max_tokens": 1024,
            "messages": [
                { "role": "user", "content": user_prompt }
            ]
        })),
        Some(45),
    )?;
    let text = response
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Anthropic returned an empty response".to_string());
    }
    Ok(text)
}

pub(crate) fn invoke_gemini_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let response = run_curl_json_with_timeout(
        "POST",
        &gemini_url(
            base_url,
            &format!("/models/{}:generateContent", model_name),
            api_key,
        ),
        None,
        &[],
        Some(json!({
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": message }]
                }
            ]
        })),
        Some(45),
    )?;
    let text = response
        .get("candidates")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(|value| value.as_array())
        .and_then(|parts| parts.first())
        .and_then(|part| part.get("text"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Gemini returned an empty response".to_string());
    }
    Ok(text)
}

pub(crate) fn invoke_gemini_structured_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    let mut body = json!({
        "system_instruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{ "text": user_prompt }]
            }
        ]
    });
    if require_json {
        body["generationConfig"] = json!({
            "responseMimeType": "application/json"
        });
    }
    let response = run_curl_json_with_timeout(
        "POST",
        &gemini_url(
            base_url,
            &format!("/models/{}:generateContent", model_name),
            api_key,
        ),
        None,
        &[],
        Some(body),
        Some(45),
    )?;
    let text = response
        .get("candidates")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(|value| value.as_array())
        .and_then(|parts| parts.first())
        .and_then(|part| part.get("text"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Gemini returned an empty response".to_string());
    }
    Ok(text)
}

pub(crate) fn fetch_models_by_protocol(
    protocol: &str,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    match protocol {
        "anthropic" => fetch_anthropic_models(base_url, api_key),
        "gemini" => fetch_gemini_models(base_url, api_key),
        _ => fetch_openai_models(base_url, api_key),
    }
}

pub(crate) fn official_fallback_products() -> Vec<Value> {
    vec![
        json!({ "id": "topup-1000", "name": "1000 积分", "amount": 9.9, "points_topup": 1000 }),
        json!({ "id": "topup-5000", "name": "5000 积分", "amount": 39.9, "points_topup": 5000 }),
        json!({ "id": "pro-monthly", "name": "Pro Monthly", "amount": 99.0, "points_topup": 20000 }),
    ]
}

pub(crate) fn official_settings_session(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_auth_session_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

pub(crate) fn official_settings_models(settings: &Value) -> Vec<Value> {
    payload_string(settings, "redbox_official_models_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn official_base_url_from_settings(settings: &Value) -> String {
    fn normalize_gateway_root(value: &str) -> String {
        let normalized = normalize_base_url(value);
        if normalized.is_empty() {
            return "https://api.ziz.hk".to_string();
        }

        if let Ok(mut url) = url::Url::parse(&normalized) {
            let mut pathname = url.path().trim_end_matches('/').to_string();
            for suffix in [
                format!("/{REDBOX_APP_SLUG}/v1"),
                format!("/{REDBOX_APP_SLUG}"),
                "/api/v1".to_string(),
                "/v1".to_string(),
            ] {
                if pathname.eq_ignore_ascii_case(&suffix) {
                    pathname.clear();
                    break;
                }
                let lower = pathname.to_lowercase();
                let suffix_lower = suffix.to_lowercase();
                if lower.ends_with(&suffix_lower) {
                    pathname.truncate(pathname.len() - suffix.len());
                    pathname = pathname.trim_end_matches('/').to_string();
                    break;
                }
            }
            url.set_path(if pathname.is_empty() { "/" } else { &pathname });
            url.set_query(None);
            url.set_fragment(None);
            return normalize_base_url(url.as_str());
        }

        for suffix in [
            format!("/{REDBOX_APP_SLUG}/v1"),
            format!("/{REDBOX_APP_SLUG}"),
            "/api/v1".to_string(),
            "/v1".to_string(),
        ] {
            if normalized.to_lowercase().ends_with(&suffix.to_lowercase()) {
                return normalize_base_url(&normalized[..normalized.len() - suffix.len()]);
            }
        }

        normalized
    }

    let configured = payload_string(settings, "redbox_official_base_url")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| REDBOX_OFFICIAL_BASE_URL.to_string());
    format!(
        "{}/{REDBOX_APP_SLUG}/v1",
        normalize_gateway_root(&configured)
    )
}

pub(crate) fn official_auth_token_from_settings(settings: &Value) -> Option<String> {
    let session = official_settings_session(settings)?;
    payload_string(&session, "apiKey")
        .or_else(|| payload_string(&session, "accessToken"))
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn official_response_items(response: &Value) -> Vec<Value> {
    fn collect_items(node: &Value) -> Option<Vec<Value>> {
        if let Some(items) = node.as_array() {
            return Some(items.clone());
        }
        for key in [
            "items",
            "data",
            "results",
            "orders",
            "products",
            "records",
            "usage_records",
            "call_records",
            "inference_records",
            "logs",
            "rows",
            "list",
            "content",
            "transactions",
            "recent_records",
        ] {
            if let Some(value) = node.get(key) {
                if let Some(items) = collect_items(value) {
                    return Some(items);
                }
            }
        }
        None
    }

    collect_items(response).unwrap_or_default()
}

pub(crate) fn official_unwrap_response_payload(response: &Value) -> Value {
    if let Some(data) = response.get("data") {
        if response.get("success").is_some()
            || response.get("code").is_some()
            || response.get("message").is_some()
        {
            return data.clone();
        }
    }
    response.clone()
}

pub(crate) fn run_official_json_request(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    run_official_json_request_response(settings, method, path, body).map(|response| response.body)
}

pub(crate) fn run_official_json_request_response(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<crate::HttpJsonResponse, String> {
    let base_url = official_base_url_from_settings(settings);
    let api_key = official_auth_token_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    crate::run_curl_json_response(
        method,
        &endpoint,
        api_key.as_deref(),
        &[],
        body,
        Some(OFFICIAL_HTTP_TIMEOUT_SECONDS),
    )
}

pub(crate) fn run_official_public_json_request(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base_url = official_base_url_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    run_curl_json_with_timeout(
        method,
        &endpoint,
        None,
        &[],
        body,
        Some(OFFICIAL_HTTP_TIMEOUT_SECONDS),
    )
}

pub(crate) fn normalize_official_auth_session(raw: &Value) -> Result<Value, String> {
    let payload = raw
        .get("auth_payload")
        .cloned()
        .unwrap_or_else(|| official_unwrap_response_payload(raw));
    let access_token = payload_string(&payload, "access_token")
        .or_else(|| payload_string(&payload, "accessToken"))
        .ok_or_else(|| "登录结果缺少 access_token".to_string())?;
    let refresh_token = payload_string(&payload, "refresh_token")
        .or_else(|| payload_string(&payload, "refreshToken"))
        .unwrap_or_default();
    let token_type = payload_string(&payload, "token_type")
        .or_else(|| payload_string(&payload, "tokenType"))
        .unwrap_or_else(|| "Bearer".to_string());
    let expires_raw = payload_field(&payload, "expires_at")
        .or_else(|| payload_field(&payload, "expiresAt"))
        .and_then(crate::auth::parse_time_candidate_ms);
    let expires_in = payload_field(&payload, "expires_in")
        .or_else(|| payload_field(&payload, "expiresIn"))
        .and_then(|value| value.as_i64())
        .filter(|value| *value > 0)
        .map(|value| (now_ms() as i64) + (value * 1000));
    let expires_at = expires_raw
        .or(expires_in)
        .or_else(|| crate::auth::jwt_expiration_ms(&access_token));
    Ok(json!({
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "tokenType": token_type,
        "expiresAt": expires_at,
        "apiKey": payload_string(&payload, "api_key").or_else(|| payload_string(&payload, "apiKey")).unwrap_or_default(),
        "user": payload.get("user").cloned().unwrap_or(Value::Null),
        "createdAt": now_ms() as i64,
        "updatedAt": now_ms() as i64,
    }))
}

pub(crate) fn official_account_summary_local(settings: &Value, models: &[Value]) -> Value {
    let session = official_settings_session(settings).unwrap_or_else(|| json!({}));
    let user = session.get("user").cloned().unwrap_or_else(|| json!({}));
    json!({
        "loggedIn": official_auth_token_from_settings(settings).is_some(),
        "displayName": user.get("displayName").cloned().or_else(|| user.get("name").cloned()).unwrap_or(Value::Null),
        "email": user.get("email").cloned().unwrap_or(Value::Null),
        "apiKeyPresent": official_auth_token_from_settings(settings).is_some(),
        "planName": user.get("planName").cloned().unwrap_or(json!("RedBox Official")),
        "pointsBalance": user.get("pointsBalance").cloned().unwrap_or(json!(0)),
        "officialBaseUrl": official_base_url_from_settings(settings),
        "modelCount": models.len(),
        "user": user,
    })
}

pub(crate) fn normalize_model_id_list(raw: &[String]) -> Vec<String> {
    let mut unique = Vec::new();
    for item in raw {
        let normalized = item.trim();
        if normalized.is_empty() {
            continue;
        }
        if !unique
            .iter()
            .any(|existing: &String| existing == normalized)
        {
            unique.push(normalized.to_string());
        }
    }
    unique
}

pub(crate) fn preserve_non_empty_model(current: Option<&str>, fallback: &str) -> String {
    let normalized = current.unwrap_or("").trim();
    if normalized.is_empty() {
        fallback.trim().to_string()
    } else {
        normalized.to_string()
    }
}

pub(crate) fn sanitize_scoped_model_override(
    available_models: &[String],
    current: Option<&str>,
) -> String {
    let normalized = current.unwrap_or("").trim();
    if normalized.is_empty() {
        return String::new();
    }
    if available_models.is_empty() || available_models.iter().any(|item| item == normalized) {
        return normalized.to_string();
    }
    String::new()
}

pub(crate) fn choose_preferred_official_chat_model(
    available_chat_models: &[String],
    current: Option<&str>,
    fallback: &str,
) -> String {
    let normalized_current = current.unwrap_or("").trim();
    if !normalized_current.is_empty()
        && available_chat_models
            .iter()
            .any(|item| item == normalized_current)
    {
        return normalized_current.to_string();
    }
    let normalized_fallback = fallback.trim();
    if !normalized_fallback.is_empty()
        && available_chat_models
            .iter()
            .any(|item| item == normalized_fallback)
    {
        return normalized_fallback.to_string();
    }
    available_chat_models
        .first()
        .cloned()
        .unwrap_or_else(|| preserve_non_empty_model(current, fallback))
}

pub(crate) fn official_sync_source_into_settings(settings: &mut Value, models: &[Value]) {
    let api_key = official_auth_token_from_settings(settings).unwrap_or_default();
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let existing_source = sources
        .iter()
        .find(|item| {
            item.get("id").and_then(|value| value.as_str()) == Some("redbox_official_auto")
        })
        .cloned();
    sources.retain(|item| {
        item.get("id").and_then(|value| value.as_str()) != Some("redbox_official_auto")
    });
    let official_model_ids = normalize_model_id_list(
        &models
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>(),
    );
    let available_chat_models = models
        .iter()
        .filter(|item| {
            item.get("capabilities")
                .and_then(|value| value.as_array())
                .map(|items| items.iter().any(|cap| cap.as_str() == Some("chat")))
                .or_else(|| {
                    item.get("capability")
                        .and_then(|value| value.as_str())
                        .map(|value| value == "chat")
                })
                .unwrap_or(false)
        })
        .filter_map(|item| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let fallback_chat_model = models
        .iter()
        .find(|item| {
            item.get("capabilities")
                .and_then(|value| value.as_array())
                .map(|items| items.iter().any(|cap| cap.as_str() == Some("chat")))
                .or_else(|| {
                    item.get("capability")
                        .and_then(|value| value.as_str())
                        .map(|value| value == "chat")
                })
                .unwrap_or(false)
        })
        .and_then(|item| item.get("id").and_then(|value| value.as_str()))
        .unwrap_or("gpt-4.1-mini");
    let current_text_model = payload_string(settings, "model_name");
    let chat_model = choose_preferred_official_chat_model(
        &available_chat_models,
        current_text_model.as_deref(),
        fallback_chat_model,
    );
    let official_base_url = official_base_url_from_settings(settings);
    let official_video_api_key = official_auth_token_from_settings(settings).unwrap_or_default();
    let existing_models = existing_source
        .as_ref()
        .and_then(|value| value.get("models"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let merged_models = normalize_model_id_list(
        &existing_models
            .into_iter()
            .chain(official_model_ids.iter().cloned())
            .chain(std::iter::once(chat_model.clone()))
            .collect::<Vec<_>>(),
    );
    let source = json!({
        "id": "redbox_official_auto",
        "name": "RedBox Official",
        "presetId": "redbox-official",
        "baseURL": official_base_url,
        "apiKey": api_key,
        "models": merged_models,
        "modelsMeta": models,
        "model": chat_model,
        "protocol": "openai"
    });
    sources.insert(0, source);
    let next_model_name_wander = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_wander").as_deref(),
    );
    let next_model_name_chatroom = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_chatroom").as_deref(),
    );
    let next_model_name_knowledge = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_knowledge").as_deref(),
    );
    let next_model_name_redclaw = sanitize_scoped_model_override(
        &official_model_ids,
        payload_string(settings, "model_name_redclaw").as_deref(),
    );
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "ai_sources_json".to_string(),
            json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
        );
        object.insert(
            "default_ai_source_id".to_string(),
            json!("redbox_official_auto"),
        );
        object.insert("api_endpoint".to_string(), json!(official_base_url));
        object.insert("api_key".to_string(), json!(api_key));
        object.insert("model_name".to_string(), json!(chat_model));
        object.insert(
            "model_name_wander".to_string(),
            json!(next_model_name_wander),
        );
        object.insert(
            "model_name_chatroom".to_string(),
            json!(next_model_name_chatroom),
        );
        object.insert(
            "model_name_knowledge".to_string(),
            json!(next_model_name_knowledge),
        );
        object.insert(
            "model_name_redclaw".to_string(),
            json!(next_model_name_redclaw),
        );
        object.insert(
            "video_endpoint".to_string(),
            json!(REDBOX_OFFICIAL_BASE_URL),
        );
        object.insert("video_api_key".to_string(), json!(official_video_api_key));
        object.insert("video_model".to_string(), json!("wan2.7-t2v-video"));
        object.insert(
            "redbox_official_models_json".to_string(),
            json!(serde_json::to_string(models).unwrap_or_else(|_| "[]".to_string())),
        );
    }
}

pub(crate) fn fetch_official_models_for_settings(settings: &Value) -> Vec<Value> {
    run_official_json_request(settings, "GET", "/models", None)
        .map(|remote| official_response_items(&remote))
        .unwrap_or_else(|_| official_settings_models(settings))
}

pub(crate) fn official_settings_json_array(settings: &Value, key: &str) -> Vec<Value> {
    payload_string(settings, key)
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn write_settings_json_value(settings: &mut Value, key: &str, value: &Value) {
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            key.to_string(),
            json!(serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())),
        );
    }
}

pub(crate) fn write_settings_json_array(settings: &mut Value, key: &str, items: &[Value]) {
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            key.to_string(),
            json!(serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())),
        );
    }
}

pub(crate) fn official_settings_api_keys(settings: &Value) -> Vec<Value> {
    official_settings_json_array(settings, "redbox_auth_api_keys_json")
}

pub(crate) fn official_settings_orders(settings: &Value) -> Vec<Value> {
    official_settings_json_array(settings, "redbox_auth_orders_json")
}

pub(crate) fn official_settings_call_records_list(settings: &Value) -> Vec<Value> {
    official_settings_json_array(settings, "redbox_auth_call_records_json")
}

pub(crate) fn official_settings_points(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_auth_points_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

pub(crate) fn official_settings_wechat_login(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_auth_wechat_login_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

pub(crate) fn upsert_official_settings_session(settings: &mut Value, session: Option<&Value>) {
    if let Some(object) = settings.as_object_mut() {
        match session {
            Some(session_value) => {
                object.insert(
                    "redbox_auth_session_json".to_string(),
                    json!(
                        serde_json::to_string(session_value).unwrap_or_else(|_| "{}".to_string())
                    ),
                );
            }
            None => {
                object.insert("redbox_auth_session_json".to_string(), json!(""));
            }
        }
    }
}

pub(crate) fn official_points_snapshot(settings: &Value) -> Value {
    let session = official_settings_session(settings).unwrap_or_else(|| json!({}));
    let user = session
        .get("user")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let balance = [
        user.get("pointsBalance"),
        user.get("points"),
        user.get("balance"),
        user.get("currentPoints"),
        user.get("current_points"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| value.as_f64())
    .unwrap_or(0.0);
    json!({
        "points": balance,
        "balance": balance,
        "currentPoints": balance,
        "availablePoints": balance,
        "pointsPerYuan": 100,
        "pricing": {
            "points_per_yuan": 100
        }
    })
}

pub(crate) fn emit_redbox_auth_session_updated(app: &AppHandle, session: Option<Value>) {
    let _ = app.emit(
        REDBOX_AUTH_SESSION_UPDATED_EVENT,
        json!({ "session": session }),
    );
}

pub(crate) fn emit_redbox_auth_data_updated(app: &AppHandle, payload: Value) {
    let _ = app.emit(REDBOX_AUTH_DATA_UPDATED_EVENT, payload);
}

pub(crate) fn create_official_payment_form(order_no: &str, amount: f64, subject: &str) -> String {
    let safe_subject = escape_html(subject);
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>RedBox 支付</title></head><body><div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;\"><h3>RedBox 充值订单</h3><p>订单号：{order_no}</p><p>金额：¥{amount:.2}</p><p>{safe_subject}</p><button style=\"padding:10px 16px;border-radius:10px;border:1px solid #ddd;background:#111;color:#fff;\">请在正式环境接入支付网关</button></div></body></html>"
    )
}

pub(crate) fn open_payment_form(payment_form: &str) -> Result<String, String> {
    let normalized = payment_form.trim();
    if normalized.is_empty() {
        return Err("payment_form 不能为空".to_string());
    }
    if normalized.starts_with("http://") || normalized.starts_with("https://") {
        open::that(normalized).map_err(|error| error.to_string())?;
        return Ok("external-url".to_string());
    }
    let target_path = std::env::temp_dir().join(format!("redbox-payment-{}.html", now_ms()));
    fs::write(&target_path, normalized).map_err(|error| error.to_string())?;
    open::that(&target_path).map_err(|error| error.to_string())?;
    Ok("external-html".to_string())
}

pub(crate) fn invoke_chat_by_protocol(
    protocol: &str,
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    match protocol {
        "anthropic" => invoke_anthropic_chat(base_url, api_key, model_name, message),
        "gemini" => invoke_gemini_chat(base_url, api_key, model_name, message),
        _ => invoke_openai_chat(base_url, api_key, model_name, message),
    }
}

pub(crate) fn invoke_structured_chat_by_protocol(
    protocol: &str,
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    require_json: bool,
) -> Result<String, String> {
    match protocol {
        "anthropic" => invoke_anthropic_structured_chat(
            base_url,
            api_key,
            model_name,
            system_prompt,
            user_prompt,
            require_json,
        ),
        "gemini" => invoke_gemini_structured_chat(
            base_url,
            api_key,
            model_name,
            system_prompt,
            user_prompt,
            require_json,
        ),
        _ => invoke_openai_structured_chat(
            base_url,
            api_key,
            model_name,
            system_prompt,
            user_prompt,
            require_json,
        ),
    }
}
