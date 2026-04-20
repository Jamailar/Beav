use std::fs;

use rusqlite::Connection;
use tauri::State;

use crate::{knowledge_index::catalog_db_path, AppState};

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
    Ok(())
}
