use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::AppState;
use crate::persistence::with_store_mut;

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
                if let Some(execution) = store
                    .redclaw_job_executions
                    .iter_mut()
                    .find(|item| item.id == execution_id)
                {
                    if matches!(execution.status.as_str(), "leased" | "running") {
                        execution.last_heartbeat_at = Some(now.clone());
                        execution.updated_at = now.clone();
                        return Ok(true);
                    }
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
