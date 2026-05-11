use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tauri::State;

use crate::{
    AppState,
    knowledge_index::{
        catalog_db_path, document_blocks::DocumentBlockRecord, schema::ensure_catalog_ready,
    },
};

const MAX_ANCHOR_CHARS: usize = 280;

#[derive(Debug, Clone)]
pub(crate) struct CitationAnchorRecord {
    pub anchor_id: String,
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
    pub page: Option<i64>,
    pub block_type: String,
    pub section_path_json: String,
    pub char_start: i64,
    pub char_end: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub quote_text: String,
    pub normalized_quote_text: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CitationAnchor {
    pub anchor_id: String,
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
    pub page: Option<i64>,
    pub block_type: String,
    pub section_path: Vec<String>,
    pub char_start: i64,
    pub char_end: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub quote_text: String,
}

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    Connection::open(catalog_db_path(state)?).map_err(|error| error.to_string())
}

pub(crate) fn replace_anchors(
    state: &State<'_, AppState>,
    anchors: &[CitationAnchorRecord],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_citation_anchors", [])
        .map_err(|error| error.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_citation_anchors (
                    anchor_id, block_id, document_id, source_id, source_name, root_path,
                    absolute_path, relative_path, file_extension, title, language, page,
                    block_type, section_path_json, char_start, char_end, line_start,
                    line_end, quote_text, normalized_quote_text, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17,
                    ?18, ?19, ?20, ?21
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        for anchor in anchors {
            stmt.execute(params![
                anchor.anchor_id,
                anchor.block_id,
                anchor.document_id,
                anchor.source_id,
                anchor.source_name,
                anchor.root_path,
                anchor.absolute_path,
                anchor.relative_path,
                anchor.file_extension,
                anchor.title,
                anchor.language,
                anchor.page,
                anchor.block_type,
                anchor.section_path_json,
                anchor.char_start,
                anchor.char_end,
                anchor.line_start,
                anchor.line_end,
                anchor.quote_text,
                anchor.normalized_quote_text,
                anchor.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn replace_anchors_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
    anchors: &[CitationAnchorRecord],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_citation_anchors WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_citation_anchors (
                    anchor_id, block_id, document_id, source_id, source_name, root_path,
                    absolute_path, relative_path, file_extension, title, language, page,
                    block_type, section_path_json, char_start, char_end, line_start,
                    line_end, quote_text, normalized_quote_text, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17,
                    ?18, ?19, ?20, ?21
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        for anchor in anchors {
            stmt.execute(params![
                anchor.anchor_id,
                anchor.block_id,
                anchor.document_id,
                anchor.source_id,
                anchor.source_name,
                anchor.root_path,
                anchor.absolute_path,
                anchor.relative_path,
                anchor.file_extension,
                anchor.title,
                anchor.language,
                anchor.page,
                anchor.block_type,
                anchor.section_path_json,
                anchor.char_start,
                anchor.char_end,
                anchor.line_start,
                anchor.line_end,
                anchor.quote_text,
                anchor.normalized_quote_text,
                anchor.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn upsert_anchors_for_documents(
    state: &State<'_, AppState>,
    anchors: &[CitationAnchorRecord],
) -> Result<(), String> {
    if anchors.is_empty() {
        return Ok(());
    }
    let document_ids = anchors
        .iter()
        .map(|anchor| anchor.document_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for document_id in &document_ids {
        tx.execute(
            "DELETE FROM knowledge_citation_anchors WHERE document_id = ?1",
            params![document_id],
        )
        .map_err(|error| error.to_string())?;
    }
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_citation_anchors (
                    anchor_id, block_id, document_id, source_id, source_name, root_path,
                    absolute_path, relative_path, file_extension, title, language, page,
                    block_type, section_path_json, char_start, char_end, line_start,
                    line_end, quote_text, normalized_quote_text, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17,
                    ?18, ?19, ?20, ?21
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        for anchor in anchors {
            stmt.execute(params![
                anchor.anchor_id,
                anchor.block_id,
                anchor.document_id,
                anchor.source_id,
                anchor.source_name,
                anchor.root_path,
                anchor.absolute_path,
                anchor.relative_path,
                anchor.file_extension,
                anchor.title,
                anchor.language,
                anchor.page,
                anchor.block_type,
                anchor.section_path_json,
                anchor.char_start,
                anchor.char_end,
                anchor.line_start,
                anchor.line_end,
                anchor.quote_text,
                anchor.normalized_quote_text,
                anchor.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn delete_anchors_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<(), String> {
    let conn = connection(state)?;
    conn.execute(
        "DELETE FROM knowledge_citation_anchors WHERE source_id = ?1",
        params![source_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub(crate) fn delete_anchors_for_documents(
    state: &State<'_, AppState>,
    document_ids: &[String],
) -> Result<(), String> {
    if document_ids.is_empty() {
        return Ok(());
    }
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for document_id in document_ids {
        tx.execute(
            "DELETE FROM knowledge_citation_anchors WHERE document_id = ?1",
            params![document_id],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn build_anchors_for_blocks(
    blocks: &[DocumentBlockRecord],
) -> Vec<CitationAnchorRecord> {
    let mut anchors = Vec::new();
    for block in blocks {
        anchors.extend(build_anchors_for_block(block));
    }
    anchors
}

pub(crate) fn anchors_for_block(
    state: &State<'_, AppState>,
    block_id: &str,
) -> Result<Vec<CitationAnchor>, String> {
    let conn = connection(state)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT anchor_id, block_id, document_id, source_id, source_name, root_path,
                   absolute_path, relative_path, file_extension, title, language, page,
                   block_type, section_path_json, char_start, char_end, line_start,
                   line_end, quote_text
            FROM knowledge_citation_anchors
            WHERE block_id = ?1
            ORDER BY char_start ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let anchors = stmt
        .query_map(params![block_id], row_to_anchor)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(anchors)
}

pub(crate) fn anchors_for_block_query(
    state: &State<'_, AppState>,
    block_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<CitationAnchor>, String> {
    let conn = connection(state)?;
    let normalized_query = normalize_text(query);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT anchor_id, block_id, document_id, source_id, source_name, root_path,
                   absolute_path, relative_path, file_extension, title, language, page,
                   block_type, section_path_json, char_start, char_end, line_start,
                   line_end, quote_text
            FROM knowledge_citation_anchors
            WHERE block_id = ?1
              AND normalized_quote_text LIKE ?2
            ORDER BY char_start ASC
            LIMIT ?3
            "#,
        )
        .map_err(|error| error.to_string())?;
    let anchors = stmt
        .query_map(
            params![block_id, format!("%{normalized_query}%"), limit.max(1)],
            row_to_anchor,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !anchors.is_empty() {
        return Ok(anchors);
    }
    anchors_for_block(state, block_id).map(|items| items.into_iter().take(limit.max(1)).collect())
}

pub(crate) fn read_anchor(
    state: &State<'_, AppState>,
    anchor_id: &str,
) -> Result<Option<CitationAnchor>, String> {
    let conn = connection(state)?;
    conn.query_row(
        r#"
        SELECT anchor_id, block_id, document_id, source_id, source_name, root_path,
               absolute_path, relative_path, file_extension, title, language, page,
               block_type, section_path_json, char_start, char_end, line_start,
               line_end, quote_text
        FROM knowledge_citation_anchors
        WHERE anchor_id = ?1
        "#,
        params![anchor_id],
        row_to_anchor,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn row_to_anchor(row: &rusqlite::Row<'_>) -> Result<CitationAnchor, rusqlite::Error> {
    let section_path_json: String = row.get(13)?;
    Ok(CitationAnchor {
        anchor_id: row.get(0)?,
        block_id: row.get(1)?,
        document_id: row.get(2)?,
        source_id: row.get(3)?,
        source_name: row.get(4)?,
        root_path: row.get(5)?,
        absolute_path: row.get(6)?,
        path: row.get(7)?,
        file_extension: row.get(8)?,
        title: row.get(9)?,
        language: row.get(10)?,
        page: row.get(11)?,
        block_type: row.get(12)?,
        section_path: decode_section_path(&section_path_json),
        char_start: row.get(14)?,
        char_end: row.get(15)?,
        line_start: row.get(16)?,
        line_end: row.get(17)?,
        quote_text: row.get(18)?,
    })
}

fn build_anchors_for_block(block: &DocumentBlockRecord) -> Vec<CitationAnchorRecord> {
    let spans = split_anchor_spans(&block.text);
    if spans.is_empty() {
        return Vec::new();
    }
    spans
        .into_iter()
        .enumerate()
        .map(|(index, span)| {
            let line_offsets = estimate_line_offsets(
                &block.text,
                span.char_start as usize,
                span.char_end as usize,
            );
            CitationAnchorRecord {
                anchor_id: format!(
                    "{}@{}-{}-{}",
                    block.block_id, span.char_start, span.char_end, index
                ),
                block_id: block.block_id.clone(),
                document_id: block.document_id.clone(),
                source_id: block.source_id.clone(),
                source_name: block.source_name.clone(),
                root_path: block.root_path.clone(),
                absolute_path: block.absolute_path.clone(),
                relative_path: block.relative_path.clone(),
                file_extension: block.file_extension.clone(),
                title: block.title.clone(),
                language: block.language.clone(),
                page: block.page,
                block_type: block.block_type.clone(),
                section_path_json: block.section_path_json.clone(),
                char_start: span.char_start,
                char_end: span.char_end,
                line_start: line_offsets.0,
                line_end: line_offsets.1,
                quote_text: span.quote_text.clone(),
                normalized_quote_text: normalize_text(&span.quote_text),
                updated_at: block.updated_at.clone(),
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct AnchorSpan {
    char_start: i64,
    char_end: i64,
    quote_text: String,
}

fn split_anchor_spans(text: &str) -> Vec<AnchorSpan> {
    let mut spans = Vec::new();
    let chars = text.chars().collect::<Vec<_>>();
    let mut start = 0usize;
    let mut current = String::new();
    for (index, ch) in chars.iter().enumerate() {
        current.push(*ch);
        let should_split = matches!(ch, '。' | '！' | '？' | '.' | '!' | '?' | ';' | '；' | '\n')
            || current.chars().count() >= MAX_ANCHOR_CHARS;
        if should_split {
            let quote = current.trim().to_string();
            if !quote.is_empty() {
                spans.push(AnchorSpan {
                    char_start: start as i64,
                    char_end: (index + 1) as i64,
                    quote_text: quote,
                });
            }
            start = index + 1;
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        spans.push(AnchorSpan {
            char_start: start as i64,
            char_end: chars.len() as i64,
            quote_text: current.trim().to_string(),
        });
    }
    if spans.is_empty() && !text.trim().is_empty() {
        spans.push(AnchorSpan {
            char_start: 0,
            char_end: chars.len() as i64,
            quote_text: text.trim().to_string(),
        });
    }
    spans
}

fn estimate_line_offsets(text: &str, char_start: usize, char_end: usize) -> (i64, i64) {
    let mut current_char = 0usize;
    let mut current_line = 1i64;
    let mut line_start = 1i64;
    let mut line_end = 1i64;
    for ch in text.chars() {
        if current_char == char_start {
            line_start = current_line;
        }
        if current_char < char_end {
            line_end = current_line;
        }
        current_char += 1;
        if ch == '\n' {
            current_line += 1;
        }
    }
    (line_start, line_end)
}

fn decode_section_path(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn normalize_text(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_block() -> DocumentBlockRecord {
        DocumentBlockRecord {
            block_id: "doc:block#0".to_string(),
            document_id: "doc:block".to_string(),
            source_id: "source-1".to_string(),
            source_name: "Source 1".to_string(),
            root_path: "/tmp/source".to_string(),
            absolute_path: "/tmp/source/file.txt".to_string(),
            relative_path: "file.txt".to_string(),
            file_extension: Some("txt".to_string()),
            title: Some("file".to_string()),
            language: Some("en".to_string()),
            content_origin: "native".to_string(),
            ocr_confidence: None,
            visual_unit_id: None,
            source_document_id: None,
            evidence_refs_json: "[]".to_string(),
            jurisdiction: None,
            authority: None,
            authority_level: None,
            effective_date: None,
            expiry_date: None,
            document_type: Some("general".to_string()),
            is_superseded: false,
            page: Some(1),
            block_type: "plain-text".to_string(),
            section_path_json: r#"["body"]"#.to_string(),
            block_index: 0,
            line_start: 1,
            line_end: 3,
            text: "First sentence. Second sentence.\nThird line.".to_string(),
            normalized_text: "first sentence second sentence third line".to_string(),
            semantic_vector_json: "[]".to_string(),
            updated_at: "2026-04-22".to_string(),
        }
    }

    #[test]
    fn builds_stable_anchor_ids_for_same_block() {
        let block = sample_block();
        let first = build_anchors_for_block(&block)
            .into_iter()
            .map(|item| item.anchor_id)
            .collect::<Vec<_>>();
        let second = build_anchors_for_block(&block)
            .into_iter()
            .map(|item| item.anchor_id)
            .collect::<Vec<_>>();
        assert_eq!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn splits_text_into_multiple_anchors() {
        let anchors = build_anchors_for_block(&sample_block());
        assert!(anchors.len() >= 2);
        assert!(anchors[0].quote_text.contains("First sentence"));
    }
}
