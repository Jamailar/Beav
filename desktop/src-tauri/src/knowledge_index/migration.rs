use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::{
    knowledge_index::{catalog_db_path, schema::ensure_catalog_ready},
    now_iso, AppState,
};

pub(crate) const CURRENT_SCHEMA_VERSION: &str = "1";
pub(crate) const CURRENT_INDEX_FORMAT_VERSION: &str = "2";
pub(crate) const CURRENT_CANONICAL_SCHEMA_VERSION: &str = "1";
pub(crate) const CURRENT_PARSER_PIPELINE_VERSION: &str = "1";
pub(crate) const CURRENT_CHUNK_ANCHOR_RULE_VERSION: &str = "1";
pub(crate) const CURRENT_RERANK_POLICY_VERSION: &str = "1";

const META_SCHEMA_VERSION: &str = "schema_version";
const META_INDEX_FORMAT_VERSION: &str = "index_format_version";
const META_CANONICAL_SCHEMA_VERSION: &str = "canonical_schema_version";
const META_PARSER_PIPELINE_VERSION: &str = "parser_pipeline_version";
const META_CHUNK_ANCHOR_RULE_VERSION: &str = "chunk_anchor_rule_version";
const META_RERANK_POLICY_VERSION: &str = "rerank_policy_version";
const META_PENDING_MIGRATION: &str = "pending_migration";
const META_LAST_SUCCESSFUL_REBUILD_AT: &str = "last_successful_rebuild_at";
const META_LAST_MIGRATION_ERROR: &str = "last_migration_error";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationDecision {
    Current,
    SchemaOnly,
    FtsRebuild,
    BlockAnchorRebuild,
    CanonicalReparse,
    FullRebuild,
}

impl MigrationDecision {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::SchemaOnly => "schema_only",
            Self::FtsRebuild => "fts_rebuild",
            Self::BlockAnchorRebuild => "block_anchor_rebuild",
            Self::CanonicalReparse => "canonical_reparse",
            Self::FullRebuild => "full_rebuild",
        }
    }
}

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    Connection::open(catalog_db_path(state)?).map_err(|error| error.to_string())
}

pub(crate) fn plan_migration(state: &State<'_, AppState>) -> Result<MigrationDecision, String> {
    let conn = connection(state)?;
    let existing_blocks = count_rows(&conn, "knowledge_document_blocks")?;
    let schema_version = meta_value(&conn, META_SCHEMA_VERSION)?;
    let index_format_version = meta_value(&conn, META_INDEX_FORMAT_VERSION)?;
    let canonical_schema_version = meta_value(&conn, META_CANONICAL_SCHEMA_VERSION)?;
    let parser_pipeline_version = meta_value(&conn, META_PARSER_PIPELINE_VERSION)?;
    let chunk_anchor_rule_version = meta_value(&conn, META_CHUNK_ANCHOR_RULE_VERSION)?;
    let rerank_policy_version = meta_value(&conn, META_RERANK_POLICY_VERSION)?;

    let decision = if canonical_schema_version
        .as_deref()
        .is_some_and(|value| value != CURRENT_CANONICAL_SCHEMA_VERSION)
        || parser_pipeline_version
            .as_deref()
            .is_some_and(|value| value != CURRENT_PARSER_PIPELINE_VERSION)
    {
        MigrationDecision::CanonicalReparse
    } else if chunk_anchor_rule_version
        .as_deref()
        .is_some_and(|value| value != CURRENT_CHUNK_ANCHOR_RULE_VERSION)
    {
        MigrationDecision::BlockAnchorRebuild
    } else if index_format_version.as_deref() != Some(CURRENT_INDEX_FORMAT_VERSION)
        && existing_blocks > 0
    {
        MigrationDecision::FtsRebuild
    } else if schema_version.as_deref() != Some(CURRENT_SCHEMA_VERSION)
        || rerank_policy_version.as_deref() != Some(CURRENT_RERANK_POLICY_VERSION)
        || canonical_schema_version.as_deref().is_none()
        || parser_pipeline_version.as_deref().is_none()
        || chunk_anchor_rule_version.as_deref().is_none()
        || index_format_version.as_deref().is_none()
    {
        MigrationDecision::SchemaOnly
    } else {
        MigrationDecision::Current
    };
    if decision == MigrationDecision::Current {
        clear_pending_migration(&conn)?;
    } else {
        set_meta_value(&conn, META_PENDING_MIGRATION, decision.label())?;
    }
    Ok(decision)
}

pub(crate) fn mark_schema_current(state: &State<'_, AppState>) -> Result<(), String> {
    let conn = connection(state)?;
    write_current_versions(&conn, true)?;
    clear_pending_migration(&conn)?;
    Ok(())
}

pub(crate) fn mark_rebuild_success(
    state: &State<'_, AppState>,
    decision: MigrationDecision,
) -> Result<(), String> {
    let conn = connection(state)?;
    write_current_versions(&conn, true)?;
    clear_pending_migration(&conn)?;
    set_meta_value(&conn, META_LAST_SUCCESSFUL_REBUILD_AT, &now_iso())?;
    delete_meta_value(&conn, META_LAST_MIGRATION_ERROR)?;
    clear_index_error(&conn, decision.label())?;
    Ok(())
}

pub(crate) fn mark_rebuild_error(
    state: &State<'_, AppState>,
    decision: MigrationDecision,
    error: &str,
) -> Result<(), String> {
    let conn = connection(state)?;
    set_meta_value(&conn, META_PENDING_MIGRATION, decision.label())?;
    set_meta_value(&conn, META_LAST_MIGRATION_ERROR, error)?;
    record_index_error(&conn, decision.label(), error)?;
    Ok(())
}

pub(crate) fn canonical_cache_is_current(state: &State<'_, AppState>) -> Result<bool, String> {
    let conn = connection(state)?;
    Ok(meta_value(&conn, META_CANONICAL_SCHEMA_VERSION)?.as_deref()
        == Some(CURRENT_CANONICAL_SCHEMA_VERSION)
        && meta_value(&conn, META_PARSER_PIPELINE_VERSION)?.as_deref()
            == Some(CURRENT_PARSER_PIPELINE_VERSION))
}

fn write_current_versions(conn: &Connection, include_index_format: bool) -> Result<(), String> {
    set_meta_value(conn, META_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION)?;
    set_meta_value(
        conn,
        META_CANONICAL_SCHEMA_VERSION,
        CURRENT_CANONICAL_SCHEMA_VERSION,
    )?;
    set_meta_value(
        conn,
        META_PARSER_PIPELINE_VERSION,
        CURRENT_PARSER_PIPELINE_VERSION,
    )?;
    set_meta_value(
        conn,
        META_CHUNK_ANCHOR_RULE_VERSION,
        CURRENT_CHUNK_ANCHOR_RULE_VERSION,
    )?;
    set_meta_value(
        conn,
        META_RERANK_POLICY_VERSION,
        CURRENT_RERANK_POLICY_VERSION,
    )?;
    if include_index_format {
        set_meta_value(
            conn,
            META_INDEX_FORMAT_VERSION,
            CURRENT_INDEX_FORMAT_VERSION,
        )?;
    }
    Ok(())
}

fn count_rows(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .map_err(|error| error.to_string())
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM knowledge_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn set_meta_value(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO knowledge_meta (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![key, value],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn delete_meta_value(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM knowledge_meta WHERE key = ?1", params![key])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn clear_pending_migration(conn: &Connection) -> Result<(), String> {
    delete_meta_value(conn, META_PENDING_MIGRATION)
}

fn record_index_error(conn: &Connection, path: &str, message: &str) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO knowledge_index_errors (path, message, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(path) DO UPDATE SET
            message = excluded.message,
            updated_at = excluded.updated_at
        "#,
        params![path, message, now_iso()],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn clear_index_error(conn: &Connection, path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM knowledge_index_errors WHERE path = ?1",
        params![path],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_decision_labels_are_stable() {
        assert_eq!(MigrationDecision::Current.label(), "current");
        assert_eq!(MigrationDecision::SchemaOnly.label(), "schema_only");
        assert_eq!(MigrationDecision::FtsRebuild.label(), "fts_rebuild");
        assert_eq!(
            MigrationDecision::BlockAnchorRebuild.label(),
            "block_anchor_rebuild"
        );
        assert_eq!(
            MigrationDecision::CanonicalReparse.label(),
            "canonical_reparse"
        );
        assert_eq!(MigrationDecision::FullRebuild.label(), "full_rebuild");
    }
}
