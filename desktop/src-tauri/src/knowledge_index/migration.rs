use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::{
    document_parse::VISUAL_DEFAULT_PROMPT_VERSION,
    knowledge_index::{open_catalog_connection, schema::ensure_catalog_ready},
    now_iso, AppState,
};

pub(crate) const CURRENT_SCHEMA_VERSION: &str = "1";
pub(crate) const CURRENT_INDEX_FORMAT_VERSION: &str = "2";
pub(crate) const CURRENT_CANONICAL_SCHEMA_VERSION: &str = "1";
pub(crate) const CURRENT_PARSER_PIPELINE_VERSION: &str = "1";
pub(crate) const CURRENT_CHUNK_ANCHOR_RULE_VERSION: &str = "1";
pub(crate) const CURRENT_RERANK_POLICY_VERSION: &str = "1";
pub(crate) const CURRENT_VISUAL_SCHEMA_VERSION: &str = "redbox.visual_manifest.v1";
pub(crate) const CURRENT_VISUAL_PROMPT_VERSION: &str = VISUAL_DEFAULT_PROMPT_VERSION;
pub(crate) const CURRENT_VISUAL_PROJECTION_VERSION: &str = "1";

const META_SCHEMA_VERSION: &str = "schema_version";
const META_INDEX_FORMAT_VERSION: &str = "index_format_version";
const META_CANONICAL_SCHEMA_VERSION: &str = "canonical_schema_version";
const META_PARSER_PIPELINE_VERSION: &str = "parser_pipeline_version";
const META_CHUNK_ANCHOR_RULE_VERSION: &str = "chunk_anchor_rule_version";
const META_RERANK_POLICY_VERSION: &str = "rerank_policy_version";
const META_VISUAL_SCHEMA_VERSION: &str = "visual_schema_version";
const META_VISUAL_PROMPT_VERSION: &str = "visual_prompt_version";
const META_VISUAL_PROJECTION_VERSION: &str = "visual_projection_version";
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
    open_catalog_connection(state)
}

pub(crate) fn plan_migration(state: &State<'_, AppState>) -> Result<MigrationDecision, String> {
    let conn = connection(state)?;
    let existing_blocks = count_rows(&conn, "knowledge_document_blocks")?;
    let existing_items = count_rows(&conn, "knowledge_items")?;
    let schema_version = meta_value(&conn, META_SCHEMA_VERSION)?;
    let index_format_version = meta_value(&conn, META_INDEX_FORMAT_VERSION)?;
    let canonical_schema_version = meta_value(&conn, META_CANONICAL_SCHEMA_VERSION)?;
    let parser_pipeline_version = meta_value(&conn, META_PARSER_PIPELINE_VERSION)?;
    let chunk_anchor_rule_version = meta_value(&conn, META_CHUNK_ANCHOR_RULE_VERSION)?;
    let rerank_policy_version = meta_value(&conn, META_RERANK_POLICY_VERSION)?;
    let visual_schema_version = meta_value(&conn, META_VISUAL_SCHEMA_VERSION)?;
    let visual_prompt_version = meta_value(&conn, META_VISUAL_PROMPT_VERSION)?;
    let visual_projection_version = meta_value(&conn, META_VISUAL_PROJECTION_VERSION)?;

    let decision = plan_migration_from_versions(MigrationVersionState {
        existing_blocks,
        existing_items,
        schema_version: schema_version.as_deref(),
        index_format_version: index_format_version.as_deref(),
        canonical_schema_version: canonical_schema_version.as_deref(),
        parser_pipeline_version: parser_pipeline_version.as_deref(),
        chunk_anchor_rule_version: chunk_anchor_rule_version.as_deref(),
        rerank_policy_version: rerank_policy_version.as_deref(),
        visual_schema_version: visual_schema_version.as_deref(),
        visual_prompt_version: visual_prompt_version.as_deref(),
        visual_projection_version: visual_projection_version.as_deref(),
    });
    if decision == MigrationDecision::Current {
        clear_pending_migration(&conn)?;
    } else {
        set_meta_value(&conn, META_PENDING_MIGRATION, decision.label())?;
    }
    Ok(decision)
}

#[derive(Debug, Clone, Copy)]
struct MigrationVersionState<'a> {
    existing_blocks: i64,
    existing_items: i64,
    schema_version: Option<&'a str>,
    index_format_version: Option<&'a str>,
    canonical_schema_version: Option<&'a str>,
    parser_pipeline_version: Option<&'a str>,
    chunk_anchor_rule_version: Option<&'a str>,
    rerank_policy_version: Option<&'a str>,
    visual_schema_version: Option<&'a str>,
    visual_prompt_version: Option<&'a str>,
    visual_projection_version: Option<&'a str>,
}

fn plan_migration_from_versions(state: MigrationVersionState<'_>) -> MigrationDecision {
    let has_catalog_without_blocks = state.existing_items > 0 && state.existing_blocks == 0;
    let canonical_or_parser_changed = state
        .canonical_schema_version
        .is_some_and(|value| value != CURRENT_CANONICAL_SCHEMA_VERSION)
        || state
            .parser_pipeline_version
            .is_some_and(|value| value != CURRENT_PARSER_PIPELINE_VERSION);
    if canonical_or_parser_changed {
        return if has_catalog_without_blocks {
            MigrationDecision::FullRebuild
        } else {
            MigrationDecision::CanonicalReparse
        };
    }
    let visual_manifest_changed = state
        .visual_schema_version
        .is_some_and(|value| value != CURRENT_VISUAL_SCHEMA_VERSION)
        || state
            .visual_prompt_version
            .is_some_and(|value| value != CURRENT_VISUAL_PROMPT_VERSION);
    if visual_manifest_changed {
        return if has_catalog_without_blocks {
            MigrationDecision::FullRebuild
        } else {
            MigrationDecision::CanonicalReparse
        };
    }
    let visual_projection_changed = state
        .visual_projection_version
        .is_some_and(|value| value != CURRENT_VISUAL_PROJECTION_VERSION);
    if visual_projection_changed {
        return if state.existing_blocks > 0 {
            MigrationDecision::BlockAnchorRebuild
        } else if state.existing_items > 0 {
            MigrationDecision::FullRebuild
        } else {
            MigrationDecision::SchemaOnly
        };
    }
    if state
        .chunk_anchor_rule_version
        .is_some_and(|value| value != CURRENT_CHUNK_ANCHOR_RULE_VERSION)
    {
        return if state.existing_blocks > 0 {
            MigrationDecision::BlockAnchorRebuild
        } else if state.existing_items > 0 {
            MigrationDecision::FullRebuild
        } else {
            MigrationDecision::SchemaOnly
        };
    }
    if state.index_format_version != Some(CURRENT_INDEX_FORMAT_VERSION) {
        return if state.existing_blocks > 0 {
            MigrationDecision::FtsRebuild
        } else if state.existing_items > 0 {
            MigrationDecision::FullRebuild
        } else {
            MigrationDecision::SchemaOnly
        };
    }
    if state.schema_version != Some(CURRENT_SCHEMA_VERSION)
        || state.rerank_policy_version != Some(CURRENT_RERANK_POLICY_VERSION)
        || state.canonical_schema_version.is_none()
        || state.parser_pipeline_version.is_none()
        || state.chunk_anchor_rule_version.is_none()
        || state.index_format_version.is_none()
        || state.visual_schema_version.is_none()
        || state.visual_prompt_version.is_none()
        || state.visual_projection_version.is_none()
    {
        MigrationDecision::SchemaOnly
    } else {
        MigrationDecision::Current
    }
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
            == Some(CURRENT_PARSER_PIPELINE_VERSION)
        && meta_value(&conn, META_VISUAL_SCHEMA_VERSION)?.as_deref()
            == Some(CURRENT_VISUAL_SCHEMA_VERSION)
        && meta_value(&conn, META_VISUAL_PROMPT_VERSION)?.as_deref()
            == Some(CURRENT_VISUAL_PROMPT_VERSION))
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
    set_meta_value(
        conn,
        META_VISUAL_SCHEMA_VERSION,
        CURRENT_VISUAL_SCHEMA_VERSION,
    )?;
    set_meta_value(
        conn,
        META_VISUAL_PROMPT_VERSION,
        CURRENT_VISUAL_PROMPT_VERSION,
    )?;
    set_meta_value(
        conn,
        META_VISUAL_PROJECTION_VERSION,
        CURRENT_VISUAL_PROJECTION_VERSION,
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

    #[test]
    fn rerank_policy_change_is_schema_only() {
        let decision = plan_migration_from_versions(MigrationVersionState {
            existing_blocks: 10,
            existing_items: 2,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            index_format_version: Some(CURRENT_INDEX_FORMAT_VERSION),
            canonical_schema_version: Some(CURRENT_CANONICAL_SCHEMA_VERSION),
            parser_pipeline_version: Some(CURRENT_PARSER_PIPELINE_VERSION),
            chunk_anchor_rule_version: Some(CURRENT_CHUNK_ANCHOR_RULE_VERSION),
            rerank_policy_version: Some("old"),
            visual_schema_version: Some(CURRENT_VISUAL_SCHEMA_VERSION),
            visual_prompt_version: Some(CURRENT_VISUAL_PROMPT_VERSION),
            visual_projection_version: Some(CURRENT_VISUAL_PROJECTION_VERSION),
        });
        assert_eq!(decision, MigrationDecision::SchemaOnly);
    }

    #[test]
    fn index_format_change_rebuilds_fts_without_parser_when_blocks_exist() {
        let decision = plan_migration_from_versions(MigrationVersionState {
            existing_blocks: 10,
            existing_items: 2,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            index_format_version: Some("old"),
            canonical_schema_version: Some(CURRENT_CANONICAL_SCHEMA_VERSION),
            parser_pipeline_version: Some(CURRENT_PARSER_PIPELINE_VERSION),
            chunk_anchor_rule_version: Some(CURRENT_CHUNK_ANCHOR_RULE_VERSION),
            rerank_policy_version: Some(CURRENT_RERANK_POLICY_VERSION),
            visual_schema_version: Some(CURRENT_VISUAL_SCHEMA_VERSION),
            visual_prompt_version: Some(CURRENT_VISUAL_PROMPT_VERSION),
            visual_projection_version: Some(CURRENT_VISUAL_PROJECTION_VERSION),
        });
        assert_eq!(decision, MigrationDecision::FtsRebuild);
    }

    #[test]
    fn catalog_without_blocks_requires_full_rebuild() {
        let decision = plan_migration_from_versions(MigrationVersionState {
            existing_blocks: 0,
            existing_items: 2,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            index_format_version: Some("old"),
            canonical_schema_version: Some(CURRENT_CANONICAL_SCHEMA_VERSION),
            parser_pipeline_version: Some(CURRENT_PARSER_PIPELINE_VERSION),
            chunk_anchor_rule_version: Some(CURRENT_CHUNK_ANCHOR_RULE_VERSION),
            rerank_policy_version: Some(CURRENT_RERANK_POLICY_VERSION),
            visual_schema_version: Some(CURRENT_VISUAL_SCHEMA_VERSION),
            visual_prompt_version: Some(CURRENT_VISUAL_PROMPT_VERSION),
            visual_projection_version: Some(CURRENT_VISUAL_PROJECTION_VERSION),
        });
        assert_eq!(decision, MigrationDecision::FullRebuild);
    }

    #[test]
    fn visual_prompt_change_requires_canonical_reparse() {
        let decision = plan_migration_from_versions(MigrationVersionState {
            existing_blocks: 10,
            existing_items: 2,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            index_format_version: Some(CURRENT_INDEX_FORMAT_VERSION),
            canonical_schema_version: Some(CURRENT_CANONICAL_SCHEMA_VERSION),
            parser_pipeline_version: Some(CURRENT_PARSER_PIPELINE_VERSION),
            chunk_anchor_rule_version: Some(CURRENT_CHUNK_ANCHOR_RULE_VERSION),
            rerank_policy_version: Some(CURRENT_RERANK_POLICY_VERSION),
            visual_schema_version: Some(CURRENT_VISUAL_SCHEMA_VERSION),
            visual_prompt_version: Some("old"),
            visual_projection_version: Some(CURRENT_VISUAL_PROJECTION_VERSION),
        });
        assert_eq!(decision, MigrationDecision::CanonicalReparse);
    }

    #[test]
    fn visual_projection_change_rebuilds_blocks_only() {
        let decision = plan_migration_from_versions(MigrationVersionState {
            existing_blocks: 10,
            existing_items: 2,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            index_format_version: Some(CURRENT_INDEX_FORMAT_VERSION),
            canonical_schema_version: Some(CURRENT_CANONICAL_SCHEMA_VERSION),
            parser_pipeline_version: Some(CURRENT_PARSER_PIPELINE_VERSION),
            chunk_anchor_rule_version: Some(CURRENT_CHUNK_ANCHOR_RULE_VERSION),
            rerank_policy_version: Some(CURRENT_RERANK_POLICY_VERSION),
            visual_schema_version: Some(CURRENT_VISUAL_SCHEMA_VERSION),
            visual_prompt_version: Some(CURRENT_VISUAL_PROMPT_VERSION),
            visual_projection_version: Some("old"),
        });
        assert_eq!(decision, MigrationDecision::BlockAnchorRebuild);
    }

    #[test]
    fn missing_visual_versions_are_schema_only() {
        let decision = plan_migration_from_versions(MigrationVersionState {
            existing_blocks: 10,
            existing_items: 2,
            schema_version: Some(CURRENT_SCHEMA_VERSION),
            index_format_version: Some(CURRENT_INDEX_FORMAT_VERSION),
            canonical_schema_version: Some(CURRENT_CANONICAL_SCHEMA_VERSION),
            parser_pipeline_version: Some(CURRENT_PARSER_PIPELINE_VERSION),
            chunk_anchor_rule_version: Some(CURRENT_CHUNK_ANCHOR_RULE_VERSION),
            rerank_policy_version: Some(CURRENT_RERANK_POLICY_VERSION),
            visual_schema_version: None,
            visual_prompt_version: None,
            visual_projection_version: None,
        });
        assert_eq!(decision, MigrationDecision::SchemaOnly);
    }
}
