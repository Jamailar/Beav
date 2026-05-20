use std::{collections::HashMap, path::Path};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::{
    knowledge_index::{
        advisor_source_id, document_blocks::is_visual_candidate_path, open_catalog_connection,
        schema::ensure_catalog_ready,
    },
    with_store, workspace_root, AppState,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileIndexDashboard {
    pub overall: FileIndexOverall,
    pub lanes: Vec<FileIndexLaneStatus>,
    pub scopes: Vec<FileIndexScopeStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileIndexOverall {
    pub status: String,
    pub indexed_files: i64,
    pub total_files: i64,
    pub failed_files: i64,
    pub last_indexed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileIndexLaneStatus {
    pub lane: String,
    pub label: String,
    pub status: String,
    pub done: i64,
    pub total: i64,
    pub failed: i64,
    pub metadata_only: i64,
    pub last_updated_at: Option<String>,
    pub next_retry_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileIndexScopeStatus {
    pub scope_id: String,
    pub name: String,
    pub scope_type: String,
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
    pub file_count: i64,
    pub status: String,
    pub failed_count: i64,
    pub lanes: Vec<FileIndexLaneStatus>,
}

#[derive(Debug, Clone, Default)]
struct ScopeSeed {
    scope_id: String,
    source_id: Option<String>,
    name: String,
    scope_type: String,
    owner_id: Option<String>,
    owner_name: Option<String>,
    file_count: i64,
    visual_candidate_count: i64,
    source_failed_count: i64,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SourceStats {
    canonical_documents: i64,
    indexed_documents: i64,
    blocks: i64,
    anchored_blocks: i64,
    visual_total: i64,
    visual_indexed: i64,
    visual_metadata_only: i64,
    visual_failed: i64,
    visual_retry_deferred: i64,
    visual_retry_ready: i64,
    last_visual_attempted_at: Option<String>,
    next_visual_retry_at: Option<String>,
}

pub(crate) fn dashboard(state: &State<'_, AppState>) -> Result<FileIndexDashboard, String> {
    ensure_catalog_ready(state)?;
    let conn = open_catalog_connection(state)?;
    let runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?
        .clone();
    let visual_enabled = with_store(state, |store| {
        Ok(store
            .settings
            .get("visual_index_enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false))
    })?;

    let source_stats = load_source_stats(&conn)?;
    let workspace_stats = load_workspace_stats(&conn)?;
    let mut scopes = load_scope_seeds(state, &conn, true)?;
    if let Some(scope) = scopes
        .iter_mut()
        .find(|scope| scope.scope_id == "workspace")
    {
        scope.file_count = workspace_stats
            .discovered_files
            .max(scope.visual_candidate_count);
        scope.updated_at = workspace_stats.last_updated_at.clone();
    }

    let mut scope_statuses = Vec::new();
    let scoped_source_ids = scopes
        .iter()
        .filter_map(|scope| scope.source_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let workspace_source_stats = aggregate_unscoped_source_stats(&source_stats, &scoped_source_ids);
    for scope in scopes {
        let stats = if let Some(source_id) = scope.source_id.as_deref() {
            source_stats.get(source_id).cloned().unwrap_or_default()
        } else {
            workspace_source_stats.clone()
        };
        scope_statuses.push(build_scope_status(
            &scope,
            &stats,
            visual_enabled,
            runtime.is_building,
        ));
    }
    scope_statuses.sort_by(|left, right| {
        status_weight(&left.status)
            .cmp(&status_weight(&right.status))
            .then(left.scope_type.cmp(&right.scope_type))
            .then(left.name.cmp(&right.name))
    });

    let totals = aggregate_totals(&scope_statuses, &workspace_stats);
    let lanes = build_global_lanes(&totals, visual_enabled, runtime.last_indexed_at.clone());
    let overall_status = if runtime.is_building {
        "indexing"
    } else if totals.failed_files > 0 {
        "partial_failed"
    } else if totals.indexed_files < totals.total_files {
        "pending"
    } else {
        "idle"
    };

    Ok(FileIndexDashboard {
        overall: FileIndexOverall {
            status: overall_status.to_string(),
            indexed_files: totals.indexed_files,
            total_files: totals.total_files,
            failed_files: totals.failed_files,
            last_indexed_at: runtime.last_indexed_at,
        },
        lanes,
        scopes: scope_statuses,
    })
}

fn load_scope_seeds(
    state: &State<'_, AppState>,
    conn: &Connection,
    prefer_cached_visual_counts: bool,
) -> Result<Vec<ScopeSeed>, String> {
    let cached_workspace_visual_count =
        cached_visual_candidate_count(conn, "workspace").unwrap_or(0);
    let indexed_workspace_visual_count = cached_workspace_visual_unit_count(conn).unwrap_or(0);
    let mut scopes = vec![ScopeSeed {
        scope_id: "workspace".to_string(),
        source_id: None,
        name: "全局知识库".to_string(),
        scope_type: "workspace".to_string(),
        owner_id: None,
        owner_name: None,
        file_count: 0,
        visual_candidate_count: if prefer_cached_visual_counts
            && cached_workspace_visual_count.max(indexed_workspace_visual_count) > 0
        {
            cached_workspace_visual_count.max(indexed_workspace_visual_count)
        } else {
            workspace_visual_candidate_count(state, conn)?
        },
        source_failed_count: 0,
        updated_at: None,
    }];

    let mut stmt = conn
        .prepare(
            r#"
            SELECT item_id, title, file_count, status, updated_at, root_path
            FROM knowledge_items
            WHERE kind = 'document-source'
            ORDER BY title COLLATE NOCASE
            "#,
        )
        .map_err(|error| error.to_string())?;
    let document_sources = stmt
        .query_map([], |row| {
            let status: Option<String> = row.get(3)?;
            let root_path: Option<String> = row.get(5)?;
            let source_id: String = row.get(0)?;
            let cached_candidate_count =
                cached_visual_candidate_count(conn, &source_id).unwrap_or(0);
            let indexed_visual_count =
                cached_source_visual_unit_count(conn, &source_id).unwrap_or(0);
            let visual_candidate_count = if prefer_cached_visual_counts
                && cached_candidate_count.max(indexed_visual_count) > 0
            {
                cached_candidate_count.max(indexed_visual_count)
            } else {
                root_path
                    .as_deref()
                    .map(|value| {
                        count_visual_candidates_under_cached(conn, &source_id, Path::new(value))
                    })
                    .unwrap_or(0)
            };
            Ok(ScopeSeed {
                scope_id: source_id.clone(),
                source_id: Some(source_id),
                name: row.get(1)?,
                scope_type: "document_source".to_string(),
                owner_id: None,
                owner_name: None,
                file_count: row.get(2)?,
                visual_candidate_count,
                source_failed_count: status
                    .as_deref()
                    .filter(|value| !value.trim().is_empty() && *value != "indexing")
                    .map(|_| 1)
                    .unwrap_or(0),
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    scopes.extend(document_sources);

    let advisors = with_store(state, |store| Ok(store.advisors.clone()))?;
    for advisor in advisors {
        let root_path = crate::advisor_knowledge_dir(state, &advisor.id)?;
        let source_id = advisor_source_id(&advisor.id);
        let cached_candidate_count = cached_visual_candidate_count(conn, &source_id).unwrap_or(0);
        let indexed_visual_count = cached_source_visual_unit_count(conn, &source_id).unwrap_or(0);
        let visual_candidate_count = if prefer_cached_visual_counts
            && cached_candidate_count.max(indexed_visual_count) > 0
        {
            cached_candidate_count.max(indexed_visual_count)
        } else {
            count_visual_candidates_under_cached(conn, &source_id, &root_path)
        };
        scopes.push(ScopeSeed {
            scope_id: format!("advisor:{}", advisor.id),
            source_id: Some(source_id),
            name: format!("{} 知识库", advisor.name),
            scope_type: "advisor".to_string(),
            owner_id: Some(advisor.id),
            owner_name: Some(advisor.name),
            file_count: (advisor.knowledge_files.len() as i64).max(visual_candidate_count),
            visual_candidate_count,
            source_failed_count: 0,
            updated_at: Some(advisor.updated_at),
        });
    }

    Ok(scopes)
}

fn visual_candidate_cache_key(scope_id: &str) -> String {
    format!("visual-candidates:{scope_id}")
}

fn cached_visual_candidate_count(conn: &Connection, scope_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT value FROM knowledge_meta WHERE key = ?1",
        params![visual_candidate_cache_key(scope_id)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .and_then(|value| value.trim().parse::<i64>().ok())
    .ok_or_else(|| "visual candidate count cache miss".to_string())
}

fn store_visual_candidate_count(
    conn: &Connection,
    scope_id: &str,
    count: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES (?1, ?2)",
        params![visual_candidate_cache_key(scope_id), count.to_string()],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn cached_workspace_visual_unit_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        r#"
        SELECT COUNT(*)
        FROM knowledge_visual_units
        WHERE source_id NOT IN (
            SELECT item_id
            FROM knowledge_items
            WHERE kind = 'document-source'
        )
          AND source_id NOT LIKE 'advisor:%'
          AND source_id NOT LIKE 'media:%'
        "#,
        [],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn cached_source_visual_unit_count(conn: &Connection, source_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM knowledge_visual_units WHERE source_id = ?1",
        params![source_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn workspace_visual_candidate_count(
    state: &State<'_, AppState>,
    conn: &Connection,
) -> Result<i64, String> {
    let knowledge_root = workspace_root(state)?.join("knowledge");
    let mut total = 0;
    for path in [
        knowledge_root.join("redbook"),
        knowledge_root.join("zhihu"),
        knowledge_root.join("wechat"),
        knowledge_root.join("youtube"),
    ] {
        total += count_visual_candidates_under(&path);
    }
    let _ = store_visual_candidate_count(conn, "workspace", total);
    Ok(total)
}

fn count_visual_candidates_under_cached(conn: &Connection, cache_key: &str, root: &Path) -> i64 {
    let total = count_visual_candidates_under(root);
    let _ = store_visual_candidate_count(conn, cache_key, total);
    total
}

fn count_visual_candidates_under(root: &Path) -> i64 {
    count_visual_candidates_under_inner(root).unwrap_or(0)
}

fn count_visual_candidates_under_inner(root: &Path) -> Result<i64, String> {
    if !root.exists() {
        return Ok(0);
    }
    if root.is_file() {
        return Ok(if is_visual_candidate_path(root) { 1 } else { 0 });
    }
    let mut total = 0;
    let entries = std::fs::read_dir(root).map_err(|error| error.to_string())?;
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            total += count_visual_candidates_under_inner(&path)?;
        } else if path.is_file() && is_visual_candidate_path(&path) {
            total += 1;
        }
    }
    Ok(total)
}

#[derive(Debug, Clone, Default)]
struct WorkspaceStats {
    discovered_files: i64,
    last_updated_at: Option<String>,
}

fn load_workspace_stats(conn: &Connection) -> Result<WorkspaceStats, String> {
    let discovered_files = conn
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM knowledge_files f
            JOIN knowledge_items i ON i.item_id = f.item_id
            WHERE i.kind != 'document-source'
            "#,
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let last_updated_at = conn
        .query_row(
            r#"
            SELECT MAX(updated_at)
            FROM knowledge_items
            WHERE kind != 'document-source'
            "#,
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    Ok(WorkspaceStats {
        discovered_files,
        last_updated_at,
    })
}

fn load_source_stats(conn: &Connection) -> Result<HashMap<String, SourceStats>, String> {
    let mut stats = HashMap::<String, SourceStats>::new();

    {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT source_id, COUNT(*)
                FROM knowledge_canonical_documents
                GROUP BY source_id
                "#,
            )
            .map_err(|error| error.to_string())?;
        for row in stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
        {
            let (source_id, count) = row.map_err(|error| error.to_string())?;
            stats.entry(source_id).or_default().canonical_documents = count;
        }
    }

    {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT source_id, COUNT(DISTINCT document_id), COUNT(*)
                FROM knowledge_document_blocks
                GROUP BY source_id
                "#,
            )
            .map_err(|error| error.to_string())?;
        for row in stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
        {
            let (source_id, indexed_documents, blocks) = row.map_err(|error| error.to_string())?;
            let entry = stats.entry(source_id).or_default();
            entry.indexed_documents = indexed_documents;
            entry.blocks = blocks;
        }
    }

    {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT b.source_id, COUNT(DISTINCT a.block_id)
                FROM knowledge_citation_anchors a
                JOIN knowledge_document_blocks b ON b.block_id = a.block_id
                GROUP BY b.source_id
                "#,
            )
            .map_err(|error| error.to_string())?;
        for row in stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
        {
            let (source_id, count) = row.map_err(|error| error.to_string())?;
            stats.entry(source_id).or_default().anchored_blocks = count;
        }
    }

    {
        let now_ms = crate::now_i64();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT
                    source_id,
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'metadata_only' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' AND CAST(COALESCE(next_retry_at, '0') AS INTEGER) > ?1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' AND CAST(COALESCE(next_retry_at, '0') AS INTEGER) <= ?1 THEN 1 ELSE 0 END), 0),
                    MAX(last_attempted_at),
                    MIN(CASE WHEN status = 'failed' THEN next_retry_at ELSE NULL END)
                FROM knowledge_visual_units
                GROUP BY source_id
                "#,
            )
            .map_err(|error| error.to_string())?;
        for row in stmt
            .query_map(params![now_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|error| error.to_string())?
        {
            let (
                source_id,
                total,
                indexed,
                metadata_only,
                failed,
                retry_deferred,
                retry_ready,
                last_attempted_at,
                next_retry_at,
            ) = row.map_err(|error| error.to_string())?;
            let entry = stats.entry(source_id).or_default();
            entry.visual_total = total;
            entry.visual_indexed = indexed;
            entry.visual_metadata_only = metadata_only;
            entry.visual_failed = failed;
            entry.visual_retry_deferred = retry_deferred;
            entry.visual_retry_ready = retry_ready;
            entry.last_visual_attempted_at = last_attempted_at;
            entry.next_visual_retry_at = next_retry_at;
        }
    }

    Ok(stats)
}

fn aggregate_unscoped_source_stats(
    source_stats: &HashMap<String, SourceStats>,
    scoped_source_ids: &std::collections::HashSet<String>,
) -> SourceStats {
    let mut aggregate = SourceStats::default();
    for (source_id, stats) in source_stats {
        if scoped_source_ids.contains(source_id)
            || source_id.starts_with("advisor:")
            || source_id.starts_with("media:")
        {
            continue;
        }
        aggregate.canonical_documents += stats.canonical_documents;
        aggregate.indexed_documents += stats.indexed_documents;
        aggregate.blocks += stats.blocks;
        aggregate.anchored_blocks += stats.anchored_blocks;
        aggregate.visual_total += stats.visual_total;
        aggregate.visual_indexed += stats.visual_indexed;
        aggregate.visual_metadata_only += stats.visual_metadata_only;
        aggregate.visual_failed += stats.visual_failed;
        aggregate.visual_retry_deferred += stats.visual_retry_deferred;
        aggregate.visual_retry_ready += stats.visual_retry_ready;
        aggregate.last_visual_attempted_at = max_optional_text(
            aggregate.last_visual_attempted_at.take(),
            stats.last_visual_attempted_at.clone(),
        );
        aggregate.next_visual_retry_at = min_optional_text(
            aggregate.next_visual_retry_at.take(),
            stats.next_visual_retry_at.clone(),
        );
    }
    aggregate
}

#[derive(Debug, Clone, Default)]
struct AggregateTotals {
    total_files: i64,
    indexed_files: i64,
    failed_files: i64,
    canonical_total: i64,
    canonical_done: i64,
    text_total: i64,
    text_done: i64,
    anchor_total: i64,
    anchor_done: i64,
    visual_total: i64,
    visual_done: i64,
    visual_metadata_only: i64,
    visual_failed: i64,
    retry_total: i64,
    retry_ready: i64,
    retry_deferred: i64,
    last_visual_attempted_at: Option<String>,
    next_visual_retry_at: Option<String>,
}

fn aggregate_totals(
    scopes: &[FileIndexScopeStatus],
    workspace_stats: &WorkspaceStats,
) -> AggregateTotals {
    let mut totals = AggregateTotals {
        total_files: scopes.iter().map(|scope| scope.file_count).sum(),
        indexed_files: workspace_stats.discovered_files,
        ..AggregateTotals::default()
    };
    for scope in scopes {
        totals.failed_files += scope.failed_count;
        for lane in &scope.lanes {
            match lane.lane.as_str() {
                "canonical_parse" => {
                    totals.canonical_total += lane.total;
                    totals.canonical_done += lane.done;
                    totals.indexed_files += lane.done;
                }
                "text_index" => {
                    totals.text_total += lane.total;
                    totals.text_done += lane.done;
                }
                "citation_anchor" => {
                    totals.anchor_total += lane.total;
                    totals.anchor_done += lane.done;
                }
                "visual_index" => {
                    totals.visual_total += lane.total;
                    totals.visual_done += lane.done;
                    totals.visual_metadata_only += lane.metadata_only;
                    totals.visual_failed += lane.failed;
                    totals.last_visual_attempted_at = max_optional_text(
                        totals.last_visual_attempted_at.take(),
                        lane.last_updated_at.clone(),
                    );
                }
                "retry_queue" => {
                    totals.retry_total += lane.total;
                    totals.retry_ready += lane.done;
                    totals.retry_deferred += lane.total.saturating_sub(lane.done);
                    totals.next_visual_retry_at = min_optional_text(
                        totals.next_visual_retry_at.take(),
                        lane.next_retry_at.clone(),
                    );
                }
                _ => {}
            }
        }
    }
    totals.indexed_files = totals.indexed_files.min(totals.total_files);
    totals
}

fn build_scope_status(
    scope: &ScopeSeed,
    stats: &SourceStats,
    visual_enabled: bool,
    is_building: bool,
) -> FileIndexScopeStatus {
    let canonical_total = scope
        .source_id
        .as_ref()
        .map(|_| scope.file_count.max(stats.canonical_documents))
        .unwrap_or(0);
    let text_total = stats.canonical_documents.max(stats.indexed_documents);
    let anchor_total = stats.blocks;
    let visual_total = stats.visual_total.max(scope.visual_candidate_count);
    let retry_total = stats.visual_failed;
    let retry_ready = stats.visual_retry_ready;

    let lanes = vec![
        FileIndexLaneStatus {
            lane: "discovery".to_string(),
            label: "文件发现".to_string(),
            status: lane_status(scope.file_count, scope.file_count, 0, false, false),
            done: scope.file_count,
            total: scope.file_count,
            failed: 0,
            metadata_only: 0,
            last_updated_at: scope.updated_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "canonical_parse".to_string(),
            label: "内容解析".to_string(),
            status: lane_status(
                stats.canonical_documents,
                canonical_total,
                scope.source_failed_count,
                is_building,
                false,
            ),
            done: stats.canonical_documents.min(canonical_total),
            total: canonical_total,
            failed: scope.source_failed_count,
            metadata_only: 0,
            last_updated_at: scope.updated_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "text_index".to_string(),
            label: "文本索引".to_string(),
            status: lane_status(stats.indexed_documents, text_total, 0, is_building, false),
            done: stats.indexed_documents.min(text_total),
            total: text_total,
            failed: 0,
            metadata_only: 0,
            last_updated_at: scope.updated_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "citation_anchor".to_string(),
            label: "引用锚点".to_string(),
            status: lane_status(stats.anchored_blocks, anchor_total, 0, is_building, false),
            done: stats.anchored_blocks.min(anchor_total),
            total: anchor_total,
            failed: 0,
            metadata_only: 0,
            last_updated_at: scope.updated_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "visual_index".to_string(),
            label: "视觉索引".to_string(),
            status: visual_lane_status(
                stats.visual_indexed,
                visual_total,
                stats.visual_failed,
                stats.visual_retry_ready,
                stats.visual_retry_deferred,
                is_building,
                !visual_enabled && visual_total == 0,
            ),
            done: stats.visual_indexed,
            total: visual_total,
            failed: stats.visual_failed,
            metadata_only: stats.visual_metadata_only,
            last_updated_at: stats.last_visual_attempted_at.clone(),
            next_retry_at: stats.next_visual_retry_at.clone(),
        },
        FileIndexLaneStatus {
            lane: "retry_queue".to_string(),
            label: "失败重试".to_string(),
            status: if retry_total == 0 {
                "done".to_string()
            } else if retry_ready > 0 {
                "pending".to_string()
            } else {
                "waiting".to_string()
            },
            done: retry_ready,
            total: retry_total,
            failed: retry_total,
            metadata_only: 0,
            last_updated_at: stats.last_visual_attempted_at.clone(),
            next_retry_at: stats.next_visual_retry_at.clone(),
        },
    ];

    let blocked_failures =
        stats.visual_failed - stats.visual_retry_ready - stats.visual_retry_deferred;
    let failed_count = scope.source_failed_count + blocked_failures.max(0);
    let status = if failed_count > 0 {
        "partial_failed"
    } else if is_building && lanes.iter().any(|lane| lane.status == "pending") {
        "indexing"
    } else if lanes.iter().any(|lane| lane.status == "pending") {
        "pending"
    } else {
        "done"
    };

    FileIndexScopeStatus {
        scope_id: scope.scope_id.clone(),
        name: scope.name.clone(),
        scope_type: scope.scope_type.clone(),
        owner_id: scope.owner_id.clone(),
        owner_name: scope.owner_name.clone(),
        file_count: scope.file_count,
        status: status.to_string(),
        failed_count,
        lanes,
    }
}

fn build_global_lanes(
    totals: &AggregateTotals,
    visual_enabled: bool,
    last_indexed_at: Option<String>,
) -> Vec<FileIndexLaneStatus> {
    vec![
        FileIndexLaneStatus {
            lane: "discovery".to_string(),
            label: "文件发现".to_string(),
            status: lane_status(totals.total_files, totals.total_files, 0, false, false),
            done: totals.total_files,
            total: totals.total_files,
            failed: 0,
            metadata_only: 0,
            last_updated_at: last_indexed_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "canonical_parse".to_string(),
            label: "内容解析".to_string(),
            status: lane_status(
                totals.canonical_done,
                totals.canonical_total,
                0,
                false,
                false,
            ),
            done: totals.canonical_done.min(totals.canonical_total),
            total: totals.canonical_total,
            failed: 0,
            metadata_only: 0,
            last_updated_at: last_indexed_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "text_index".to_string(),
            label: "文本索引".to_string(),
            status: lane_status(totals.text_done, totals.text_total, 0, false, false),
            done: totals.text_done.min(totals.text_total),
            total: totals.text_total,
            failed: 0,
            metadata_only: 0,
            last_updated_at: last_indexed_at.clone(),
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "citation_anchor".to_string(),
            label: "引用锚点".to_string(),
            status: lane_status(totals.anchor_done, totals.anchor_total, 0, false, false),
            done: totals.anchor_done.min(totals.anchor_total),
            total: totals.anchor_total,
            failed: 0,
            metadata_only: 0,
            last_updated_at: last_indexed_at,
            next_retry_at: None,
        },
        FileIndexLaneStatus {
            lane: "visual_index".to_string(),
            label: "视觉索引".to_string(),
            status: visual_lane_status(
                totals.visual_done,
                totals.visual_total,
                totals.visual_failed,
                totals.retry_ready,
                totals.retry_deferred,
                false,
                !visual_enabled && totals.visual_total == 0,
            ),
            done: totals.visual_done,
            total: totals.visual_total,
            failed: totals.visual_failed,
            metadata_only: totals.visual_metadata_only,
            last_updated_at: totals.last_visual_attempted_at.clone(),
            next_retry_at: totals.next_visual_retry_at.clone(),
        },
        FileIndexLaneStatus {
            lane: "retry_queue".to_string(),
            label: "失败重试".to_string(),
            status: if totals.retry_total == 0 {
                "done".to_string()
            } else if totals.retry_ready > 0 {
                "pending".to_string()
            } else {
                "waiting".to_string()
            },
            done: totals.retry_ready,
            total: totals.retry_total,
            failed: totals.retry_total,
            metadata_only: 0,
            last_updated_at: totals.last_visual_attempted_at.clone(),
            next_retry_at: totals.next_visual_retry_at.clone(),
        },
    ]
}

fn lane_status(done: i64, total: i64, failed: i64, is_building: bool, disabled: bool) -> String {
    if disabled {
        return "disabled".to_string();
    }
    if failed > 0 {
        return "partial_failed".to_string();
    }
    if total <= 0 {
        return "done".to_string();
    }
    if done >= total {
        return "done".to_string();
    }
    if is_building {
        return "indexing".to_string();
    }
    "pending".to_string()
}

fn visual_lane_status(
    done: i64,
    total: i64,
    failed: i64,
    retry_ready: i64,
    retry_deferred: i64,
    is_building: bool,
    disabled: bool,
) -> String {
    if disabled {
        return "disabled".to_string();
    }
    if failed > 0 {
        if retry_ready > 0 {
            return "pending".to_string();
        }
        if retry_deferred >= failed {
            return "waiting".to_string();
        }
        return "partial_failed".to_string();
    }
    lane_status(done, total, 0, is_building, false)
}

fn status_weight(status: &str) -> u8 {
    match status {
        "partial_failed" => 0,
        "indexing" => 1,
        "pending" => 2,
        "waiting" => 3,
        "disabled" => 4,
        _ => 5,
    }
}

fn max_optional_text(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn min_optional_text(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lane_status_prefers_failure_then_completion() {
        assert_eq!(lane_status(0, 10, 1, false, false), "partial_failed");
        assert_eq!(lane_status(10, 10, 0, false, false), "done");
        assert_eq!(lane_status(2, 10, 0, true, false), "indexing");
        assert_eq!(lane_status(0, 0, 0, false, true), "disabled");
    }

    #[test]
    fn visual_lane_status_treats_retryable_failures_as_queue_state() {
        assert_eq!(visual_lane_status(19, 22, 3, 2, 1, false, false), "pending");
        assert_eq!(visual_lane_status(19, 22, 3, 0, 3, false, false), "waiting");
        assert_eq!(
            visual_lane_status(19, 22, 3, 0, 2, false, false),
            "partial_failed"
        );
    }
}
