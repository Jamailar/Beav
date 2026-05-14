use regex::Regex;
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, ToSocketAddrs};
use std::thread;
use std::time::Duration;
use url::Url;

use crate::{app_brand_display_name, payload_string};

const DEFAULT_MAX_CHARS: usize = 12_000;
const MIN_MAX_CHARS: usize = 1_000;
const MAX_MAX_CHARS: usize = 40_000;
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const WEB_FETCH_TIMEOUT_SECONDS: u64 = 20;

pub(crate) fn fetch(payload: &Value) -> Result<Value, String> {
    let payload = payload.clone();
    thread::spawn(move || fetch_blocking(&payload))
        .join()
        .map_err(|_| "web.fetch worker panicked".to_string())?
}

fn fetch_blocking(payload: &Value) -> Result<Value, String> {
    let raw_url = payload_string(payload, "url")
        .or_else(|| payload_string(payload, "path"))
        .ok_or_else(|| "web.fetch requires payload.url".to_string())?;
    let url = normalize_url(&raw_url)?;
    validate_public_http_url(&url)?;
    validate_resolved_public_host(&url)?;

    let max_chars = normalized_max_chars(payload);
    let include_links = payload
        .get("includeLinks")
        .or_else(|| payload.get("include_links"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(WEB_FETCH_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if let Err(message) = validate_public_http_url(attempt.url()) {
                attempt.error(std::io::Error::new(std::io::ErrorKind::Other, message))
            } else if attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent(format!("{}-Agent/1.0", app_brand_display_name()))
        .build()
        .map_err(|error| format!("failed to build web client: {error}"))?;

    let mut response = client
        .get(url.clone())
        .send()
        .map_err(|error| format!("failed to fetch url: {error}"))?;
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut bytes = Vec::new();
    let read_limit = MAX_RESPONSE_BYTES + 1;
    response
        .by_ref()
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read response body: {error}"))?;
    let truncated_bytes = bytes.len() as u64 > MAX_RESPONSE_BYTES;
    if truncated_bytes {
        bytes.truncate(MAX_RESPONSE_BYTES as usize);
    }

    let raw_text = String::from_utf8_lossy(&bytes).to_string();
    let title = extract_title(&raw_text);
    let text = if looks_like_html(&content_type, &raw_text) {
        html_to_text(&raw_text)
    } else {
        normalize_text(&raw_text)
    };
    let truncated_chars = text.chars().count() > max_chars;
    let text = truncate_chars(&text, max_chars);
    let links = if include_links {
        extract_links(&raw_text, response_url_base(&final_url).as_ref())
    } else {
        Vec::new()
    };

    Ok(json!({
        "url": url.to_string(),
        "finalUrl": final_url,
        "status": status,
        "contentType": content_type,
        "title": title,
        "text": text,
        "links": links,
        "truncated": truncated_bytes || truncated_chars,
        "maxChars": max_chars,
    }))
}

pub(crate) fn normalize_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("url is required".to_string());
    }
    Url::parse(trimmed).map_err(|error| format!("invalid url: {error}"))
}

pub(crate) fn validate_public_http_url(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported url scheme: {scheme}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "url host is required".to_string())?;
    let host_lower = host.trim_matches('.').to_ascii_lowercase();
    if host_lower.is_empty() {
        return Err("url host is required".to_string());
    }
    if matches!(host_lower.as_str(), "localhost" | "localhost.localdomain")
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
    {
        return Err("local network urls are not available to agents".to_string());
    }
    if let Ok(ip) = host_lower.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err("private or local network urls are not available to agents".to_string());
        }
    }
    Ok(())
}

fn validate_resolved_public_host(url: &Url) -> Result<(), String> {
    let Some(host) = url.host_str() else {
        return Err("url host is required".to_string());
    };
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve url host: {error}"))?;
    for address in addresses {
        if is_blocked_ip(address.ip()) {
            return Err("private or local network urls are not available to agents".to_string());
        }
    }
    Ok(())
}

fn normalized_max_chars(payload: &Value) -> usize {
    payload
        .get("maxChars")
        .or_else(|| payload.get("max_chars"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(MIN_MAX_CHARS, MAX_MAX_CHARS)
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

fn looks_like_html(content_type: &str, text: &str) -> bool {
    content_type.to_ascii_lowercase().contains("html")
        || text
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("<!doctype html")
        || text.trim_start().to_ascii_lowercase().starts_with("<html")
}

fn extract_title(html: &str) -> Option<String> {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    let raw = re.captures(html)?.get(1)?.as_str();
    let title = normalize_text(&decode_html_entities(raw));
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn html_to_text(html: &str) -> String {
    let mut without_scripts = html.to_string();
    for pattern in [
        r"(?is)<script[^>]*>.*?</script>",
        r"(?is)<style[^>]*>.*?</style>",
        r"(?is)<noscript[^>]*>.*?</noscript>",
        r"(?is)<svg[^>]*>.*?</svg>",
    ] {
        if let Ok(re) = Regex::new(pattern) {
            without_scripts = re.replace_all(&without_scripts, " ").to_string();
        }
    }
    let with_breaks = Regex::new(
        r"(?i)</?(p|div|section|article|header|footer|main|br|li|h[1-6]|tr|table)[^>]*>",
    )
    .map(|re| re.replace_all(&without_scripts, "\n").to_string())
    .unwrap_or(without_scripts);
    let without_tags = Regex::new(r"(?is)<[^>]+>")
        .map(|re| re.replace_all(&with_breaks, " ").to_string())
        .unwrap_or(with_breaks);
    normalize_text(&decode_html_entities(&without_tags))
}

fn normalize_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let line_space = Regex::new(r"[ \t]+")
        .map(|re| re.replace_all(&normalized, " ").to_string())
        .unwrap_or(normalized);
    let collapsed_blank = Regex::new(r"\n{3,}")
        .map(|re| re.replace_all(&line_space, "\n\n").to_string())
        .unwrap_or(line_space);
    collapsed_blank
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn decode_html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n\n[truncated]");
    truncated
}

fn response_url_base(final_url: &str) -> Option<Url> {
    Url::parse(final_url).ok()
}

fn extract_links(html: &str, base: Option<&Url>) -> Vec<Value> {
    let Ok(re) = Regex::new(r#"(?is)<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#) else {
        return Vec::new();
    };
    let mut links = Vec::new();
    for capture in re.captures_iter(html).take(80) {
        let Some(raw_href) = capture.get(1).map(|item| item.as_str().trim()) else {
            continue;
        };
        let resolved = base
            .and_then(|base| base.join(raw_href).ok())
            .or_else(|| Url::parse(raw_href).ok());
        let Some(url) = resolved else {
            continue;
        };
        if validate_public_http_url(&url).is_err() {
            continue;
        }
        let label = capture
            .get(2)
            .map(|item| normalize_text(&html_to_text(item.as_str())))
            .unwrap_or_default();
        links.push(json!({
            "url": url.to_string(),
            "text": truncate_chars(&label, 160),
        }));
    }
    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_urls() {
        let url = normalize_url("http://127.0.0.1:3000").expect("url");
        assert!(validate_public_http_url(&url).is_err());
        let url = normalize_url("http://192.168.1.1").expect("url");
        assert!(validate_public_http_url(&url).is_err());
        let url = normalize_url("file:///tmp/a.txt").expect("url");
        assert!(validate_public_http_url(&url).is_err());
    }

    #[test]
    fn allows_public_https_urls() {
        let url = normalize_url("https://github.com/Yeachan-Heo/oh-my-codex").expect("url");
        assert!(validate_public_http_url(&url).is_ok());
    }

    #[test]
    fn rejects_resolved_localhost() {
        let url = normalize_url("http://localhost:3000").expect("url");
        assert!(validate_resolved_public_host(&url).is_err());
    }

    #[test]
    fn extracts_clean_html_text() {
        let html = r#"<html><head><title>Demo &amp; Test</title><style>.x{}</style></head><body><h1>Hello</h1><script>alert(1)</script><p>A&nbsp;B</p></body></html>"#;
        assert_eq!(extract_title(html), Some("Demo & Test".to_string()));
        let text = html_to_text(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("A B"));
        assert!(!text.contains("alert"));
    }
}
