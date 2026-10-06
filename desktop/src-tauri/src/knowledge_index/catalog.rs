use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::{
    knowledge_index::{open_catalog_connection, schema::ensure_catalog_ready, workspace_id},
    AppState,
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
    pub author_id: Option<String>,
    pub author_url: Option<String>,
    pub site_name: Option<String>,
    pub source_url: Option<String>,
    pub folder_path: Option<String>,
    pub root_path: Option<String>,
    pub cover_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub preview_text: String,
    pub scope: String,
    pub owner_type: Option<String>,
    pub owner_id: Option<String>,
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
    pub ready_for_wander: bool,
    pub wander_index_status: Option<String>,
    pub visual_search_summary: Option<String>,
    pub visual_search_path: Option<String>,
    pub visual_search_page: Option<i64>,
    pub visual_search_unit_id: Option<String>,
    pub visual_search_evidence_refs: Vec<String>,
    pub visual_search_thumbnail_path: Option<String>,
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
    open_catalog_connection(state)
}

fn decode_json_list(raw: String) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

fn preview_text(input: &str, max_chars: usize) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> Result<KnowledgeCatalogSummary, rusqlite::Error> {
    Ok(KnowledgeCatalogSummary {
        item_id: row.get("item_id")?,
        kind: row.get("kind")?,
        note_type: row.get("note_type")?,
        capture_kind: row.get("capture_kind")?,
        title: row.get("title")?,
        author: row.get("author")?,
        author_id: row.get("author_id")?,
        author_url: row.get("author_url")?,
        site_name: row.get("site_name")?,
        source_url: row.get("source_url")?,
        folder_path: row.get("folder_path")?,
        root_path: row.get("root_path")?,
        cover_url: row.get("cover_url")?,
        thumbnail_url: row.get("thumbnail_url")?,
        preview_text: row.get("preview_text")?,
        scope: row.get("scope")?,
        owner_type: row.get("owner_type")?,
        owner_id: row.get("owner_id")?,
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
        ready_for_wander: false,
        wander_index_status: None,
        visual_search_summary: None,
        visual_search_path: None,
        visual_search_page: None,
        visual_search_unit_id: None,
        visual_search_evidence_refs: Vec::new(),
        visual_search_thumbnail_path: None,
    })
}

fn attach_wander_readiness(
    conn: &Connection,
    items: &mut [KnowledgeCatalogSummary],
) -> Result<(), String> {
    let mut block_stmt = conn
        .prepare("SELECT COUNT(*) FROM knowledge_document_blocks WHERE source_id = ?1 LIMIT 1")
        .map_err(|error| error.to_string())?;
    let mut visual_stmt = conn
        .prepare(
            r#"
            SELECT DISTINCT lower(status)
            FROM knowledge_visual_units
            WHERE source_id = ?1
              AND lower(status) <> 'indexed'
            ORDER BY lower(status) ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    for item in items.iter_mut() {
        let block_count = block_stmt
            .query_row(params![item.item_id], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?;
        let incomplete_statuses = visual_stmt
            .query_map(params![item.item_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        item.ready_for_wander = true;
        item.wander_index_status = Some(if incomplete_statuses.is_empty() {
            if block_count <= 0 {
                "not_indexed".to_string()
            } else {
                "ready".to_string()
            }
        } else if incomplete_statuses
            .iter()
            .any(|status| matches!(status.as_str(), "failed" | "metadata_only"))
        {
            "failed".to_string()
        } else {
            "indexing".to_string()
        });
    }
    Ok(())
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

pub(crate) fn delete_item(state: &State<'_, AppState>, item_id: &str) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let workspace_id = workspace_id(state)?;
    tx.execute(
        "DELETE FROM knowledge_files WHERE item_id = ?1",
        params![item_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_items WHERE workspace_id = ?1 AND item_id = ?2",
        params![workspace_id, item_id],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn list_page(
    state: &State<'_, AppState>,
    cursor: Option<&str>,
    limit: usize,
    kind: Option<&str>,
    query: Option<&str>,
    sort: Option<&str>,
    _ready_for_wander_only: bool,
) -> Result<KnowledgeCatalogPage, String> {
    let conn = connection(state)?;
    let workspace_id = workspace_id(state)?;
    list_page_from_connection(
        &conn,
        &workspace_id,
        cursor,
        limit,
        kind,
        query,
        sort,
        _ready_for_wander_only,
    )
}

fn list_page_from_connection(
    conn: &Connection,
    workspace_id: &str,
    cursor: Option<&str>,
    limit: usize,
    kind: Option<&str>,
    query: Option<&str>,
    sort: Option<&str>,
    _ready_for_wander_only: bool,
) -> Result<KnowledgeCatalogPage, String> {
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
            lower(COALESCE(author_id, '')) LIKE ?3 OR
            lower(COALESCE(author_url, '')) LIKE ?3 OR
            lower(COALESCE(site_name, '')) LIKE ?3 OR
            lower(COALESCE(source_url, '')) LIKE ?3 OR
            lower(COALESCE(root_path, '')) LIKE ?3 OR
            lower(preview_text) LIKE ?3 OR
            lower(tags_json) LIKE ?3 OR
            lower(sample_files_json) LIKE ?3 OR
            EXISTS (
                SELECT 1
                FROM knowledge_document_blocks b
                WHERE b.source_id = knowledge_items.item_id
                  AND (
                    lower(b.text) LIKE ?3 OR
                    lower(b.normalized_text) LIKE ?3 OR
                    lower(COALESCE(b.title, '')) LIKE ?3 OR
                    lower(b.relative_path) LIKE ?3
                  )
            ) OR
            EXISTS (
                SELECT 1
                FROM knowledge_visual_units u
                WHERE u.source_id = knowledge_items.item_id
                  AND (
                    lower(u.relative_path) LIKE ?3 OR
                    lower(u.manifest_json) LIKE ?3
                  )
            )
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
    let mut items = stmt
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
    attach_wander_readiness(&conn, &mut items)?;
    attach_visual_search_matches(&conn, &mut items, normalized_query.as_deref())?;

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

fn attach_visual_search_matches(
    conn: &Connection,
    items: &mut [KnowledgeCatalogSummary],
    normalized_query: Option<&str>,
) -> Result<(), String> {
    let Some(query) = normalized_query else {
        return Ok(());
    };
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                b.text,
                b.relative_path,
                b.page,
                b.visual_unit_id,
                b.evidence_refs_json,
                u.unit_kind,
                u.absolute_path,
                json_extract(u.manifest_json, '$.summary.short') AS manifest_short,
                json_extract(u.manifest_json, '$.summary.title') AS manifest_title
            FROM knowledge_document_blocks b
            LEFT JOIN knowledge_visual_units u ON u.unit_id = b.visual_unit_id
            WHERE b.source_id = ?1
              AND (
                lower(b.text) LIKE ?2 OR
                lower(b.normalized_text) LIKE ?2 OR
                lower(COALESCE(b.title, '')) LIKE ?2 OR
                lower(b.relative_path) LIKE ?2
              )
            ORDER BY
                CASE WHEN b.content_origin = 'visual_llm' OR b.visual_unit_id IS NOT NULL THEN 0 ELSE 1 END,
                b.block_index ASC
            LIMIT 1
            "#,
        )
        .map_err(|error| error.to_string())?;
    for item in items.iter_mut() {
        let match_row = stmt
            .query_row(params![item.item_id, query], |row| {
                let text: String = row.get("text")?;
                let relative_path: String = row.get("relative_path")?;
                let page: Option<i64> = row.get("page")?;
                let unit_id: Option<String> = row.get("visual_unit_id")?;
                let evidence_refs_json: String = row.get("evidence_refs_json")?;
                let unit_kind: Option<String> = row.get("unit_kind")?;
                let absolute_path: Option<String> = row.get("absolute_path")?;
                let manifest_short: Option<String> = row.get("manifest_short")?;
                let manifest_title: Option<String> = row.get("manifest_title")?;
                Ok((
                    text,
                    relative_path,
                    page,
                    unit_id,
                    evidence_refs_json,
                    unit_kind,
                    absolute_path,
                    manifest_short,
                    manifest_title,
                ))
            })
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((
            text,
            relative_path,
            page,
            unit_id,
            evidence_refs_json,
            unit_kind,
            absolute_path,
            manifest_short,
            manifest_title,
        )) = match_row
        else {
            continue;
        };
        item.visual_search_summary = manifest_short
            .filter(|value| !value.trim().is_empty())
            .or_else(|| manifest_title.filter(|value| !value.trim().is_empty()))
            .or_else(|| Some(preview_text(&text, 180)));
        item.visual_search_path = Some(relative_path);
        item.visual_search_page = page;
        item.visual_search_unit_id = unit_id;
        item.visual_search_evidence_refs =
            serde_json::from_str::<Vec<String>>(&evidence_refs_json).unwrap_or_default();
        item.visual_search_thumbnail_path = if unit_kind.as_deref() == Some("image_file") {
            absolute_path
        } else {
            None
        };
        continue;
    }

    let mut unit_stmt = conn
        .prepare(
            r#"
            SELECT
                relative_path,
                page_number,
                unit_id,
                unit_kind,
                absolute_path,
                json_extract(manifest_json, '$.summary.short') AS manifest_short,
                json_extract(manifest_json, '$.summary.title') AS manifest_title
            FROM knowledge_visual_units
            WHERE source_id = ?1
              AND (
                lower(relative_path) LIKE ?2 OR
                lower(manifest_json) LIKE ?2
              )
            ORDER BY
                CASE WHEN status = 'indexed' THEN 0 ELSE 1 END,
                updated_at DESC
            LIMIT 1
            "#,
        )
        .map_err(|error| error.to_string())?;
    for item in items.iter_mut() {
        if item.visual_search_summary.is_some() {
            continue;
        }
        let match_row = unit_stmt
            .query_row(params![item.item_id, query], |row| {
                let relative_path: String = row.get("relative_path")?;
                let page: Option<i64> = row.get("page_number")?;
                let unit_id: Option<String> = row.get("unit_id")?;
                let unit_kind: Option<String> = row.get("unit_kind")?;
                let absolute_path: Option<String> = row.get("absolute_path")?;
                let manifest_short: Option<String> = row.get("manifest_short")?;
                let manifest_title: Option<String> = row.get("manifest_title")?;
                Ok((
                    relative_path,
                    page,
                    unit_id,
                    unit_kind,
                    absolute_path,
                    manifest_short,
                    manifest_title,
                ))
            })
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((
            relative_path,
            page,
            unit_id,
            unit_kind,
            absolute_path,
            manifest_short,
            manifest_title,
        )) = match_row
        else {
            continue;
        };
        item.visual_search_summary = manifest_short
            .filter(|value| !value.trim().is_empty())
            .or_else(|| manifest_title.filter(|value| !value.trim().is_empty()));
        item.visual_search_path = Some(relative_path);
        item.visual_search_page = page;
        item.visual_search_unit_id = unit_id;
        item.visual_search_evidence_refs = Vec::new();
        item.visual_search_thumbnail_path = if unit_kind.as_deref() == Some("image_file") {
            absolute_path
        } else {
            None
        };
    }
    Ok(())
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
                item_id, workspace_id, kind, note_type, capture_kind, title, author, author_id, author_url, site_name,
                source_url, folder_path, root_path, cover_url, thumbnail_url, preview_text,
                scope, owner_type, owner_id, created_at, updated_at, language, has_video, has_transcript, tags_json, status,
                item_hash, indexed_at, sample_files_json, file_count
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21,
                ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30
            )
            ON CONFLICT(item_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                kind = excluded.kind,
                note_type = excluded.note_type,
                capture_kind = excluded.capture_kind,
                title = excluded.title,
                author = excluded.author,
                author_id = excluded.author_id,
                author_url = excluded.author_url,
                site_name = excluded.site_name,
                source_url = excluded.source_url,
                folder_path = excluded.folder_path,
                root_path = excluded.root_path,
                cover_url = excluded.cover_url,
                thumbnail_url = excluded.thumbnail_url,
                preview_text = excluded.preview_text,
                scope = excluded.scope,
                owner_type = excluded.owner_type,
                owner_id = excluded.owner_id,
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
                item.author_id,
                item.author_url,
                item.site_name,
                item.source_url,
                item.folder_path,
                item.root_path,
                item.cover_url,
                item.thumbnail_url,
                item.preview_text,
                item.scope,
                item.owner_type,
                item.owner_id,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_readiness_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute(
            "CREATE TABLE knowledge_document_blocks (source_id TEXT NOT NULL)",
            [],
        )
        .expect("create blocks");
        conn.execute(
            "CREATE TABLE knowledge_visual_units (source_id TEXT NOT NULL, status TEXT NOT NULL)",
            [],
        )
        .expect("create visual units");
        conn
    }

    fn setup_list_page_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE knowledge_items (
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
            CREATE TABLE knowledge_document_blocks (
                source_id TEXT NOT NULL,
                text TEXT NOT NULL DEFAULT '',
                normalized_text TEXT NOT NULL DEFAULT '',
                title TEXT,
                relative_path TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE knowledge_visual_units (
                source_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '',
                relative_path TEXT NOT NULL DEFAULT '',
                manifest_json TEXT NOT NULL DEFAULT '{}'
            );
            "#,
        )
        .expect("create list page tables");
        for (item_id, title, updated_at) in [
            ("note-a", "Recent note", "2026-05-16T12:00:00Z"),
            ("note-b", "Older note", "2026-05-15T12:00:00Z"),
        ] {
            conn.execute(
                r#"
                INSERT INTO knowledge_items (
                    item_id, workspace_id, kind, title, author, preview_text, scope,
                    created_at, updated_at, tags_json, item_hash, indexed_at,
                    sample_files_json, file_count
                )
                VALUES (?1, 'default', 'redbook-note', ?2, '', '', 'workspace-shared',
                    ?3, ?3, '[]', ?1, ?3, '[]', 0)
                "#,
                params![item_id, title, updated_at],
            )
            .expect("insert item");
        }
        conn
    }

    fn summary(item_id: &str) -> KnowledgeCatalogSummary {
        KnowledgeCatalogSummary {
            item_id: item_id.to_string(),
            kind: "redbook-note".to_string(),
            note_type: None,
            capture_kind: None,
            title: item_id.to_string(),
            author: String::new(),
            author_id: None,
            author_url: None,
            site_name: None,
            source_url: None,
            folder_path: None,
            root_path: None,
            cover_url: None,
            thumbnail_url: None,
            preview_text: String::new(),
            scope: "workspace-shared".to_string(),
            owner_type: None,
            owner_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            language: None,
            has_video: false,
            has_transcript: false,
            tags: Vec::new(),
            status: None,
            sample_files: Vec::new(),
            file_count: 0,
            item_hash: String::new(),
            ready_for_wander: false,
            wander_index_status: None,
            visual_search_summary: None,
            visual_search_path: None,
            visual_search_page: None,
            visual_search_unit_id: None,
            visual_search_evidence_refs: Vec::new(),
            visual_search_thumbnail_path: None,
        }
    }

    #[test]
    fn list_page_uses_limit_and_offset_params_after_wander_filter() {
        let conn = setup_list_page_conn();

        let first_page =
            list_page_from_connection(&conn, "default", None, 1, None, None, None, false)
                .expect("list first page");

        assert_eq!(first_page.total, 2);
        assert_eq!(first_page.items.len(), 1);
        assert_eq!(first_page.items[0].item_id, "note-a");
        assert_eq!(first_page.next_cursor.as_deref(), Some("1"));

        let second_page =
            list_page_from_connection(&conn, "default", Some("1"), 1, None, None, None, false)
                .expect("list second page");

        assert_eq!(second_page.items.len(), 1);
        assert_eq!(second_page.items[0].item_id, "note-b");
        assert_eq!(second_page.next_cursor, None);
    }

    #[test]
    fn wander_readiness_allows_items_without_indexed_blocks() {
        let conn = setup_readiness_conn();
        let mut items = vec![summary("note-a")];

        attach_wander_readiness(&conn, &mut items).expect("attach readiness");

        assert!(items[0].ready_for_wander);
        assert_eq!(items[0].wander_index_status.as_deref(), Some("not_indexed"));
    }

    #[test]
    fn wander_readiness_allows_text_blocks_without_visual_units() {
        let conn = setup_readiness_conn();
        conn.execute(
            "INSERT INTO knowledge_document_blocks (source_id) VALUES ('note-a')",
            [],
        )
        .expect("insert block");
        let mut items = vec![summary("note-a")];

        attach_wander_readiness(&conn, &mut items).expect("attach readiness");

        assert!(items[0].ready_for_wander);
        assert_eq!(items[0].wander_index_status.as_deref(), Some("ready"));
    }

    #[test]
    fn wander_readiness_reports_failed_or_metadata_only_visual_units_without_blocking() {
        let conn = setup_readiness_conn();
        conn.execute(
            "INSERT INTO knowledge_document_blocks (source_id) VALUES ('note-a'), ('note-b')",
            [],
        )
        .expect("insert blocks");
        conn.execute(
            "INSERT INTO knowledge_visual_units (source_id, status) VALUES ('note-a', 'failed'), ('note-b', 'metadata_only')",
            [],
        )
        .expect("insert visual units");
        let mut items = vec![summary("note-a"), summary("note-b")];

        attach_wander_readiness(&conn, &mut items).expect("attach readiness");

        assert!(items[0].ready_for_wander);
        assert!(items[1].ready_for_wander);
        assert_eq!(items[0].wander_index_status.as_deref(), Some("failed"));
        assert_eq!(items[1].wander_index_status.as_deref(), Some("failed"));
    }

    #[test]
    fn wander_readiness_allows_indexed_visual_units() {
        let conn = setup_readiness_conn();
        conn.execute(
            "INSERT INTO knowledge_document_blocks (source_id) VALUES ('note-a')",
            [],
        )
        .expect("insert block");
        conn.execute(
            "INSERT INTO knowledge_visual_units (source_id, status) VALUES ('note-a', 'indexed')",
            [],
        )
        .expect("insert visual unit");
        let mut items = vec![summary("note-a")];

        attach_wander_readiness(&conn, &mut items).expect("attach readiness");

        assert!(items[0].ready_for_wander);
        assert_eq!(items[0].wander_index_status.as_deref(), Some("ready"));
    }
}
