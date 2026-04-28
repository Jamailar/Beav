use crate::{compute_local_embedding, cosine_similarity};

const DEFAULT_RRF_K: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetrievalMode {
    Lexical,
    Hybrid,
}

#[derive(Debug, Clone)]
pub(crate) struct ExpandedQuery {
    pub normalized_query: String,
    pub lexical_terms: Vec<String>,
    pub sparse_terms: Vec<String>,
}

pub(crate) fn expand_query(normalized_query: &str, lexical_terms: Vec<String>) -> ExpandedQuery {
    let mut sparse = lexical_terms.clone();
    let lower = normalized_query.to_lowercase();
    for (needle, expansions) in bilingual_legal_map() {
        if lower.contains(needle) {
            sparse.extend(expansions.iter().map(|value| value.to_string()));
        }
    }
    sparse.sort();
    sparse.dedup();
    ExpandedQuery {
        normalized_query: normalized_query.to_string(),
        lexical_terms,
        sparse_terms: sparse,
    }
}

pub(crate) fn semantic_vector_json(text: &str) -> String {
    serde_json::to_string(&compute_local_embedding(text)).unwrap_or_else(|_| "[]".to_string())
}

pub(crate) fn semantic_similarity(query: &[f64], vector_json: &str) -> f64 {
    let vector = serde_json::from_str::<Vec<f64>>(vector_json).unwrap_or_default();
    cosine_similarity(query, &vector)
}

pub(crate) fn query_embedding(normalized_query: &str, sparse_terms: &[String]) -> Vec<f64> {
    let semantic_input = if sparse_terms.is_empty() {
        normalized_query.to_string()
    } else {
        format!("{normalized_query}\n{}", sparse_terms.join(" "))
    };
    compute_local_embedding(&semantic_input)
}

pub(crate) fn weighted_rrf(
    lexical_rank: Option<usize>,
    semantic_rank: Option<usize>,
    lexical_weight: f64,
    semantic_weight: f64,
) -> f64 {
    let mut score = 0.0;
    if let Some(rank) = lexical_rank {
        score += lexical_weight / (DEFAULT_RRF_K + rank as f64 + 1.0);
    }
    if let Some(rank) = semantic_rank {
        score += semantic_weight / (DEFAULT_RRF_K + rank as f64 + 1.0);
    }
    score
}

pub(crate) fn citation_rerank_bonus(
    page: Option<i64>,
    block_type: &str,
    content_origin: &str,
    ocr_confidence: Option<f64>,
) -> f64 {
    let mut score = 0.0;
    if page.is_some() {
        score += 1.5;
    }
    if matches!(
        block_type,
        "pdf-page" | "ocr-page" | "docx-body" | "plain-text"
    ) {
        score += 1.0;
    }
    if content_origin == "visual_llm" || block_type.starts_with("image.") {
        score += 0.8;
    }
    if content_origin == "ocr" {
        score += match ocr_confidence {
            Some(confidence) if confidence >= 0.9 => 0.6,
            Some(confidence) if confidence >= 0.75 => 0.2,
            Some(confidence) if confidence >= 0.6 => -0.6,
            Some(_) => -1.5,
            None => -1.0,
        };
    }
    score
}

#[cfg(test)]
pub(crate) fn fixture_eval_metrics() -> (f64, f64) {
    let corpus = vec![
        ("law-zh", "中华人民共和国民法典 合同编 违约责任 救济"),
        ("commentary-en", "Commentary about contract breach remedies"),
        ("law-zh-termination", "劳动合同法 解除劳动合同 赔偿"),
        ("case-en", "Employment termination case note"),
    ];
    let queries = vec![
        ("contract breach remedy", "law-zh"),
        (
            "termination compensation labor contract",
            "law-zh-termination",
        ),
    ];
    let lexical = queries
        .iter()
        .map(|(query, expected)| reciprocal_rank_for_fixture(query, expected, &corpus, false))
        .sum::<f64>()
        / queries.len() as f64;
    let hybrid = queries
        .iter()
        .map(|(query, expected)| reciprocal_rank_for_fixture(query, expected, &corpus, true))
        .sum::<f64>()
        / queries.len() as f64;
    (lexical, hybrid)
}

#[cfg(test)]
fn reciprocal_rank_for_fixture(
    query: &str,
    expected_id: &str,
    corpus: &[(&str, &str)],
    hybrid_enabled: bool,
) -> f64 {
    let normalized = normalize_fixture_text(query);
    let lexical_terms = split_terms(&normalized);
    let expanded = if hybrid_enabled {
        expand_query(&normalized, lexical_terms.clone())
    } else {
        ExpandedQuery {
            normalized_query: normalized.clone(),
            lexical_terms: lexical_terms.clone(),
            sparse_terms: lexical_terms.clone(),
        }
    };
    let query_embedding = query_embedding(&expanded.normalized_query, &expanded.sparse_terms);

    let mut lexical_ranked = corpus
        .iter()
        .map(|(id, text)| {
            let normalized_text = normalize_fixture_text(text);
            let lexical_basis = if hybrid_enabled {
                &expanded.sparse_terms
            } else {
                &expanded.lexical_terms
            };
            let lexical_score = lexical_basis
                .iter()
                .filter(|term| normalized_text.contains(term.as_str()))
                .count() as f64;
            (*id, lexical_score)
        })
        .collect::<Vec<_>>();
    lexical_ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let lexical_positions = lexical_ranked
        .iter()
        .enumerate()
        .filter(|(_, (_, score))| *score > 0.0)
        .map(|(index, (id, _))| ((*id).to_string(), index))
        .collect::<std::collections::HashMap<_, _>>();

    let semantic_positions = if hybrid_enabled {
        let mut semantic_ranked = corpus
            .iter()
            .map(|(id, text)| {
                let vector = compute_local_embedding(&normalize_fixture_text(text));
                (*id, cosine_similarity(&query_embedding, &vector))
            })
            .collect::<Vec<_>>();
        semantic_ranked.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        semantic_ranked
            .iter()
            .enumerate()
            .map(|(index, (id, _))| ((*id).to_string(), index))
            .collect::<std::collections::HashMap<_, _>>()
    } else {
        std::collections::HashMap::new()
    };

    let mut ids = lexical_positions
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    ids.extend(semantic_positions.keys().cloned());
    let mut ranked = ids
        .into_iter()
        .map(|id| {
            let score = if hybrid_enabled {
                weighted_rrf(
                    lexical_positions.get(&id).copied(),
                    semantic_positions.get(&id).copied(),
                    1.0,
                    0.9,
                )
            } else {
                lexical_positions
                    .get(&id)
                    .map(|rank| weighted_rrf(Some(*rank), None, 1.0, 0.0))
                    .unwrap_or(0.0)
            };
            (id, score)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    ranked
        .iter()
        .position(|(id, _)| id == expected_id)
        .map(|index| 1.0 / (index as f64 + 1.0))
        .unwrap_or(0.0)
}

fn bilingual_legal_map() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("contract", &["合同", "协议"]),
        ("breach", &["违约"]),
        ("remedy", &["救济", "赔偿"]),
        ("termination", &["解除", "终止"]),
        ("employment", &["劳动", "雇佣"]),
        ("confidentiality", &["保密"]),
        ("合同", &["contract", "agreement"]),
        ("违约", &["breach"]),
        ("救济", &["remedy"]),
        ("解除", &["termination"]),
        ("劳动", &["employment", "labor"]),
    ]
}

#[cfg(test)]
fn normalize_fixture_text(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
fn split_terms(normalized_query: &str) -> Vec<String> {
    let mut terms = normalized_query
        .split_whitespace()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    if terms.is_empty() && !normalized_query.is_empty() {
        terms.push(normalized_query.to_string());
    }
    terms.sort();
    terms.dedup();
    terms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_bilingual_legal_terms() {
        let expanded = expand_query(
            "contract breach remedy",
            vec!["breach".into(), "contract".into()],
        );
        assert!(expanded.sparse_terms.iter().any(|value| value == "合同"));
        assert!(expanded.sparse_terms.iter().any(|value| value == "违约"));
    }

    #[test]
    fn hybrid_fixture_improves_mean_reciprocal_rank() {
        let (lexical, hybrid) = fixture_eval_metrics();
        eprintln!("fixture MRR lexical={lexical:.3} hybrid={hybrid:.3}");
        assert!(hybrid > lexical);
        assert!(hybrid >= 0.75);
        assert!(lexical <= 0.5);
    }
}
