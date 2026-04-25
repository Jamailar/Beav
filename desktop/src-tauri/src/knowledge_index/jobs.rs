use tauri::{AppHandle, Manager, State};

use crate::{
    knowledge_index::{
        document_blocks::rebuild_fts_index,
        index_status,
        indexer::rebuild_catalog,
        migration::{self, MigrationDecision},
        schema::ensure_catalog_ready,
    },
    AppState,
};

#[derive(Debug, Clone, Copy)]
enum RebuildJobKind {
    FullCatalog,
    FtsOnly,
}

impl RebuildJobKind {
    fn reason(self) -> &'static str {
        match self {
            Self::FullCatalog => "full_rebuild",
            Self::FtsOnly => "fts_rebuild",
        }
    }

    fn migration_decision(self) -> MigrationDecision {
        match self {
            Self::FullCatalog => MigrationDecision::FullRebuild,
            Self::FtsOnly => MigrationDecision::FtsRebuild,
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
        return Ok(false);
    }
    runtime.pending_count = 1;
    runtime.pending_rebuild_reason = Some(reason.to_string());
    runtime.migration_status = Some("migration_pending".to_string());
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
            runtime.migration_status = None;
            runtime.pending_rebuild_reason = None;
        }
        Err(error) => {
            runtime.failed_count += 1;
            runtime.last_error = Some(error);
            runtime.migration_status = Some("stale_fallback".to_string());
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
        let result = match kind {
            RebuildJobKind::FullCatalog => rebuild_catalog(&app, &state),
            RebuildJobKind::FtsOnly => rebuild_fts_index(&state),
        };
        match &result {
            Ok(_) => {
                if let Err(error) =
                    migration::mark_rebuild_success(&state, kind.migration_decision())
                {
                    eprintln!("[RedBox knowledge index] mark migration success failed: {error}");
                }
            }
            Err(error) => {
                if let Err(mark_error) =
                    migration::mark_rebuild_error(&state, kind.migration_decision(), error)
                {
                    eprintln!("[RedBox knowledge index] mark migration error failed: {mark_error}");
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

pub(crate) fn schedule_rebuild(app: &AppHandle, _reason: &str) {
    let state = app.state::<AppState>();
    match mark_pending(&state, "full_rebuild") {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::FullCatalog),
        Ok(false) => {}
        Err(error) => eprintln!("[RedBox knowledge index] mark pending failed: {error}"),
    }
}

fn schedule_fts_rebuild(app: &AppHandle) {
    let state = app.state::<AppState>();
    match mark_pending(&state, "fts_rebuild") {
        Ok(true) => spawn_rebuild(app.clone(), RebuildJobKind::FtsOnly),
        Ok(false) => {}
        Err(error) => eprintln!("[RedBox knowledge index] mark fts pending failed: {error}"),
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
            schedule_fts_rebuild(app);
        }
        MigrationDecision::FullRebuild => {
            schedule_rebuild(app, "migration-full-rebuild");
            return Ok(());
        }
    }
    let status = index_status(state)?;
    if status.indexed_count == 0 && !status.is_building {
        schedule_rebuild(app, "ensure-ready");
    }
    Ok(())
}
