use glob::Pattern;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::State;

use crate::{
    document_parse::CanonicalDocument,
    knowledge_index::{
        canonical_store::{self, CanonicalDocumentRow},
        catalog_db_path,
        fingerprint::fingerprint_file,
        schema::ensure_catalog_ready,
    },
    AppState,
};

const MAX_INDEXED_FILE_BYTES: u64 = 4 * 1024 * 1024;

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
    pub page: Option<i64>,
    pub block_type: String,
    pub section_path_json: String,
    pub block_index: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
    pub normalized_text: String,
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
    pub page: Option<i64>,
    pub block_type: String,
    pub section_path: Vec<String>,
    pub block_index: i64,
    pub line_start: i64,
    pub line_end: i64,
    pub snippet: String,
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
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_document_blocks (
                    block_id, document_id, source_id, source_name, root_path, absolute_path,
                    relative_path, file_extension, title, language, page, block_type,
                    section_path_json, block_index, line_start, line_end, text,
                    normalized_text, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17,
                    ?18, ?19
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
                block.page,
                block.block_type,
                block.section_path_json,
                block.block_index,
                block.line_start,
                block.line_end,
                block.text,
                block.normalized_text,
                block.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
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

pub(crate) fn search_blocks(
    state: &State<'_, AppState>,
    source_id: &str,
    query: &str,
    pattern: &Pattern,
    limit: usize,
    snippet_chars: usize,
) -> Result<Vec<DocumentBlockHit>, String> {
    let conn = connection(state)?;
    let normalized_query = normalize_text(query);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
                   relative_path, file_extension, title, language, page, block_type,
                   section_path_json, block_index, line_start, line_end, text
            FROM knowledge_document_blocks
            WHERE source_id = ?1
              AND normalized_text LIKE ?2
            ORDER BY relative_path ASC, block_index ASC
            LIMIT ?3
            "#,
        )
        .map_err(|error| error.to_string())?;
    let candidates = stmt
        .query_map(
            params![source_id, format!("%{normalized_query}%"), (limit * 8).max(limit)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, i64>(15)?,
                    row.get::<_, String>(16)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    let mut hits = Vec::new();
    for row in candidates {
        let (
            block_id,
            document_id,
            source_id,
            source_name,
            root_path,
            absolute_path,
            relative_path,
            file_extension,
            title,
            language,
            page,
            block_type,
            section_path_json,
            block_index,
            line_start,
            line_end,
            text,
        ) = row.map_err(|error| error.to_string())?;
        if !pattern.matches_path_with(Path::new(&relative_path), glob_match_options()) {
            continue;
        }
        hits.push(DocumentBlockHit {
            block_id,
            document_id,
            source_id,
            source_name,
            root_path,
            path: relative_path,
            absolute_path,
            file_extension,
            title,
            language,
            page,
            block_type,
            section_path: decode_section_path(&section_path_json),
            block_index,
            line_start,
            line_end,
            snippet: build_snippet(&text, query, snippet_chars),
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

pub(crate) fn read_block(
    state: &State<'_, AppState>,
    block_id: &str,
) -> Result<Option<DocumentBlockRecord>, String> {
    let conn = connection(state)?;
    conn.query_row(
        r#"
        SELECT block_id, document_id, source_id, source_name, root_path, absolute_path,
               relative_path, file_extension, title, language, page, block_type,
               section_path_json, block_index, line_start, line_end, text,
               normalized_text, updated_at
        FROM knowledge_document_blocks
        WHERE block_id = ?1
        "#,
        params![block_id],
        |row| {
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
                page: row.get(10)?,
                block_type: row.get(11)?,
                section_path_json: row.get(12)?,
                block_index: row.get(13)?,
                line_start: row.get(14)?,
                line_end: row.get(15)?,
                text: row.get(16)?,
                normalized_text: row.get(17)?,
                updated_at: row.get(18)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
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
        let Some(parsed) = crate::document_parse::parse_path(source_id, root_path, file_path)? else {
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

fn block_records_from_document(
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
            page: block.page,
            block_type: block.block_type.clone(),
            section_path_json: serde_json::to_string(&block.section_path)
                .map_err(|error| error.to_string())?,
            block_index: block_index as i64,
            line_start: block.line_start,
            line_end: block.line_end,
            text: block.text.clone(),
            normalized_text,
            updated_at: updated_at.to_string(),
        });
    }
    Ok(records)
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
}
