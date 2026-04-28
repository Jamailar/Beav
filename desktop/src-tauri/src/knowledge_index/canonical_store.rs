use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::State;

use crate::{
    document_parse::{CanonicalDocument, PARSER_NAME, PARSER_VERSION},
    knowledge_index::{catalog_db_path, migration, schema::ensure_catalog_ready},
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
    if !migration::canonical_cache_is_current(state)? {
        return Ok(None);
    }
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

pub(crate) fn load_unchanged_cached_document(
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
            ORDER BY updated_at DESC
            LIMIT 1
            "#,
            params![absolute_path, content_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    json.map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()
}

pub(crate) fn delete_documents_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<(), String> {
    let conn = connection(state)?;
    conn.execute(
        "DELETE FROM knowledge_visual_evidence WHERE source_document_id IN (SELECT source_document_id FROM knowledge_visual_units WHERE source_id = ?1)",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM knowledge_visual_units WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM knowledge_canonical_documents WHERE source_id = ?1",
        params![source_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
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
    tx.execute("DELETE FROM knowledge_visual_evidence", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_visual_units", [])
        .map_err(|error| error.to_string())?;
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
    sync_visual_rows(&tx, rows)?;
    tx.commit().map_err(|error| error.to_string())
}

fn sync_visual_rows(conn: &Connection, rows: &[CanonicalDocumentRow]) -> Result<(), String> {
    let mut unit_stmt = conn
        .prepare(
            r#"
            INSERT OR REPLACE INTO knowledge_visual_units (
                unit_id, document_id, source_document_id, source_id, relative_path,
                absolute_path, unit_kind, page_number, page_count, mime_type,
                content_hash, rendered_image_hash, manifest_json, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
        )
        .map_err(|error| error.to_string())?;
    let mut evidence_stmt = conn
        .prepare(
            r#"
            INSERT OR REPLACE INTO knowledge_visual_evidence (
                evidence_id, unit_id, source_document_id, document_id, block_id,
                projection_id, page_number, bbox_json, label, text, updated_at
            ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .map_err(|error| error.to_string())?;
    for row in rows {
        let Ok(canonical) = serde_json::from_str::<CanonicalDocument>(&row.canonical_json) else {
            continue;
        };
        let Some(manifest) = canonical.visual_manifest.as_ref() else {
            continue;
        };
        for manifest in visual_manifest_items(manifest) {
            let Some(source) = manifest.get("source") else {
                continue;
            };
            let Some(unit_id) = source.get("unitId").and_then(Value::as_str) else {
                continue;
            };
            let source_document_id = source
                .get("sourceDocumentId")
                .and_then(Value::as_str)
                .unwrap_or(&row.document_id);
            let document_id = source
                .get("documentId")
                .and_then(Value::as_str)
                .unwrap_or(&row.document_id);
            let manifest_json =
                serde_json::to_string(manifest).unwrap_or_else(|_| "{}".to_string());
            unit_stmt
                .execute(params![
                    unit_id,
                    document_id,
                    source_document_id,
                    row.source_id,
                    source
                        .get("relativePath")
                        .and_then(Value::as_str)
                        .unwrap_or(&row.relative_path),
                    source
                        .get("absolutePath")
                        .and_then(Value::as_str)
                        .unwrap_or(&row.absolute_path),
                    source
                        .get("unitKind")
                        .and_then(Value::as_str)
                        .unwrap_or("image_file"),
                    source.get("pageNumber").and_then(Value::as_i64),
                    source.get("pageCount").and_then(Value::as_i64),
                    source.get("mimeType").and_then(Value::as_str),
                    source
                        .get("contentHash")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    source.get("renderedImageHash").and_then(Value::as_str),
                    manifest_json,
                    row.updated_at
                ])
                .map_err(|error| error.to_string())?;
            sync_visual_evidence(
                &mut evidence_stmt,
                manifest,
                unit_id,
                source_document_id,
                document_id,
                row.updated_at.as_str(),
            )?;
        }
    }
    Ok(())
}

fn visual_manifest_items(manifest: &Value) -> Vec<&Value> {
    manifest
        .get("pages")
        .and_then(Value::as_array)
        .map(|pages| pages.iter().collect())
        .unwrap_or_else(|| vec![manifest])
}

fn sync_visual_evidence(
    stmt: &mut rusqlite::Statement<'_>,
    manifest: &Value,
    unit_id: &str,
    source_document_id: &str,
    document_id: &str,
    updated_at: &str,
) -> Result<(), String> {
    let page_number = manifest
        .get("source")
        .and_then(|source| source.get("pageNumber"))
        .and_then(Value::as_i64);
    let projections = manifest
        .get("retrievalProjection")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let facts = manifest
        .get("factBlocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for fact in facts {
        let Some(fact_id) = fact.get("id").and_then(Value::as_str) else {
            continue;
        };
        let projection_id = projections.iter().find_map(|projection| {
            let ids = projection.get("evidenceIds").and_then(Value::as_array)?;
            let matched = ids.iter().any(|value| value.as_str() == Some(fact_id));
            if matched {
                projection.get("id").and_then(Value::as_str)
            } else {
                None
            }
        });
        let evidence_id = format!("{unit_id}:{fact_id}");
        let bbox_json = fact
            .get("bbox")
            .and_then(|value| serde_json::to_string(value).ok());
        let label = fact
            .get("title")
            .or_else(|| fact.get("kind"))
            .and_then(Value::as_str);
        let text = fact.get("text").and_then(Value::as_str).unwrap_or("");
        stmt.execute(params![
            evidence_id,
            unit_id,
            source_document_id,
            document_id,
            projection_id,
            page_number,
            bbox_json,
            label,
            text,
            updated_at
        ])
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
