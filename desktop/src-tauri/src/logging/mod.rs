pub mod config;
pub mod event;
pub mod file_sink;
pub mod memory_sink;
pub mod panic_hook;
pub mod redaction;
pub mod report_builder;
pub mod upload_queue;

use self::config::{logging_config_from_settings, LoggingConfig};
use self::event::{
    DiagnosticReportRecord, DiagnosticsUploadResponse, LogBuildMetadata, LogEventRecord, LogLevel,
    LogPrivacy, LogSource,
};
use self::file_sink::{spawn_file_sink, FileSinkHandle};
use self::memory_sink::RecentLogBuffer;
use self::panic_hook::{install_panic_hook, mark_runtime_clean_shutdown, mark_runtime_started};
use self::redaction::{redact_json_local, redact_text_local};
use self::report_builder::{
    build_report_bundle, create_pending_report, create_startup_recovery_report, feedback_log_text,
};
use self::upload_queue::{
    delete_report, ensure_report_dirs, list_reports, load_report, move_report, persist_report,
    upload_response_value,
};
use crate::{with_store, AppState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::State;

pub struct LoggingRuntime {
    root: PathBuf,
    config: LoggingConfig,
    build: LogBuildMetadata,
    file_sink: FileSinkHandle,
    recent: RecentLogBuffer,
    previous_unclean_shutdown: bool,
}

static GLOBAL_LOGGING_RUNTIME: OnceLock<Arc<LoggingRuntime>> = OnceLock::new();

fn build_metadata() -> LogBuildMetadata {
    LogBuildMetadata {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        channel: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
        build_type: "tauri".to_string(),
        git_commit: option_env!("GIT_COMMIT_HASH").map(ToString::to_string),
    }
}

impl LoggingRuntime {
    pub fn init(root: PathBuf, settings: &Value) -> Result<Arc<Self>, String> {
        ensure_report_dirs(&root)?;
        let config = logging_config_from_settings(settings);
        let build = build_metadata();
        let previous_unclean_shutdown = mark_runtime_started(&root)?;
        let file_sink = spawn_file_sink(root.clone(), config.clone());
        let runtime = Arc::new(Self {
            root: root.clone(),
            config: config.clone(),
            build: build.clone(),
            file_sink,
            recent: RecentLogBuffer::new(config.recent_preview_limit),
            previous_unclean_shutdown,
        });
        let _ = GLOBAL_LOGGING_RUNTIME.set(runtime.clone());
        install_panic_hook(root, config, build);
        Ok(runtime)
    }

    pub fn global() -> Option<Arc<Self>> {
        GLOBAL_LOGGING_RUNTIME.get().cloned()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config(&self) -> &LoggingConfig {
        &self.config
    }

    pub fn previous_unclean_shutdown(&self) -> bool {
        self.previous_unclean_shutdown
    }

    pub fn emit(&self, mut record: LogEventRecord, preview_line: Option<String>) {
        record.build = self.build.clone();
        record.fields = redact_json_local(&record.fields, self.config.local_raw_body_limit);
        let preview = preview_line.unwrap_or_else(|| {
            format!(
                "{} | [{}][{}] {}",
                record.ts,
                record.category,
                record.event,
                redact_text_local(&record.message, 320)
            )
        });
        self.recent.push(preview);
        self.file_sink.write(record);
    }

    pub fn recent_lines(&self, limit: usize) -> Vec<String> {
        self.recent.list(limit)
    }
}

pub fn initialize_logging(root: PathBuf, settings: &Value) -> Result<Arc<LoggingRuntime>, String> {
    LoggingRuntime::init(root, settings)
}

pub fn mark_clean_shutdown_global() {
    if let Some(runtime) = LoggingRuntime::global() {
        let _ = mark_runtime_clean_shutdown(runtime.root());
    }
}

pub fn emit_log_record(record: LogEventRecord, preview_line: Option<String>) {
    if let Some(runtime) = LoggingRuntime::global() {
        runtime.emit(record, preview_line);
    }
}

pub fn emit_legacy_line(
    source: LogSource,
    level: LogLevel,
    category: &str,
    event: &str,
    line: String,
    fields: Value,
    preview_line: Option<String>,
) {
    let record = LogEventRecord {
        ts: crate::now_iso(),
        level,
        source,
        category: category.to_string(),
        event: event.to_string(),
        message: line.clone(),
        session_id: None,
        task_id: None,
        runtime_mode: None,
        provider: None,
        model: None,
        endpoint: None,
        transport: None,
        http_status: None,
        retryable: None,
        fields,
        build: build_metadata(),
        privacy: LogPrivacy::Local,
    };
    emit_log_record(record, preview_line.or(Some(line)));
}

pub fn log_renderer_event(
    level: LogLevel,
    category: &str,
    event: &str,
    message: &str,
    fields: Value,
) {
    emit_log_record(
        LogEventRecord {
            ts: crate::now_iso(),
            level,
            source: LogSource::Renderer,
            category: category.to_string(),
            event: event.to_string(),
            message: message.to_string(),
            session_id: None,
            task_id: None,
            runtime_mode: None,
            provider: None,
            model: None,
            endpoint: None,
            transport: None,
            http_status: None,
            retryable: None,
            fields,
            build: build_metadata(),
            privacy: LogPrivacy::Local,
        },
        None,
    );
}

pub fn status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let Some(runtime) = LoggingRuntime::global() else {
        return Ok(json!({
            "enabled": false,
        }));
    };
    let pending = list_reports(runtime.root(), "pending");
    Ok(json!({
        "enabled": true,
        "logDirectory": runtime.root().join("logs").display().to_string(),
        "reportDirectory": runtime.root().join("diagnostic-reports").display().to_string(),
        "retentionDays": runtime.config().retention_days,
        "maxFileMb": runtime.config().max_file_mb,
        "recentPreviewLimit": runtime.config().recent_preview_limit,
        "reportUploadTargetBytes": runtime.config().report_upload_target_bytes,
        "uploadConfigured": runtime.config().upload_endpoint.is_some(),
        "uploadEndpoint": runtime.config().upload_endpoint.clone(),
        "pendingCount": pending.len(),
        "debugVerboseEnabled": settings
            .get("debug_log_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "previousUncleanShutdown": runtime.previous_unclean_shutdown(),
    }))
}

pub fn recent_value(limit: usize) -> Value {
    let lines = LoggingRuntime::global()
        .map(|runtime| runtime.recent_lines(limit))
        .unwrap_or_default();
    json!({ "lines": lines })
}

pub fn create_report_from_trigger(
    state: &State<'_, AppState>,
    trigger: &str,
    summary: &str,
    include_advanced_context: bool,
    metadata: Value,
) -> Result<DiagnosticReportRecord, String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    let config = logging_config_from_settings(&settings);
    create_pending_report(
        runtime.root(),
        state,
        &config,
        trigger,
        summary,
        include_advanced_context,
        metadata,
    )
}

pub fn create_startup_recovery_report_if_needed(
    state: &State<'_, AppState>,
) -> Result<Option<DiagnosticReportRecord>, String> {
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    if !runtime.previous_unclean_shutdown() {
        return Ok(None);
    }
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let config = logging_config_from_settings(&settings);
    create_startup_recovery_report(runtime.root(), state, &config).map(Some)
}

pub fn export_bundle_for_report(
    state: &State<'_, AppState>,
    report_id: &str,
) -> Result<PathBuf, String> {
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let config = logging_config_from_settings(&settings);
    let report = load_report(runtime.root(), "pending", report_id)?;
    let bundle = build_report_bundle(runtime.root(), state, &config, &report)?;
    let mut updated = report.clone();
    updated.bundle_file_name = bundle
        .file_name()
        .map(|item| item.to_string_lossy().to_string());
    updated.updated_at = crate::now_iso();
    persist_report(runtime.root(), "pending", &updated)?;
    Ok(bundle)
}

pub fn list_pending_reports_value() -> Result<Value, String> {
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    Ok(Value::Array(
        list_reports(runtime.root(), "pending")
            .into_iter()
            .map(|report| upload_response_value(&report))
            .collect(),
    ))
}

pub fn dismiss_pending_report(report_id: &str) -> Result<Value, String> {
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    delete_report(runtime.root(), "pending", report_id)?;
    Ok(json!({ "success": true, "reportId": report_id }))
}

pub fn update_upload_consent(
    state: &State<'_, AppState>,
    consent: &str,
    auto_send_same_crash: bool,
) -> Result<Value, String> {
    crate::with_store_mut(state, |store| {
        let object = store
            .settings
            .as_object_mut()
            .ok_or_else(|| "settings object unavailable".to_string())?;
        object.insert("diagnostics_upload_consent".to_string(), json!(consent));
        object.insert(
            "diagnostics_auto_send_same_crash".to_string(),
            json!(auto_send_same_crash),
        );
        object.insert(
            "diagnostics_last_prompted_at".to_string(),
            json!(crate::now_iso()),
        );
        Ok(())
    })?;
    Ok(json!({ "success": true }))
}

pub fn upload_pending_report(
    state: &State<'_, AppState>,
    report_id: &str,
) -> Result<Value, String> {
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let config = logging_config_from_settings(&settings);
    let endpoint = config
        .upload_endpoint
        .clone()
        .ok_or_else(|| "No diagnostics report endpoint configured".to_string())?;
    let mut report = load_report(runtime.root(), "pending", report_id)?;
    let bundle = if let Some(file_name) = report.bundle_file_name.clone() {
        runtime
            .root()
            .join("diagnostic-reports")
            .join("export")
            .join(file_name)
    } else {
        export_bundle_for_report(state, report_id)?
    };
    let metadata_value = json!({
        "reportId": report.id,
        "trigger": report.trigger,
        "createdAt": report.created_at,
        "summary": report.summary,
        "metadata": report.metadata,
        "app": crate::app_brand_display_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "channel": if cfg!(debug_assertions) { "debug" } else { "release" },
        "buildType": "tauri",
    });
    let metadata_text =
        serde_json::to_string(&metadata_value).map_err(|error| error.to_string())?;
    let bundle_bytes = std::fs::read(&bundle).map_err(|error| error.to_string())?;
    let response = tauri::async_runtime::block_on(async move {
        let form = reqwest::multipart::Form::new()
            .text("metadata", metadata_text)
            .part(
                "bundle",
                reqwest::multipart::Part::bytes(bundle_bytes)
                    .file_name(format!("{}.zip", report_id))
                    .mime_str("application/zip")
                    .map_err(|error| error.to_string())?,
            );
        let client = reqwest::Client::new();
        let response = client
            .post(endpoint)
            .multipart(form)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let body = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "diagnostics upload failed: HTTP {} {}",
                status.as_u16(),
                body
            ));
        }
        serde_json::from_str::<DiagnosticsUploadResponse>(&body).map_err(|error| error.to_string())
    })?;
    report.status = "uploaded".to_string();
    report.updated_at = crate::now_iso();
    report.uploaded_at = Some(crate::now_iso());
    report.last_attempt_at = Some(crate::now_iso());
    report.dedupe_key = Some(response.dedupe_key.clone());
    move_report(runtime.root(), "pending", "uploaded", &report)?;
    Ok(json!({
        "success": true,
        "report": report,
        "response": response,
    }))
}

pub fn create_feedback_report(
    state: &State<'_, AppState>,
    title: &str,
    content: &str,
    category: &str,
    priority: &str,
    source: &str,
    include_advanced_context: bool,
    metadata: Value,
) -> Result<(DiagnosticReportRecord, String), String> {
    let settings = with_store(state, |store| Ok(store.settings.clone()))?;
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    let config = logging_config_from_settings(&settings);
    let log_text = feedback_log_text(runtime.root(), &config);
    let report = create_pending_report(
        runtime.root(),
        state,
        &config,
        "user_feedback",
        title,
        include_advanced_context,
        json!({
            "kind": "user_feedback",
            "title": title,
            "content": content,
            "category": category,
            "priority": priority,
            "source": source,
            "submittedAt": crate::now_iso(),
            "feedback": metadata,
        }),
    )?;
    Ok((report, log_text))
}

pub fn mark_feedback_report_uploaded(
    report_id: &str,
    response: Value,
) -> Result<DiagnosticReportRecord, String> {
    let runtime =
        LoggingRuntime::global().ok_or_else(|| "Logging runtime unavailable".to_string())?;
    let mut report = load_report(runtime.root(), "pending", report_id)?;
    report.status = "uploaded".to_string();
    report.updated_at = crate::now_iso();
    report.uploaded_at = Some(crate::now_iso());
    report.last_attempt_at = Some(crate::now_iso());
    if let Some(dedupe_key) = response
        .get("dedupe_key")
        .or_else(|| response.get("dedupeKey"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        report.dedupe_key = Some(dedupe_key.to_string());
    }
    report.metadata = json!({
        "original": report.metadata,
        "officialFeedbackResponse": response,
    });
    move_report(runtime.root(), "pending", "uploaded", &report)?;
    Ok(report)
}
