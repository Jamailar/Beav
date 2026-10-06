use serde::{Deserialize, Serialize};

const DEFAULT_FRAGMENT_TOKEN_BUDGET: i64 = 1_000;
const TOKEN_CHAR_RATIO: f64 = 4.0;
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextFragment {
    pub key: String,
    pub source: String,
    pub role: ContextFragmentRole,
    pub body: String,
    pub body_hash: String,
    pub original_chars: i64,
    pub rendered_chars: i64,
    pub estimated_tokens: i64,
    pub token_budget: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextFragmentRole {
    Developer,
    User,
}

impl ContextFragment {
    #[allow(dead_code)]
    pub fn user(key: impl Into<String>, body: impl Into<String>, token_budget: i64) -> Self {
        Self::new(ContextFragmentRole::User, key, body, token_budget)
    }

    #[allow(dead_code)]
    pub fn developer(key: impl Into<String>, body: impl Into<String>, token_budget: i64) -> Self {
        Self::new(ContextFragmentRole::Developer, key, body, token_budget)
    }

    #[allow(dead_code)]
    pub fn user_from_source(
        key: impl Into<String>,
        source: impl Into<String>,
        body: impl Into<String>,
        token_budget: i64,
    ) -> Self {
        Self::new_with_source(ContextFragmentRole::User, key, source, body, token_budget)
    }

    #[allow(dead_code)]
    pub fn developer_from_source(
        key: impl Into<String>,
        source: impl Into<String>,
        body: impl Into<String>,
        token_budget: i64,
    ) -> Self {
        Self::new_with_source(
            ContextFragmentRole::Developer,
            key,
            source,
            body,
            token_budget,
        )
    }

    pub fn new(
        role: ContextFragmentRole,
        key: impl Into<String>,
        body: impl Into<String>,
        token_budget: i64,
    ) -> Self {
        let key = key.into();
        Self::new_with_source(role, key.clone(), key, body, token_budget)
    }

    pub fn new_with_source(
        role: ContextFragmentRole,
        key: impl Into<String>,
        source: impl Into<String>,
        body: impl Into<String>,
        token_budget: i64,
    ) -> Self {
        let token_budget = normalize_token_budget(token_budget);
        let original_body = body.into();
        let original_chars = original_body.chars().count() as i64;
        let (body, truncated) = truncate_text_to_token_budget(&original_body, token_budget);
        let rendered_chars = body.chars().count() as i64;
        let estimated_tokens = estimate_tokens_from_text(&body);
        let body_hash = stable_text_hash(&original_body);
        Self {
            key: sanitize_fragment_key(&key.into()),
            source: sanitize_fragment_key(&source.into()),
            role,
            body,
            body_hash,
            original_chars,
            rendered_chars,
            estimated_tokens,
            token_budget,
            truncated,
        }
    }

    #[allow(dead_code)]
    pub fn render(&self) -> String {
        match self.role {
            ContextFragmentRole::Developer => {
                format!(
                    "<redbox_context key=\"{}\" source=\"{}\" bodyHash=\"{}\" truncated=\"{}\">{}</redbox_context>",
                    self.key, self.source, self.body_hash, self.truncated, self.body
                )
            }
            ContextFragmentRole::User => {
                format!(
                    "<external_redbox_context key=\"{}\" source=\"{}\" bodyHash=\"{}\" truncated=\"{}\">{}</external_redbox_context>",
                    self.key, self.source, self.body_hash, self.truncated, self.body
                )
            }
        }
    }
}

pub fn stable_text_hash(text: &str) -> String {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

pub fn estimate_tokens_from_text(text: &str) -> i64 {
    ((text.chars().count().max(0) as f64) / TOKEN_CHAR_RATIO).ceil() as i64
}

pub fn truncate_text_to_token_budget(text: &str, token_budget: i64) -> (String, bool) {
    let token_budget = normalize_token_budget(token_budget);
    let max_chars = (token_budget as usize).saturating_mul(TOKEN_CHAR_RATIO as usize);
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    if max_chars <= 32 {
        return (text.chars().take(max_chars).collect(), true);
    }

    let marker = "\n...[truncated]...\n";
    let marker_len = marker.chars().count();
    let remaining = max_chars.saturating_sub(marker_len);
    let head_len = remaining / 2;
    let tail_len = remaining.saturating_sub(head_len);
    let head = text.chars().take(head_len).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_len)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    (format!("{head}{marker}{tail}"), true)
}

fn normalize_token_budget(token_budget: i64) -> i64 {
    if token_budget <= 0 {
        DEFAULT_FRAGMENT_TOKEN_BUDGET
    } else {
        token_budget
    }
}

fn sanitize_fragment_key(key: &str) -> String {
    let sanitized = key
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "context".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_fragment_truncates_to_budget_and_marks_boundaries() {
        let fragment = ContextFragment::user("source title", "a".repeat(120), 10);

        assert_eq!(fragment.key, "source_title");
        assert_eq!(fragment.source, "source_title");
        assert!(fragment.truncated);
        assert_eq!(fragment.original_chars, 120);
        assert!(fragment.rendered_chars < fragment.original_chars);
        assert!(fragment.estimated_tokens <= 10);
        assert!(fragment.render().starts_with("<external_redbox_context"));
        assert!(fragment.render().contains("bodyHash="));
    }

    #[test]
    fn context_fragment_preserves_small_bodies() {
        let fragment =
            ContextFragment::developer_from_source("runtime", "settings://ai", "short", 10);

        assert_eq!(fragment.body, "short");
        assert_eq!(fragment.source, "settings___ai");
        assert!(!fragment.truncated);
        assert_eq!(fragment.estimated_tokens, 2);
        assert_eq!(fragment.body_hash, stable_text_hash("short"));
    }
}
