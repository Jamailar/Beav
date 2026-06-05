use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::persistence::with_store_mut;
use crate::store::redclaw as redclaw_store;
use crate::AppState;

pub struct ExecutionHeartbeat {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ExecutionHeartbeat {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            join.abort();
        }
    }
}

pub fn start_execution_heartbeat(
    app: &AppHandle,
    execution_id: String,
    interval: Duration,
) -> ExecutionHeartbeat {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let app_handle = app.clone();
    let join = tauri::async_runtime::spawn(async move {
        while !thread_stop.load(Ordering::Relaxed) {
            tokio::time::sleep(interval).await;
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            let state = app_handle.state::<AppState>();
            let now = crate::now_iso();
            let result = with_store_mut(&state, |store| {
                if let Some(updated) =
                    redclaw_store::update_job_execution(store, &execution_id, |execution| {
                        if matches!(execution.status.as_str(), "leased" | "running") {
                            execution.last_heartbeat_at = Some(now.clone());
                            execution.updated_at = now.clone();
                            return true;
                        }
                        false
                    })
                {
                    return Ok(updated);
                }
                Ok(false)
            });
            if !matches!(result, Ok(true)) {
                break;
            }
        }
    });

    ExecutionHeartbeat {
        stop,
        join: Some(join),
    }
}
