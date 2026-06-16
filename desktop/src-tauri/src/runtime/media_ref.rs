use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;

const DEFAULT_MAX_MEDIA_REF_ITEMS: usize = 5;
const DEFAULT_MAX_INLINE_BYTES: u64 = 12 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_INLINE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaRefKind {
    Image,
    Audio,
    Video,
    File,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaRefSourceKind {
    DataUrl,
    HttpUrl,
    FilePath,
    Base64,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRefBudget {
    pub max_items: usize,
    pub max_inline_bytes: u64,
    pub max_total_inline_bytes: u64,
}

impl Default for MediaRefBudget {
    fn default() -> Self {
        Self {
            max_items: DEFAULT_MAX_MEDIA_REF_ITEMS,
            max_inline_bytes: DEFAULT_MAX_INLINE_BYTES,
            max_total_inline_bytes: DEFAULT_MAX_TOTAL_INLINE_BYTES,
        }
    }
}

impl MediaRefBudget {
    pub fn reference_images(max_items: usize) -> Self {
        Self {
            max_items,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    pub raw: String,
    pub raw_hash: String,
    pub kind: MediaRefKind,
    pub source_kind: MediaRefSourceKind,
    pub mime_type: Option<String>,
    pub byte_count: Option<u64>,
    pub estimated_prompt_tokens: i64,
}

impl MediaRef {
    pub fn from_raw(raw: &str, kind: MediaRefKind) -> Self {
        let trimmed = raw.trim().to_string();
        let (source_kind, mime_type, byte_count) = inspect_media_ref(&trimmed);
        let estimated_prompt_tokens = byte_count
            .map(estimate_binary_prompt_tokens)
            .unwrap_or_else(|| crate::runtime::estimate_tokens_from_text(&trimmed));
        Self {
            raw_hash: crate::runtime::stable_text_hash(&trimmed),
            raw: trimmed,
            kind,
            source_kind,
            mime_type,
            byte_count,
            estimated_prompt_tokens,
        }
    }

    pub fn is_inline_payload(&self) -> bool {
        matches!(
            self.source_kind,
            MediaRefSourceKind::DataUrl | MediaRefSourceKind::Base64
        )
    }
}

pub fn collect_media_refs_from_payload(
    payload: &Value,
    keys: &[&str],
    kind: MediaRefKind,
    budget: MediaRefBudget,
) -> Result<Vec<MediaRef>, String> {
    let mut refs = Vec::new();
    for key in keys {
        let items = crate::payload_field(payload, key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .take(budget.max_items)
                    .map(|item| MediaRef::from_raw(item, kind))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !items.is_empty() {
            refs = items;
            break;
        }
    }
    validate_media_ref_budget(&refs, budget)?;
    Ok(refs)
}

pub fn validate_media_ref_budget(refs: &[MediaRef], budget: MediaRefBudget) -> Result<(), String> {
    if refs.len() > budget.max_items {
        return Err(format!(
            "media references exceed limit: {} > {}",
            refs.len(),
            budget.max_items
        ));
    }

    let mut total_inline_bytes = 0u64;
    for (index, item) in refs.iter().enumerate() {
        let Some(bytes) = item.byte_count else {
            continue;
        };
        if item.is_inline_payload() {
            if bytes > budget.max_inline_bytes {
                return Err(format!(
                    "reference media {} is too large: {} bytes exceeds {} bytes",
                    index + 1,
                    bytes,
                    budget.max_inline_bytes
                ));
            }
            total_inline_bytes = total_inline_bytes.saturating_add(bytes);
        }
    }

    if total_inline_bytes > budget.max_total_inline_bytes {
        return Err(format!(
            "reference media payload is too large: {} bytes exceeds {} bytes",
            total_inline_bytes, budget.max_total_inline_bytes
        ));
    }
    Ok(())
}

fn inspect_media_ref(raw: &str) -> (MediaRefSourceKind, Option<String>, Option<u64>) {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return (MediaRefSourceKind::HttpUrl, None, None);
    }
    if let Some((mime_type, bytes)) = inspect_data_url(raw) {
        return (
            MediaRefSourceKind::DataUrl,
            Some(mime_type),
            Some(bytes as u64),
        );
    }
    if let Some(path) = crate::resolve_local_path(raw).filter(|path| path.exists()) {
        let byte_count = fs::metadata(path).ok().map(|metadata| metadata.len());
        return (MediaRefSourceKind::FilePath, None, byte_count);
    }
    if looks_like_base64(raw) {
        return (
            MediaRefSourceKind::Base64,
            None,
            approximate_base64_decoded_len(raw),
        );
    }
    (MediaRefSourceKind::Unknown, None, None)
}

fn inspect_data_url(raw: &str) -> Option<(String, usize)> {
    let without_prefix = raw.strip_prefix("data:")?;
    let (meta, body) = without_prefix.split_once(',')?;
    let is_base64 = meta.contains(";base64");
    let mime_type = meta
        .split(';')
        .next()
        .filter(|item| !item.trim().is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = if is_base64 {
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .ok()?
            .len()
    } else {
        body.as_bytes().len()
    };
    Some((mime_type, bytes))
}

fn looks_like_base64(raw: &str) -> bool {
    raw.len() > 128
        && raw
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=')
}

fn approximate_base64_decoded_len(raw: &str) -> Option<u64> {
    let trimmed = raw.trim_end_matches('=');
    Some(((trimmed.len() as u64).saturating_mul(3)) / 4)
}

fn estimate_binary_prompt_tokens(bytes: u64) -> i64 {
    // Binary media usually travels as base64 when inlined. This estimate is
    // intentionally conservative so oversized media is visible in diagnostics.
    ((bytes as f64 * 4.0 / 3.0) / 4.0).ceil() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn media_ref_classifies_data_urls_and_estimates_tokens() {
        let media_ref = MediaRef::from_raw("data:image/png;base64,QUJDRA==", MediaRefKind::Image);

        assert_eq!(media_ref.source_kind, MediaRefSourceKind::DataUrl);
        assert_eq!(media_ref.mime_type.as_deref(), Some("image/png"));
        assert_eq!(media_ref.byte_count, Some(4));
        assert_eq!(media_ref.raw_hash.len(), 16);
        assert!(media_ref.estimated_prompt_tokens > 0);
    }

    #[test]
    fn collect_media_refs_enforces_inline_payload_budget() {
        let payload = json!({
            "referenceImages": ["data:image/png;base64,QUJDRA=="]
        });
        let result = collect_media_refs_from_payload(
            &payload,
            &["referenceImages"],
            MediaRefKind::Image,
            MediaRefBudget {
                max_items: 1,
                max_inline_bytes: 3,
                max_total_inline_bytes: 3,
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn collect_media_refs_uses_first_nonempty_payload_key() {
        let payload = json!({
            "referenceImages": [],
            "images": ["https://example.com/a.png"]
        });
        let refs = collect_media_refs_from_payload(
            &payload,
            &["referenceImages", "images"],
            MediaRefKind::Image,
            MediaRefBudget::reference_images(2),
        )
        .expect("refs");

        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source_kind, MediaRefSourceKind::HttpUrl);
    }
}
