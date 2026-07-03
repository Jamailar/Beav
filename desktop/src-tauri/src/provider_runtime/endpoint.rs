#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use url::Url;

use super::{CapabilityScope, EndpointBaseKind, EndpointPolicy};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndpointResolveInput {
    pub base_url: String,
    pub scope: CapabilityScope,
    pub is_full_url: bool,
    pub models_url_override: Option<String>,
    pub policy: EndpointPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EndpointCandidateReport {
    pub candidates: Vec<String>,
}

pub(crate) fn resolve_endpoint(
    base_url: &str,
    policy: &EndpointPolicy,
    scope: CapabilityScope,
) -> Result<String, String> {
    let base = normalize_url_text(base_url);
    if base.is_empty() {
        return Err("Base URL is empty".to_string());
    }
    Url::parse(&base).map_err(|error| format!("Invalid base URL: {error}"))?;
    let Some(path) = policy.capability_paths.get(scope.as_str()) else {
        return Ok(base);
    };
    if base_ends_with_path(&base, path) {
        return Ok(base);
    }
    let endpoint_base = apply_version_path(&base, policy);
    Ok(append_path_once(&endpoint_base, path))
}

pub(crate) fn model_list_candidates(
    base_url: &str,
    is_full_url: bool,
    policy: &EndpointPolicy,
    models_url_override: Option<&str>,
) -> Result<Vec<String>, String> {
    if let Some(raw) = models_url_override {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            Url::parse(trimmed).map_err(|error| format!("Invalid models URL: {error}"))?;
            return Ok(vec![trimmed.to_string()]);
        }
    }

    let trimmed = normalize_url_text(base_url);
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }
    Url::parse(&trimmed).map_err(|error| format!("Invalid base URL: {error}"))?;

    let mut candidates = Vec::<String>::new();
    if is_full_url {
        if !policy.model_list.allow_full_url_derive {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
        if let Some(root) = derive_root_from_full_url(&trimmed) {
            candidates.push(append_path_once(&root, &policy.model_list.default_path));
        }
        if candidates.is_empty() {
            return Err("Cannot derive models endpoint from full URL".to_string());
        }
        return Ok(unique_urls(candidates));
    }

    if policy.model_list.version_aware
        && (ends_with_version_segment(&trimmed) || ends_with_policy_version_path(&trimmed, policy))
    {
        candidates.push(append_path_once(&trimmed, "/models"));
        if ends_with_version_segment(&trimmed)
            && !trimmed.ends_with("/v1")
            && !ends_with_policy_version_path(&trimmed, policy)
        {
            candidates.push(append_path_once(&trimmed, &policy.model_list.default_path));
        }
    } else {
        candidates.push(append_path_once(&trimmed, &policy.model_list.default_path));
    }

    if let Some(stripped) = strip_known_suffix(&trimmed, &policy.model_list.strip_suffixes) {
        let root = normalize_url_text(stripped);
        if !root.is_empty() {
            candidates.push(append_path_once(&root, &policy.model_list.default_path));
            candidates.push(append_path_once(&root, "/models"));
        }
    }

    Ok(unique_urls(candidates))
}

pub(crate) fn candidate_report(
    input: EndpointResolveInput,
) -> Result<EndpointCandidateReport, String> {
    let candidates = model_list_candidates(
        &input.base_url,
        input.is_full_url,
        &input.policy,
        input.models_url_override.as_deref(),
    )?;
    Ok(EndpointCandidateReport { candidates })
}

fn normalize_url_text(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains("://") {
        return trimmed.to_string();
    }
    if is_local_host_like(trimmed) {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    }
}

fn append_path_once(base_url: &str, path: &str) -> String {
    let base = normalize_url_text(base_url);
    let normalized_path = path.trim();
    if normalized_path.is_empty() || normalized_path == "/" {
        return base;
    }
    let path_without_query = normalized_path
        .split_once('?')
        .map(|(left, _)| left)
        .unwrap_or(normalized_path)
        .trim_end_matches('/');
    if !path_without_query.is_empty() && base.ends_with(path_without_query) {
        return base;
    }
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        normalized_path.trim_start_matches('/')
    )
}

fn apply_version_path(base_url: &str, policy: &EndpointPolicy) -> String {
    let Some(version_path) = policy.version_path.as_deref() else {
        return base_url.to_string();
    };
    if version_path.trim().is_empty()
        || ends_with_version_segment(base_url)
        || ends_with_policy_version_path(base_url, policy)
        || should_skip_version_path(base_url, policy)
    {
        return base_url.to_string();
    }
    append_path_once(base_url, version_path)
}

fn should_skip_version_path(base_url: &str, policy: &EndpointPolicy) -> bool {
    if policy.base_kind != EndpointBaseKind::Anthropic {
        return false;
    }
    policy
        .model_list
        .strip_suffixes
        .iter()
        .any(|suffix| base_url.ends_with(suffix))
}

fn base_ends_with_path(base_url: &str, path: &str) -> bool {
    let normalized_path = path
        .trim()
        .split_once('?')
        .map(|(left, _)| left)
        .unwrap_or(path)
        .trim_end_matches('/');
    !normalized_path.is_empty() && base_url.trim_end_matches('/').ends_with(normalized_path)
}

fn ends_with_policy_version_path(value: &str, policy: &EndpointPolicy) -> bool {
    let Some(version_path) = policy.version_path.as_deref() else {
        return false;
    };
    let normalized = version_path.trim().trim_matches('/');
    !normalized.is_empty()
        && value
            .trim_end_matches('/')
            .ends_with(&format!("/{normalized}"))
}

fn derive_root_from_full_url(full_url: &str) -> Option<String> {
    let normalized = normalize_url_text(full_url);
    if let Some(idx) = normalized.find("/v1/") {
        return Some(normalized[..idx].to_string());
    }
    let idx = normalized.rfind('/')?;
    let root = &normalized[..idx];
    (root.contains("://") && root.len() > root.find("://")? + 3).then(|| root.to_string())
}

fn ends_with_version_segment(value: &str) -> bool {
    let Some(segment) = value.rsplit('/').next() else {
        return false;
    };
    let Some(number) = segment.strip_prefix('v') else {
        return false;
    };
    !number.is_empty() && number.chars().all(|ch| ch.is_ascii_digit())
}

fn is_local_host_like(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("localhost")
        || lower.starts_with("127.")
        || lower.starts_with("0.0.0.0")
        || lower.starts_with("[::1]")
        || lower.starts_with("::1")
}

fn strip_known_suffix<'a>(base_url: &'a str, suffixes: &[String]) -> Option<&'a str> {
    let mut ordered = suffixes.iter().map(String::as_str).collect::<Vec<_>>();
    ordered.sort_by_key(|suffix| std::cmp::Reverse(suffix.len()));
    ordered
        .into_iter()
        .find(|suffix| base_url.ends_with(*suffix))
        .map(|suffix| &base_url[..base_url.len() - suffix.len()])
}

fn unique_urls(candidates: Vec<String>) -> Vec<String> {
    let mut unique = Vec::<String>::with_capacity(candidates.len());
    for url in candidates {
        if !unique.iter().any(|item| item == &url) {
            unique.push(url);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_runtime::catalog::{catalog_entry_for, openai_compatible_endpoint_policy};

    #[test]
    fn resolve_endpoint_accepts_bare_domains_and_adds_version_path() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            resolve_endpoint("api.example.com", &policy, CapabilityScope::Chat).unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            resolve_endpoint(
                "https://api.example.com",
                &policy,
                CapabilityScope::Embedding,
            )
            .unwrap(),
            "https://api.example.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("localhost:11434/v1", &policy, CapabilityScope::Chat,).unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn resolve_endpoint_preserves_existing_version_and_full_endpoint() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            resolve_endpoint(
                "https://api.example.com/v1",
                &policy,
                CapabilityScope::Transcription,
            )
            .unwrap(),
            "https://api.example.com/v1/audio/transcriptions"
        );
        assert_eq!(
            resolve_endpoint(
                "https://api.example.com/v1/chat/completions",
                &policy,
                CapabilityScope::Chat,
            )
            .unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolve_endpoint_handles_anthropic_native_and_compatible_roots() {
        let native = catalog_entry_for("anthropic", "anthropic", "anthropic", "api.anthropic.com");
        assert_eq!(
            resolve_endpoint(
                "api.anthropic.com",
                &native.endpoint_policy,
                CapabilityScope::Chat,
            )
            .unwrap(),
            "https://api.anthropic.com/v1/messages"
        );

        let compat = catalog_entry_for(
            "dashscope-coding-anthropic",
            "dashscope-coding-anthropic",
            "anthropic",
            "https://coding.dashscope.aliyuncs.com/apps/anthropic",
        );
        assert_eq!(
            resolve_endpoint(
                "https://coding.dashscope.aliyuncs.com/apps/anthropic",
                &compat.endpoint_policy,
                CapabilityScope::Chat,
            )
            .unwrap(),
            "https://coding.dashscope.aliyuncs.com/apps/anthropic/messages"
        );
    }

    #[test]
    fn model_candidates_use_models_after_version_segment() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            model_list_candidates("https://api.example.com/v1", false, &policy, None).unwrap(),
            vec!["https://api.example.com/v1/models"]
        );
        assert_eq!(
            model_list_candidates("https://api.example.com/v4", false, &policy, None).unwrap(),
            vec![
                "https://api.example.com/v4/models",
                "https://api.example.com/v4/v1/models"
            ]
        );
    }

    #[test]
    fn model_candidates_accept_bare_domains_and_policy_versions() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            model_list_candidates("api.example.com", false, &policy, None).unwrap(),
            vec!["https://api.example.com/v1/models"]
        );

        let gemini = catalog_entry_for(
            "gemini",
            "gemini",
            "gemini",
            "generativelanguage.googleapis.com",
        );
        assert_eq!(
            model_list_candidates(
                "generativelanguage.googleapis.com/v1beta",
                false,
                &gemini.endpoint_policy,
                None,
            )
            .unwrap(),
            vec!["https://generativelanguage.googleapis.com/v1beta/models"]
        );
    }

    #[test]
    fn model_candidates_strip_anthropic_compatible_suffixes() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            model_list_candidates(
                "https://dashscope.aliyuncs.com/apps/anthropic",
                false,
                &policy,
                None,
            )
            .unwrap(),
            vec![
                "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
                "https://dashscope.aliyuncs.com/v1/models",
                "https://dashscope.aliyuncs.com/models",
            ]
        );
    }

    #[test]
    fn model_candidates_derive_from_full_url() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            model_list_candidates(
                "https://api.example.com/v1/chat/completions",
                true,
                &policy,
                None,
            )
            .unwrap(),
            vec!["https://api.example.com/v1/models"]
        );
    }

    #[test]
    fn model_candidates_respect_override() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            model_list_candidates(
                "https://api.example.com/v1",
                false,
                &policy,
                Some("https://models.example.com/custom"),
            )
            .unwrap(),
            vec!["https://models.example.com/custom"]
        );
    }

    #[test]
    fn resolve_endpoint_does_not_duplicate_path() {
        let policy = openai_compatible_endpoint_policy();
        assert_eq!(
            resolve_endpoint(
                "https://api.example.com/v1/chat/completions",
                &policy,
                CapabilityScope::Chat,
            )
            .unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
    }
}
