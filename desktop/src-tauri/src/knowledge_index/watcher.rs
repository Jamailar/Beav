use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

use crate::{knowledge_index::jobs, workspace_root, AppState};

const WATCH_DEBOUNCE_MS: u64 = 1200;

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
        let mut watched_root: Option<PathBuf> = None;
        let mut dirty_at: Option<Instant> = Some(Instant::now());

        loop {
            let state = app.state::<AppState>();
            let current_root = workspace_root(&state)
                .ok()
                .map(|root| root.join("knowledge"))
                .filter(|root| root.exists());

            if current_root != watched_root {
                if let Some(previous) = watched_root.as_ref() {
                    let _ = watcher.unwatch(previous);
                }
                if let Some(next_root) = current_root.as_ref() {
                    if let Err(error) = watcher.watch(next_root, RecursiveMode::Recursive) {
                        eprintln!("[RedBox knowledge index] watch failed: {error}");
                    } else {
                        if let Ok(mut runtime) = state.knowledge_index_state.lock() {
                            runtime.watched_root = Some(next_root.clone());
                        }
                        dirty_at = Some(Instant::now());
                    }
                }
                watched_root = current_root;
            }

            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(Ok(_event)) => {
                    dirty_at = Some(Instant::now());
                }
                Ok(Err(error)) => {
                    eprintln!("[RedBox knowledge index] watch event error: {error}");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if let Some(last_dirty_at) = dirty_at {
                if last_dirty_at.elapsed() >= Duration::from_millis(WATCH_DEBOUNCE_MS) {
                    jobs::schedule_rebuild(&app, "watcher");
                    dirty_at = None;
                }
            }
        }
    });
}
