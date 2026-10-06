use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;
use tauri::State;

use crate::{workspace_root, AppState};

fn brand_workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?
        .join("assets")
        .join("brand-workspace");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn brand_workspace_db_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(brand_workspace_root(state)?.join("brand-workspace.sqlite"))
}

pub(super) fn brand_workspace_ai_index_root(
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let root = brand_workspace_root(state)?.join("ai-index");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(super) fn brand_workspace_asset_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = brand_workspace_root(state)?.join("media");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

pub(super) fn open_connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    let path = brand_workspace_db_path(state)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS brand_records (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_refs (
            id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            path TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_refs_owner
            ON asset_refs(owner_type, owner_id, role, id);
        CREATE TABLE IF NOT EXISTS product_records (
            id TEXT PRIMARY KEY,
            brand_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(brand_id) REFERENCES brand_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_products_brand_id
            ON product_records(brand_id, updated_at DESC, id);
        CREATE TABLE IF NOT EXISTS product_skus (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            name TEXT NOT NULL,
            variant_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(product_id) REFERENCES product_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_skus_product_id
            ON product_skus(product_id, updated_at DESC, id);
        CREATE TABLE IF NOT EXISTS product_detail_pages (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            market TEXT NOT NULL DEFAULT '',
            locale TEXT NOT NULL DEFAULT '',
            title TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(product_id, platform, market, locale),
            FOREIGN KEY(product_id) REFERENCES product_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_detail_pages_product_platform
            ON product_detail_pages(product_id, platform, market, locale);
        "#,
    )
    .map_err(|error| error.to_string())?;
    ensure_column(
        &conn,
        "product_skus",
        "variant_text",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(conn)
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if columns.iter().any(|item| item == column) {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
