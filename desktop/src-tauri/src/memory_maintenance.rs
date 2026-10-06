use crate::{normalize_base_url, payload_string, run_curl_json, run_curl_text};
use serde_json::{json, Value};

pub(crate) fn url_encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

pub(crate) fn normalize_search_provider(value: Option<&str>) -> &'static str {
    match value.unwrap_or("duckduckgo").trim().to_lowercase().as_str() {
        "tavily" => "tavily",
        "searxng" => "searxng",
        _ => "duckduckgo",
    }
}

pub(crate) fn parse_duckduckgo_results(html: &str, count: usize) -> Vec<Value> {
    let mut results = Vec::new();
    let mut rest = html;
    while results.len() < count {
        let Some(anchor_idx) = rest.find("result__a") else {
            break;
        };
        let anchor_slice = &rest[anchor_idx..];
        let Some(href_idx) = anchor_slice.find("href=\"") else {
            rest = &anchor_slice["result__a".len()..];
            continue;
        };
        let href_slice = &anchor_slice[href_idx + 6..];
        let Some(href_end) = href_slice.find('"') else {
            break;
        };
        let url = href_slice[..href_end].trim().to_string();
        let Some(tag_close) = href_slice[href_end..].find('>') else {
            break;
        };
        let title_slice = &href_slice[href_end + tag_close + 1..];
        let Some(title_end) = title_slice.find("</a>") else {
            break;
        };
        let title = title_slice[..title_end]
            .replace("<b>", "")
            .replace("</b>", "")
            .replace("&amp;", "&")
            .replace("&#x27;", "'")
            .trim()
            .to_string();
        let snippet = if let Some(snippet_idx) = title_slice.find("result__snippet") {
            let snippet_slice = &title_slice[snippet_idx..];
            if let Some(start) = snippet_slice.find('>') {
                if let Some(end) = snippet_slice[start + 1..].find("</a>") {
                    snippet_slice[start + 1..start + 1 + end]
                        .replace("<b>", "")
                        .replace("</b>", "")
                        .replace("&amp;", "&")
                        .replace("&#x27;", "'")
                        .replace('\n', " ")
                        .trim()
                        .to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        if !title.is_empty() && !url.is_empty() && !url.contains("duckduckgo.com") {
            results.push(json!({
                "title": title,
                "url": url,
                "snippet": snippet,
            }));
        }
        rest = &title_slice[title_end..];
    }
    results
}

pub(crate) fn duckduckgo_requires_human_challenge(html: &str) -> bool {
    html.contains("anomaly-modal")
        || html.contains("Unfortunately, bots use DuckDuckGo too")
        || html.contains("/anomaly.js")
}

pub(crate) fn search_web_with_settings(
    settings: &Value,
    query: &str,
    count: usize,
) -> Result<Vec<Value>, String> {
    let provider =
        normalize_search_provider(payload_string(settings, "search_provider").as_deref());
    let endpoint = payload_string(settings, "search_endpoint").unwrap_or_default();
    let api_key = payload_string(settings, "search_api_key").unwrap_or_default();
    match provider {
        "tavily" => {
            if api_key.trim().is_empty() {
                return Err("Tavily 搜索需要先配置 API Key".to_string());
            }
            let base = if endpoint.trim().is_empty() {
                "https://api.tavily.com".to_string()
            } else {
                normalize_base_url(&endpoint)
            };
            let response = run_curl_json(
                "POST",
                &format!("{}/search", base),
                None,
                &[("Content-Type", "application/json".to_string())],
                Some(json!({
                    "api_key": api_key,
                    "query": query,
                    "max_results": count,
                    "search_depth": "basic",
                    "include_answer": false,
                    "include_images": false
                })),
            )?;
            Ok(response
                .get("results")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default())
        }
        "searxng" => {
            let base = normalize_base_url(&endpoint);
            if base.is_empty() {
                return Err("SearXNG 搜索需要先配置 endpoint".to_string());
            }
            let url = format!(
                "{}/search?q={}&format=json&language=zh-CN",
                base,
                url_encode_component(query)
            );
            let mut headers = Vec::new();
            if !api_key.trim().is_empty() {
                headers.push(("Authorization", format!("Bearer {}", api_key.trim())));
            }
            let response = run_curl_json("GET", &url, None, &headers, None)?;
            Ok(response
                .get("results")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default())
        }
        _ => {
            let url = format!(
                "https://html.duckduckgo.com/html/?q={}",
                url_encode_component(query)
            );
            let html = run_curl_text(
                "GET",
                &url,
                &[(
                    "User-Agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36".to_string(),
                )],
                None,
            )?;
            if duckduckgo_requires_human_challenge(&html) {
                return Err("DuckDuckGo 搜索被人机验证拦截；请配置 Tavily API Key 或 SearXNG endpoint 作为本地搜索后端".to_string());
            }
            Ok(parse_duckduckgo_results(&html, count))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duckduckgo_human_challenge_is_detected() {
        let html = r#"
            <form action="//duckduckgo.com/anomaly.js">
              <div class="anomaly-modal__title">
                Unfortunately, bots use DuckDuckGo too.
              </div>
            </form>
        "#;

        assert!(duckduckgo_requires_human_challenge(html));
    }

    #[test]
    fn duckduckgo_regular_results_are_not_challenge() {
        let html = r#"
            <a rel="nofollow" class="result__a" href="https://example.com">Example</a>
            <a class="result__snippet">Snippet</a>
        "#;

        assert!(!duckduckgo_requires_human_challenge(html));
        assert_eq!(parse_duckduckgo_results(html, 1).len(), 1);
    }
}
