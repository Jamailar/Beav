use glob::Pattern;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::State;
use time::OffsetDateTime;

use crate::{
    document_parse::{
        CanonicalDocument, LegalMetadata, OcrProvider, OcrProviderConfig, ParserProviderConfig,
    },
    knowledge_index::{
        canonical_store::{self, CanonicalDocumentRow},
        catalog_db_path,
        fingerprint::fingerprint_file,
        hybrid::{
            citation_rerank_bonus, expand_query, query_embedding, semantic_similarity,
            semantic_vector_json, weighted_rrf, RetrievalMode,
        },
        schema::ensure_catalog_ready,
        tantivy_index,
    },
    payload_field, payload_string,
    persistence::with_store,
    AppState,
};

const MAX_INDEXED_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SEMANTIC_SCAN_BLOCKS: usize = 1200;
const MAX_EXTERNAL_RERANK_CANDIDATES: usize = 80;

#[derive(Debug, Clone)]
pub(crate) struct DocumentBlockRecord {
    pub block_id: String,
    pub document_id: String,
    pub source_id: String,
    pub source_name: String,
    pub root_path: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub file_extension: Option<String>,
    pub title: Option<String>,
    pub language: Option<String>,
    pub content_origin: String,
    pub ocr_confidence: Option<f64>,
    pub jurisdiction: Option<String>,
    pub authority: Option<String>,
    pub authority_level: Option<i64>,
    pub effective_date: Option<String>,
    pub expiry_date: Option<String>,
    pub document_type: Option<String>,
    pub is_superseded: bool,
    pub page: Option<i64>,
    pub block_type: String,
    pub section_path_json: String,
    pub block_index: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
    pub normalized_text: String,
    pub semantic_vector_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentBlockHit {
    pub block_id: String,
    pub document_id: String,
    pub source_id: String,
    pub source_name: String,
    pub root_path: String,
    pub path: String,
    pub absolute_path: String,
    pub file_extension: Option<String>,
    pub title: Option<String>,
    pub language: Option<String>,
    pub content_origin: String,
    pub ocr_confidence: Option<f64>,
    pub jurisdiction: Option<String>,
    pub authority: Option<String>,
    pub authority_level: Option<i64>,
    pub effective_date: Option<String>,
    pub expiry_date: Option<String>,
    pub document_type: Option<String>,
    pub is_superseded: bool,
    pub page: Option<i64>,
    pub block_type: String,
    pub section_path: Vec<String>,
    pub block_index: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub snippet: String,
    pub lexical_score: f64,
    pub semantic_score: f64,
    pub bm25_score: f64,
    pub fusion_score: f64,
    pub rerank_score: f64,
    pub legal_score: f64,
    pub total_score: f64,
    pub retrieval_lanes: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct BuildSourceBlocksResult {
    pub blocks: Vec<DocumentBlockRecord>,
    pub canonical_rows: Vec<CanonicalDocumentRow>,
}

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    Connection::open(catalog_db_path(state)?).map_err(|error| error.to_string())
}

pub(crate) fn replace_blocks(
    state: &State<'_, AppState>,
    blocks: &[DocumentBlockRecord],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_document_blocks", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_document_blocks_fts", [])
        .map_err(|error| error.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_document_blocks (
                    block_id, document_id, source_id, source_name, root_path, absolute_path,
                    relative_path, file_extension, title, language, content_origin,
                    ocr_confidence, jurisdiction, authority, authority_level, effective_date,
                    expiry_date, document_type, is_superseded, page, block_type,
                    section_path_json, block_index, line_start, line_end, text,
                    normalized_text, semantic_vector_json, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17, ?18,
                    ?19, ?20, ?21, ?22, ?23, ?24,
                    ?25, ?26, ?27, ?28, ?29
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        let mut fts_stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_document_blocks_fts (
                    block_id, source_id, title, text, normalized_text, relative_path
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
            )
            .map_err(|error| error.to_string())?;
        for block in blocks {
            stmt.execute(params![
                block.block_id,
                block.document_id,
                block.source_id,
                block.source_name,
                block.root_path,
                block.absolute_path,
                block.relative_path,
                block.file_extension,
                block.title,
                block.language,
                block.content_origin,
                block.ocr_confidence,
                block.jurisdiction,
                block.authority,
                block.authority_level,
                block.effective_date,
                block.expiry_date,
                block.document_type,
                block.is_superseded,
                block.page,
                block.block_type,
                block.section_path_json,
                block.block_index,
                block.line_start,
                block.line_end,
                block.text,
                block.normalized_text,
                block.semantic_vector_json,
                block.updated_at
            ])
            .map_err(|error| error.to_string())?;
            fts_stmt
                .execute(params![
                    block.block_id,
                    block.source_id,
                    block.title,
                    block.text,
                    block.normalized_text,
                    block.relative_path
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    crate::knowledge_index::tantivy_index::rebuild_index(state, blocks)
}

pub(crate) fn replace_blocks_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
    blocks: &[DocumentBlockRecord],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_blocks WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_document_blocks (
                    block_id, document_id, source_id, source_name, root_path, absolute_path,
                    relative_path, file_extension, title, language, content_origin,
                    ocr_confidence, jurisdiction, authority, authority_level, effective_date,
                    expiry_date, document_type, is_superseded, page, block_type,
                    section_path_json, block_index, line_start, line_end, text,
                    normalized_text, semantic_vector_json, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17, ?18,
                    ?19, ?20, ?21, ?22, ?23, ?24,
                    ?25, ?26, ?27, ?28, ?29
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        for block in blocks {
            stmt.execute(params![
                block.block_id,
                block.document_id,
                block.source_id,
                block.source_name,
                block.root_path,
                block.absolute_path,
                block.relative_path,
                block.file_extension,
                block.title,
                block.language,
                block.content_origin,
                block.ocr_confidence,
                block.jurisdiction,
                block.authority,
                block.authority_level,
                block.effective_date,
                block.expiry_date,
                block.document_type,
                block.is_superseded,
                block.page,
                block.block_type,
                block.section_path_json,
                block.block_index,
                block.line_start,
                block.line_end,
                block.text,
                block.normalized_text,
                block.semantic_vector_json,
                block.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    rebuild_fts_index(state)?;
    rebuild_tantivy_from_db(state)
}

pub(crate) fn delete_blocks_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_blocks WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_blocks_fts WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    rebuild_tantivy_from_db(state)
}

pub(crate) fn count_blocks_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<i64, String> {
    let conn = connection(state)?;
    conn.query_row(
        "SELECT COUNT(*) FROM knowledge_document_blocks WHERE source_id = ?1",
        params![source_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn rebuild_fts_index(state: &State<'_, AppState>) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_document_blocks_fts", [])
        .map_err(|error| error.to_string())?;
    tx.execute(
        r#"
        INSERT INTO knowledge_document_blocks_fts (
            block_id, source_id, title, text, normalized_text, relative_path
        )
        SELECT block_id, source_id, title, text, normalized_text, relative_path
        FROM knowledge_document_blocks
        "#,
        [],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    rebuild_tantivy_from_db(state)
}

pub(crate) fn rebuild_fts_index_for_source(
    state: &State<'_, AppState>,
    source_id: Option<&str>,
) -> Result<(), String> {
    let Some(source_id) = source_id else {
        return rebuild_fts_index(state);
    };
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_document_blocks_fts WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        r#"
        INSERT INTO knowledge_document_blocks_fts (
            block_id, source_id, title, text, normalized_text, relative_path
        )
        SELECT block_id, source_id, title, text, normalized_text, relative_path
        FROM knowledge_document_blocks
        WHERE source_id = ?1
        "#,
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    rebuild_tantivy_from_db(state)
}

fn rebuild_tantivy_from_db(state: &State<'_, AppState>) -> Result<(), String> {
    let blocks = load_blocks_for_index(state)?;
    crate::knowledge_index::tantivy_index::rebuild_index(state, &blocks)
}

pub(crate) fn load_blocks_for_index(
    state: &State<'_, AppState>,
) -> Result<Vec<DocumentBlockRecord>, String> {
    let conn = connection(state)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
                   relative_path, file_extension, title, language, content_origin,
                   ocr_confidence, jurisdiction, authority, authority_level, effective_date,
                   expiry_date, document_type, is_superseded, page, block_type,
                   section_path_json, block_index, line_start, line_end, text,
                   normalized_text, semantic_vector_json, updated_at
            FROM knowledge_document_blocks
            ORDER BY source_id ASC, relative_path ASC, block_index ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], row_to_document_block)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn search_blocks(
    state: &State<'_, AppState>,
    source_id: &str,
    query: &str,
    pattern: &Pattern,
    limit: usize,
    snippet_chars: usize,
    retrieval_mode: RetrievalMode,
) -> Result<Vec<DocumentBlockHit>, String> {
    let conn = connection(state)?;
    let normalized_query = normalize_text(query);
    let lexical_terms = extract_query_terms(&normalized_query);
    if lexical_terms.is_empty() {
        return Ok(Vec::new());
    }
    let expanded_query = expand_query(&normalized_query, lexical_terms.clone());
    let candidate_limit = (limit * 24).max(limit);
    let lower_query = query.to_lowercase();
    let sparse_terms = if retrieval_mode == RetrievalMode::Hybrid {
        &expanded_query.sparse_terms
    } else {
        &expanded_query.lexical_terms
    };

    let today = current_iso_date();
    let query_embedding = if retrieval_mode == RetrievalMode::Hybrid {
        Some(query_embedding(
            &expanded_query.normalized_query,
            &expanded_query.sparse_terms,
        ))
    } else {
        None
    };

    let mut lexical_candidates =
        fts_candidates_for_source(&conn, source_id, sparse_terms, candidate_limit)?;
    if lexical_candidates.len() < candidate_limit {
        lexical_candidates.extend(like_candidates_for_source(
            &conn,
            source_id,
            sparse_terms,
            candidate_limit,
        )?);
    }
    if let Ok(tantivy_hits) =
        tantivy_index::search_block_ids(state, source_id, query, candidate_limit)
    {
        for hit in tantivy_hits {
            if let Some(mut candidate) = candidate_for_block_id(&conn, source_id, &hit.block_id)? {
                candidate.bm25_score = candidate
                    .bm25_score
                    .max((hit.score as f64).clamp(0.0, 12.0));
                lexical_candidates.push(candidate);
            }
        }
    }

    let mut lexical_hits_by_id = std::collections::HashMap::<String, SearchCandidate>::new();
    for mut candidate in lexical_candidates {
        if !pattern.matches_path_with(Path::new(&candidate.path), glob_match_options()) {
            continue;
        }
        let lexical_score = lexical_match_score(
            &candidate.text,
            candidate.title.as_deref(),
            &candidate.path,
            &normalized_query,
            &lower_query,
            &expanded_query.lexical_terms,
            candidate.language.as_deref(),
        );
        if lexical_score <= 0.0 && candidate.bm25_score <= 0.0 {
            continue;
        }
        candidate.lexical_score = lexical_score + candidate.bm25_score;
        match lexical_hits_by_id.get(&candidate.block_id) {
            Some(existing) if existing.lexical_score >= candidate.lexical_score => {}
            _ => {
                lexical_hits_by_id.insert(candidate.block_id.clone(), candidate);
            }
        }
    }

    let mut merged = lexical_hits_by_id
        .into_values()
        .into_iter()
        .map(|candidate| (candidate.block_id.clone(), candidate))
        .collect::<std::collections::HashMap<_, _>>();

    let mut semantic_order = std::collections::HashMap::<String, usize>::new();
    let mut lexical_order = std::collections::HashMap::<String, usize>::new();

    let mut lexical_ranked = merged
        .values()
        .map(|candidate| (candidate.block_id.clone(), candidate.lexical_score))
        .collect::<Vec<_>>();
    lexical_ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (index, (block_id, _)) in lexical_ranked.into_iter().enumerate() {
        lexical_order.insert(block_id, index);
    }

    if retrieval_mode == RetrievalMode::Hybrid {
        let semantic_candidates =
            semantic_candidates_for_source(&conn, source_id, pattern, MAX_SEMANTIC_SCAN_BLOCKS)?;
        let mut semantic_ranked = semantic_candidates
            .into_iter()
            .filter_map(|candidate| {
                let query_embedding = query_embedding.as_ref()?;
                let score = semantic_similarity(query_embedding, &candidate.semantic_vector_json);
                if score <= 0.0 {
                    return None;
                }
                if !merged.contains_key(&candidate.block_id) {
                    merged.insert(candidate.block_id.clone(), candidate.clone());
                }
                Some((candidate.block_id, score))
            })
            .collect::<Vec<_>>();
        semantic_ranked.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for (index, (block_id, _)) in semantic_ranked.into_iter().enumerate() {
            semantic_order.insert(block_id, index);
        }
    }

    let mut scored_hits = Vec::new();
    for (_, candidate) in merged {
        let semantic_score = if retrieval_mode == RetrievalMode::Hybrid {
            query_embedding
                .as_ref()
                .map(|embedding| semantic_similarity(embedding, &candidate.semantic_vector_json))
                .unwrap_or(0.0)
        } else {
            0.0
        };
        let legal_metadata = LegalMetadata {
            jurisdiction: candidate.jurisdiction.clone(),
            authority: candidate.authority.clone(),
            authority_level: candidate.authority_level,
            effective_date: candidate.effective_date.clone(),
            expiry_date: candidate.expiry_date.clone(),
            document_type: candidate.document_type.clone(),
            is_superseded: candidate.is_superseded,
        };
        let legal_score = legal_priority_score(&legal_metadata, &today);
        let fusion_score = if retrieval_mode == RetrievalMode::Hybrid {
            weighted_rrf(
                lexical_order.get(&candidate.block_id).copied(),
                semantic_order.get(&candidate.block_id).copied(),
                1.0,
                0.9,
            )
        } else {
            weighted_rrf(
                lexical_order.get(&candidate.block_id).copied(),
                None,
                1.0,
                0.0,
            )
        };
        let rerank_score = legal_score
            + citation_rerank_bonus(
                candidate.page,
                &candidate.block_type,
                &candidate.content_origin,
                candidate.ocr_confidence,
            )
            + confidence_score(&candidate.content_origin, candidate.ocr_confidence);
        let total_score = candidate.lexical_score
            + (semantic_score * 12.0)
            + (fusion_score * 250.0)
            + rerank_score;
        let mut retrieval_lanes = Vec::new();
        if lexical_order.contains_key(&candidate.block_id) {
            retrieval_lanes.push("lexical".to_string());
        }
        if semantic_order.contains_key(&candidate.block_id) {
            retrieval_lanes.push("semantic".to_string());
        }
        scored_hits.push(DocumentBlockHit {
            block_id: candidate.block_id,
            document_id: candidate.document_id,
            source_id: candidate.source_id,
            source_name: candidate.source_name,
            root_path: candidate.root_path,
            path: candidate.path,
            absolute_path: candidate.absolute_path,
            file_extension: candidate.file_extension,
            title: candidate.title,
            language: candidate.language,
            content_origin: candidate.content_origin,
            ocr_confidence: candidate.ocr_confidence,
            jurisdiction: candidate.jurisdiction,
            authority: candidate.authority,
            authority_level: candidate.authority_level,
            effective_date: candidate.effective_date,
            expiry_date: candidate.expiry_date,
            document_type: candidate.document_type,
            is_superseded: candidate.is_superseded,
            page: candidate.page,
            block_type: candidate.block_type,
            section_path: decode_section_path(&candidate.section_path_json),
            block_index: candidate.block_index,
            line_start: candidate.line_start,
            line_end: candidate.line_end,
            snippet: build_snippet(&candidate.text, query, snippet_chars),
            lexical_score: candidate.lexical_score,
            semantic_score,
            bm25_score: candidate.bm25_score,
            fusion_score,
            rerank_score,
            legal_score,
            total_score,
            retrieval_lanes,
        });
    }
    apply_external_rerank(state, query, &mut scored_hits);
    scored_hits.sort_by(|left, right| {
        right
            .total_score
            .partial_cmp(&left.total_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .lexical_score
                    .partial_cmp(&left.lexical_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.block_index.cmp(&right.block_index))
    });
    scored_hits.truncate(limit);
    Ok(scored_hits)
}

#[derive(Debug, Clone)]
struct ExternalRerankConfig {
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    timeout_seconds: u64,
}

fn apply_external_rerank(state: &State<'_, AppState>, query: &str, hits: &mut [DocumentBlockHit]) {
    let Ok(config) = resolve_external_rerank_config(state) else {
        return;
    };
    let Some(endpoint) = config
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let candidates = hits
        .iter()
        .take(MAX_EXTERNAL_RERANK_CANDIDATES)
        .map(|hit| {
            json!({
                "blockId": hit.block_id,
                "title": hit.title,
                "path": hit.path,
                "page": hit.page,
                "text": hit.snippet,
                "legalMetadata": {
                    "jurisdiction": hit.jurisdiction,
                    "authority": hit.authority,
                    "authorityLevel": hit.authority_level,
                    "effectiveDate": hit.effective_date,
                    "expiryDate": hit.expiry_date,
                    "documentType": hit.document_type,
                    "isSuperseded": hit.is_superseded
                }
            })
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return;
    }
    let body = json!({
        "model": config.model,
        "query": query,
        "candidates": candidates,
    });
    let Ok(response) = crate::run_curl_json_with_timeout(
        "POST",
        endpoint,
        config.api_key.as_deref(),
        &[],
        Some(body),
        Some(config.timeout_seconds),
    ) else {
        return;
    };
    let scores = parse_external_rerank_scores(&response);
    if scores.is_empty() {
        return;
    }
    for hit in hits {
        let Some(score) = scores.get(&hit.block_id).copied() else {
            continue;
        };
        let boost = score.clamp(0.0, 1.0) * 24.0;
        hit.rerank_score += boost;
        hit.total_score += boost;
        if !hit
            .retrieval_lanes
            .iter()
            .any(|lane| lane == "external-rerank")
        {
            hit.retrieval_lanes.push("external-rerank".to_string());
        }
    }
}

fn resolve_external_rerank_config(
    state: &State<'_, AppState>,
) -> Result<ExternalRerankConfig, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let timeout_seconds = payload_field(&settings, "rerank_timeout_seconds")
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(30)
        .clamp(5, 120);
    Ok(ExternalRerankConfig {
        endpoint: payload_string(&settings, "rerank_endpoint")
            .or_else(|| payload_string(&settings, "cross_encoder_rerank_endpoint")),
        api_key: payload_string(&settings, "rerank_api_key"),
        model: payload_string(&settings, "rerank_model"),
        timeout_seconds,
    })
}

fn parse_external_rerank_scores(value: &Value) -> std::collections::HashMap<String, f64> {
    let mut scores = std::collections::HashMap::new();
    if let Some(items) = value
        .get("scores")
        .or_else(|| value.get("results"))
        .or_else(|| value.get("data"))
        .and_then(Value::as_array)
    {
        for item in items {
            let Some(block_id) = item
                .get("blockId")
                .or_else(|| item.get("block_id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(score) = item
                .get("score")
                .or_else(|| item.get("relevance"))
                .and_then(Value::as_f64)
            else {
                continue;
            };
            scores.insert(block_id.to_string(), score);
        }
    }
    scores
}

pub(crate) fn read_block(
    state: &State<'_, AppState>,
    block_id: &str,
) -> Result<Option<DocumentBlockRecord>, String> {
    let conn = connection(state)?;
    conn.query_row(
        r#"
        SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
               relative_path, file_extension, title, language, content_origin,
               ocr_confidence, jurisdiction, authority, authority_level, effective_date,
               expiry_date, document_type, is_superseded, page, block_type,
               section_path_json, block_index, line_start, line_end, text,
               normalized_text, semantic_vector_json, updated_at
        FROM knowledge_document_blocks
        WHERE block_id = ?1
        "#,
        params![block_id],
        row_to_document_block,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn row_to_document_block(row: &rusqlite::Row<'_>) -> Result<DocumentBlockRecord, rusqlite::Error> {
    Ok(DocumentBlockRecord {
        block_id: row.get(0)?,
        document_id: row.get(1)?,
        source_id: row.get(2)?,
        source_name: row.get(3)?,
        root_path: row.get(4)?,
        absolute_path: row.get(5)?,
        relative_path: row.get(6)?,
        file_extension: row.get(7)?,
        title: row.get(8)?,
        language: row.get(9)?,
        content_origin: row.get(10)?,
        ocr_confidence: row.get(11)?,
        jurisdiction: row.get(12)?,
        authority: row.get(13)?,
        authority_level: row.get(14)?,
        effective_date: row.get(15)?,
        expiry_date: row.get(16)?,
        document_type: row.get(17)?,
        is_superseded: row.get(18)?,
        page: row.get(19)?,
        block_type: row.get(20)?,
        section_path_json: row.get(21)?,
        block_index: row.get(22)?,
        line_start: row.get(23)?,
        line_end: row.get(24)?,
        text: row.get(25)?,
        normalized_text: row.get(26)?,
        semantic_vector_json: row.get(27)?,
        updated_at: row.get(28)?,
    })
}

pub(crate) fn build_blocks_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
    source_name: &str,
    root_path: &Path,
    updated_at: &str,
) -> Result<BuildSourceBlocksResult, String> {
    let mut blocks = Vec::new();
    let mut canonical_rows = Vec::new();
    if root_path.is_file() {
        build_blocks_for_file(
            state,
            source_id,
            source_name,
            root_path.parent().unwrap_or(root_path),
            root_path,
            updated_at,
            &mut blocks,
            &mut canonical_rows,
        )?;
        return Ok(BuildSourceBlocksResult {
            blocks,
            canonical_rows,
        });
    }
    collect_blocks_recursive(
        state,
        source_id,
        source_name,
        root_path,
        root_path,
        updated_at,
        &mut blocks,
        &mut canonical_rows,
    )?;
    Ok(BuildSourceBlocksResult {
        blocks,
        canonical_rows,
    })
}

fn collect_blocks_recursive(
    state: &State<'_, AppState>,
    source_id: &str,
    source_name: &str,
    root_path: &Path,
    current: &Path,
    updated_at: &str,
    blocks: &mut Vec<DocumentBlockRecord>,
    canonical_rows: &mut Vec<CanonicalDocumentRow>,
) -> Result<(), String> {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect_blocks_recursive(
                state,
                source_id,
                source_name,
                root_path,
                &path,
                updated_at,
                blocks,
                canonical_rows,
            )?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        build_blocks_for_file(
            state,
            source_id,
            source_name,
            root_path,
            &path,
            updated_at,
            blocks,
            canonical_rows,
        )?;
    }
    Ok(())
}

fn build_blocks_for_file(
    state: &State<'_, AppState>,
    source_id: &str,
    source_name: &str,
    root_path: &Path,
    file_path: &Path,
    updated_at: &str,
    blocks: &mut Vec<DocumentBlockRecord>,
    canonical_rows: &mut Vec<CanonicalDocumentRow>,
) -> Result<(), String> {
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_INDEXED_FILE_BYTES {
        return Ok(());
    }
    let absolute_path = file_path.display().to_string();
    let fingerprint = fingerprint_file(file_path)?;
    let canonical = if let Some(cached) =
        canonical_store::load_cached_document(state, &absolute_path, &fingerprint.content_hash)?
    {
        cached
    } else {
        let ocr_config = resolve_ocr_provider_config(state)?;
        let parser_config = resolve_parser_provider_config(state)?;
        let Some(parsed) = crate::document_parse::parse_path(
            source_id,
            root_path,
            file_path,
            &ocr_config,
            &parser_config,
        )?
        else {
            return Ok(());
        };
        parsed
    };

    canonical_rows.push(CanonicalDocumentRow {
        document_id: canonical.document_id.clone(),
        source_id: canonical.source_id.clone(),
        absolute_path: canonical.absolute_path.clone(),
        relative_path: canonical.relative_path.clone(),
        file_extension: file_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase()),
        source_type: canonical.source_type.clone(),
        content_hash: fingerprint.content_hash,
        parser_name: canonical.parser_info.parser_name.clone(),
        parser_version: canonical.parser_info.parser_version.clone(),
        language: canonical.language.clone(),
        title: canonical.title.clone(),
        content_origin: canonical.content_origin.clone(),
        ocr_average_confidence: canonical.ocr_average_confidence,
        jurisdiction: canonical.legal_metadata.jurisdiction.clone(),
        authority: canonical.legal_metadata.authority.clone(),
        authority_level: canonical.legal_metadata.authority_level,
        effective_date: canonical.legal_metadata.effective_date.clone(),
        expiry_date: canonical.legal_metadata.expiry_date.clone(),
        document_type: canonical.legal_metadata.document_type.clone(),
        is_superseded: canonical.legal_metadata.is_superseded,
        canonical_json: serde_json::to_string(&canonical).map_err(|error| error.to_string())?,
        updated_at: updated_at.to_string(),
    });
    blocks.extend(block_records_from_document(
        &canonical,
        source_name,
        root_path,
        updated_at,
    )?);
    Ok(())
}

fn resolve_parser_provider_config(
    state: &State<'_, AppState>,
) -> Result<ParserProviderConfig, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let timeout_seconds = payload_field(&settings, "parser_timeout_seconds")
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(90)
        .clamp(10, 300);
    Ok(ParserProviderConfig {
        docling_endpoint: payload_string(&settings, "docling_endpoint")
            .or_else(|| payload_string(&settings, "parser_docling_endpoint")),
        tika_endpoint: payload_string(&settings, "tika_endpoint")
            .or_else(|| payload_string(&settings, "parser_tika_endpoint")),
        unstructured_endpoint: payload_string(&settings, "unstructured_endpoint")
            .or_else(|| payload_string(&settings, "parser_unstructured_endpoint")),
        api_key: payload_string(&settings, "parser_api_key"),
        timeout_seconds,
    })
}

fn resolve_ocr_provider_config(state: &State<'_, AppState>) -> Result<OcrProviderConfig, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let provider = match payload_string(&settings, "ocr_provider")
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "api" | "network" | "remote" => OcrProvider::Api,
        "local" | "internal" | "vision" => OcrProvider::Local,
        "disabled" | "off" | "none" => OcrProvider::Disabled,
        _ => OcrProvider::Auto,
    };
    let timeout_seconds = payload_field(&settings, "ocr_timeout_seconds")
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(60)
        .clamp(10, 300);
    let local_fallback = payload_field(&settings, "ocr_local_fallback")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    Ok(OcrProviderConfig {
        provider,
        endpoint: payload_string(&settings, "ocr_endpoint")
            .or_else(|| payload_string(&settings, "ocr_api_endpoint")),
        api_key: payload_string(&settings, "ocr_key")
            .or_else(|| payload_string(&settings, "ocr_api_key")),
        model: payload_string(&settings, "ocr_model"),
        timeout_seconds,
        local_fallback,
    })
}

pub(crate) fn block_records_from_document(
    document: &CanonicalDocument,
    source_name: &str,
    root_path: &Path,
    updated_at: &str,
) -> Result<Vec<DocumentBlockRecord>, String> {
    let mut records = Vec::new();
    for (block_index, block) in document.blocks.iter().enumerate() {
        let normalized_text = normalize_text(&block.text);
        if normalized_text.is_empty() {
            continue;
        }
        records.push(DocumentBlockRecord {
            block_id: format!("{}#{block_index}", document.document_id),
            document_id: document.document_id.clone(),
            source_id: document.source_id.clone(),
            source_name: source_name.to_string(),
            root_path: root_path.display().to_string(),
            absolute_path: document.absolute_path.clone(),
            relative_path: document.relative_path.clone(),
            file_extension: Some(document.source_type.clone()),
            title: document.title.clone(),
            language: block.language.clone().or_else(|| document.language.clone()),
            content_origin: block.content_origin.clone(),
            ocr_confidence: block.ocr_confidence,
            jurisdiction: document.legal_metadata.jurisdiction.clone(),
            authority: document.legal_metadata.authority.clone(),
            authority_level: document.legal_metadata.authority_level,
            effective_date: document.legal_metadata.effective_date.clone(),
            expiry_date: document.legal_metadata.expiry_date.clone(),
            document_type: document.legal_metadata.document_type.clone(),
            is_superseded: document.legal_metadata.is_superseded,
            page: block.page,
            block_type: block.block_type.clone(),
            section_path_json: serde_json::to_string(&block.section_path)
                .map_err(|error| error.to_string())?,
            block_index: block_index as i64,
            line_start: block.line_start,
            line_end: block.line_end,
            text: block.text.clone(),
            normalized_text,
            semantic_vector_json: semantic_vector_json(&format!(
                "{}\n{}\n{}",
                document.title.clone().unwrap_or_default(),
                block.block_type,
                block.text
            )),
            updated_at: updated_at.to_string(),
        });
    }
    Ok(records)
}

#[derive(Debug, Clone)]
struct SearchCandidate {
    block_id: String,
    document_id: String,
    source_id: String,
    source_name: String,
    root_path: String,
    path: String,
    absolute_path: String,
    file_extension: Option<String>,
    title: Option<String>,
    language: Option<String>,
    content_origin: String,
    ocr_confidence: Option<f64>,
    jurisdiction: Option<String>,
    authority: Option<String>,
    authority_level: Option<i64>,
    effective_date: Option<String>,
    expiry_date: Option<String>,
    document_type: Option<String>,
    is_superseded: bool,
    page: Option<i64>,
    block_type: String,
    section_path_json: String,
    block_index: i64,
    line_start: i64,
    line_end: i64,
    text: String,
    semantic_vector_json: String,
    lexical_score: f64,
    bm25_score: f64,
}

fn decode_section_path(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn fts_candidates_for_source(
    conn: &Connection,
    source_id: &str,
    terms: &[String],
    limit: usize,
) -> Result<Vec<SearchCandidate>, String> {
    let Some(match_query) = build_fts_match_query(terms) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare(
            r#"
            SELECT b.block_id, b.document_id, b.source_id, b.source_name, b.root_path,
                   b.absolute_path, b.relative_path, b.file_extension, b.title, b.language,
                   b.content_origin, b.ocr_confidence, b.jurisdiction, b.authority,
                   b.authority_level, b.effective_date, b.expiry_date, b.document_type,
                   b.is_superseded, b.page, b.block_type, b.section_path_json,
                   b.block_index, b.line_start, b.line_end, b.text, b.semantic_vector_json,
                   bm25(knowledge_document_blocks_fts) AS bm25_rank
            FROM knowledge_document_blocks_fts
            JOIN knowledge_document_blocks b ON b.block_id = knowledge_document_blocks_fts.block_id
            WHERE knowledge_document_blocks_fts MATCH ?1
              AND knowledge_document_blocks_fts.source_id = ?2
            ORDER BY bm25_rank ASC
            LIMIT ?3
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![match_query, source_id, limit as i64], |row| {
            let mut candidate = row_to_search_candidate(row)?;
            let bm25_rank: f64 = row.get(27)?;
            candidate.bm25_score = bm25_rank_score(bm25_rank);
            Ok(candidate)
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn like_candidates_for_source(
    conn: &Connection,
    source_id: &str,
    terms: &[String],
    limit: usize,
) -> Result<Vec<SearchCandidate>, String> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut params = vec![SqlValue::Text(source_id.to_string())];
    let mut fragments = Vec::new();
    let mut next_param = 2usize;
    for term in terms {
        let like = format!("%{term}%");
        fragments.push(format!(
            "(normalized_text LIKE ?{start} OR lower(COALESCE(title, '')) LIKE ?{mid} OR lower(relative_path) LIKE ?{end})",
            start = next_param,
            mid = next_param + 1,
            end = next_param + 2
        ));
        params.push(SqlValue::Text(like.clone()));
        params.push(SqlValue::Text(like.clone()));
        params.push(SqlValue::Text(like));
        next_param += 3;
    }
    params.push(SqlValue::Integer(limit as i64));
    let mut stmt = conn
        .prepare(&format!(
            r#"
            SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
                   relative_path, file_extension, title, language, content_origin,
                   ocr_confidence, jurisdiction, authority, authority_level, effective_date,
                   expiry_date, document_type, is_superseded, page, block_type,
                   section_path_json, block_index, line_start, line_end, text,
                   semantic_vector_json
            FROM knowledge_document_blocks
            WHERE source_id = ?1
              AND ({})
            LIMIT ?{}
            "#,
            fragments.join(" OR "),
            next_param
        ))
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), row_to_search_candidate)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn candidate_for_block_id(
    conn: &Connection,
    source_id: &str,
    block_id: &str,
) -> Result<Option<SearchCandidate>, String> {
    conn.query_row(
        r#"
        SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
               relative_path, file_extension, title, language, content_origin,
               ocr_confidence, jurisdiction, authority, authority_level, effective_date,
               expiry_date, document_type, is_superseded, page, block_type,
               section_path_json, block_index, line_start, line_end, text,
               semantic_vector_json
        FROM knowledge_document_blocks
        WHERE source_id = ?1 AND block_id = ?2
        "#,
        params![source_id, block_id],
        row_to_search_candidate,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn build_fts_match_query(terms: &[String]) -> Option<String> {
    let mut phrases = terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .map(quote_fts_phrase)
        .collect::<Vec<_>>();
    phrases.sort();
    phrases.dedup();
    if phrases.is_empty() {
        None
    } else {
        Some(phrases.join(" OR "))
    }
}

fn quote_fts_phrase(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn bm25_rank_score(rank: f64) -> f64 {
    if !rank.is_finite() {
        return 0.0;
    }
    if rank < 0.0 {
        return (rank.abs() * 1_000_000.0).clamp(0.0, 12.0);
    }
    (1.0 / (1.0 + rank)).clamp(0.0, 1.0) * 6.0
}

fn semantic_candidates_for_source(
    conn: &Connection,
    source_id: &str,
    pattern: &Pattern,
    limit: usize,
) -> Result<Vec<SearchCandidate>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
                   relative_path, file_extension, title, language, content_origin,
                   ocr_confidence, jurisdiction, authority, authority_level, effective_date,
                   expiry_date, document_type, is_superseded, page, block_type,
                   section_path_json, block_index, line_start, line_end, text,
                   semantic_vector_json
            FROM knowledge_document_blocks
            WHERE source_id = ?1
            LIMIT ?2
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![source_id, limit as i64], |row| {
            Ok(SearchCandidate {
                block_id: row.get(0)?,
                document_id: row.get(1)?,
                source_id: row.get(2)?,
                source_name: row.get(3)?,
                root_path: row.get(4)?,
                absolute_path: row.get(5)?,
                path: row.get(6)?,
                file_extension: row.get(7)?,
                title: row.get(8)?,
                language: row.get(9)?,
                content_origin: row.get(10)?,
                ocr_confidence: row.get(11)?,
                jurisdiction: row.get(12)?,
                authority: row.get(13)?,
                authority_level: row.get(14)?,
                effective_date: row.get(15)?,
                expiry_date: row.get(16)?,
                document_type: row.get(17)?,
                is_superseded: row.get(18)?,
                page: row.get(19)?,
                block_type: row.get(20)?,
                section_path_json: row.get(21)?,
                block_index: row.get(22)?,
                line_start: row.get(23)?,
                line_end: row.get(24)?,
                text: row.get(25)?,
                semantic_vector_json: row.get(26)?,
                lexical_score: 0.0,
                bm25_score: 0.0,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut candidates = Vec::new();
    for row in rows {
        let candidate = row.map_err(|error| error.to_string())?;
        if pattern.matches_path_with(Path::new(&candidate.path), glob_match_options()) {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

fn normalize_text(input: &str) -> String {
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

fn extract_query_terms(normalized_query: &str) -> Vec<String> {
    let mut terms = normalized_query
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect::<Vec<_>>();
    if terms.is_empty() && !normalized_query.is_empty() {
        terms.push(normalized_query.to_string());
    }
    terms.sort();
    terms.dedup();
    terms
}

fn lexical_match_score(
    text: &str,
    title: Option<&str>,
    relative_path: &str,
    normalized_query: &str,
    lower_query: &str,
    terms: &[String],
    language: Option<&str>,
) -> f64 {
    let normalized_text = normalize_text(text);
    let normalized_title = normalize_text(title.unwrap_or_default());
    let normalized_path = normalize_text(relative_path);
    let mut score = 0.0;
    if !normalized_query.is_empty() && normalized_text.contains(normalized_query) {
        score += 18.0;
    }
    if !lower_query.is_empty() && text.to_lowercase().contains(lower_query) {
        score += 6.0;
    }
    if !normalized_query.is_empty() && normalized_title.contains(normalized_query) {
        score += 9.0;
    }
    if !normalized_query.is_empty() && normalized_path.contains(normalized_query) {
        score += 4.0;
    }
    let mut matched_terms = 0usize;
    for term in terms {
        if normalized_text.contains(term) {
            score += 5.0;
            matched_terms += 1;
        } else if normalized_title.contains(term) {
            score += 3.5;
            matched_terms += 1;
        } else if normalized_path.contains(term) {
            score += 2.0;
            matched_terms += 1;
        }
    }
    if matched_terms == terms.len() {
        score += 6.0;
    }
    if language == Some("multilingual") && query_has_multilingual_terms(terms) {
        score += 1.5;
    }
    score
}

fn query_has_multilingual_terms(terms: &[String]) -> bool {
    let mut has_han = false;
    let mut has_ascii = false;
    for term in terms {
        if term
            .chars()
            .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
        {
            has_han = true;
        }
        if term.chars().any(|ch| ch.is_ascii_alphabetic()) {
            has_ascii = true;
        }
    }
    has_han && has_ascii
}

fn legal_priority_score(metadata: &LegalMetadata, today: &str) -> f64 {
    let mut score = metadata.authority_level.unwrap_or(0) as f64 / 8.0;
    score += match metadata.document_type.as_deref().unwrap_or("general") {
        "law" => 16.0,
        "regulation" => 13.0,
        "judicial-interpretation" => 12.0,
        "case" => 9.0,
        "contract" => 5.0,
        "internal-policy" => 3.0,
        "commentary" => 1.0,
        _ => 0.0,
    };
    if let Some(expiry) = metadata.expiry_date.as_deref() {
        if expiry <= today {
            score -= 10.0;
        }
    }
    if let Some(effective) = metadata.effective_date.as_deref() {
        if effective > today {
            score -= 4.0;
        } else {
            score += 3.0;
        }
    }
    if metadata.is_superseded {
        score -= 18.0;
    }
    score
}

fn confidence_score(content_origin: &str, ocr_confidence: Option<f64>) -> f64 {
    if content_origin != "ocr" {
        return 0.0;
    }
    match ocr_confidence {
        Some(confidence) if confidence >= 0.9 => -0.5,
        Some(confidence) if confidence >= 0.75 => -2.0,
        Some(confidence) if confidence >= 0.6 => -5.0,
        Some(_) => -10.0,
        None => -8.0,
    }
}

fn current_iso_date() -> String {
    OffsetDateTime::now_utc().date().to_string()
}

fn row_to_search_candidate(row: &rusqlite::Row<'_>) -> Result<SearchCandidate, rusqlite::Error> {
    Ok(SearchCandidate {
        block_id: row.get(0)?,
        document_id: row.get(1)?,
        source_id: row.get(2)?,
        source_name: row.get(3)?,
        root_path: row.get(4)?,
        absolute_path: row.get(5)?,
        path: row.get(6)?,
        file_extension: row.get(7)?,
        title: row.get(8)?,
        language: row.get(9)?,
        content_origin: row.get(10)?,
        ocr_confidence: row.get(11)?,
        jurisdiction: row.get(12)?,
        authority: row.get(13)?,
        authority_level: row.get(14)?,
        effective_date: row.get(15)?,
        expiry_date: row.get(16)?,
        document_type: row.get(17)?,
        is_superseded: row.get(18)?,
        page: row.get(19)?,
        block_type: row.get(20)?,
        section_path_json: row.get(21)?,
        block_index: row.get(22)?,
        line_start: row.get(23)?,
        line_end: row.get(24)?,
        text: row.get(25)?,
        semantic_vector_json: row.get(26)?,
        lexical_score: 0.0,
        bm25_score: 0.0,
    })
}

fn build_snippet(text: &str, query: &str, max_chars: usize) -> String {
    let normalized_query = query.to_lowercase();
    let lowered = text.to_lowercase();
    let start = lowered.find(&normalized_query).unwrap_or(0);
    let safe_start = start.saturating_sub(max_chars / 4);
    let snippet = text
        .chars()
        .skip(safe_start)
        .take(max_chars)
        .collect::<String>();
    if snippet.chars().count() >= text.chars().count() {
        return snippet.trim().to_string();
    }
    snippet.trim().to_string()
}

fn glob_match_options() -> glob::MatchOptions {
    glob::MatchOptions {
        case_sensitive: false,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_section_path_json() {
        let value = decode_section_path(r#"["sheet","Sheet1"]"#);
        assert_eq!(value, vec!["sheet".to_string(), "Sheet1".to_string()]);
    }

    #[test]
    fn normalizes_text_to_lowercase_compact_form() {
        let value = normalize_text("Hello   World\nSecond");
        assert_eq!(value, "hello world second");
    }

    #[test]
    fn multilingual_query_terms_are_preserved() {
        let value = extract_query_terms(&normalize_text("合同 breach"));
        assert_eq!(value, vec!["breach".to_string(), "合同".to_string()]);
    }

    #[test]
    fn fts_candidates_use_bm25_scores() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE knowledge_document_blocks (
                block_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                source_name TEXT NOT NULL DEFAULT '',
                root_path TEXT NOT NULL,
                absolute_path TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                file_extension TEXT,
                title TEXT,
                language TEXT,
                content_origin TEXT NOT NULL DEFAULT 'native',
                ocr_confidence REAL,
                jurisdiction TEXT,
                authority TEXT,
                authority_level INTEGER,
                effective_date TEXT,
                expiry_date TEXT,
                document_type TEXT,
                is_superseded INTEGER NOT NULL DEFAULT 0,
                page INTEGER,
                block_type TEXT NOT NULL DEFAULT '',
                section_path_json TEXT NOT NULL DEFAULT '[]',
                block_index INTEGER NOT NULL,
                line_start INTEGER NOT NULL,
                line_end INTEGER NOT NULL,
                text TEXT NOT NULL,
                normalized_text TEXT NOT NULL,
                semantic_vector_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE VIRTUAL TABLE knowledge_document_blocks_fts USING fts5(
                block_id UNINDEXED,
                source_id UNINDEXED,
                title,
                text,
                normalized_text,
                relative_path,
                tokenize='unicode61'
            );
            "#,
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO knowledge_document_blocks (
                block_id, document_id, source_id, source_name, root_path, absolute_path,
                relative_path, file_extension, title, language, content_origin,
                ocr_confidence, jurisdiction, authority, authority_level, effective_date,
                expiry_date, document_type, is_superseded, page, block_type,
                section_path_json, block_index, line_start, line_end, text,
                normalized_text, semantic_vector_json, updated_at
            ) VALUES (
                'block-1', 'doc-1', 'source-1', 'Source', '/tmp', '/tmp/doc.txt',
                'doc.txt', 'txt', 'Breach Remedy', 'en', 'native',
                NULL, NULL, NULL, NULL, NULL,
                NULL, 'contract', 0, 1, 'paragraph',
                '[]', 0, 1, 1, 'Material breach remedy clause.',
                'material breach remedy clause', '[]', '2026-04-25'
            )
            "#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO knowledge_document_blocks_fts (
                block_id, source_id, title, text, normalized_text, relative_path
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            rusqlite::params![
                "block-1",
                "source-1",
                "Breach Remedy",
                "Material breach remedy clause.",
                "material breach remedy clause",
                "doc.txt"
            ],
        )
        .unwrap();

        let candidates =
            fts_candidates_for_source(&conn, "source-1", &["breach".to_string()], 10).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].block_id, "block-1");
        assert!(candidates[0].bm25_score > 0.0);
    }

    #[test]
    fn legal_priority_prefers_current_law_over_commentary() {
        let law = LegalMetadata {
            jurisdiction: Some("CN-national".to_string()),
            authority: Some("全国人民代表大会".to_string()),
            authority_level: Some(144),
            effective_date: Some("2021-01-01".to_string()),
            expiry_date: None,
            document_type: Some("law".to_string()),
            is_superseded: false,
        };
        let commentary = LegalMetadata {
            jurisdiction: Some("CN-national".to_string()),
            authority: None,
            authority_level: Some(30),
            effective_date: Some("2021-01-01".to_string()),
            expiry_date: None,
            document_type: Some("commentary".to_string()),
            is_superseded: false,
        };
        assert!(
            legal_priority_score(&law, "2026-04-22")
                > legal_priority_score(&commentary, "2026-04-22")
        );
    }

    #[test]
    fn superseded_documents_are_penalized() {
        let current = LegalMetadata {
            jurisdiction: Some("CN-national".to_string()),
            authority: Some("国务院".to_string()),
            authority_level: Some(120),
            effective_date: Some("2020-01-01".to_string()),
            expiry_date: None,
            document_type: Some("regulation".to_string()),
            is_superseded: false,
        };
        let superseded = LegalMetadata {
            is_superseded: true,
            expiry_date: Some("2024-12-31".to_string()),
            ..current.clone()
        };
        assert!(
            legal_priority_score(&current, "2026-04-22")
                > legal_priority_score(&superseded, "2026-04-22")
        );
    }

    #[test]
    fn low_confidence_ocr_is_penalized() {
        assert!(confidence_score("ocr", Some(0.52)) < confidence_score("ocr", Some(0.92)));
        assert_eq!(confidence_score("native", None), 0.0);
    }

    #[test]
    fn parses_external_rerank_scores_by_block_id() {
        let scores = parse_external_rerank_scores(&json!({
            "results": [
                { "blockId": "block-1", "score": 0.91 },
                { "block_id": "block-2", "relevance": 0.42 }
            ]
        }));

        assert_eq!(scores.get("block-1").copied(), Some(0.91));
        assert_eq!(scores.get("block-2").copied(), Some(0.42));
    }
}
