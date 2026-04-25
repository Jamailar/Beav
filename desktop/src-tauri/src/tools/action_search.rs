use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

use crate::tools::catalog::ActionDescriptor;
use crate::tools::plan::DeferredActionEntry;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionSearchResult {
    pub action: String,
    pub namespace: String,
    pub description: String,
    pub input_summary: Vec<String>,
    pub mutating: bool,
    pub concurrency_safe: bool,
    pub runtime_modes: Vec<String>,
    pub available_this_turn: bool,
    pub score: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ActionSearchParams<'a> {
    pub query: &'a str,
    pub namespace: Option<&'a str>,
    pub limit: usize,
    pub include_direct: bool,
}

pub fn search_actions(
    direct: &[ActionDescriptor],
    deferred: &[DeferredActionEntry],
    params: ActionSearchParams<'_>,
) -> Vec<ActionSearchResult> {
    let limit = params.limit.clamp(1, 50);
    let query_tokens = tokenize(params.query);
    let mut results = Vec::<ActionSearchResult>::new();
    if params.include_direct {
        results.extend(
            direct.iter().filter_map(|descriptor| {
                direct_result(descriptor, params.namespace, &query_tokens)
            }),
        );
    }
    results.extend(
        deferred
            .iter()
            .filter_map(|entry| deferred_result(entry, params.namespace, &query_tokens)),
    );
    results.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.available_this_turn.cmp(&b.available_this_turn))
            .then_with(|| a.action.cmp(&b.action))
    });
    results.truncate(limit);
    results
}

#[allow(dead_code)]
pub fn descriptor_matches_query(
    query: &str,
    namespace: Option<&str>,
    descriptor: &ActionDescriptor,
) -> bool {
    !search_actions(
        &[*descriptor],
        &[],
        ActionSearchParams {
            query,
            namespace,
            limit: 1,
            include_direct: true,
        },
    )
    .is_empty()
}

#[allow(dead_code)]
pub fn deferred_matches_query(
    query: &str,
    namespace: Option<&str>,
    entry: &DeferredActionEntry,
) -> bool {
    !search_actions(
        &[],
        &[entry.clone()],
        ActionSearchParams {
            query,
            namespace,
            limit: 1,
            include_direct: false,
        },
    )
    .is_empty()
}

fn direct_result(
    descriptor: &ActionDescriptor,
    namespace: Option<&str>,
    query_tokens: &[String],
) -> Option<ActionSearchResult> {
    if !namespace_matches(namespace, descriptor.namespace) {
        return None;
    }
    let input_summary = input_summary_for_schema((descriptor.input_schema)());
    let score = action_score(
        query_tokens,
        descriptor.action,
        descriptor.namespace,
        descriptor.description,
        &input_summary,
    )?;
    Some(ActionSearchResult {
        action: descriptor.action.to_string(),
        namespace: descriptor.namespace.to_string(),
        description: descriptor.description.to_string(),
        input_summary,
        mutating: descriptor.mutating,
        concurrency_safe: descriptor.concurrency_safe,
        runtime_modes: descriptor
            .runtime_modes
            .iter()
            .map(|item| item.to_string())
            .collect(),
        available_this_turn: true,
        score,
    })
}

fn deferred_result(
    entry: &DeferredActionEntry,
    namespace: Option<&str>,
    query_tokens: &[String],
) -> Option<ActionSearchResult> {
    if !namespace_matches(namespace, &entry.namespace) {
        return None;
    }
    let score = action_score(
        query_tokens,
        &entry.action,
        &entry.namespace,
        &entry.description,
        &[],
    )?;
    Some(ActionSearchResult {
        action: entry.action.clone(),
        namespace: entry.namespace.clone(),
        description: entry.description.clone(),
        input_summary: Vec::new(),
        mutating: entry.mutating,
        concurrency_safe: entry.concurrency_safe,
        runtime_modes: entry.runtime_modes.clone(),
        available_this_turn: false,
        score,
    })
}

fn namespace_matches(namespace: Option<&str>, candidate: &str) -> bool {
    namespace
        .map(|filter| candidate == filter || candidate.starts_with(&(filter.to_string() + ".")))
        .unwrap_or(true)
}

fn action_score(
    query_tokens: &[String],
    action: &str,
    namespace: &str,
    description: &str,
    input_summary: &[String],
) -> Option<usize> {
    if query_tokens.is_empty() {
        return Some(1);
    }
    let mut haystack = tokenize(&format!("{action} {namespace} {description}"));
    haystack.extend(input_summary.iter().flat_map(|item| tokenize(item)));
    let haystack = haystack.into_iter().collect::<BTreeSet<_>>();
    let score = query_tokens
        .iter()
        .map(|token| {
            if action.to_ascii_lowercase().contains(token) {
                4
            } else if namespace.to_ascii_lowercase().contains(token) {
                3
            } else if haystack.contains(token) {
                2
            } else {
                0
            }
        })
        .sum::<usize>();
    (score > 0).then_some(score)
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| item.to_ascii_lowercase())
        .collect()
}

fn input_summary_for_schema(schema: Value) -> Vec<String> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|properties| properties.keys().take(8).cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::catalog::{action_descriptors_for_tool, ActionVisibility};

    #[test]
    fn search_matches_image_generation_by_prompt_field() {
        let direct = action_descriptors_for_tool(
            "app_cli",
            Some("image-generation"),
            ActionVisibility::Model,
        );
        let results = search_actions(
            &direct,
            &[],
            ActionSearchParams {
                query: "image prompt aspect ratio generate cards",
                include_direct: true,
                limit: 5,
                ..ActionSearchParams::default()
            },
        );

        assert_eq!(
            results.first().map(|item| item.action.as_str()),
            Some("image.generate")
        );
        assert!(results
            .first()
            .map(|item| item
                .input_summary
                .iter()
                .any(|field| field == "aspectRatio"))
            .unwrap_or(false));
    }

    #[test]
    fn search_can_filter_namespace() {
        let direct =
            action_descriptors_for_tool("app_cli", Some("diagnostics"), ActionVisibility::Model);
        let results = search_actions(
            &direct,
            &[],
            ActionSearchParams {
                query: "list",
                namespace: Some("mcp"),
                include_direct: true,
                limit: 10,
            },
        );

        assert!(results.iter().all(|item| item.namespace.starts_with("mcp")));
        assert!(results.iter().any(|item| item.action == "mcp.list"));
    }
}
