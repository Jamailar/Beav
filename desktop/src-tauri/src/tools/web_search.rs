use std::collections::BTreeSet;

use serde_json::{json, Map, Value};
use tauri::State;

use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{
    normalize_base_url, payload_field, payload_string, provider_profile_from_config,
    resolve_chat_config, run_curl_json_response, text_snippet, AppState, ResolvedChatConfig,
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

    hosted_search(&config, payload, &query, limit)
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
        crate::provider_compat::ProviderFamily::OpenAiCompat => {
            if is_qwen_search_config(config) {
                qwen_hosted_search(config, payload, query, limit)
            } else {
                openai_responses_hosted_search(config, payload, query, limit)
            }
        }
        crate::provider_compat::ProviderFamily::MiniMax => {
            openai_responses_hosted_search(config, payload, query, limit)
        }
        crate::provider_compat::ProviderFamily::Gemini => {
            Err("hosted web search passthrough is not implemented for Gemini protocol".to_string())
        }
    }
}

fn is_qwen_search_config(config: &ResolvedChatConfig) -> bool {
    let model = config.model_name.trim().to_ascii_lowercase();
    if model.contains("gpt") {
        return false;
    }
    let base_url = config.base_url.trim().to_ascii_lowercase();
    model.contains("qwen")
        || base_url.contains("dashscope")
        || base_url.contains(".maas.aliyuncs.com")
}

fn qwen_hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    if qwen_uses_responses_web_search(&config.model_name) {
        qwen_responses_hosted_search(config, payload, query, limit)
    } else {
        qwen_chat_completions_hosted_search(config, payload, query, limit)
    }
}

fn openai_responses_hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let endpoint = openai_responses_search_endpoint(config);
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
    let mut sources = extract_openai_response_sources(&response.body);
    if sources.is_empty() {
        sources = extract_sources_from_answer_text(&answer);
    }
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

fn qwen_responses_hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let endpoint = openai_responses_search_endpoint(config);
    let response = run_curl_json_response(
        "POST",
        &endpoint,
        config.api_key.as_deref(),
        &[],
        Some(qwen_responses_search_body(config, payload, query, limit)),
        Some(90),
    )
    .map_err(|error| format!("Qwen Responses web search request failed: {error}"))?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Qwen Responses web search returned HTTP {}: {}",
            response.status,
            text_snippet(&response.body.to_string(), 500)
        ));
    }
    let answer = extract_openai_response_text(&response.body);
    let mut sources = extract_openai_response_sources(&response.body);
    if sources.is_empty() {
        sources = extract_sources_from_answer_text(&answer);
    }
    if answer.trim().is_empty() && sources.is_empty() {
        return Err("Qwen Responses web search returned no usable text or sources".to_string());
    }
    Ok(json!({
        "success": true,
        "provider": "dashscope.responses.web_search",
        "query": query,
        "answer": answer,
        "results": sources,
        "resultCount": sources.len(),
        "rawResultAvailable": true,
    }))
}

fn qwen_chat_completions_hosted_search(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Result<Value, String> {
    let endpoint = qwen_chat_completions_search_endpoint(config);
    let response = run_curl_json_response(
        "POST",
        &endpoint,
        config.api_key.as_deref(),
        &[],
        Some(qwen_chat_completions_search_body(
            config, payload, query, limit,
        )),
        Some(90),
    )
    .map_err(|error| format!("Qwen Chat Completions web search request failed: {error}"))?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Qwen Chat Completions web search returned HTTP {}: {}",
            response.status,
            text_snippet(&response.body.to_string(), 500)
        ));
    }
    let answer = extract_chat_completion_text(&response.body);
    let mut sources = extract_search_info_sources(&response.body);
    if sources.is_empty() {
        sources = extract_sources_from_answer_text(&answer);
    }
    if answer.trim().is_empty() && sources.is_empty() {
        return Err(
            "Qwen Chat Completions web search returned no usable text or sources".to_string(),
        );
    }
    Ok(json!({
        "success": true,
        "provider": "dashscope.chat_completions.enable_search",
        "query": query,
        "answer": answer,
        "results": sources,
        "resultCount": sources.len(),
        "rawResultAvailable": true,
    }))
}

fn openai_responses_search_endpoint(config: &ResolvedChatConfig) -> String {
    format!("{}/responses", normalize_base_url(&config.base_url))
}

fn qwen_chat_completions_search_endpoint(config: &ResolvedChatConfig) -> String {
    format!("{}/chat/completions", normalize_base_url(&config.base_url))
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

fn qwen_responses_search_body(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Value {
    let mut body = json!({
        "model": config.model_name,
        "tools": [{ "type": "web_search" }],
        "input": hosted_search_instruction(query, limit),
    });
    body["enable_thinking"] =
        json!(payload_bool(payload, &["enableThinking", "enable_thinking"]).unwrap_or(true));
    body
}

fn qwen_chat_completions_search_body(
    config: &ResolvedChatConfig,
    payload: &Value,
    query: &str,
    limit: usize,
) -> Value {
    let mut body = json!({
        "model": config.model_name,
        "messages": [
            { "role": "user", "content": hosted_search_instruction(query, limit) }
        ],
        "enable_search": true,
    });
    if let Some(search_options) = qwen_chat_search_options(payload) {
        body["search_options"] = search_options;
    }
    if let Some(enable_thinking) = payload_bool(payload, &["enableThinking", "enable_thinking"]) {
        body["enable_thinking"] = json!(enable_thinking);
    }
    body
}

fn qwen_uses_responses_web_search(model_name: &str) -> bool {
    let model = model_name.trim().to_ascii_lowercase();
    model.contains("qwen3.7")
        || model.contains("qwen3.6-plus")
        || model.contains("qwen3.6-flash")
        || model.contains("qwen3.5-plus")
        || model.contains("qwen3.5-flash")
        || model == "qwen3-max"
        || model.starts_with("qwen3-max-")
}

fn qwen_chat_search_options(payload: &Value) -> Option<Value> {
    let mut options = payload_field(payload, "searchOptions")
        .or_else(|| payload_field(payload, "search_options"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    insert_bool_if_absent(
        &mut options,
        "forced_search",
        payload_bool(payload, &["forcedSearch", "forced_search"]).unwrap_or(true),
    );

    if let Some(strategy) = payload_string(payload, "searchStrategy")
        .or_else(|| payload_string(payload, "search_strategy"))
    {
        let normalized = strategy.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "turbo" | "max" | "agent" | "agent_max") {
            options
                .entry("search_strategy")
                .or_insert_with(|| json!(normalized));
        }
    }

    if let Some(freshness) = payload_field(payload, "freshness")
        .or_else(|| payload_field(payload, "freshnessDays"))
        .and_then(Value::as_u64)
    {
        let freshness = freshness.clamp(1, 365);
        options
            .entry("freshness")
            .or_insert_with(|| json!(freshness));
        options
            .entry("search_strategy")
            .or_insert_with(|| json!("turbo"));
    }

    if let Some(domains) = normalized_string_array(
        payload,
        &[
            "assignedSiteList",
            "assigned_site_list",
            "allowedDomains",
            "allowed_domains",
        ],
    ) {
        options
            .entry("assigned_site_list")
            .or_insert_with(|| json!(domains.into_iter().take(25).collect::<Vec<_>>()));
        options
            .entry("search_strategy")
            .or_insert_with(|| json!("turbo"));
    }

    if let Some(enable_extension) = payload_bool(
        payload,
        &["enableSearchExtension", "enable_search_extension"],
    ) {
        options
            .entry("enable_search_extension")
            .or_insert_with(|| json!(enable_extension));
    }

    if let Some(prompt_intervene) = payload_string(payload, "promptIntervene")
        .or_else(|| payload_string(payload, "prompt_intervene"))
    {
        let mut intention_options = options
            .get("intention_options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        intention_options
            .entry("prompt_intervene")
            .or_insert_with(|| json!(prompt_intervene));
        options.insert(
            "intention_options".to_string(),
            Value::Object(intention_options),
        );
    }

    (!options.is_empty()).then(|| Value::Object(options))
}

fn insert_bool_if_absent(options: &mut Map<String, Value>, key: &str, value: bool) {
    options
        .entry(key.to_string())
        .or_insert_with(|| json!(value));
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
                .map(|value| {
                    value
                        .trim_start_matches("https://")
                        .trim_start_matches("http://")
                })
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

fn extract_chat_completion_text(response: &Value) -> String {
    response
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("message").or_else(|| choice.get("delta")))
        .map(|message| {
            message
                .get("content")
                .map(extract_message_content_text)
                .unwrap_or_default()
        })
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_message_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => content
            .get("text")
            .or_else(|| content.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn extract_openai_response_sources(response: &Value) -> Vec<Value> {
    let mut sources = Vec::new();
    collect_annotation_sources(response, &mut sources);
    sources
}

fn extract_sources_from_answer_text(answer: &str) -> Vec<Value> {
    let mut sources = Vec::<Value>::new();
    let mut seen_urls = BTreeSet::<String>::new();
    let mut pending_title = String::new();
    let mut last_source_index: Option<usize> = None;
    for line in answer.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((url, before, after)) = first_url_with_context(trimmed) else {
            if let Some(index) = last_source_index {
                if let Some(snippet) = source_snippet_continuation(trimmed) {
                    if let Some(source) = sources.get_mut(index) {
                        source["snippet"] = json!(snippet);
                    }
                }
            }
            if is_source_bullet(trimmed) {
                pending_title = clean_source_title(trimmed);
                last_source_index = None;
            }
            continue;
        };
        if !seen_urls.insert(url.clone()) {
            pending_title.clear();
            continue;
        }
        let title = if !before.trim().is_empty() {
            clean_source_title(before)
        } else if !pending_title.trim().is_empty() {
            pending_title.clone()
        } else {
            url_host_title(&url)
        };
        let snippet = clean_source_snippet(after);
        sources.push(json!({
            "title": title,
            "url": url,
            "snippet": snippet,
        }));
        last_source_index = sources.len().checked_sub(1);
        pending_title.clear();
    }
    sources
}

fn first_url_with_context(line: &str) -> Option<(String, &str, &str)> {
    let http_index = line.find("https://").or_else(|| line.find("http://"))?;
    let before = &line[..http_index];
    let rest = &line[http_index..];
    let end = rest
        .char_indices()
        .find_map(|(idx, ch)| {
            if ch.is_whitespace() || matches!(ch, ')' | ']' | '<' | '"' | '\'') {
                Some(idx)
            } else {
                None
            }
        })
        .unwrap_or(rest.len());
    let raw_url = rest[..end]
        .trim_matches(|ch: char| matches!(ch, '.' | ',' | ';'))
        .to_string();
    if raw_url.is_empty() {
        return None;
    }
    Some((raw_url, before, &rest[end..]))
}

fn is_source_bullet(line: &str) -> bool {
    line.starts_with("- ") || line.starts_with("* ") || line.starts_with("• ")
}

fn clean_source_title(value: &str) -> String {
    let mut title = value
        .trim()
        .trim_start_matches("- ")
        .trim_start_matches("* ")
        .trim_start_matches("• ")
        .trim_matches('`')
        .trim()
        .to_string();
    for separator in [" — ", " - ", ": "] {
        if let Some((prefix, suffix)) = title.rsplit_once(separator) {
            if !suffix.trim().is_empty() && !prefix.trim().is_empty() {
                title = prefix.trim().to_string();
                break;
            }
        }
    }
    title
        .trim_matches(|ch: char| matches!(ch, '-' | '—' | ':' | '"' | '“' | '”'))
        .trim()
        .to_string()
}

fn clean_source_snippet(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('-')
        .trim_start_matches('—')
        .trim_start_matches(':')
        .trim()
        .to_string()
}

fn source_snippet_continuation(line: &str) -> Option<String> {
    for prefix in [
        "Relevance:",
        "Reports:",
        "Covers:",
        "Details:",
        "Summarizes:",
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

fn url_host_title(url: &str) -> String {
    url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
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

fn extract_search_info_sources(response: &Value) -> Vec<Value> {
    let mut sources = Vec::new();
    let mut seen_urls = BTreeSet::new();
    collect_search_info_sources(response, &mut sources, &mut seen_urls);
    sources
}

fn collect_search_info_sources(
    value: &Value,
    sources: &mut Vec<Value>,
    seen_urls: &mut BTreeSet<String>,
) {
    match value {
        Value::Object(map) => {
            if let Some(results) = map.get("search_results").and_then(Value::as_array) {
                for result in results {
                    let Some(url) = result.get("url").and_then(Value::as_str) else {
                        continue;
                    };
                    if url.trim().is_empty() || !seen_urls.insert(url.to_string()) {
                        continue;
                    }
                    let title = result
                        .get("title")
                        .or_else(|| result.get("site_name"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| url_host_title(url));
                    let snippet = result
                        .get("snippet")
                        .or_else(|| result.get("summary"))
                        .or_else(|| result.get("site_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    sources.push(json!({
                        "title": title,
                        "url": url,
                        "snippet": snippet,
                    }));
                }
            }
            for child in map.values() {
                collect_search_info_sources(child, sources, seen_urls);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_search_info_sources(item, sources, seen_urls);
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
    fn extracts_sources_from_answer_text_sources_section() {
        let answer = r#"
Answer.

Sources:
- Investing.com — "SpaceX surges past Amazon"
  https://m.in.investing.com/news/stock-market-news/spacex-surges-past-amazon-briefly-tops-microsoft-in-market-cap-5458117
  Relevance: Reports SPCX closing at $201.80 and an implied market cap.

- Axios — "SpaceX soars above Amazon" — https://www.axios.com/2026/06/16/spacex-amazon-market-cap — Covers SpaceX's market-cap surge.
"#;
        let sources = extract_sources_from_answer_text(answer);

        assert_eq!(sources.len(), 2);
        assert_eq!(
            sources[0]["url"],
            json!("https://m.in.investing.com/news/stock-market-news/spacex-surges-past-amazon-briefly-tops-microsoft-in-market-cap-5458117")
        );
        assert_eq!(sources[0]["title"], json!("Investing.com"));
        assert_eq!(
            sources[0]["snippet"],
            json!("Reports SPCX closing at $201.80 and an implied market cap.")
        );
        assert_eq!(
            sources[1]["url"],
            json!("https://www.axios.com/2026/06/16/spacex-amazon-market-cap")
        );
        assert_eq!(sources[1]["title"], json!("Axios"));
        assert_eq!(
            sources[1]["snippet"],
            json!("Covers SpaceX's market-cap surge.")
        );
    }

    #[test]
    fn falls_back_to_answer_text_sources_when_annotations_are_absent() {
        let response = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "Sources:\n- Axios — https://www.axios.com/2026/06/16/spacex-amazon-market-cap — Reports SpaceX's market value."
                }]
            }]
        });
        let answer = extract_openai_response_text(&response);
        let mut sources = extract_openai_response_sources(&response);
        if sources.is_empty() {
            sources = extract_sources_from_answer_text(&answer);
        }

        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0]["url"],
            json!("https://www.axios.com/2026/06/16/spacex-amazon-market-cap")
        );
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

    #[test]
    fn qwen3_5_search_uses_alibaba_responses_passthrough() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://api.ziz.hk/redbox/v1".to_string(),
            api_key: None,
            model_name: "qwen3.5-plus".to_string(),
            reasoning_effort: None,
        };

        assert_eq!(
            openai_responses_search_endpoint(&config),
            "https://api.ziz.hk/redbox/v1/responses"
        );
        assert!(qwen_uses_responses_web_search(&config.model_name));
    }

    #[test]
    fn official_openai_search_uses_responses_passthrough() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: None,
            model_name: "gpt-4.1".to_string(),
            reasoning_effort: None,
        };

        assert_eq!(
            openai_responses_search_endpoint(&config),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn gpt_model_names_do_not_enter_qwen_search_branch() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            api_key: None,
            model_name: "gpt-4.1".to_string(),
            reasoning_effort: None,
        };

        assert!(!is_qwen_search_config(&config));
    }

    #[test]
    fn qwen_plus_search_uses_alibaba_chat_completions_body() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            api_key: None,
            model_name: "qwen-plus".to_string(),
            reasoning_effort: None,
        };
        let payload = json!({
            "allowedDomains": ["https://help.aliyun.com/"],
            "freshness": 7,
            "promptIntervene": "仅检索阿里云模型文档"
        });
        let body = qwen_chat_completions_search_body(&config, &payload, "qwen 联网搜索", 4);

        assert!(!qwen_uses_responses_web_search(&config.model_name));
        assert_eq!(
            qwen_chat_completions_search_endpoint(&config),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        assert_eq!(body["model"], json!("qwen-plus"));
        assert_eq!(body["enable_search"], json!(true));
        assert_eq!(body.get("tools"), None);
        assert_eq!(body["search_options"]["forced_search"], json!(true));
        assert_eq!(body["search_options"]["search_strategy"], json!("turbo"));
        assert_eq!(body["search_options"]["freshness"], json!(7));
        assert_eq!(
            body["search_options"]["assigned_site_list"],
            json!(["help.aliyun.com"])
        );
        assert_eq!(
            body["search_options"]["intention_options"]["prompt_intervene"],
            json!("仅检索阿里云模型文档")
        );
    }

    #[test]
    fn qwen_responses_search_body_uses_alibaba_responses_shape() {
        let config = ResolvedChatConfig {
            protocol: "openai".to_string(),
            wire_api: crate::runtime::ProviderWireApi::ChatCompat,
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            api_key: None,
            model_name: "qwen3.7-max".to_string(),
            reasoning_effort: None,
        };
        let body = qwen_responses_search_body(&config, &json!({}), "杭州天气", 6);

        assert!(qwen_uses_responses_web_search(&config.model_name));
        assert_eq!(body["model"], json!("qwen3.7-max"));
        assert_eq!(body["tools"], json!([{ "type": "web_search" }]));
        assert_eq!(body["enable_thinking"], json!(true));
        assert_eq!(body.get("tool_choice"), None);
        assert_eq!(body.get("search_options"), None);
    }

    #[test]
    fn extracts_qwen_chat_completion_answer_and_search_info_sources() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "answer"
                }
            }],
            "output": {
                "search_info": {
                    "search_results": [{
                        "title": "Aliyun",
                        "url": "https://help.aliyun.com/zh/model-studio/web-search",
                        "snippet": "联网搜索文档"
                    }]
                }
            }
        });

        assert_eq!(extract_chat_completion_text(&response), "answer");
        let sources = extract_search_info_sources(&response);
        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0]["url"],
            json!("https://help.aliyun.com/zh/model-studio/web-search")
        );
    }
}
