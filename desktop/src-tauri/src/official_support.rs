use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter};

use crate::{
    app_brand_display_name, app_brand_slug, append_debug_trace_global, escape_html,
    format_http_error_message, http_error_debug_line, http_error_details_from_value,
    normalize_anthropic_base_url, normalize_base_url, now_ms, payload_field, payload_string,
    run_curl_json_response,
};

const REDBOX_OFFICIAL_CN_GATEWAY_ROOT: &str = "https://api.ziz.hk";
const REDBOX_OFFICIAL_GLOBAL_GATEWAY_ROOT: &str = "https://api.thrivingos.com";
pub(crate) const REDBOX_OFFICIAL_DEFAULT_REALM: &str = "cn";
pub(crate) const REDBOX_AUTH_SESSION_UPDATED_EVENT: &str = "redbox-auth:session-updated";
pub(crate) const REDBOX_AUTH_DATA_UPDATED_EVENT: &str = "redbox-auth:data-updated";
pub(crate) const AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY: &str = "ai_model_defaults_initialized_at";
const OFFICIAL_HTTP_TIMEOUT_SECONDS: u64 = 15;

fn log_non_200_http(scope: &str, method: &str, url: &str, status: u16, body: &Value) {
    let details = http_error_details_from_value(status, body);
    append_debug_trace_global(http_error_debug_line(scope, method, url, &details));
}

fn ensure_successful_ai_response(
    protocol: &str,
    operation: &str,
    method: &str,
    url: &str,
    model_name: &str,
    response: crate::HttpJsonResponse,
) -> Result<Value, String> {
    if (200..300).contains(&response.status) {
        return Ok(response.body);
    }
    let details = http_error_details_from_value(response.status, &response.body);
    append_debug_trace_global(format!(
        "{} | model={} protocol={} operation={}",
        http_error_debug_line("ai-http", method, url, &details),
        model_name,
        protocol,
        operation,
    ));
    Err(format_http_error_message("AI request", &details))
}

pub(crate) fn gemini_url(base_url: &str, path: &str, api_key: Option<&str>) -> String {
    let base = normalize_base_url(base_url);
    match api_key.map(str::trim).filter(|value| !value.is_empty()) {
        Some(key) => format!("{base}{path}?key={key}"),
        None => format!("{base}{path}"),
    }
}

pub(crate) fn invoke_openai_chat(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    message: &str,
) -> Result<String, String> {
    let endpoint = format!("{}/chat/completions", normalize_base_url(base_url));
    let response = run_curl_json_response(
        "POST",
        &endpoint,
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
    let response =
        ensure_successful_ai_response("openai", "text", "POST", &endpoint, model_name, response)?;
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
    let endpoint = format!("{}/chat/completions", normalize_base_url(base_url));
    let response = run_curl_json_response("POST", &endpoint, api_key, &[], Some(body), Some(45))?;
    let response = ensure_successful_ai_response(
        "openai",
        "structured",
        "POST",
        &endpoint,
        model_name,
        response,
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
    let endpoint = format!("{}/messages", normalize_anthropic_base_url(base_url));
    let response = run_curl_json_response(
        "POST",
        &endpoint,
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
    let response = ensure_successful_ai_response(
        "anthropic",
        "text",
        "POST",
        &endpoint,
        model_name,
        response,
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
    let endpoint = format!("{}/messages", normalize_anthropic_base_url(base_url));
    let response = run_curl_json_response(
        "POST",
        &endpoint,
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
    let response = ensure_successful_ai_response(
        "anthropic",
        "structured",
        "POST",
        &endpoint,
        model_name,
        response,
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
    let endpoint = gemini_url(
        base_url,
        &format!("/models/{}:generateContent", model_name),
        api_key,
    );
    let response = run_curl_json_response(
        "POST",
        &endpoint,
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
    let response =
        ensure_successful_ai_response("gemini", "text", "POST", &endpoint, model_name, response)?;
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
    let endpoint = gemini_url(
        base_url,
        &format!("/models/{}:generateContent", model_name),
        api_key,
    );
    let response = run_curl_json_response("POST", &endpoint, None, &[], Some(body), Some(45))?;
    let response = ensure_successful_ai_response(
        "gemini",
        "structured",
        "POST",
        &endpoint,
        model_name,
        response,
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

pub(crate) fn invoke_video_analysis_by_protocol(
    protocol: &str,
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    mime_type: &str,
    base64_data: &str,
) -> Result<String, String> {
    if protocol == "gemini" {
        return invoke_gemini_video_analysis(
            base_url,
            api_key,
            model_name,
            system_prompt,
            user_prompt,
            mime_type,
            base64_data,
        );
    }
    invoke_openai_video_analysis(
        base_url,
        api_key,
        model_name,
        system_prompt,
        user_prompt,
        mime_type,
        base64_data,
    )
}

fn invoke_gemini_video_analysis(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    mime_type: &str,
    base64_data: &str,
) -> Result<String, String> {
    let body = json!({
        "system_instruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": [
            {
                "role": "user",
                "parts": [
                    { "text": user_prompt },
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": base64_data,
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    });
    let endpoint = gemini_url(
        base_url,
        &format!("/models/{}:generateContent", model_name),
        api_key,
    );
    let response = run_curl_json_response("POST", &endpoint, None, &[], Some(body), Some(120))?;
    let response = ensure_successful_ai_response(
        "gemini",
        "video-analysis",
        "POST",
        &endpoint,
        model_name,
        response,
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
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("Video Analysis Agent returned an empty response".to_string());
    }
    Ok(text)
}

fn invoke_openai_video_analysis(
    base_url: &str,
    api_key: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    mime_type: &str,
    base64_data: &str,
) -> Result<String, String> {
    let endpoint = format!("{}/chat/completions", normalize_base_url(base_url));
    let body = openai_video_analysis_body(
        model_name,
        system_prompt,
        user_prompt,
        mime_type,
        base64_data,
    );
    let response = run_curl_json_response("POST", &endpoint, api_key, &[], Some(body), Some(120))?;
    let response = ensure_successful_ai_response(
        "openai",
        "video-analysis",
        "POST",
        &endpoint,
        model_name,
        response,
    )?;
    let text = openai_chat_message_content(&response);
    if text.trim().is_empty() {
        return Err("Video Analysis Agent returned an empty response".to_string());
    }
    Ok(text)
}

fn openai_video_analysis_body(
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    mime_type: &str,
    base64_data: &str,
) -> Value {
    let data_url = if model_name.to_ascii_lowercase().contains("qwen") {
        format!("data:;base64,{base64_data}")
    } else {
        format!("data:{mime_type};base64,{base64_data}")
    };
    json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": system_prompt },
            {
                "role": "user",
                "content": [
                    {
                        "type": "video_url",
                        "video_url": {
                            "url": data_url
                        }
                    },
                    {
                        "type": "text",
                        "text": user_prompt
                    }
                ]
            }
        ],
        "modalities": ["text"],
        "stream": false
    })
}

fn openai_chat_message_content(response: &Value) -> String {
    let Some(content) = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
    else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
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

pub(crate) fn official_realm_from_settings(settings: &Value) -> String {
    if let Some(realm) = payload_string(settings, "redbox_official_realm") {
        let normalized = normalize_official_realm(&realm);
        if !normalized.is_empty() {
            return normalized;
        }
    }
    if let Some(base_url) = payload_string(settings, "redbox_official_base_url") {
        let normalized = base_url.to_lowercase();
        if normalized.contains("thrivingos.com") {
            return "global".to_string();
        }
    }
    REDBOX_OFFICIAL_DEFAULT_REALM.to_string()
}

pub(crate) fn normalize_official_realm(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "cn" | "china" | "mainland" | "zh-cn" | "中国大陆" | "大陆" => "cn".to_string(),
        "global" | "intl" | "international" | "overseas" | "non-cn" | "海外" | "国际" => {
            "global".to_string()
        }
        _ => String::new(),
    }
}

fn official_base_url_for_gateway_root(root: &str) -> String {
    format!("{}/{}/v1", normalize_base_url(root), app_brand_slug())
}

pub(crate) fn official_base_url_for_realm(realm: &str) -> String {
    let root = match normalize_official_realm(realm).as_str() {
        "global" => REDBOX_OFFICIAL_GLOBAL_GATEWAY_ROOT,
        _ => REDBOX_OFFICIAL_CN_GATEWAY_ROOT,
    };
    official_base_url_for_gateway_root(root)
}

pub(crate) fn official_realm_label(realm: &str) -> &'static str {
    match normalize_official_realm(realm).as_str() {
        "global" => "海外账号",
        _ => "中国大陆账号",
    }
}

pub(crate) fn official_realms_payload(active_realm: &str) -> Value {
    json!([
        {
            "id": "cn",
            "label": official_realm_label("cn"),
            "baseUrl": official_base_url_for_realm("cn"),
            "active": normalize_official_realm(active_realm) != "global",
        },
        {
            "id": "global",
            "label": official_realm_label("global"),
            "baseUrl": official_base_url_for_realm("global"),
            "active": normalize_official_realm(active_realm) == "global",
        }
    ])
}

fn official_settings_sessions(settings: &Value) -> serde_json::Map<String, Value> {
    payload_string(settings, "redbox_auth_sessions_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

pub(crate) fn official_settings_models(settings: &Value) -> Vec<Value> {
    payload_string(settings, "redbox_official_models_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn official_settings_pricing(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_official_pricing_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

pub(crate) fn official_base_url_from_settings(settings: &Value) -> String {
    fn gateway_route_suffixes() -> Vec<String> {
        let mut suffixes = vec![
            format!("/{}/v1", app_brand_slug()),
            format!("/{}", app_brand_slug()),
            "/redbox/v1".to_string(),
            "/redbox".to_string(),
            "/thrive/v1".to_string(),
            "/thrive".to_string(),
            "/api/v1".to_string(),
            "/v1".to_string(),
        ];
        suffixes.dedup();
        suffixes
    }

    fn normalize_gateway_root(value: &str) -> String {
        let normalized = normalize_base_url(value);
        if normalized.is_empty() {
            return REDBOX_OFFICIAL_CN_GATEWAY_ROOT.to_string();
        }

        if let Ok(mut url) = url::Url::parse(&normalized) {
            let mut pathname = url.path().trim_end_matches('/').to_string();
            for suffix in gateway_route_suffixes() {
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

        for suffix in gateway_route_suffixes() {
            if normalized.to_lowercase().ends_with(&suffix.to_lowercase()) {
                return normalize_base_url(&normalized[..normalized.len() - suffix.len()]);
            }
        }

        normalized
    }

    let configured = payload_string(settings, "redbox_official_base_url")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| official_base_url_for_realm(&official_realm_from_settings(settings)));
    official_base_url_for_gateway_root(&normalize_gateway_root(&configured))
}

pub(crate) fn official_ai_api_key_from_settings(settings: &Value) -> Option<String> {
    let session = official_settings_session(settings)?;
    payload_string(&session, "apiKey").filter(|value| !value.trim().is_empty())
}

pub(crate) fn official_access_token_from_settings(settings: &Value) -> Option<String> {
    let session = official_settings_session(settings)?;
    payload_string(&session, "accessToken").filter(|value| !value.trim().is_empty())
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
    let access_token = official_access_token_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    let response = crate::run_curl_json_response(
        method,
        &endpoint,
        access_token.as_deref(),
        &[],
        body,
        Some(OFFICIAL_HTTP_TIMEOUT_SECONDS),
    )?;
    if !(200..300).contains(&response.status) {
        log_non_200_http(
            "official-http",
            method,
            &endpoint,
            response.status,
            &response.body,
        );
    }
    Ok(response)
}

pub(crate) fn run_official_ai_json_request(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    run_official_ai_json_request_response(settings, method, path, body)
        .map(|response| response.body)
}

pub(crate) fn run_official_ai_json_request_response(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<crate::HttpJsonResponse, String> {
    let base_url = official_base_url_from_settings(settings);
    let api_key = official_ai_api_key_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    let response = crate::run_curl_json_response(
        method,
        &endpoint,
        api_key.as_deref(),
        &[],
        body,
        Some(OFFICIAL_HTTP_TIMEOUT_SECONDS),
    )?;
    if !(200..300).contains(&response.status) {
        log_non_200_http(
            "official-http",
            method,
            &endpoint,
            response.status,
            &response.body,
        );
    }
    Ok(response)
}

pub(crate) fn run_official_public_json_request_response(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<crate::HttpJsonResponse, String> {
    let base_url = official_base_url_from_settings(settings);
    let endpoint = format!(
        "{}/{}",
        normalize_base_url(&base_url),
        path.trim_start_matches('/')
    );
    let response = crate::run_curl_json_response(
        method,
        &endpoint,
        None,
        &[],
        body,
        Some(OFFICIAL_HTTP_TIMEOUT_SECONDS),
    )?;
    if !(200..300).contains(&response.status) {
        log_non_200_http(
            "official-http",
            method,
            &endpoint,
            response.status,
            &response.body,
        );
    }
    Ok(response)
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
    let response = run_curl_json_response(
        method,
        &endpoint,
        None,
        &[],
        body,
        Some(OFFICIAL_HTTP_TIMEOUT_SECONDS),
    )?;
    if !(200..300).contains(&response.status) {
        log_non_200_http(
            "official-http",
            method,
            &endpoint,
            response.status,
            &response.body,
        );
    }
    Ok(response.body)
}

fn official_auth_payload_candidate(raw: &Value) -> Value {
    let unwrapped = official_unwrap_response_payload(raw);
    for payload in [&unwrapped, raw] {
        for key in [
            "auth_payload",
            "authPayload",
            "auth_session",
            "authSession",
            "session",
        ] {
            if let Some(value) = payload.get(key).filter(|value| value.is_object()) {
                return value.clone();
            }
        }
    }
    unwrapped
}

pub(crate) fn normalize_official_auth_session(raw: &Value) -> Result<Value, String> {
    let payload = official_auth_payload_candidate(raw);
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

fn looks_like_machine_user_id(value: &str) -> bool {
    let trimmed = value.trim();
    let parts: Vec<&str> = trimmed.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn official_user_display_name(user: &Value) -> Value {
    for key in [
        "displayName",
        "display_name",
        "nickname",
        "nickName",
        "name",
        "username",
        "userName",
        "email",
        "phone",
        "mobile",
    ] {
        if let Some(value) = payload_string(user, key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && !looks_like_machine_user_id(trimmed) {
                return json!(trimmed);
            }
        }
    }
    Value::Null
}

pub(crate) fn official_account_summary_local(settings: &Value, models: &[Value]) -> Value {
    let session = official_settings_session(settings).unwrap_or_else(|| json!({}));
    let user = session.get("user").cloned().unwrap_or_else(|| json!({}));
    json!({
        "loggedIn": official_access_token_from_settings(settings).is_some(),
        "displayName": official_user_display_name(&user),
        "email": user.get("email").cloned().unwrap_or(Value::Null),
        "apiKeyPresent": official_ai_api_key_from_settings(settings).is_some(),
        "planName": user.get("planName").cloned().unwrap_or_else(|| json!(format!("{} Official", app_brand_display_name()))),
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

fn model_name_disallows_chat_list(model_id: &str) -> bool {
    model_id.trim().to_ascii_lowercase().contains("omni")
}

fn forced_model_capabilities_by_name(model_id: &str) -> Option<Vec<String>> {
    let normalized = model_id.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized.contains("asr") || normalized == "nova-3" {
        return Some(vec!["transcription".to_string()]);
    }
    None
}

fn normalize_model_capability_name(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    let capability = match normalized.as_str() {
        "stt" => "transcription",
        "chat" | "image" | "video" | "audio" | "tts" | "voice_clone" | "transcription"
        | "embedding" => normalized.as_str(),
        _ => return None,
    };
    Some(capability.to_string())
}

fn official_model_capabilities(item: &Value) -> Vec<String> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if let Some(capabilities) = forced_model_capabilities_by_name(id) {
        return capabilities;
    }

    let mut capabilities = Vec::<String>::new();
    if let Some(items) = item.get("capabilities").and_then(Value::as_array) {
        for value in items {
            if let Some(capability) = value.as_str().and_then(normalize_model_capability_name) {
                if !capabilities.iter().any(|item| item == &capability) {
                    capabilities.push(capability);
                }
            }
        }
    }
    if let Some(capability) = item
        .get("capability")
        .and_then(Value::as_str)
        .and_then(normalize_model_capability_name)
    {
        if !capabilities.iter().any(|item| item == &capability) {
            capabilities.push(capability);
        }
    }
    capabilities
}

fn official_model_meta_value(item: &Value) -> Value {
    let mut meta = item.clone();
    let capabilities = official_model_capabilities(item);
    if !capabilities.is_empty() {
        if let Some(object) = meta.as_object_mut() {
            object.insert("capabilities".to_string(), json!(capabilities));
        }
    }
    meta
}

fn official_model_is_chat_list_candidate(item: &Value) -> bool {
    let Some(id) = item.get("id").and_then(Value::as_str).map(str::trim) else {
        return false;
    };
    if id.is_empty() || model_name_disallows_chat_list(id) {
        return false;
    }
    official_model_capabilities(item)
        .iter()
        .any(|capability| capability == "chat")
}

pub(crate) fn model_defaults_initialized(settings: &Value) -> bool {
    payload_string(settings, AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub(crate) fn official_sync_source_into_settings(
    settings: &mut Value,
    models: &[Value],
    seed_default_routes: bool,
) {
    let api_key = official_ai_api_key_from_settings(settings).unwrap_or_default();
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let current_default_source_id =
        payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let current_default_source_exists = !current_default_source_id.trim().is_empty()
        && sources.iter().any(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(|value| value.trim() == current_default_source_id.trim())
                .unwrap_or(false)
        });
    let defaults_initialized = model_defaults_initialized(settings);
    let current_default_is_official = current_default_source_id.trim() == "redbox_official_auto";
    let should_sync_official_route = seed_default_routes
        && !defaults_initialized
        && (current_default_source_id.trim().is_empty()
            || current_default_is_official
            || !current_default_source_exists);
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
        .filter(|item| official_model_is_chat_list_candidate(item))
        .filter_map(|item| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    let fallback_chat_model = models
        .iter()
        .find(|item| official_model_is_chat_list_candidate(item))
        .and_then(|item| item.get("id").and_then(|value| value.as_str()))
        .unwrap_or("gpt-4.1-mini");
    let current_text_model = payload_string(settings, "model_name");
    let official_model_id_set = official_model_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let preserved_official_model =
        if !seed_default_routes || (defaults_initialized && current_default_is_official) {
            existing_source
                .as_ref()
                .and_then(|item| payload_string(item, "model"))
                .filter(|value| official_model_id_set.contains(value.trim()))
                .or_else(|| {
                    current_text_model
                        .clone()
                        .filter(|value| official_model_id_set.contains(value.trim()))
                })
        } else {
            None
        };
    let chat_model = preserved_official_model.unwrap_or_else(|| {
        choose_preferred_official_chat_model(
            &available_chat_models,
            current_text_model.as_deref(),
            fallback_chat_model,
        )
    });
    let official_base_url = official_base_url_from_settings(settings);
    let official_video_api_key = official_ai_api_key_from_settings(settings).unwrap_or_default();
    let mut seen_meta_ids = std::collections::HashSet::new();
    let merged_models_meta = models
        .iter()
        .filter(|item| {
            let Some(id) = item.get("id").and_then(Value::as_str).map(str::trim) else {
                return false;
            };
            !id.is_empty() && seen_meta_ids.insert(id.to_string())
        })
        .map(official_model_meta_value)
        .collect::<Vec<_>>();
    let source = json!({
        "id": "redbox_official_auto",
        "name": format!("{} Official", app_brand_display_name()),
        "presetId": "redbox-official",
        "baseURL": official_base_url,
        "apiKey": api_key,
        "models": official_model_ids,
        "modelsMeta": merged_models_meta,
        "model": chat_model,
        "protocol": "openai"
    });
    sources.insert(0, source);
    let official_route_scoped_models = if should_sync_official_route {
        Some((
            sanitize_scoped_model_override(
                &official_model_ids,
                payload_string(settings, "model_name_wander").as_deref(),
            ),
            sanitize_scoped_model_override(
                &official_model_ids,
                payload_string(settings, "model_name_chatroom").as_deref(),
            ),
            sanitize_scoped_model_override(
                &official_model_ids,
                payload_string(settings, "model_name_knowledge").as_deref(),
            ),
            sanitize_scoped_model_override(
                &official_model_ids,
                payload_string(settings, "model_name_redclaw").as_deref(),
            ),
        ))
    } else {
        None
    };
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "ai_sources_json".to_string(),
            json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
        );
        if let Some((
            next_model_name_wander,
            next_model_name_chatroom,
            next_model_name_knowledge,
            next_model_name_redclaw,
        )) = official_route_scoped_models
        {
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
            object
                .entry(AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY.to_string())
                .or_insert_with(|| json!(now_ms().to_string()));
        }
        object.insert("video_endpoint".to_string(), json!(official_base_url));
        object.insert("video_api_key".to_string(), json!(official_video_api_key));
        object.insert(
            "redbox_official_models_json".to_string(),
            json!(serde_json::to_string(models).unwrap_or_else(|_| "[]".to_string())),
        );
    }
}

pub(crate) fn sync_official_cached_models_into_settings(settings: &mut Value) -> bool {
    let models = official_settings_models(settings);
    if models.is_empty() {
        return false;
    }
    official_sync_source_into_settings(settings, &models, false);
    true
}

pub(crate) fn fetch_official_models_for_settings(settings: &Value) -> Vec<Value> {
    run_official_ai_json_request(settings, "GET", "/models", None)
        .map(|remote| official_response_items(&remote))
        .unwrap_or_else(|_| official_settings_models(settings))
}

pub(crate) fn fetch_official_default_model_slots_for_settings(
    settings: &Value,
) -> Result<Vec<Value>, String> {
    run_official_json_request(settings, "GET", "/ai/default-models", None)
        .map(|remote| official_response_items(&remote))
}

fn parse_routes_setting(settings: &Value) -> serde_json::Map<String, Value> {
    payload_string(settings, "ai_model_routes_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn route_has_model(routes: &serde_json::Map<String, Value>, scope: &str) -> bool {
    routes
        .get(scope)
        .and_then(|route| route.get("model").or_else(|| route.get("modelName")))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn scope_has_configured_model(
    settings: &Value,
    routes: &serde_json::Map<String, Value>,
    scope: &str,
) -> bool {
    route_has_model(routes, scope)
        || default_slot_setting_key(scope)
            .and_then(|key| payload_string(settings, key))
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

pub(crate) fn has_missing_official_default_models(settings: &Value) -> bool {
    let routes = parse_routes_setting(settings);
    [
        "chat",
        "wander",
        "team",
        "knowledge",
        "redclaw",
        "transcription",
        "embedding",
        "image",
        "video",
        "visualIndex",
        "videoAnalysis",
        "voiceTts",
        "voiceClone",
    ]
    .iter()
    .any(|scope| !scope_has_configured_model(settings, &routes, scope))
}

fn value_text<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    })
}

fn default_slot_model(slot: &Value) -> Option<Value> {
    for key in [
        "effective_model",
        "effectiveModel",
        "primary_model",
        "primaryModel",
    ] {
        if let Some(model) = slot.get(key).filter(|value| value.is_object()) {
            let model_key = value_text(model, &["model_key", "modelKey", "model", "id"])?;
            let capability = value_text(model, &["capability"]).unwrap_or("chat");
            return Some(json!({
                "id": model_key,
                "capability": capability,
                "capabilities": [capability],
            }));
        }
    }
    let model_key = value_text(
        slot,
        &[
            "model_key",
            "modelKey",
            "model",
            "model_name",
            "modelName",
            "id",
        ],
    )?;
    let capability = value_text(slot, &["capability"]).unwrap_or("chat");
    Some(json!({
        "id": model_key,
        "capability": capability,
        "capabilities": [capability],
    }))
}

fn default_slot_key(slot: &Value) -> Option<String> {
    value_text(slot, &["slot_key", "slotKey", "slot", "key"]).map(|value| value.replace('-', "_"))
}

fn default_slot_route_scopes(slot_key: &str) -> &'static [&'static str] {
    match slot_key {
        "reasoning" => &["chat", "wander", "team", "knowledge", "redclaw"],
        "visual_index" => &["visualIndex"],
        "visual_analysis" => &["videoAnalysis"],
        "tts" => &["voiceTts"],
        "embedding" => &["embedding"],
        "transcription" => &["transcription"],
        "image_generation" => &["image"],
        "video_text_to_video" | "video_image_to_video" | "video_reference_to_video" => &["video"],
        _ => &[],
    }
}

fn default_slot_setting_key(route_scope: &str) -> Option<&'static str> {
    match route_scope {
        "chat" => Some("model_name"),
        "wander" => Some("model_name_wander"),
        "team" => Some("model_name_chatroom"),
        "knowledge" => Some("model_name_knowledge"),
        "redclaw" => Some("model_name_redclaw"),
        "transcription" => Some("transcription_model"),
        "embedding" => Some("embedding_model"),
        "image" => Some("image_model"),
        "video" => Some("video_model"),
        "visualIndex" => Some("visual_index_model"),
        "videoAnalysis" => Some("video_analysis_model"),
        "voiceTts" => Some("voice_tts_model"),
        "voiceClone" => Some("voice_clone_model"),
        _ => None,
    }
}

pub(crate) fn seed_official_default_models_into_settings(
    settings: &mut Value,
    default_slots: &[Value],
    catalog_models: &[Value],
) -> bool {
    if model_defaults_initialized(settings) {
        return false;
    }
    let mut default_models = Vec::<Value>::new();
    let mut routes = serde_json::Map::new();
    for slot in default_slots {
        let Some(slot_key) = default_slot_key(slot) else {
            continue;
        };
        let Some(model) = default_slot_model(slot) else {
            continue;
        };
        let Some(model_id) = value_text(&model, &["id"]).map(ToString::to_string) else {
            continue;
        };
        default_models.push(model);
        for scope in default_slot_route_scopes(&slot_key) {
            routes.insert(
                (*scope).to_string(),
                json!({
                    "mode": "official",
                    "sourceId": "redbox_official_auto",
                    "model": model_id,
                }),
            );
        }
    }
    if routes.is_empty() {
        return false;
    }

    let mut models_for_source = Vec::<Value>::new();
    models_for_source.extend(catalog_models.iter().cloned());
    models_for_source.extend(default_models);
    official_sync_source_into_settings(settings, &models_for_source, true);

    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "default_ai_source_id".to_string(),
            json!("redbox_official_auto"),
        );
        object
            .entry(AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY.to_string())
            .or_insert_with(|| json!(now_ms().to_string()));
        for (scope, route) in &routes {
            if let Some(model) = route.get("model").and_then(Value::as_str) {
                if let Some(setting_key) = default_slot_setting_key(scope) {
                    object.insert(setting_key.to_string(), json!(model));
                }
            }
        }
        object.insert(
            "ai_model_routes_json".to_string(),
            json!(
                serde_json::to_string(&Value::Object(routes)).unwrap_or_else(|_| "{}".to_string())
            ),
        );
    }
    crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
    true
}

pub(crate) fn repair_missing_official_default_models_into_settings(
    settings: &mut Value,
    default_slots: &[Value],
    catalog_models: &[Value],
) -> bool {
    let mut routes = parse_routes_setting(settings);
    let mut default_models = Vec::<Value>::new();
    let mut repaired = false;

    for slot in default_slots {
        let Some(slot_key) = default_slot_key(slot) else {
            continue;
        };
        let Some(model) = default_slot_model(slot) else {
            continue;
        };
        let Some(model_id) = value_text(&model, &["id"]).map(ToString::to_string) else {
            continue;
        };
        let mut used_model = false;
        for scope in default_slot_route_scopes(&slot_key) {
            if scope_has_configured_model(settings, &routes, scope) {
                continue;
            }
            routes.insert(
                (*scope).to_string(),
                json!({
                    "mode": "official",
                    "sourceId": "redbox_official_auto",
                    "model": model_id,
                }),
            );
            if let Some(setting_key) = default_slot_setting_key(scope) {
                if let Some(object) = settings.as_object_mut() {
                    object.insert(setting_key.to_string(), json!(model_id));
                }
            }
            repaired = true;
            used_model = true;
        }
        if used_model {
            default_models.push(model);
        }
    }

    if !repaired {
        return false;
    }

    let mut models_for_source = Vec::<Value>::new();
    models_for_source.extend(catalog_models.iter().cloned());
    models_for_source.extend(default_models);
    official_sync_source_into_settings(settings, &models_for_source, false);

    let default_source_missing = payload_string(settings, "default_ai_source_id")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    if let Some(object) = settings.as_object_mut() {
        if default_source_missing {
            object.insert(
                "default_ai_source_id".to_string(),
                json!("redbox_official_auto"),
            );
        }
        object
            .entry(AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY.to_string())
            .or_insert_with(|| json!(now_ms().to_string()));
        object.insert(
            "ai_model_routes_json".to_string(),
            json!(
                serde_json::to_string(&Value::Object(routes)).unwrap_or_else(|_| "{}".to_string())
            ),
        );
    }
    crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn official_models_fixture() -> Vec<Value> {
        vec![
            json!({ "id": "gpt-5.5", "capabilities": ["chat"] }),
            json!({ "id": "embedding-3", "capabilities": ["embedding"] }),
        ]
    }

    #[test]
    fn official_chat_candidates_exclude_omni_models() {
        let models = vec![
            json!({ "id": "qwen3.5-omni-flash", "capabilities": ["chat", "audio"] }),
            json!({ "id": "qwen3.5-plus", "capabilities": ["chat"] }),
        ];
        let available_chat_models = models
            .iter()
            .filter(|item| official_model_is_chat_list_candidate(item))
            .filter_map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>();

        assert_eq!(available_chat_models, vec!["qwen3.5-plus"]);
        assert_eq!(
            choose_preferred_official_chat_model(
                &available_chat_models,
                Some("qwen3.5-omni-flash"),
                "qwen3.5-plus",
            ),
            "qwen3.5-plus"
        );
    }

    #[test]
    fn official_chat_candidates_exclude_asr_name_models() {
        let models = vec![
            json!({ "id": "qwen3-asr-flash-filetrans", "capabilities": ["chat"] }),
            json!({ "id": "nova-3", "capabilities": ["chat"] }),
            json!({ "id": "qwen3.5-flash", "capabilities": ["chat"] }),
        ];
        let available_chat_models = models
            .iter()
            .filter(|item| official_model_is_chat_list_candidate(item))
            .filter_map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .collect::<Vec<_>>();

        assert_eq!(available_chat_models, vec!["qwen3.5-flash"]);
        assert_eq!(
            official_model_capabilities(
                &json!({ "id": "qwen3-asr-flash-filetrans", "capabilities": ["chat"] })
            ),
            vec!["transcription".to_string()]
        );
        assert_eq!(
            official_model_capabilities(&json!({ "id": "nova-3", "capability": "chat" })),
            vec!["transcription".to_string()]
        );
    }

    #[test]
    fn official_base_url_uses_current_brand_slug() {
        assert_eq!(
            official_base_url_for_realm("cn"),
            format!("https://api.ziz.hk/{}/v1", app_brand_slug())
        );
        assert_eq!(
            official_base_url_from_settings(
                &json!({ "redbox_official_base_url": "https://api.ziz.hk/thrive/v1" })
            ),
            format!("https://api.ziz.hk/{}/v1", app_brand_slug())
        );
    }

    #[test]
    fn normalize_official_auth_session_accepts_wechat_auth_payload_aliases() {
        let session = normalize_official_auth_session(&json!({
            "status": "CONFIRMED",
            "authPayload": {
                "accessToken": "access-token",
                "refreshToken": "refresh-token",
                "apiKey": "official-key",
                "user": { "id": "user-1" }
            }
        }))
        .expect("wechat auth payload alias should normalize");

        assert_eq!(
            payload_string(&session, "accessToken").as_deref(),
            Some("access-token")
        );
        assert_eq!(
            payload_string(&session, "refreshToken").as_deref(),
            Some("refresh-token")
        );
        assert_eq!(
            payload_string(&session, "apiKey").as_deref(),
            Some("official-key")
        );
    }

    #[test]
    fn normalize_official_auth_session_rejects_confirmed_payload_without_tokens() {
        let error = normalize_official_auth_session(&json!({
            "status": "CONFIRMED",
            "message": "登录成功"
        }))
        .expect_err("confirmed payload without tokens must not be treated as logged in");

        assert!(error.contains("access_token"));
    }

    #[test]
    fn official_sync_preserves_user_selected_custom_default_route() {
        let custom_sources = vec![json!({
            "id": "custom-source",
            "name": "Custom",
            "presetId": "custom",
            "baseURL": "https://custom.example/v1",
            "apiKey": "custom-key",
            "model": "custom-model",
            "models": ["custom-model"],
            "modelsMeta": [{ "id": "custom-model", "capabilities": ["chat"] }],
            "protocol": "openai"
        })];
        let mut settings = json!({
            "default_ai_source_id": "custom-source",
            "api_endpoint": "https://custom.example/v1",
            "api_key": "custom-key",
            "model_name": "custom-model",
            "model_name_wander": "custom-wander",
            "ai_sources_json": serde_json::to_string(&custom_sources).unwrap(),
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });

        official_sync_source_into_settings(&mut settings, &official_models_fixture(), true);

        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("custom-source")
        );
        assert_eq!(
            payload_string(&settings, "api_endpoint").as_deref(),
            Some("https://custom.example/v1")
        );
        assert_eq!(
            payload_string(&settings, "api_key").as_deref(),
            Some("custom-key")
        );
        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("custom-model")
        );
        assert_eq!(
            payload_string(&settings, "model_name_wander").as_deref(),
            Some("custom-wander")
        );

        let sources = payload_string(&settings, "ai_sources_json")
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();
        assert_eq!(
            sources
                .first()
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str),
            Some("redbox_official_auto")
        );
        assert!(sources
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some("custom-source")));
    }

    #[test]
    fn openai_video_analysis_body_uses_openai_compatible_video_url() {
        let body = openai_video_analysis_body(
            "qwen3.5-omni-flash",
            "system",
            "inspect video",
            "video/mp4",
            "BASE64",
        );

        assert_eq!(body.get("model"), Some(&json!("qwen3.5-omni-flash")));
        assert_eq!(body.get("modalities"), Some(&json!(["text"])));
        assert_eq!(body.get("stream"), Some(&json!(false)));
        assert_eq!(
            body.pointer("/messages/1/content/0/type"),
            Some(&json!("video_url"))
        );
        assert_eq!(
            body.pointer("/messages/1/content/0/video_url/url"),
            Some(&json!("data:;base64,BASE64"))
        );
        assert_eq!(
            body.pointer("/messages/1/content/1/text"),
            Some(&json!("inspect video"))
        );
    }

    #[test]
    fn openai_chat_message_content_accepts_array_parts() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "hello" },
                        { "type": "text", "text": " world" }
                    ]
                }
            }]
        });

        assert_eq!(openai_chat_message_content(&response), "hello world");
    }

    #[test]
    fn official_sync_updates_route_when_official_is_current_default() {
        let official_cn_base_url = official_base_url_for_realm("cn");
        let official_sources = vec![json!({
            "id": "redbox_official_auto",
            "name": format!("{} Official", app_brand_display_name()),
            "presetId": "redbox-official",
            "baseURL": official_cn_base_url.clone(),
            "apiKey": "old-official-key",
            "model": "old-model",
            "models": ["old-model"],
            "protocol": "openai"
        })];
        let mut settings = json!({
            "default_ai_source_id": "redbox_official_auto",
            "api_endpoint": "https://old.example/v1",
            "api_key": "old-key",
            "model_name": "old-model",
            "model_name_wander": "missing-official-model",
            "ai_sources_json": serde_json::to_string(&official_sources).unwrap(),
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });

        official_sync_source_into_settings(&mut settings, &official_models_fixture(), true);

        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("redbox_official_auto")
        );
        assert_eq!(
            payload_string(&settings, "api_endpoint").as_deref(),
            Some(official_cn_base_url.as_str())
        );
        assert_eq!(
            payload_string(&settings, "api_key").as_deref(),
            Some("official-key")
        );
        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            payload_string(&settings, "model_name_wander").as_deref(),
            None
        );
        assert!(
            payload_string(&settings, AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        );
    }

    #[test]
    fn official_sync_preserves_initialized_official_default_model_when_still_available() {
        let official_cn_base_url = official_base_url_for_realm("cn");
        let official_sources = vec![json!({
            "id": "redbox_official_auto",
            "name": format!("{} Official", app_brand_display_name()),
            "presetId": "redbox-official",
            "baseURL": official_cn_base_url.clone(),
            "apiKey": "old-official-key",
            "model": "gpt-5.5",
            "models": ["gpt-5.5", "stale-tts-model"],
            "modelsMeta": [{ "id": "stale-tts-model", "capabilities": ["tts"] }],
            "protocol": "openai"
        })];
        let mut settings = json!({
            "default_ai_source_id": "redbox_official_auto",
            "api_endpoint": official_cn_base_url,
            "api_key": "official-key",
            "model_name": "gpt-5.5",
            "model_name_wander": "user-wander-model",
            "ai_sources_json": serde_json::to_string(&official_sources).unwrap(),
            "ai_model_defaults_initialized_at": "2026-05-19T00:00:00Z",
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });

        official_sync_source_into_settings(&mut settings, &official_models_fixture(), true);

        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            payload_string(&settings, "model_name_wander").as_deref(),
            Some("user-wander-model")
        );
        let sources = payload_string(&settings, "ai_sources_json")
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();
        assert_eq!(
            sources
                .iter()
                .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
                .and_then(|item| payload_string(item, "model"))
                .as_deref(),
            Some("gpt-5.5")
        );
        let official_source = sources
            .iter()
            .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
            .expect("official source");
        let source_models = official_source
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(!source_models
            .iter()
            .any(|item| item.as_str() == Some("stale-tts-model")));
        let source_models_meta = official_source
            .get("modelsMeta")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(!source_models_meta
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some("stale-tts-model")));
    }

    #[test]
    fn seed_official_default_models_writes_route_config_from_slots() {
        let mut settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });
        let default_slots = vec![
            json!({
                "slot_key": "reasoning",
                "effective_model": { "model_key": "qwen3.5-plus", "capability": "chat", "is_active": true }
            }),
            json!({
                "slot_key": "embedding",
                "effective_model": { "model_key": "text-embedding-3-small", "capability": "embedding", "is_active": true }
            }),
            json!({
                "slot_key": "image_generation",
                "effective_model": { "model_key": "gpt-image-2", "capability": "image", "is_active": true }
            }),
            json!({
                "slot_key": "visual_analysis",
                "effective_model": { "model_key": "qwen3.5-omni-flash", "capability": "chat", "is_active": true }
            }),
        ];

        assert!(seed_official_default_models_into_settings(
            &mut settings,
            &default_slots,
            &[]
        ));

        let routes = payload_string(&settings, "ai_model_routes_json")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| json!({}));
        assert_eq!(routes["chat"]["model"], json!("qwen3.5-plus"));
        assert_eq!(routes["wander"]["model"], json!("qwen3.5-plus"));
        assert_eq!(
            routes["embedding"]["model"],
            json!("text-embedding-3-small")
        );
        assert_eq!(routes["image"]["model"], json!("gpt-image-2"));
        assert_eq!(
            routes["videoAnalysis"]["model"],
            json!("qwen3.5-omni-flash")
        );
        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("redbox_official_auto")
        );
        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("qwen3.5-plus")
        );
        assert!(
            payload_string(&settings, AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        );
    }

    #[test]
    fn seed_official_default_models_does_not_override_initialized_user_routes() {
        let user_routes = json!({
            "chat": { "mode": "custom", "sourceId": "custom-source", "model": "user-chat" },
            "image": { "mode": "custom", "sourceId": "custom-source", "model": "user-image" },
            "video": { "mode": "custom", "sourceId": "custom-source", "model": "user-video" }
        });
        let mut settings = json!({
            "default_ai_source_id": "custom-source",
            "api_endpoint": "https://custom.example/v1",
            "api_key": "custom-key",
            "model_name": "user-chat",
            "image_model": "user-image",
            "video_model": "user-video",
            AI_MODEL_DEFAULTS_INITIALIZED_AT_KEY: "2026-05-19T00:00:00Z",
            "ai_model_routes_json": serde_json::to_string(&user_routes).unwrap(),
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "name": "Custom",
                "presetId": "custom",
                "baseURL": "https://custom.example/v1",
                "apiKey": "custom-key",
                "model": "user-chat",
                "protocol": "openai"
            })])
            .unwrap(),
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });
        let default_slots = vec![json!({
            "slot_key": "reasoning",
            "effective_model": { "model_key": "qwen3.5-plus", "capability": "chat", "is_active": true }
        })];

        assert!(!seed_official_default_models_into_settings(
            &mut settings,
            &default_slots,
            &official_models_fixture()
        ));

        let routes = payload_string(&settings, "ai_model_routes_json")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| json!({}));
        assert_eq!(routes, user_routes);
        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("custom-source")
        );
        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("user-chat")
        );
        assert_eq!(
            payload_string(&settings, "image_model").as_deref(),
            Some("user-image")
        );
        assert_eq!(
            payload_string(&settings, "video_model").as_deref(),
            Some("user-video")
        );
    }

    #[test]
    fn repair_missing_official_default_models_only_fills_empty_scopes() {
        let user_routes = json!({
            "chat": { "mode": "custom", "sourceId": "custom-source", "model": "user-chat" },
            "image": { "mode": "custom", "sourceId": "custom-source", "model": "user-image" }
        });
        let mut settings = json!({
            "default_ai_source_id": "custom-source",
            "api_endpoint": "https://custom.example/v1",
            "api_key": "custom-key",
            "model_name": "user-chat",
            "image_model": "user-image",
            "ai_model_routes_json": serde_json::to_string(&user_routes).unwrap(),
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "custom-source",
                "name": "Custom",
                "presetId": "custom",
                "baseURL": "https://custom.example/v1",
                "apiKey": "custom-key",
                "model": "user-chat",
                "protocol": "openai"
            })]).unwrap(),
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });
        let default_slots = vec![
            json!({
                "slot_key": "reasoning",
                "effective_model": { "model_key": "qwen3.5-plus", "capability": "chat", "is_active": true }
            }),
            json!({
                "slot_key": "image_generation",
                "effective_model": { "model_key": "gpt-image-2", "capability": "image", "is_active": true }
            }),
            json!({
                "slot_key": "video_text_to_video",
                "effective_model": { "model_key": "seedance-3.0", "capability": "video", "is_active": true }
            }),
            json!({
                "slot_key": "embedding",
                "effective_model": { "model_key": "embedding-3", "capability": "embedding", "is_active": true }
            }),
        ];

        assert!(repair_missing_official_default_models_into_settings(
            &mut settings,
            &default_slots,
            &official_models_fixture()
        ));

        let routes = payload_string(&settings, "ai_model_routes_json")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| json!({}));
        assert_eq!(routes["chat"]["model"], json!("user-chat"));
        assert_eq!(routes["image"]["model"], json!("user-image"));
        assert_eq!(routes["video"]["model"], json!("seedance-3.0"));
        assert_eq!(routes["embedding"]["model"], json!("embedding-3"));
        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("custom-source")
        );
        assert_eq!(
            payload_string(&settings, "video_model").as_deref(),
            Some("seedance-3.0")
        );
        assert_eq!(
            payload_string(&settings, "embedding_model").as_deref(),
            Some("embedding-3")
        );
    }

    #[test]
    fn official_model_catalog_sync_does_not_invent_video_model() {
        let mut settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });

        official_sync_source_into_settings(&mut settings, &official_models_fixture(), false);

        assert_eq!(payload_string(&settings, "video_model"), None);
    }

    #[test]
    fn official_model_catalog_sync_marks_asr_name_models_as_transcription() {
        let mut settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({ "apiKey": "official-key" })).unwrap()
        });
        let models = vec![
            json!({ "id": "qwen3-asr-flash-filetrans", "capabilities": ["chat"] }),
            json!({ "id": "nova-3", "capabilities": ["chat"] }),
            json!({ "id": "qwen3.5-flash", "capabilities": ["chat"] }),
        ];

        official_sync_source_into_settings(&mut settings, &models, false);

        let sources = payload_string(&settings, "ai_sources_json")
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();
        let official_source = sources
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some("redbox_official_auto"))
            .expect("official source should be synced");
        let models_meta = official_source
            .get("modelsMeta")
            .and_then(Value::as_array)
            .expect("official source should include modelsMeta");

        for model_id in ["qwen3-asr-flash-filetrans", "nova-3"] {
            let meta = models_meta
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(model_id))
                .expect("ASR model meta should exist");
            assert_eq!(meta.get("capabilities"), Some(&json!(["transcription"])));
        }
    }
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
    let active_realm = official_realm_from_settings(settings);
    let active_base_url = official_base_url_from_settings(settings);
    let mut sessions = official_settings_sessions(settings);
    if let Some(object) = settings.as_object_mut() {
        match session {
            Some(session_value) => {
                let mut session_value = session_value.clone();
                if let Some(session_object) = session_value.as_object_mut() {
                    session_object.insert("realm".to_string(), json!(active_realm.clone()));
                    session_object.insert(
                        "realmLabel".to_string(),
                        json!(official_realm_label(&active_realm)),
                    );
                    session_object.insert("baseUrl".to_string(), json!(active_base_url.clone()));
                }
                sessions.insert(active_realm.clone(), session_value.clone());
                object.insert(
                    "redbox_auth_session_json".to_string(),
                    json!(
                        serde_json::to_string(&session_value).unwrap_or_else(|_| "{}".to_string())
                    ),
                );
            }
            None => {
                sessions.remove(&active_realm);
                object.insert("redbox_auth_session_json".to_string(), json!(""));
            }
        }
        object.insert(
            "redbox_auth_sessions_json".to_string(),
            json!(serde_json::to_string(&Value::Object(sessions))
                .unwrap_or_else(|_| "{}".to_string())),
        );
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
    let brand_name = app_brand_display_name();
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>{brand_name} 支付</title></head><body><div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;\"><h3>{brand_name} 充值订单</h3><p>订单号：{order_no}</p><p>金额：¥{amount:.2}</p><p>{safe_subject}</p><button style=\"padding:10px 16px;border-radius:10px;border:1px solid #ddd;background:#111;color:#fff;\">请在正式环境接入支付网关</button></div></body></html>"
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
