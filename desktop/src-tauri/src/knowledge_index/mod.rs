pub mod canonical_store;
pub mod catalog;
pub mod citation_anchors;
pub mod document_blocks;
#[cfg(test)]
pub mod evaluation;
pub mod fingerprint;
pub mod hybrid;
pub mod indexer;
pub mod jobs;
pub mod migration;
pub mod query_profile;
pub mod retrieval_audit;
pub mod schema;
pub mod tantivy_index;
pub mod watcher;

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{now_iso, with_store, workspace_root, AppState};

#[derive(Debug, Clone, Default)]
pub(crate) struct KnowledgeIndexRuntimeState {
    pub is_building: bool,
    pub pending_rebuild: bool,
    pub pending_count: usize,
    pub failed_count: usize,
    pub rebuild_progress: Option<f64>,
    pub last_indexed_at: Option<String>,
    pub last_error: Option<String>,
    pub migration_status: Option<String>,
    pub pending_rebuild_reason: Option<String>,
    pub watched_roots: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeCatalogStatus {
    pub indexed_count: i64,
    pub pending_count: usize,
    pub failed_count: usize,
    pub rebuild_progress: Option<f64>,
    pub last_indexed_at: Option<String>,
    pub is_building: bool,
    pub last_error: Option<String>,
    pub migration_status: Option<String>,
    pub pending_rebuild_reason: Option<String>,
}

pub(crate) fn workspace_id(state: &State<'_, AppState>) -> Result<String, String> {
    with_store(state, |store| Ok(store.active_space_id.clone()))
}

pub(crate) fn catalog_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(workspace_root(state)?.join(".redbox").join("index"))
}

pub(crate) fn catalog_db_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(catalog_root(state)?.join("knowledge_catalog.sqlite"))
}

pub(crate) fn initialize(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    schema::ensure_catalog_ready(state)?;
    jobs::ensure_catalog_ready_async(app, state, "app-setup")?;
    watcher::start(app.clone());
    Ok(())
}

pub(crate) fn index_status(state: &State<'_, AppState>) -> Result<KnowledgeCatalogStatus, String> {
    let indexed_count = catalog::count_items(state)?;
    let runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?
        .clone();
    Ok(KnowledgeCatalogStatus {
        indexed_count,
        pending_count: runtime.pending_count,
        failed_count: runtime.failed_count,
        rebuild_progress: runtime.rebuild_progress,
        last_indexed_at: runtime.last_indexed_at,
        is_building: runtime.is_building,
        last_error: runtime.last_error,
        migration_status: runtime.migration_status,
        pending_rebuild_reason: runtime.pending_rebuild_reason,
    })
}

pub(crate) fn delete_source_artifacts(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<(), String> {
    canonical_store::delete_documents_for_source(state, source_id)?;
    citation_anchors::delete_anchors_for_source(state, source_id)?;
    document_blocks::delete_blocks_for_source(state, source_id)?;
    retrieval_audit::delete_runs_for_source(state, source_id)?;
    Ok(())
}

pub(crate) fn mark_indexed_now(state: &State<'_, AppState>) -> Result<(), String> {
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    runtime.last_indexed_at = Some(now_iso());
    Ok(())
}

pub(crate) fn advisor_source_id(advisor_id: &str) -> String {
    format!("advisor:{advisor_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisor_source_id_is_stable() {
        assert_eq!(advisor_source_id("member-1"), "advisor:member-1");
    }
}
