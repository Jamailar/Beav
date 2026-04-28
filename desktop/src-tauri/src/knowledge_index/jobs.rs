use tauri::{AppHandle, Manager, State};

use crate::{
    knowledge_index::{
        document_blocks::rebuild_fts_index_for_source,
        index_status,
        indexer::{
            backfill_incomplete_visual_index, rebuild_blocks_from_canonical, rebuild_catalog,
            rebuild_catalog_reusing_unchanged_canonical, refresh_catalog_summaries,
            visual_backfill_needed,
        },
        migration::{self, MigrationDecision},
        schema::ensure_catalog_ready,
    },
    AppState,
};

#[derive(Debug, Clone)]
enum RebuildJobKind {
    FullCatalog,
    FtsOnly { source_id: Option<String> },
    BlockAnchor { source_id: Option<String> },
    CanonicalReparse,
    VisualBackfill,
}

impl RebuildJobKind {
    fn reason(&self) -> &'static str {
        match self {
            Self::FullCatalog => "full_rebuild",
            Self::FtsOnly { .. } => "fts_rebuild",
            Self::BlockAnchor { .. } => "block_anchor_rebuild",
            Self::CanonicalReparse => "canonical_reparse",
            Self::VisualBackfill => "visual_backfill",
        }
    }

    fn migration_decision(&self) -> Option<MigrationDecision> {
        match self {
            Self::FullCatalog => Some(MigrationDecision::FullRebuild),
            Self::FtsOnly { .. } => Some(MigrationDecision::FtsRebuild),
            Self::BlockAnchor { .. } => Some(MigrationDecision::BlockAnchorRebuild),
            Self::CanonicalReparse => Some(MigrationDecision::CanonicalReparse),
            Self::VisualBackfill => None,
        }
    }
}

fn mark_pending(state: &State<'_, AppState>, reason: &str) -> Result<bool, String> {
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    if runtime.is_building {
        runtime.pending_rebuild = true;
        runtime.pending_count = 1;
        runtime.pending_rebuild_reason = Some(reason.to_string());
        runtime.migration_status = Some("rebuilding".to_string());
        runtime.rebuild_progress = Some(0.0);
        return Ok(false);
    }
    runtime.pending_count = 1;
    runtime.pending_rebuild_reason = Some(reason.to_string());
    runtime.migration_status = Some("migration_pending".to_string());
    runtime.rebuild_progress = Some(0.0);
    Ok(true)
}

fn begin_build(state: &State<'_, AppState>, reason: &str) -> Result<bool, String> {
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    if runtime.is_building {
        runtime.pending_rebuild = true;
        runtime.pending_count = 1;
        runtime.pending_rebuild_reason = Some(reason.to_string());
        return Ok(false);
    }
    runtime.is_building = true;
    runtime.pending_count = 0;
    runtime.last_error = None;
    runtime.migration_status = Some("rebuilding".to_string());
    runtime.pending_rebuild_reason = Some(reason.to_string());
    runtime.rebuild_progress = Some(0.05);
    Ok(true)
}

fn finish_build(state: &State<'_, AppState>, result: Result<(), String>) -> Result<bool, String> {
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    runtime.is_building = false;
    let rerun = runtime.pending_rebuild;
    runtime.pending_rebuild = false;
    runtime.pending_count = 0;
    match result {
        Ok(_) => {
            runtime.last_error = None;
            runtime.failed_count = 0;
            runtime.migration_status = None;
            runtime.pending_rebuild_reason = None;
            runtime.rebuild_progress = Some(1.0);
        }
        Err(error) => {
            runtime.failed_count += 1;
            runtime.last_error = Some(error);
            runtime.migration_status = Some("stale_fallback".to_string());
            runtime.rebuild_progress = Some(1.0);
        }
    }
    Ok(rerun)
}

fn spawn_rebuild(app: AppHandle, kind: RebuildJobKind) {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match begin_build(&state, kind.reason()) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                eprintln!("[RedBox knowledge index] begin build failed: {error}");
                return;
            }
        }
        let result = match &kind {
            RebuildJobKind::FullCatalog => rebuild_catalog(&app, &state),
            RebuildJobKind::FtsOnly { source_id } => {
                rebuild_fts_index_for_source(&state, source_id.as_deref())
            }
            RebuildJobKind::BlockAnchor { source_id } => {
                rebuild_blocks_from_canonical(&app, &state, source_id.as_deref())
            }
            RebuildJobKind::CanonicalReparse => {
                rebuild_catalog_reusing_unchanged_canonical(&app, &state)
            }
            RebuildJobKind::VisualBackfill => backfill_incomplete_visual_index(&app, &state),
        };
        match &result {
            Ok(_) => {
                if let Some(decision) = kind.migration_decision() {
                    if let Err(error) = migration::mark_rebuild_success(&state, decision) {
                        eprintln!(
                            "[RedBox knowledge index] mark migration success failed: {error}"
                        );
                    }
                }
            }
            Err(error) => {
                if let Some(decision) = kind.migration_decision() {
                    if let Err(mark_error) = migration::mark_rebuild_error(&state, decision, error)
                    {
                        eprintln!(
                            "[RedBox knowledge index] mark migration error failed: {mark_error}"
                        );
                    }
                }
            }
        }
        let rerun = finish_build(&state, result.clone()).unwrap_or(false);
        if let Err(error) = result {
            eprintln!("[RedBox knowledge index] rebuild failed: {error}");
        }
        if rerun {
            schedule_rebuild(&app, "pending");
        }
    });
}

pub(crate) fn schedule_rebuild(app: &AppHandle, reason: &str) {
    let state = app.state::<AppState>();
    let reason = if reason.trim().is_empty() {
        "full_rebuild"
    } else {
        reason.trim()
    };
    match mark_pending(&state, reason) {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::FullCatalog),
        Ok(false) => {}
        Err(error) => eprintln!("[RedBox knowledge index] mark pending failed: {error}"),
    }
}

pub(crate) fn refresh_catalog_async(app: &AppHandle, reason: &str) {
    let app = app.clone();
    let reason = reason.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Err(error) = refresh_catalog_summaries(&app, &state) {
            let label = if reason.is_empty() {
                "catalog-refresh"
            } else {
                reason.as_str()
            };
            eprintln!("[RedBox knowledge index] {label} failed: {error}");
        }
    });
}

pub(crate) fn schedule_fts_rebuild(app: &AppHandle, source_id: Option<String>) {
    let state = app.state::<AppState>();
    match mark_pending(&state, "fts_rebuild") {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::FtsOnly { source_id }),
        Ok(false) => {}
        Err(error) => eprintln!("[RedBox knowledge index] mark fts pending failed: {error}"),
    }
}

pub(crate) fn schedule_block_anchor_rebuild(app: &AppHandle, source_id: Option<String>) {
    let state = app.state::<AppState>();
    match mark_pending(&state, "block_anchor_rebuild") {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::BlockAnchor { source_id }),
        Ok(false) => {}
        Err(error) => {
            eprintln!("[RedBox knowledge index] mark block-anchor pending failed: {error}")
        }
    }
}

pub(crate) fn schedule_canonical_reparse(app: &AppHandle) {
    let state = app.state::<AppState>();
    match mark_pending(&state, "canonical_reparse") {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::CanonicalReparse),
        Ok(false) => {}
        Err(error) => {
            eprintln!("[RedBox knowledge index] mark canonical reparse pending failed: {error}")
        }
    }
}

pub(crate) fn schedule_visual_backfill(app: &AppHandle, reason: &str) {
    let state = app.state::<AppState>();
    match visual_backfill_needed(&state) {
        Ok(false) => return,
        Ok(true) => {}
        Err(error) => {
            eprintln!("[RedBox knowledge index] visual backfill check failed: {error}");
            return;
        }
    }
    let reason = if reason.trim().is_empty() {
        "visual_backfill"
    } else {
        reason.trim()
    };
    match mark_pending(&state, reason) {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::VisualBackfill),
        Ok(false) => {}
        Err(error) => {
            eprintln!("[RedBox knowledge index] mark visual backfill pending failed: {error}")
        }
    }
}

pub(crate) fn ensure_catalog_ready_async(
    app: &AppHandle,
    state: &State<'_, AppState>,
    _reason: &str,
) -> Result<(), String> {
    ensure_catalog_ready(state)?;
    match migration::plan_migration(state)? {
        MigrationDecision::Current => {}
        MigrationDecision::SchemaOnly => {
            migration::mark_schema_current(state)?;
        }
        MigrationDecision::FtsRebuild => {
            schedule_fts_rebuild(app, None);
        }
        MigrationDecision::BlockAnchorRebuild => {
            schedule_block_anchor_rebuild(app, None);
        }
        MigrationDecision::CanonicalReparse => {
            schedule_canonical_reparse(app);
        }
        MigrationDecision::FullRebuild => {
            schedule_rebuild(app, "migration-full-rebuild");
            return Ok(());
        }
    }
    let status = index_status(state)?;
    if status.indexed_count == 0 && !status.is_building {
        schedule_rebuild(app, "ensure-ready");
    } else {
        schedule_visual_backfill(app, "ensure-visual-backfill");
    }
    Ok(())
}
