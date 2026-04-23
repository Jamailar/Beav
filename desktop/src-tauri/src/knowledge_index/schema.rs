use std::fs;

use rusqlite::Connection;
use tauri::State;

use crate::{knowledge_index::catalog_db_path, AppState};

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|item| item == column))
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if has_column(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn ensure_catalog_ready(state: &State<'_, AppState>) -> Result<(), String> {
    let db_path = catalog_db_path(state)?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(&db_path).map_err(|error| error.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS knowledge_items (
            item_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            note_type TEXT,
            capture_kind TEXT,
            title TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            site_name TEXT,
            source_url TEXT,
            folder_path TEXT,
            root_path TEXT,
            cover_url TEXT,
            thumbnail_url TEXT,
            preview_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            language TEXT,
            has_video INTEGER NOT NULL DEFAULT 0,
            has_transcript INTEGER NOT NULL DEFAULT 0,
            tags_json TEXT NOT NULL DEFAULT '[]',
            status TEXT,
            item_hash TEXT NOT NULL DEFAULT '',
            indexed_at TEXT NOT NULL DEFAULT '',
            sample_files_json TEXT NOT NULL DEFAULT '[]',
            file_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_items_kind_updated
            ON knowledge_items(kind, updated_at DESC, item_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_items_workspace_updated
            ON knowledge_items(workspace_id, updated_at DESC, item_id);
        CREATE TABLE IF NOT EXISTS knowledge_files (
            file_path TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            mtime_ms INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            role TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_files_item_id
            ON knowledge_files(item_id);
        CREATE TABLE IF NOT EXISTS knowledge_document_blocks (
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
            block_index INTEGER NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            text TEXT NOT NULL,
            normalized_text TEXT NOT NULL,
            semantic_vector_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_document_blocks_source_path
            ON knowledge_document_blocks(source_id, relative_path, block_index);
        CREATE INDEX IF NOT EXISTS idx_knowledge_document_blocks_document
            ON knowledge_document_blocks(document_id, block_index);
        CREATE TABLE IF NOT EXISTS knowledge_citation_anchors (
            anchor_id TEXT PRIMARY KEY,
            block_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_name TEXT NOT NULL DEFAULT '',
            root_path TEXT NOT NULL,
            absolute_path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            file_extension TEXT,
            title TEXT,
            language TEXT,
            page INTEGER,
            block_type TEXT NOT NULL DEFAULT '',
            section_path_json TEXT NOT NULL DEFAULT '[]',
            char_start INTEGER NOT NULL,
            char_end INTEGER NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            quote_text TEXT NOT NULL,
            normalized_quote_text TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_citation_anchors_block
            ON knowledge_citation_anchors(block_id, char_start);
        CREATE INDEX IF NOT EXISTS idx_knowledge_citation_anchors_source
            ON knowledge_citation_anchors(source_id, relative_path, page, char_start);
        CREATE TABLE IF NOT EXISTS knowledge_canonical_documents (
            document_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            absolute_path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            file_extension TEXT,
            source_type TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            parser_name TEXT NOT NULL,
            parser_version TEXT NOT NULL,
            language TEXT,
            title TEXT,
            content_origin TEXT NOT NULL DEFAULT 'native',
            ocr_average_confidence REAL,
            jurisdiction TEXT,
            authority TEXT,
            authority_level INTEGER,
            effective_date TEXT,
            expiry_date TEXT,
            document_type TEXT,
            is_superseded INTEGER NOT NULL DEFAULT 0,
            canonical_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_canonical_documents_source_path
            ON knowledge_canonical_documents(source_id, relative_path);
        CREATE INDEX IF NOT EXISTS idx_knowledge_canonical_documents_path_hash
            ON knowledge_canonical_documents(absolute_path, content_hash);
        CREATE TABLE IF NOT EXISTS knowledge_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_index_errors (
            path TEXT PRIMARY KEY,
            message TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .map_err(|error| error.to_string())?;
    ensure_column(&conn, "knowledge_document_blocks", "page", "INTEGER")?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "block_type",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "section_path_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "semantic_vector_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "content_origin",
        "TEXT NOT NULL DEFAULT 'native'",
    )?;
    ensure_column(&conn, "knowledge_document_blocks", "ocr_confidence", "REAL")?;
    ensure_column(&conn, "knowledge_document_blocks", "jurisdiction", "TEXT")?;
    ensure_column(&conn, "knowledge_document_blocks", "authority", "TEXT")?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "authority_level",
        "INTEGER",
    )?;
    ensure_column(&conn, "knowledge_document_blocks", "effective_date", "TEXT")?;
    ensure_column(&conn, "knowledge_document_blocks", "expiry_date", "TEXT")?;
    ensure_column(&conn, "knowledge_document_blocks", "document_type", "TEXT")?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "is_superseded",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "content_origin",
        "TEXT NOT NULL DEFAULT 'native'",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "ocr_average_confidence",
        "REAL",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "jurisdiction",
        "TEXT",
    )?;
    ensure_column(&conn, "knowledge_canonical_documents", "authority", "TEXT")?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "authority_level",
        "INTEGER",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "effective_date",
        "TEXT",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "expiry_date",
        "TEXT",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "document_type",
        "TEXT",
    )?;
    ensure_column(
        &conn,
        "knowledge_canonical_documents",
        "is_superseded",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}
