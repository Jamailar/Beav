use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri::State;

use super::store::{memory_root, search_memory_records};
use super::types::MemoryRecallItem;
use crate::persistence::with_store;
use crate::{truncate_chars, AppState, UserMemoryRecord};

const MEMORY_INDEX_SCHEMA_VERSION: &str = "memory-index-v1";

#[derive(Debug, Clone, Default)]
pub(crate) struct MemorySearchOptions {
    pub query: String,
    pub limit: usize,
    pub include_archived: bool,
    pub scopes: Vec<String>,
    pub memory_types: Vec<String>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct MemoryIndexHit {
    pub id: String,
    pub score: f64,
    pub bm25_score: f64,
    pub retrieval_lanes: Vec<String>,
}

fn memory_index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(memory_root(state)?.join("index.sqlite"))
}

fn open_memory_index(state: &State<'_, AppState>) -> Result<Connection, String> {
    let path = memory_index_path(state)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    ensure_memory_index_schema(&conn)?;
    Ok(conn)
}

fn ensure_memory_index_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS memory_records_index (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            memory_type TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'user',
            space_id TEXT,
            project_id TEXT,
            session_id TEXT,
            source_json TEXT NOT NULL DEFAULT '{}',
            entities_json TEXT NOT NULL DEFAULT '[]',
            confidence REAL NOT NULL DEFAULT 0.75,
            tags_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts USING fts5(
            id UNINDEXED,
            content,
            memory_type,
            tags,
            search_text,
            tokenize='unicode61'
        );
        CREATE TABLE IF NOT EXISTS memory_index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|error| error.to_string())?;
    ensure_column(
        conn,
        "memory_records_index",
        "scope",
        "TEXT NOT NULL DEFAULT 'user'",
    )?;
    ensure_column(conn, "memory_records_index", "space_id", "TEXT")?;
    ensure_column(conn, "memory_records_index", "project_id", "TEXT")?;
    ensure_column(conn, "memory_records_index", "session_id", "TEXT")?;
    ensure_column(
        conn,
        "memory_records_index",
        "source_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    ensure_column(
        conn,
        "memory_records_index",
        "entities_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        conn,
        "memory_records_index",
        "confidence",
        "REAL NOT NULL DEFAULT 0.75",
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO memory_index_meta (key, value) VALUES ('schemaVersion', ?1)",
        params![MEMORY_INDEX_SCHEMA_VERSION],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

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

pub(crate) fn rebuild_memory_index(
    state: &State<'_, AppState>,
    memories: &[UserMemoryRecord],
) -> Result<(), String> {
    let mut conn = open_memory_index(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM memory_records_index", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM memory_records_fts", [])
        .map_err(|error| error.to_string())?;
    for item in memories.iter() {
        insert_memory_record(&tx, item)?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO memory_index_meta (key, value) VALUES ('snapshotFingerprint', ?1)",
        params![memory_snapshot_fingerprint(memories)],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn rebuild_memory_index_from_store(state: &State<'_, AppState>) -> Result<(), String> {
    let memories = with_store(state, |store| Ok(store.memories.clone()))?;
    rebuild_memory_index(state, &memories)
}

pub(crate) fn memory_index_diagnostics(state: &State<'_, AppState>) -> Result<Value, String> {
    let memories = with_store(state, |store| Ok(store.memories.clone()))?;
    let path = memory_index_path(state)?;
    let exists = path.exists();
    let conn = open_memory_index(state)?;
    let indexed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_records_index", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let schema_version = conn
        .query_row(
            "SELECT value FROM memory_index_meta WHERE key = 'schemaVersion'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let indexed_fingerprint = conn
        .query_row(
            "SELECT value FROM memory_index_meta WHERE key = 'snapshotFingerprint'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let snapshot_fingerprint = memory_snapshot_fingerprint(&memories);
    Ok(json!({
        "path": path.display().to_string(),
        "exists": exists,
        "schemaVersion": schema_version,
        "expectedSchemaVersion": MEMORY_INDEX_SCHEMA_VERSION,
        "indexedCount": indexed_count,
        "memoryCount": memories.len(),
        "activeCount": memories
            .iter()
            .filter(|item| item.status.as_deref().unwrap_or("active") == "active")
            .count(),
        "fingerprintMatches": indexed_fingerprint == snapshot_fingerprint,
        "retrievalEngine": "sqlite-fts5-bm25"
    }))
}

pub(crate) fn search_memory_records_indexed(
    state: &State<'_, AppState>,
    options: &MemorySearchOptions,
) -> Result<Vec<Value>, String> {
    let memories = with_store(state, |store| Ok(store.memories.clone()))?;
    ensure_index_matches_snapshot(state, &memories)?;
    let hits = search_memory_index_hits(state, options)?;
    if hits.is_empty() {
        let mut fallback = search_memory_records(
            &crate::AppStore {
                memories,
                ..crate::AppStore::default()
            },
            &options.query,
        );
        fallback.retain(|value| value_matches_options(value, options));
        fallback.truncate(options.limit.max(1));
        return Ok(fallback);
    }
    Ok(values_from_hits(&memories, &hits))
}

pub(crate) fn recall_memory_matches_indexed(
    state: &State<'_, AppState>,
    options: &MemorySearchOptions,
) -> Result<Vec<MemoryRecallItem>, String> {
    let memories = with_store(state, |store| Ok(store.memories.clone()))?;
    ensure_index_matches_snapshot(state, &memories)?;
    let hits = search_memory_index_hits(state, options)?;
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    Ok(hits
        .into_iter()
        .filter_map(|hit| {
            memories
                .iter()
                .find(|item| item.id == hit.id)
                .filter(|item| memory_matches_options(item, options))
                .map(|item| MemoryRecallItem {
                    id: item.id.clone(),
                    memory_type: item.r#type.clone(),
                    content_preview: truncate_chars(item.content.trim(), 180),
                    score: hit.score,
                    match_reasons: vec!["bm25".to_string()],
                    tags: item.tags.clone(),
                    updated_at: item.updated_at.unwrap_or(item.created_at),
                })
        })
        .collect())
}

fn ensure_index_matches_snapshot(
    state: &State<'_, AppState>,
    memories: &[UserMemoryRecord],
) -> Result<(), String> {
    let conn = open_memory_index(state)?;
    let indexed_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_records_index", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let indexed_fingerprint = conn
        .query_row(
            "SELECT value FROM memory_index_meta WHERE key = 'snapshotFingerprint'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    if indexed_count != memories.len() as i64
        || indexed_fingerprint != memory_snapshot_fingerprint(memories)
    {
        drop(conn);
        rebuild_memory_index(state, memories)?;
    }
    Ok(())
}

fn memory_snapshot_fingerprint(memories: &[UserMemoryRecord]) -> String {
    let mut items = memories
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
                item.id,
                item.status.as_deref().unwrap_or("active"),
                item.updated_at.unwrap_or(item.created_at),
                item.revision.unwrap_or(0),
                item.content,
                item.scope.as_deref().unwrap_or("user"),
                item.space_id.as_deref().unwrap_or_default(),
                item.project_id.as_deref().unwrap_or_default(),
                item.session_id.as_deref().unwrap_or_default(),
                item.tags.join(","),
                item.entities.join(",")
            )
        })
        .collect::<Vec<_>>();
    items.sort();
    let mut hasher = DefaultHasher::new();
    items.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn insert_memory_record(conn: &Connection, item: &UserMemoryRecord) -> Result<(), String> {
    let tags_text = item.tags.join(" ");
    let entities_text = item.entities.join(" ");
    let searchable = searchable_text(item);
    conn.execute(
        r#"
        INSERT OR REPLACE INTO memory_records_index (
            id, content, memory_type, scope, space_id, project_id, session_id,
            source_json, entities_json, confidence, tags_json, status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#,
        params![
            item.id,
            item.content,
            item.r#type,
            item.scope.as_deref().unwrap_or("user"),
            item.space_id.as_deref(),
            item.project_id.as_deref(),
            item.session_id.as_deref(),
            item.source
                .as_ref()
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "legacy" }))
                .to_string(),
            serde_json::to_string(&item.entities).unwrap_or_else(|_| "[]".to_string()),
            item.confidence.unwrap_or(0.75),
            serde_json::to_string(&item.tags).unwrap_or_else(|_| "[]".to_string()),
            item.status.as_deref().unwrap_or("active"),
            item.created_at,
            item.updated_at.unwrap_or(item.created_at)
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        INSERT INTO memory_records_fts (
            id, content, memory_type, tags, search_text
        ) VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
        params![
            item.id,
            item.content,
            item.r#type,
            format!("{tags_text} {entities_text}"),
            searchable
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn search_memory_index_hits(
    state: &State<'_, AppState>,
    options: &MemorySearchOptions,
) -> Result<Vec<MemoryIndexHit>, String> {
    let normalized_query = normalize_text(&options.query);
    let terms = extract_query_terms(&normalized_query);
    let Some(match_query) = build_fts_match_query(&terms) else {
        return Ok(Vec::new());
    };
    let conn = open_memory_index(state)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT i.id, bm25(memory_records_fts) AS bm25_rank
            FROM memory_records_fts
            JOIN memory_records_index i ON i.id = memory_records_fts.id
            WHERE memory_records_fts MATCH ?1
              AND (?2 = 1 OR i.status = 'active')
            ORDER BY bm25_rank ASC
            LIMIT ?3
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![
                match_query,
                if options.include_archived {
                    1_i64
                } else {
                    0_i64
                },
                candidate_limit(options) as i64
            ],
            |row| {
                let bm25_rank: f64 = row.get(1)?;
                let bm25_score = bm25_rank_score(bm25_rank);
                Ok(MemoryIndexHit {
                    id: row.get(0)?,
                    score: bm25_score,
                    bm25_score,
                    retrieval_lanes: vec!["bm25".to_string()],
                })
            },
        )
        .map_err(|error| error.to_string())?;
    let hits = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let memories = with_store(state, |store| Ok(store.memories.clone()))?;
    let mut filtered = hits
        .into_iter()
        .filter(|hit| {
            memories
                .iter()
                .find(|item| item.id == hit.id)
                .map(|item| memory_matches_options(item, options))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    filtered.truncate(options.limit.max(1));
    Ok(filtered)
}

fn values_from_hits(memories: &[UserMemoryRecord], hits: &[MemoryIndexHit]) -> Vec<Value> {
    hits.iter()
        .filter_map(|hit| {
            memories.iter().find(|item| item.id == hit.id).map(|item| {
                let mut value = json!(item);
                if let Some(object) = value.as_object_mut() {
                    object.insert("score".to_string(), json!(hit.score));
                    object.insert("bm25Score".to_string(), json!(hit.bm25_score));
                    object.insert("matchReasons".to_string(), json!(["bm25"]));
                    object.insert("retrievalLanes".to_string(), json!(hit.retrieval_lanes));
                    object.insert(
                        "ranking".to_string(),
                        json!({
                            "bm25Score": hit.bm25_score,
                            "lexicalScore": 0.0,
                            "retrievalEngine": "sqlite-fts5-bm25"
                        }),
                    );
                }
                value
            })
        })
        .collect()
}

fn searchable_text(item: &UserMemoryRecord) -> String {
    let joined = [
        item.content.as_str(),
        item.r#type.as_str(),
        item.scope.as_deref().unwrap_or("user"),
        item.project_id.as_deref().unwrap_or_default(),
        item.session_id.as_deref().unwrap_or_default(),
        &item.tags.join(" "),
        &item.entities.join(" "),
    ]
    .into_iter()
    .collect::<Vec<_>>()
    .join(" ");
    let normalized = normalize_text(&joined);
    let bigrams = normalized
        .split_whitespace()
        .flat_map(cjk_bigrams)
        .collect::<Vec<_>>()
        .join(" ");
    format!("{joined} {normalized} {bigrams}")
}

fn candidate_limit(options: &MemorySearchOptions) -> usize {
    if options.scopes.is_empty()
        && options.memory_types.is_empty()
        && options.project_id.is_none()
        && options.session_id.is_none()
    {
        return options.limit.max(1);
    }
    options.limit.max(1).saturating_mul(5).clamp(10, 250)
}

fn value_matches_options(value: &Value, options: &MemorySearchOptions) -> bool {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    if !options.include_archived && status != "active" {
        return false;
    }
    if !options.scopes.is_empty() {
        let scope = value.get("scope").and_then(Value::as_str).unwrap_or("user");
        if !options.scopes.iter().any(|item| item == scope) {
            return false;
        }
    }
    if !options.memory_types.is_empty() {
        let memory_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("general");
        if !options.memory_types.iter().any(|item| item == memory_type) {
            return false;
        }
    }
    if let Some(project_id) = options.project_id.as_deref() {
        if value.get("projectId").and_then(Value::as_str) != Some(project_id) {
            return false;
        }
    }
    if let Some(session_id) = options.session_id.as_deref() {
        if value.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            return false;
        }
    }
    true
}

fn memory_matches_options(item: &UserMemoryRecord, options: &MemorySearchOptions) -> bool {
    if !options.include_archived && item.status.as_deref().unwrap_or("active") != "active" {
        return false;
    }
    if !options.scopes.is_empty() {
        let scope = item.scope.as_deref().unwrap_or("user");
        if !options.scopes.iter().any(|value| value == scope) {
            return false;
        }
    }
    if !options.memory_types.is_empty()
        && !options
            .memory_types
            .iter()
            .any(|value| value == item.r#type.as_str())
    {
        return false;
    }
    if let Some(project_id) = options.project_id.as_deref() {
        if item.project_id.as_deref() != Some(project_id) {
            return false;
        }
    }
    if let Some(session_id) = options.session_id.as_deref() {
        if item.session_id.as_deref() != Some(session_id) {
            return false;
        }
    }
    true
}

fn normalize_text(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn extract_query_terms(normalized_query: &str) -> Vec<String> {
    let mut terms = normalized_query
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    for token in normalized_query.split_whitespace() {
        terms.extend(cjk_bigrams(token));
    }
    if terms.is_empty() && !normalized_query.is_empty() {
        terms.push(normalized_query.to_string());
    }
    terms.sort();
    terms.dedup();
    terms
}

fn cjk_bigrams(token: &str) -> Vec<String> {
    let chars = token.chars().collect::<Vec<_>>();
    if chars.len() < 2
        || !chars
            .iter()
            .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch))
    {
        return Vec::new();
    }
    chars
        .windows(2)
        .filter_map(|pair| {
            if pair.iter().all(|ch| ('\u{4e00}'..='\u{9fff}').contains(ch)) {
                Some(pair.iter().collect::<String>())
            } else {
                None
            }
        })
        .collect()
}

fn build_fts_match_query(terms: &[String]) -> Option<String> {
    let mut phrases = terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .map(quote_fts_phrase)
        .collect::<Vec<_>>();
    phrases.sort();
    phrases.dedup();
    if phrases.is_empty() {
        None
    } else {
        Some(phrases.join(" OR "))
    }
}

fn quote_fts_phrase(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn bm25_rank_score(rank: f64) -> f64 {
    if !rank.is_finite() {
        return 0.0;
    }
    if rank < 0.0 {
        return (rank.abs() * 1_000_000.0).clamp(0.0, 12.0);
    }
    (1.0 / (1.0 + rank)).clamp(0.0, 1.0) * 6.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::now_i64;

    fn memory(id: &str, content: &str, tags: &[&str]) -> UserMemoryRecord {
        let now = now_i64();
        UserMemoryRecord {
            id: id.to_string(),
            content: content.to_string(),
            r#type: "preference".to_string(),
            tags: tags.iter().map(|item| item.to_string()).collect(),
            entities: Vec::new(),
            scope: Some("user".to_string()),
            space_id: None,
            project_id: None,
            session_id: None,
            source: Some(json!({ "kind": "test" })),
            confidence: Some(0.75),
            created_at: now,
            updated_at: Some(now),
            last_accessed: None,
            status: Some("active".to_string()),
            archived_at: None,
            archive_reason: None,
            origin_id: None,
            canonical_key: None,
            revision: Some(1),
            last_conflict_at: None,
        }
    }

    #[test]
    fn cjk_query_terms_include_bigrams() {
        let terms = extract_query_terms(&normalize_text("长期偏好"));
        assert!(terms.iter().any(|item| item == "长期"));
        assert!(terms.iter().any(|item| item == "期偏"));
        assert!(terms.iter().any(|item| item == "偏好"));
    }

    #[test]
    fn searchable_text_includes_cjk_bigrams() {
        let value = searchable_text(&memory("memory-1", "用户偏好复盘方法", &["方法论"]));
        assert!(value.contains("偏好"));
        assert!(value.contains("复盘"));
    }
}
