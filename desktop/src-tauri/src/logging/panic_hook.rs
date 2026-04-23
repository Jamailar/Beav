use super::config::LoggingConfig;
use super::event::{
    DiagnosticReportRecord, LogBuildMetadata, LogEventRecord, LogLevel, LogPrivacy, LogSource,
    RuntimeStateReceipt,
};
use super::upload_queue::{ensure_report_dirs, persist_report, runtime_state_path};
use serde_json::json;
use std::fs;
use std::path::Path;

pub fn load_runtime_state(root: &Path) -> Option<RuntimeStateReceipt> {
    let path = runtime_state_path(root);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn mark_runtime_started(root: &Path) -> Result<bool, String> {
    ensure_report_dirs(root)?;
    let previous_unclean = load_runtime_state(root)
        .map(|value| value.unclean_shutdown)
        .unwrap_or(false);
    let next = RuntimeStateReceipt {
        boot_id: crate::make_id("boot"),
        started_at: crate::now_iso(),
        unclean_shutdown: true,
    };
    let serialized = serde_json::to_string_pretty(&next).map_err(|error| error.to_string())?;
    fs::write(runtime_state_path(root), serialized).map_err(|error| error.to_string())?;
    Ok(previous_unclean)
}

pub fn mark_runtime_clean_shutdown(root: &Path) -> Result<(), String> {
    ensure_report_dirs(root)?;
    let mut state = load_runtime_state(root).unwrap_or(RuntimeStateReceipt {
        boot_id: crate::make_id("boot"),
        started_at: crate::now_iso(),
        unclean_shutdown: true,
    });
    state.unclean_shutdown = false;
    let serialized = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(runtime_state_path(root), serialized).map_err(|error| error.to_string())
}

pub fn install_panic_hook(
    root: std::path::PathBuf,
    config: LoggingConfig,
    build: LogBuildMetadata,
) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .map(|value| value.to_string())
            .or_else(|| panic_info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let location = panic_info
            .location()
            .map(|value| format!("{}:{}", value.file(), value.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let record = LogEventRecord {
            ts: crate::now_iso(),
            level: LogLevel::Error,
            source: LogSource::Crash,
            category: "crash".to_string(),
            event: "panic".to_string(),
            message: message.clone(),
            session_id: None,
            task_id: None,
            runtime_mode: None,
            provider: None,
            model: None,
            endpoint: None,
            transport: None,
            http_status: None,
            retryable: Some(false),
            fields: json!({
                "location": location,
                "backtrace": std::backtrace::Backtrace::force_capture().to_string(),
            }),
            build: build.clone(),
            privacy: LogPrivacy::Local,
        };
        let path = root.join("logs").join("current").join("crash.ndjson");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(line) = serde_json::to_string(&record) {
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut file| {
                    use std::io::Write;
                    file.write_all(line.as_bytes())?;
                    file.write_all(b"\n")
                });
        }
        let report = DiagnosticReportRecord {
            id: crate::make_id("diagnostic-report"),
            trigger: "panic".to_string(),
            status: "pending".to_string(),
            created_at: crate::now_iso(),
            updated_at: crate::now_iso(),
            summary: format!("panic at {location}: {message}"),
            include_advanced_context: false,
            last_error: Some(message),
            uploaded_at: None,
            last_attempt_at: None,
            dedupe_key: None,
            bundle_file_name: None,
            metadata: json!({
                "location": location,
                "panic": true,
            }),
        };
        let _ = ensure_report_dirs(&root);
        let _ = persist_report(&root, "pending", &report);
        let _ = mark_runtime_clean_shutdown(&root);
        let _ = config;
        previous(panic_info);
    }));
}
