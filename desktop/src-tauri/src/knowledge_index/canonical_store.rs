use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::{
    document_parse::CanonicalDocument,
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
            WHERE absolute_path = ?1 AND content_hash = ?2
            "#,
            params![absolute_path, content_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    json.map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
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
                    jurisdiction, authority, authority_level, effective_date, expiry_date,
                    document_type, is_superseded, canonical_json, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, ?9, ?10, ?11,
                    ?12, ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20
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
