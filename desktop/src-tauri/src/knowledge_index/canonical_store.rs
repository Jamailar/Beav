use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::{
    document_parse::{CanonicalDocument, PARSER_NAME, PARSER_VERSION},
    knowledge_index::{catalog_db_path, schema::ensure_catalog_ready},
    AppState,
};

#[derive(Debug, Clone)]
pub(crate) struct CanonicalDocumentRow {
    pub document_id: String,
    pub source_id: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub file_extension: Option<String>,
    pub source_type: String,
    pub content_hash: String,
    pub parser_name: String,
    pub parser_version: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub content_origin: String,
    pub ocr_average_confidence: Option<f64>,
    pub jurisdiction: Option<String>,
    pub authority: Option<String>,
    pub authority_level: Option<i64>,
    pub effective_date: Option<String>,
    pub expiry_date: Option<String>,
    pub document_type: Option<String>,
    pub is_superseded: bool,
    pub canonical_json: String,
    pub updated_at: String,
}

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    Connection::open(catalog_db_path(state)?).map_err(|error| error.to_string())
}

pub(crate) fn load_cached_document(
    state: &State<'_, AppState>,
    absolute_path: &str,
    content_hash: &str,
) -> Result<Option<CanonicalDocument>, String> {
    let conn = connection(state)?;
    let json = conn
        .query_row(
            r#"
            SELECT canonical_json
            FROM knowledge_canonical_documents
            WHERE absolute_path = ?1
              AND content_hash = ?2
              AND parser_name = ?3
              AND parser_version = ?4
            "#,
            params![absolute_path, content_hash, PARSER_NAME, PARSER_VERSION],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    json.map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
}

pub(crate) fn load_document_rows(
    state: &State<'_, AppState>,
    source_id: Option<&str>,
) -> Result<Vec<CanonicalDocumentRow>, String> {
    let conn = connection(state)?;
    let sql = if source_id.is_some() {
        r#"
        SELECT document_id, source_id, absolute_path, relative_path, file_extension,
               source_type, content_hash, parser_name, parser_version, language, title,
               content_origin, ocr_average_confidence, jurisdiction, authority,
               authority_level, effective_date, expiry_date, document_type,
               is_superseded, canonical_json, updated_at
        FROM knowledge_canonical_documents
        WHERE source_id = ?1
        ORDER BY source_id ASC, relative_path ASC
        "#
    } else {
        r#"
        SELECT document_id, source_id, absolute_path, relative_path, file_extension,
               source_type, content_hash, parser_name, parser_version, language, title,
               content_origin, ocr_average_confidence, jurisdiction, authority,
               authority_level, effective_date, expiry_date, document_type,
               is_superseded, canonical_json, updated_at
        FROM knowledge_canonical_documents
        ORDER BY source_id ASC, relative_path ASC
        "#
    };
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = if let Some(source_id) = source_id {
        stmt.query_map(params![source_id], row_to_canonical_document_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        stmt.query_map([], row_to_canonical_document_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    Ok(rows)
}

fn row_to_canonical_document_row(
    row: &rusqlite::Row<'_>,
) -> Result<CanonicalDocumentRow, rusqlite::Error> {
    Ok(CanonicalDocumentRow {
        document_id: row.get(0)?,
        source_id: row.get(1)?,
        absolute_path: row.get(2)?,
        relative_path: row.get(3)?,
        file_extension: row.get(4)?,
        source_type: row.get(5)?,
        content_hash: row.get(6)?,
        parser_name: row.get(7)?,
        parser_version: row.get(8)?,
        language: row.get(9)?,
        title: row.get(10)?,
        content_origin: row.get(11)?,
        ocr_average_confidence: row.get(12)?,
        jurisdiction: row.get(13)?,
        authority: row.get(14)?,
        authority_level: row.get(15)?,
        effective_date: row.get(16)?,
        expiry_date: row.get(17)?,
        document_type: row.get(18)?,
        is_superseded: row.get(19)?,
        canonical_json: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

pub(crate) fn replace_documents(
    state: &State<'_, AppState>,
    rows: &[CanonicalDocumentRow],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_canonical_documents", [])
        .map_err(|error| error.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO knowledge_canonical_documents (
                    document_id, source_id, absolute_path, relative_path, file_extension,
                    source_type, content_hash, parser_name, parser_version, language, title,
                    content_origin, ocr_average_confidence, jurisdiction, authority,
                    authority_level, effective_date, expiry_date, document_type,
                    is_superseded, canonical_json, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, ?9, ?10, ?11,
                    ?12, ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20, ?21,
                    ?22
                )
                "#,
            )
            .map_err(|error| error.to_string())?;
        for row in rows {
            stmt.execute(params![
                row.document_id,
                row.source_id,
                row.absolute_path,
                row.relative_path,
                row.file_extension,
                row.source_type,
                row.content_hash,
                row.parser_name,
                row.parser_version,
                row.language,
                row.title,
                row.content_origin,
                row.ocr_average_confidence,
                row.jurisdiction,
                row.authority,
                row.authority_level,
                row.effective_date,
                row.expiry_date,
                row.document_type,
                row.is_superseded,
                row.canonical_json,
                row.updated_at
            ])
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}
