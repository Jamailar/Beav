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
            author_id TEXT,
            author_url TEXT,
            site_name TEXT,
            source_url TEXT,
            folder_path TEXT,
            root_path TEXT,
            cover_url TEXT,
            thumbnail_url TEXT,
            preview_text TEXT NOT NULL DEFAULT '',
            scope TEXT NOT NULL DEFAULT 'workspace-shared',
            owner_type TEXT,
            owner_id TEXT,
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
            visual_unit_id TEXT,
            source_document_id TEXT,
            evidence_refs_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_document_blocks_source_path
            ON knowledge_document_blocks(source_id, relative_path, block_index);
        CREATE INDEX IF NOT EXISTS idx_knowledge_document_blocks_document
            ON knowledge_document_blocks(document_id, block_index);
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_document_blocks_fts USING fts5(
            block_id UNINDEXED,
            source_id UNINDEXED,
            title,
            text,
            normalized_text,
            relative_path,
            tokenize='unicode61'
        );
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
        CREATE TABLE IF NOT EXISTS knowledge_retrieval_runs (
            run_id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            source_name TEXT,
            query TEXT NOT NULL,
            search_mode TEXT NOT NULL,
            query_profile_json TEXT NOT NULL,
            query_plan_json TEXT NOT NULL,
            evidence_pack_json TEXT NOT NULL,
            total_hits INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_runs_source_created
            ON knowledge_retrieval_runs(source_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS knowledge_retrieval_hits (
            run_id TEXT NOT NULL,
            rank INTEGER NOT NULL,
            block_id TEXT,
            document_id TEXT,
            anchor_ids_json TEXT NOT NULL DEFAULT '[]',
            source_path TEXT,
            page INTEGER,
            snippet TEXT NOT NULL DEFAULT '',
            ranking_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, rank)
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_hits_block
            ON knowledge_retrieval_hits(block_id);
        CREATE TABLE IF NOT EXISTS knowledge_index_errors (
            path TEXT PRIMARY KEY,
            message TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_visual_units (
            unit_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            source_document_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            absolute_path TEXT NOT NULL,
            unit_kind TEXT NOT NULL,
            page_number INTEGER,
            page_count INTEGER,
            mime_type TEXT,
            content_hash TEXT NOT NULL DEFAULT '',
            rendered_image_hash TEXT,
            manifest_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'indexed',
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            next_retry_at TEXT,
            schema_version TEXT,
            provider TEXT,
            model TEXT,
            prompt_version TEXT,
            config_signature TEXT,
            payload_policy_version TEXT,
            indexed_at TEXT,
            last_attempted_at TEXT,
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_visual_units_source
            ON knowledge_visual_units(source_id, source_document_id, page_number);
        CREATE INDEX IF NOT EXISTS idx_knowledge_visual_units_status
            ON knowledge_visual_units(status, next_retry_at);
        CREATE TABLE IF NOT EXISTS knowledge_visual_evidence (
            evidence_id TEXT PRIMARY KEY,
            unit_id TEXT NOT NULL,
            source_document_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            block_id TEXT,
            projection_id TEXT,
            page_number INTEGER,
            bbox_json TEXT,
            label TEXT,
            text TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_visual_evidence_unit
            ON knowledge_visual_evidence(unit_id, page_number);
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
    ensure_column(&conn, "knowledge_document_blocks", "visual_unit_id", "TEXT")?;
    ensure_column(
        &conn,
        "knowledge_visual_units",
        "status",
        "TEXT NOT NULL DEFAULT 'indexed'",
    )?;
    ensure_column(
        &conn,
        "knowledge_visual_units",
        "retry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&conn, "knowledge_visual_units", "last_error", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "next_retry_at", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "schema_version", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "provider", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "model", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "prompt_version", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "config_signature", "TEXT")?;
    ensure_column(
        &conn,
        "knowledge_visual_units",
        "payload_policy_version",
        "TEXT",
    )?;
    ensure_column(&conn, "knowledge_visual_units", "indexed_at", "TEXT")?;
    ensure_column(&conn, "knowledge_visual_units", "last_attempted_at", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_visual_units_status ON knowledge_visual_units(status, next_retry_at)",
        [],
    )
    .map_err(|error| error.to_string())?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "source_document_id",
        "TEXT",
    )?;
    ensure_column(
        &conn,
        "knowledge_document_blocks",
        "evidence_refs_json",
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
        "knowledge_items",
        "scope",
        "TEXT NOT NULL DEFAULT 'workspace-shared'",
    )?;
    ensure_column(&conn, "knowledge_items", "owner_type", "TEXT")?;
    ensure_column(&conn, "knowledge_items", "owner_id", "TEXT")?;
    ensure_column(&conn, "knowledge_items", "author_id", "TEXT")?;
    ensure_column(&conn, "knowledge_items", "author_url", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_items_owner_scope ON knowledge_items(workspace_id, scope, owner_type, owner_id, updated_at DESC)",
        [],
    )
    .map_err(|error| error.to_string())?;
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
