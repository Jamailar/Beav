use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn auth_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)(authorization\s*:\s*bearer\s+|bearer\s+)[a-z0-9\-_\.=+/]+")
            .expect("valid auth regex")
    })
}

fn api_key_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie)\s*[:=]\s*[^\s"',;]+"#)
            .expect("valid secret regex")
    })
}

fn path_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(/Users/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)").expect("valid path regex")
    })
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= limit {
        trimmed.to_string()
    } else {
        format!("{}...", trimmed.chars().take(limit).collect::<String>())
    }
}

pub fn redact_text_local(value: &str, max_len: usize) -> String {
    let partially = auth_regex().replace_all(value, "$1[REDACTED]").to_string();
    let partially = api_key_regex()
        .replace_all(&partially, "[REDACTED_SECRET]")
        .to_string();
    let partially = path_regex()
        .replace_all(&partially, "~/<redacted-path>")
        .to_string();
    truncate_chars(&partially, max_len)
}

pub fn redact_text_for_upload(value: &str, max_len: usize) -> String {
    redact_text_local(value, max_len)
}

pub fn redact_json_local(value: &Value, max_len: usize) -> Value {
    match value {
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            for (key, item) in map {
                let normalized = key.trim().to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "authorization"
                        | "api_key"
                        | "api-key"
                        | "access_token"
                        | "refresh_token"
                        | "cookie"
                        | "set-cookie"
                ) {
                    next.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else {
                    next.insert(key.clone(), redact_json_local(item, max_len));
                }
            }
            Value::Object(next)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_json_local(item, max_len))
                .collect(),
        ),
        Value::String(text) => Value::String(redact_text_local(text, max_len)),
        _ => value.clone(),
    }
}

pub fn redact_json_for_upload(value: &Value, max_len: usize) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text_for_upload(text, max_len)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_json_for_upload(item, max_len))
                .collect(),
        ),
        Value::Object(map) => {
            let mut next = serde_json::Map::new();
            for (key, item) in map {
                let normalized = key.trim().to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "authorization"
                        | "api_key"
                        | "api-key"
                        | "access_token"
                        | "refresh_token"
                        | "cookie"
                        | "set-cookie"
                ) {
                    next.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                } else if normalized.contains("rawbody") || normalized == "raw" {
                    next.insert(
                        key.clone(),
                        Value::String(redact_text_for_upload(&item.to_string(), max_len)),
                    );
                } else {
                    next.insert(key.clone(), redact_json_for_upload(item, max_len));
                }
            }
            Value::Object(next)
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{redact_json_for_upload, redact_text_local};
    use serde_json::json;

    #[test]
    fn redact_text_local_masks_tokens_and_paths() {
        let text = "Authorization: Bearer super-secret-token api_key=abc123 path=/Users/jam/project/file.txt";
        let redacted = redact_text_local(text, 500);
        assert!(!redacted.contains("super-secret-token"));
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("/Users/jam"));
        assert!(redacted.contains("[REDACTED]") || redacted.contains("[REDACTED_SECRET]"));
        assert!(redacted.contains("~/<redacted-path>"));
    }

    #[test]
    fn redact_json_for_upload_masks_secret_keys_and_raw_body() {
        let value = json!({
            "authorization": "Bearer abcdef",
            "api_key": "secret",
            "rawBody": "{\"token\":\"abc\",\"path\":\"/Users/jam/repo\"}",
            "nested": {
                "cookie": "session=123",
                "normal": "ok"
            }
        });
        let redacted = redact_json_for_upload(&value, 256);
        assert_eq!(redacted["authorization"], "[REDACTED]");
        assert_eq!(redacted["api_key"], "[REDACTED]");
        assert_eq!(redacted["nested"]["cookie"], "[REDACTED]");
        assert_eq!(redacted["nested"]["normal"], "ok");
        let raw_body = redacted["rawBody"].as_str().unwrap_or_default();
        assert!(!raw_body.contains("/Users/jam/repo"));
        assert!(!raw_body.contains("\"abc\""));
    }
}
