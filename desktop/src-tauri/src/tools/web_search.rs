use serde_json::{json, Value};
use tauri::State;

use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{
    normalize_base_url, payload_field, payload_string, provider_profile_from_config,
    resolve_chat_config, run_curl_json_response, search_web_with_settings, text_snippet, AppState,
    ResolvedChatConfig,
};

const DEFAULT_RESULT_LIMIT: usize = 6;
const MAX_RESULT_LIMIT: usize = 10;
const DEFAULT_SEARCH_CONTEXT_SIZE: &str = "medium";

pub(crate) fn search(
    state: &State<'_, AppState>,
    payload: &Value,
    model_config: Option<&Value>,
) -> Result<Value, String> {
    let query = payload_string(payload, "query")
        .or_else(|| payload_string(payload, "prompt"))
        .ok_or_else(|| "web.search requires query".to_string())?;
    if query.trim().is_empty() {
        return Err("web.search requires a non-empty query".to_string());
    }
    let limit = normalized_limit(payload);
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let config = resolve_chat_config(&settings_snapshot, model_config)
        .ok_or_else(|| "web.search failed to resolve model config".to_string())?;
    let mode = payload_string(payload, "mode")
        .or_else(|| payload_string(payload, "providerMode"))
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase();
    let prefer_hosted = mode != "local";
    let allow_fallback = payload_bool(payload, &["allowFallback", "allow_fallback"]).unwrap_or(true);

    if prefer_hosted {
        match hosted_search(&config, payload, &query, limit) {
            Ok(mut result) => {
                result["fallbackUsed"] = json!(false);
                return Ok(result);
            }
            Err(error) if allow_fallback => {
                let mut result = local_search(&settings_snapshot, &query, limit)?;
                result["fallbackUsed"] = json!(true);
                result["hostedError"] = json!(text_snippet(&error, 500));
                return Ok(result);
            }
            Err(error) => return Err(error),
        }
    }

    local_search(&settings_snapshot, &query, limit)
}

fn hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let profile = provider_profile_from_config(config);
    match profile.provider_family {
        crate::provider_compat::ProviderFamily::Anthropic => {
            anthropic_hosted_search(config, payload, query, limit)
        }
        crate::provider_compat::ProviderFamily::OpenAiCompat
        | crate::provider_compat::ProviderFamily::MiniMax => {
            if is_openai_official_base(&config.base_url) {
                openai_responses_hosted_search(config, payload, query, limit)
            } else {
                Err("hosted web search passthrough is only known for official OpenAI/Anthropic APIs; this OpenAI-compatible endpoint does not advertise a provider-hosted search contract".to_string())
            }
        }
        crate::provider_compat::ProviderFamily::Gemini => {
            Err("hosted web search passthrough is not implemented for Gemini protocol".to_string())
        }
    }
}

fn openai_responses_hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let endpoint = format!("{}/responses", normalize_base_url(&config.base_url));
    let tool = openai_web_search_tool(payload);
    let response = run_curl_json_response(
        "POST",
        &endpoint,
        config.api_key.as_deref(),
        &[],
        Some(json!({
            "model": config.model_name,
            "tools": [tool],
            "tool_choice": "required",
            "input": hosted_search_instruction(query, limit),
        })),
        Some(90),
    )
    .map_err(|error| format!("OpenAI hosted web search request failed: {error}"))?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "OpenAI hosted web search returned HTTP {}: {}",
            response.status,
            text_snippet(&response.body.to_string(), 500)
        ));
    }
    let answer = extract_openai_response_text(&response.body);
    let sources = extract_openai_response_sources(&response.body);
    if answer.trim().is_empty() && sources.is_empty() {
        return Err("OpenAI hosted web search returned no usable text or sources".to_string());
    }
    Ok(json!({
        "success": true,
        "provider": "openai.responses.web_search",
        "query": query,
        "answer": answer,
        "results": sources,
        "resultCount": sources.len(),
        "rawResultAvailable": true,
    }))
}

fn anthropic_hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let endpoint = format!("{}/messages", normalize_base_url(&config.base_url));
    let response = run_curl_json_response(
        "POST",
        &endpoint,
        None,
        &[
            ("x-api-key", config.api_key.clone().unwrap_or_default()),
            ("anthropic-version", "2023-06-01".to_string()),
        ],
        Some(json!({
            "model": config.model_name,
            "max_tokens": payload_field(payload, "maxTokens")
                .or_else(|| payload_field(payload, "max_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(1600)
                .clamp(256, 4096),
            "tools": [anthropic_web_search_tool(payload)],
            "messages": [
                { "role": "user", "content": hosted_search_instruction(query, limit) }
            ]
        })),
        Some(90),
    )
    .map_err(|error| format!("Anthropic hosted web search request failed: {error}"))?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Anthropic hosted web search returned HTTP {}: {}",
            response.status,
            text_snippet(&response.body.to_string(), 500)
        ));
    }
    let answer = extract_anthropic_text(&response.body);
    let sources = extract_anthropic_sources(&response.body);
    if answer.trim().is_empty() && sources.is_empty() {
        return Err("Anthropic hosted web search returned no usable text or sources".to_string());
    }
    Ok(json!({
        "success": true,
        "provider": "anthropic.messages.web_search",
        "query": query,
        "answer": answer,
        "results": sources,
        "resultCount": sources.len(),
        "rawResultAvailable": true,
    }))
}

fn local_search(settings_snapshot: &Value, query: &str, limit: usize) -> Result<Value, String> {
    let results = search_web_with_settings(settings_snapshot, query, limit)?;
    Ok(json!({
        "success": true,
        "provider": "local.search_settings",
        "query": query,
        "answer": "",
        "results": results,
        "resultCount": results.len(),
    }))
}

fn openai_web_search_tool(payload: &Value) -> Value {
    let mut tool = json!({ "type": "web_search" });
    let search_context_size = payload_string(payload, "searchContextSize")
        .or_else(|| payload_string(payload, "search_context_size"))
        .unwrap_or_else(|| DEFAULT_SEARCH_CONTEXT_SIZE.to_string());
    if matches!(search_context_size.as_str(), "low" | "medium" | "high") {
        tool["search_context_size"] = json!(search_context_size);
    }
    if let Some(filters) = openai_domain_filters(payload) {
        tool["filters"] = filters;
    }
    if let Some(external_web_access) =
        payload_bool(payload, &["externalWebAccess", "external_web_access"])
    {
        tool["external_web_access"] = json!(external_web_access);
    }
    tool
}

fn anthropic_web_search_tool(payload: &Value) -> Value {
    let mut tool = json!({
        "type": "web_search_20250305",
        "name": "web_search",
    });
    if let Some(max_uses) = payload_field(payload, "maxUses")
        .or_else(|| payload_field(payload, "max_uses"))
        .and_then(Value::as_u64)
    {
        tool["max_uses"] = json!(max_uses.clamp(1, 10));
    }
    if let Some(domains) = normalized_string_array(payload, &["allowedDomains", "allowed_domains"])
    {
        tool["allowed_domains"] = json!(domains);
    }
    if let Some(domains) = normalized_string_array(payload, &["blockedDomains", "blocked_domains"])
    {
        tool["blocked_domains"] = json!(domains);
    }
    tool
}

fn openai_domain_filters(payload: &Value) -> Option<Value> {
    let allowed = normalized_string_array(payload, &["allowedDomains", "allowed_domains"]);
    let blocked = normalized_string_array(payload, &["blockedDomains", "blocked_domains"]);
    if allowed.is_none() && blocked.is_none() {
        return None;
    }
    let mut filters = serde_json::Map::new();
    if let Some(domains) = allowed {
        filters.insert("allowed_domains".to_string(), json!(domains));
    }
    if let Some(domains) = blocked {
        filters.insert("blocked_domains".to_string(), json!(domains));
    }
    Some(Value::Object(filters))
}

fn normalized_string_array(payload: &Value, keys: &[&str]) -> Option<Vec<String>> {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(100)
                .map(|value| value.trim_start_matches("https://").trim_start_matches("http://"))
                .map(|value| value.trim_matches('/').to_string())
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
}

fn hosted_search_instruction(query: &str, limit: usize) -> String {
    format!(
        "Search the public web for this query and return a concise answer plus up to {limit} source entries with title, url, and one-sentence relevance. Query: {query}"
    )
}

fn normalized_limit(payload: &Value) -> usize {
    payload_field(payload, "limit")
        .or_else(|| payload_field(payload, "count"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT)
}

fn payload_bool(payload: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| payload_field(payload, key))
        .and_then(|value| match value {
            Value::Bool(flag) => Some(*flag),
            Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "y" => Some(true),
                "false" | "0" | "no" | "n" => Some(false),
                _ => None,
            },
            _ => None,
        })
}

fn is_openai_official_base(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("api.openai.com")
}

fn extract_openai_response_text(response: &Value) -> String {
    if let Some(text) = response.get("output_text").and_then(Value::as_str) {
        return text.to_string();
    }
    response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|content| {
            content
                .get("text")
                .or_else(|| content.get("output_text"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_openai_response_sources(response: &Value) -> Vec<Value> {
    let mut sources = Vec::new();
    collect_annotation_sources(response, &mut sources);
    sources
}

fn collect_annotation_sources(value: &Value, sources: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            if let Some(annotations) = map.get("annotations").and_then(Value::as_array) {
                for annotation in annotations {
                    let url = annotation
                        .get("url")
                        .or_else(|| annotation.pointer("/citation/url"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if url.trim().is_empty() {
                        continue;
                    }
                    sources.push(json!({
                        "title": annotation.get("title").and_then(Value::as_str).unwrap_or(""),
                        "url": url,
                        "snippet": annotation.get("text")
                            .or_else(|| annotation.get("cited_text"))
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    }));
                }
            }
            for child in map.values() {
                collect_annotation_sources(child, sources);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_annotation_sources(item, sources);
            }
        }
        _ => {}
    }
}

fn extract_anthropic_text(response: &Value) -> String {
    response
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                item.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_anthropic_sources(response: &Value) -> Vec<Value> {
    let mut sources = Vec::new();
    collect_anthropic_source_blocks(response, &mut sources);
    sources
}

fn collect_anthropic_source_blocks(value: &Value, sources: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("web_search_result") {
                if let Some(url) = map.get("url").and_then(Value::as_str) {
                    sources.push(json!({
                        "title": map.get("title").and_then(Value::as_str).unwrap_or(""),
                        "url": url,
                        "snippet": map.get("cited_text")
                            .or_else(|| map.get("page_age"))
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    }));
                }
            }
            for child in map.values() {
                collect_anthropic_source_blocks(child, sources);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_anthropic_source_blocks(item, sources);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_openai_output_text_from_response_items() {
        let response = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "answer",
                    "annotations": [{ "title": "Source", "url": "https://example.com", "text": "snippet" }]
                }]
            }]
        });
        assert_eq!(extract_openai_response_text(&response), "answer");
        let sources = extract_openai_response_sources(&response);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0]["url"], json!("https://example.com"));
    }

    #[test]
    fn normalizes_domain_filters_without_scheme() {
        let payload = json!({
            "allowedDomains": ["https://example.com/", "docs.example.com"]
        });
        let filters = openai_domain_filters(&payload).unwrap();
        assert_eq!(
            filters["allowed_domains"],
            json!(["example.com", "docs.example.com"])
        );
    }
}
