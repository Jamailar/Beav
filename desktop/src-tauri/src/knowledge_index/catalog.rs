use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;

use crate::{
    AppState,
    knowledge_index::{catalog_db_path, schema::ensure_catalog_ready, workspace_id},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCatalogSummary {
    pub item_id: String,
    pub kind: String,
    pub note_type: Option<String>,
    pub capture_kind: Option<String>,
    pub title: String,
    pub author: String,
    pub site_name: Option<String>,
    pub source_url: Option<String>,
    pub folder_path: Option<String>,
    pub root_path: Option<String>,
    pub cover_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub preview_text: String,
    pub created_at: String,
    pub updated_at: String,
    pub language: Option<String>,
    pub has_video: bool,
    pub has_transcript: bool,
    pub tags: Vec<String>,
    pub status: Option<String>,
    pub sample_files: Vec<String>,
    pub file_count: i64,
    pub item_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCatalogPage {
    pub items: Vec<KnowledgeCatalogSummary>,
    pub next_cursor: Option<String>,
    pub total: i64,
    pub kind_counts: Value,
}

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    Connection::open(catalog_db_path(state)?).map_err(|error| error.to_string())
}

fn decode_json_list(raw: String) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> Result<KnowledgeCatalogSummary, rusqlite::Error> {
    Ok(KnowledgeCatalogSummary {
        item_id: row.get("item_id")?,
        kind: row.get("kind")?,
        note_type: row.get("note_type")?,
        capture_kind: row.get("capture_kind")?,
        title: row.get("title")?,
        author: row.get("author")?,
        site_name: row.get("site_name")?,
        source_url: row.get("source_url")?,
        folder_path: row.get("folder_path")?,
        root_path: row.get("root_path")?,
        cover_url: row.get("cover_url")?,
        thumbnail_url: row.get("thumbnail_url")?,
        preview_text: row.get("preview_text")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        language: row.get("language")?,
        has_video: row.get::<_, i64>("has_video")? != 0,
        has_transcript: row.get::<_, i64>("has_transcript")? != 0,
        tags: decode_json_list(row.get("tags_json")?),
        status: row.get("status")?,
        sample_files: decode_json_list(row.get("sample_files_json")?),
        file_count: row.get("file_count")?,
        item_hash: row.get("item_hash")?,
    })
}

pub(crate) fn count_items(state: &State<'_, AppState>) -> Result<i64, String> {
    let conn = connection(state)?;
    let workspace_id = workspace_id(state)?;
    conn.query_row(
        "SELECT COUNT(*) FROM knowledge_items WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn list_page(
    state: &State<'_, AppState>,
    cursor: Option<&str>,
    limit: usize,
    kind: Option<&str>,
    query: Option<&str>,
    sort: Option<&str>,
) -> Result<KnowledgeCatalogPage, String> {
    let conn = connection(state)?;
    let workspace_id = workspace_id(state)?;
    let limit = limit.clamp(1, 200) as i64;
    let offset = cursor
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);
    let normalized_query = query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", value.to_lowercase()));
    let normalized_kind = kind
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all");
    let order_by = match sort.unwrap_or("updated-desc") {
        "created-desc" => "created_at DESC, item_id DESC",
        "title-asc" => "title COLLATE NOCASE ASC, item_id ASC",
        _ => "updated_at DESC, item_id DESC",
    };

    let where_sql = r#"
        workspace_id = ?1
        AND (?2 IS NULL OR kind = ?2)
        AND (
            ?3 IS NULL OR
            lower(title) LIKE ?3 OR
            lower(author) LIKE ?3 OR
            lower(COALESCE(site_name, '')) LIKE ?3 OR
            lower(COALESCE(source_url, '')) LIKE ?3 OR
            lower(COALESCE(root_path, '')) LIKE ?3 OR
            lower(preview_text) LIKE ?3 OR
            lower(tags_json) LIKE ?3 OR
            lower(sample_files_json) LIKE ?3
        )
    "#;

    let total = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM knowledge_items WHERE {where_sql}"),
            params![workspace_id, normalized_kind, normalized_query],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT * FROM knowledge_items WHERE {where_sql} ORDER BY {order_by} LIMIT ?4 OFFSET ?5"
        ))
        .map_err(|error| error.to_string())?;
    let items = stmt
        .query_map(
            params![
                workspace_id,
                normalized_kind,
                normalized_query,
                limit,
                offset
            ],
            row_to_summary,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut kind_stmt = conn
        .prepare(
            r#"
            SELECT kind, COUNT(*) AS count
            FROM knowledge_items
            WHERE workspace_id = ?1
            GROUP BY kind
            "#,
        )
        .map_err(|error| error.to_string())?;
    let kind_rows = kind_stmt
        .query_map(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut kind_counts = serde_json::Map::new();
    for (kind_name, count) in kind_rows {
        kind_counts.insert(kind_name, json!(count));
    }

    let next_cursor = if offset + items.len() as i64 >= total {
        None
    } else {
        Some((offset + items.len() as i64).to_string())
    };

    Ok(KnowledgeCatalogPage {
        items,
        next_cursor,
        total,
        kind_counts: Value::Object(kind_counts),
    })
}

pub(crate) fn upsert_summaries(
    state: &State<'_, AppState>,
    items: &[KnowledgeCatalogSummary],
    files: &[(String, String, i64, i64, String, String)],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let workspace_id = workspace_id(state)?;
    for item in items {
        tx.execute(
            r#"
            INSERT INTO knowledge_items (
                item_id, workspace_id, kind, note_type, capture_kind, title, author, site_name,
                source_url, folder_path, root_path, cover_url, thumbnail_url, preview_text,
                created_at, updated_at, language, has_video, has_transcript, tags_json, status,
                item_hash, indexed_at, sample_files_json, file_count
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                ?22, ?23, ?24, ?25
            )
            ON CONFLICT(item_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                kind = excluded.kind,
                note_type = excluded.note_type,
                capture_kind = excluded.capture_kind,
                title = excluded.title,
                author = excluded.author,
                site_name = excluded.site_name,
                source_url = excluded.source_url,
                folder_path = excluded.folder_path,
                root_path = excluded.root_path,
                cover_url = excluded.cover_url,
                thumbnail_url = excluded.thumbnail_url,
                preview_text = excluded.preview_text,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                language = excluded.language,
                has_video = excluded.has_video,
                has_transcript = excluded.has_transcript,
                tags_json = excluded.tags_json,
                status = excluded.status,
                item_hash = excluded.item_hash,
                indexed_at = excluded.indexed_at,
                sample_files_json = excluded.sample_files_json,
                file_count = excluded.file_count
            "#,
            params![
                item.item_id,
                workspace_id,
                item.kind,
                item.note_type,
                item.capture_kind,
                item.title,
                item.author,
                item.site_name,
                item.source_url,
                item.folder_path,
                item.root_path,
                item.cover_url,
                item.thumbnail_url,
                item.preview_text,
                item.created_at,
                item.updated_at,
                item.language,
                item.has_video as i64,
                item.has_transcript as i64,
                serde_json::to_string(&item.tags).unwrap_or_else(|_| "[]".to_string()),
                item.status,
                item.item_hash,
                crate::now_iso(),
                serde_json::to_string(&item.sample_files).unwrap_or_else(|_| "[]".to_string()),
                item.file_count
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.execute("DELETE FROM knowledge_files", [])
        .map_err(|error| error.to_string())?;
    for (file_path, item_id, size_bytes, mtime_ms, content_hash, role) in files {
        tx.execute(
            r#"
            INSERT INTO knowledge_files (file_path, item_id, size_bytes, mtime_ms, content_hash, role)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(file_path) DO UPDATE SET
                item_id = excluded.item_id,
                size_bytes = excluded.size_bytes,
                mtime_ms = excluded.mtime_ms,
                content_hash = excluded.content_hash,
                role = excluded.role
            "#,
            params![file_path, item_id, size_bytes, mtime_ms, content_hash, role],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.execute(
        "DELETE FROM knowledge_items WHERE workspace_id = ?1 AND item_id NOT IN (SELECT item_id FROM knowledge_files)",
        params![workspace_id],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn replace_catalog(
    state: &State<'_, AppState>,
    items: &[KnowledgeCatalogSummary],
    files: &[(String, String, i64, i64, String, String)],
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let workspace_id = workspace_id(state)?;
    tx.execute(
        "DELETE FROM knowledge_items WHERE workspace_id = ?1",
        params![workspace_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM knowledge_files", [])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    drop(conn);
    upsert_summaries(state, items, files)
}
