use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, RecursiveMode, Watcher, recommended_watcher};
use tauri::{AppHandle, Manager};

use crate::{
    AppState,
    knowledge_index::{document_blocks::is_visual_candidate_path, jobs},
    with_store, workspace_root,
};

const WATCH_DEBOUNCE_MS: u64 = 1200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchDirtyKind {
    CatalogOnly,
    FullRebuild,
}

fn desired_watch_roots(app: &AppHandle) -> Vec<PathBuf> {
    let state = app.state::<AppState>();
    let mut roots = Vec::<PathBuf>::new();
    if let Ok(root) = workspace_root(&state).map(|root| root.join("knowledge")) {
        if root.exists() {
            roots.push(root);
        }
    }
    let source_roots = with_store(&state, |store| {
        Ok(store
            .document_sources
            .iter()
            .map(|item| PathBuf::from(&item.root_path))
            .collect::<Vec<_>>())
    })
    .unwrap_or_default();
    for root in source_roots {
        if root.exists() && !roots.iter().any(|item| item == &root) {
            roots.push(root);
        }
    }
    let advisor_roots = with_store(&state, |store| {
        Ok(store
            .advisors
            .iter()
            .filter_map(|item| crate::advisor_knowledge_dir(&state, &item.id).ok())
            .collect::<Vec<_>>())
    })
    .unwrap_or_default();
    for root in advisor_roots {
        if root.exists() && !roots.iter().any(|item| item == &root) {
            roots.push(root);
        }
    }
    roots.sort();
    roots
}

fn classify_event(app: &AppHandle, event: &Event) -> WatchDirtyKind {
    let state = app.state::<AppState>();
    let Ok(knowledge_root) = workspace_root(&state).map(|root| root.join("knowledge")) else {
        return WatchDirtyKind::FullRebuild;
    };
    let redbook_root = knowledge_root.join("redbook");
    let youtube_root = knowledge_root.join("youtube");
    if event.paths.is_empty() {
        return WatchDirtyKind::FullRebuild;
    }
    if event
        .paths
        .iter()
        .any(|path| is_visual_candidate_path(path))
    {
        return WatchDirtyKind::FullRebuild;
    }
    let all_catalog_paths = event
        .paths
        .iter()
        .all(|path| path.starts_with(&redbook_root) || path.starts_with(&youtube_root));
    if all_catalog_paths {
        WatchDirtyKind::CatalogOnly
    } else {
        WatchDirtyKind::FullRebuild
    }
}

pub(crate) fn start(app: AppHandle) {
    thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = match recommended_watcher(tx) {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("[RedBox knowledge index] watcher init failed: {error}");
                return;
            }
        };
        let mut watched_roots: Vec<PathBuf> = Vec::new();
        let mut dirty_at: Option<Instant> = Some(Instant::now());
        let mut dirty_kind = WatchDirtyKind::CatalogOnly;

        loop {
            let state = app.state::<AppState>();
            let current_roots = desired_watch_roots(&app);

            if current_roots != watched_roots {
                for previous in &watched_roots {
                    let _ = watcher.unwatch(previous);
                }
                for next_root in &current_roots {
                    if let Err(error) = watcher.watch(next_root, RecursiveMode::Recursive) {
                        eprintln!("[RedBox knowledge index] watch failed: {error}");
                    }
                }
                if let Ok(mut runtime) = state.knowledge_index_state.lock() {
                    runtime.watched_roots = current_roots.clone();
                }
                watched_roots = current_roots;
                dirty_at = Some(Instant::now());
                dirty_kind = WatchDirtyKind::CatalogOnly;
            }

            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(Ok(event)) => {
                    dirty_at = Some(Instant::now());
                    if classify_event(&app, &event) == WatchDirtyKind::FullRebuild {
                        dirty_kind = WatchDirtyKind::FullRebuild;
                    }
                }
                Ok(Err(error)) => {
                    eprintln!("[RedBox knowledge index] watch event error: {error}");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if let Some(last_dirty_at) = dirty_at {
                if last_dirty_at.elapsed() >= Duration::from_millis(WATCH_DEBOUNCE_MS) {
                    match dirty_kind {
                        WatchDirtyKind::CatalogOnly => {
                            jobs::refresh_catalog_async(&app, "watcher-catalog");
                            jobs::schedule_visual_backfill(&app, "watcher-visual")
                        }
                        WatchDirtyKind::FullRebuild => jobs::schedule_rebuild(&app, "watcher"),
                    }
                    dirty_at = None;
                    dirty_kind = WatchDirtyKind::CatalogOnly;
                }
            }
        }
    });
}
