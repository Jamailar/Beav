use std::thread;

use tauri::{AppHandle, Manager, State};

use crate::{
    knowledge_index::{index_status, indexer::rebuild_catalog, schema::ensure_catalog_ready},
    AppState,
};

fn mark_pending(state: &State<'_, AppState>) -> Result<bool, String> {
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    if runtime.is_building {
        runtime.pending_rebuild = true;
        runtime.pending_count = 1;
        return Ok(false);
    }
    runtime.pending_count = 1;
    Ok(true)
}

fn begin_build(state: &State<'_, AppState>) -> Result<bool, String> {
    let mut runtime = state
        .knowledge_index_state
        .lock()
        .map_err(|_| "knowledge index state lock 已损坏".to_string())?;
    if runtime.is_building {
        runtime.pending_rebuild = true;
        runtime.pending_count = 1;
        return Ok(false);
    }
    runtime.is_building = true;
    runtime.pending_count = 0;
    runtime.last_error = None;
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
        }
        Err(error) => {
            runtime.failed_count += 1;
            runtime.last_error = Some(error);
        }
    }
    Ok(rerun)
}

fn spawn_rebuild(app: AppHandle) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        match begin_build(&state) {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                eprintln!("[RedBox knowledge index] begin build failed: {error}");
                return;
            }
        }
        let result = rebuild_catalog(&app, &state);
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
    match mark_pending(&state) {
        Ok(true) => spawn_rebuild(app.clone()),
        Ok(false) => {}
        Err(error) => eprintln!("[RedBox knowledge index] mark pending failed: {error}"),
    }
}

pub(crate) fn ensure_catalog_ready_async(
    app: &AppHandle,
    state: &State<'_, AppState>,
    _reason: &str,
) -> Result<(), String> {
    ensure_catalog_ready(state)?;
    let status = index_status(state)?;
    if status.indexed_count == 0 && !status.is_building {
        schedule_rebuild(app, "ensure-ready");
    }
    Ok(())
}
