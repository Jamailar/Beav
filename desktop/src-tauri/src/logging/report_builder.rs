use super::config::LoggingConfig;
use super::event::DiagnosticReportRecord;
use super::redaction::{redact_json_for_upload, redact_text_for_upload};
use super::upload_queue::{ensure_report_dirs, export_dir, persist_report};
use crate::{AppState, build_runtime_diagnostics_summary, now_iso};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::State;

const MIN_UPLOAD_LOG_SLICE_BYTES: usize = 16 * 1024;
const UPLOAD_BUNDLE_RESERVED_BYTES: usize = 256 * 1024;
const ADVANCED_CONTEXT_RESERVED_BYTES: usize = 256 * 1024;

fn current_log_path(root: &Path, sink_name: &str) -> PathBuf {
    root.join("logs")
        .join("current")
        .join(format!("{sink_name}.ndjson"))
}

fn within_window(line: &str, now_unix_ms: i128, window_minutes: i64) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let Some(ts) = value.get("ts").and_then(Value::as_str) else {
        return false;
    };
    let Ok(parsed) =
        time::OffsetDateTime::parse(ts, &time::format_description::well_known::Rfc3339)
    else {
        return false;
    };
    let delta = now_unix_ms.saturating_sub(parsed.unix_timestamp_nanos() / 1_000_000);
    delta <= (window_minutes.max(1) as i128) * 60 * 1000
}

fn log_slice(root: &Path, sink_name: &str, config: &LoggingConfig) -> String {
    let path = current_log_path(root, sink_name);
    let Ok(raw) = fs::read_to_string(path) else {
        return String::new();
    };
    let now_unix_ms = crate::now_ms() as i128;
    let mut lines = raw
        .lines()
        .filter(|line| within_window(line, now_unix_ms, config.report_time_window_minutes))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        lines = raw
            .lines()
            .rev()
            .take(200)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
    }
    lines.join("\n")
}

pub fn feedback_log_text(root: &Path, config: &LoggingConfig) -> String {
    let limit = upload_log_slice_limit(config, false);
    let host_logs = redact_text_for_upload(&log_slice(root, "host", config), limit / 2);
    let renderer_logs = redact_text_for_upload(&log_slice(root, "renderer", config), limit / 2);
    format!(
        "[host]\n{}\n\n[renderer]\n{}",
        host_logs.trim(),
        renderer_logs.trim()
    )
    .trim()
    .to_string()
}

fn build_advanced_context(state: &State<'_, AppState>) -> Value {
    let Ok(store) = state.store.lock() else {
        return Value::Null;
    };
    let session_trace = store
        .session_transcript_records
        .iter()
        .rev()
        .take(200)
        .cloned()
        .collect::<Vec<_>>();
    let task_trace = store
        .runtime_task_traces
        .iter()
        .rev()
        .take(200)
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "sessionTrace": session_trace,
        "taskTrace": task_trace,
    })
}

fn redaction_manifest() -> Value {
    json!({
        "version": 1,
        "policies": [
            "authorization_removed",
            "api_key_removed",
            "cookie_removed",
            "path_redacted",
            "raw_body_truncated"
        ]
    })
}

fn upload_log_slice_limit(config: &LoggingConfig, include_advanced_context: bool) -> usize {
    let reserved_bytes = UPLOAD_BUNDLE_RESERVED_BYTES
        + if include_advanced_context {
            ADVANCED_CONTEXT_RESERVED_BYTES
        } else {
            0
        };
    let per_sink_budget = config
        .report_upload_target_bytes
        .saturating_sub(reserved_bytes)
        / 2;
    per_sink_budget
        .max(MIN_UPLOAD_LOG_SLICE_BYTES)
        .min(config.report_bundle_limit_bytes)
}

pub fn bundle_path(root: &Path, report_id: &str) -> PathBuf {
    export_dir(root).join(format!("{}.zip", crate::slug_from_relative_path(report_id)))
}

pub fn build_report_bundle(
    root: &Path,
    state: &State<'_, AppState>,
    config: &LoggingConfig,
    report: &DiagnosticReportRecord,
) -> Result<PathBuf, String> {
    ensure_report_dirs(root)?;
    let path = bundle_path(root, &report.id);
    let file = fs::File::create(&path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let runtime_summary = build_runtime_diagnostics_summary(state)?;
    let upload_log_limit = upload_log_slice_limit(config, report.include_advanced_context);
    let upload_report = redact_json_for_upload(
        &json!({
            "report": report,
            "hostLogWindowMinutes": config.report_time_window_minutes,
            "targetUploadBytes": config.report_upload_target_bytes,
        }),
        config.upload_raw_body_limit,
    );

    let host_logs = redact_text_for_upload(&log_slice(root, "host", config), upload_log_limit);
    let renderer_logs =
        redact_text_for_upload(&log_slice(root, "renderer", config), upload_log_limit);

    zip.start_file("report.json", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&upload_report)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    )
    .map_err(|error| error.to_string())?;

    zip.start_file("host.ndjson", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(host_logs.as_bytes())
        .map_err(|error| error.to_string())?;

    zip.start_file("renderer.ndjson", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(renderer_logs.as_bytes())
        .map_err(|error| error.to_string())?;

    zip.start_file("runtime-summary.json", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&redact_json_for_upload(
            &runtime_summary,
            config.upload_raw_body_limit,
        ))
        .map_err(|error| error.to_string())?
        .as_bytes(),
    )
    .map_err(|error| error.to_string())?;

    if report.include_advanced_context {
        zip.start_file("advanced-context.json", options)
            .map_err(|error| error.to_string())?;
        zip.write_all(
            serde_json::to_string_pretty(&redact_json_for_upload(
                &build_advanced_context(state),
                config.upload_raw_body_limit,
            ))
            .map_err(|error| error.to_string())?
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    }

    zip.start_file("redaction-manifest.json", options)
        .map_err(|error| error.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&redaction_manifest())
            .map_err(|error| error.to_string())?
            .as_bytes(),
    )
    .map_err(|error| error.to_string())?;

    zip.finish().map_err(|error| error.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::upload_log_slice_limit;
    use crate::logging::config::LoggingConfig;

    #[test]
    fn upload_target_caps_per_sink_log_budget() {
        let config = LoggingConfig {
            report_bundle_limit_bytes: 8 * 1024 * 1024,
            report_upload_target_bytes: 2 * 1024 * 1024,
            ..LoggingConfig::default()
        };

        let without_advanced = upload_log_slice_limit(&config, false);
        let with_advanced = upload_log_slice_limit(&config, true);

        assert_eq!(without_advanced, 917_504);
        assert_eq!(with_advanced, 786_432);
        assert!(with_advanced < without_advanced);
    }

    #[test]
    fn report_bundle_limit_remains_the_hard_upper_bound() {
        let config = LoggingConfig {
            report_bundle_limit_bytes: 128 * 1024,
            report_upload_target_bytes: 16 * 1024 * 1024,
            ..LoggingConfig::default()
        };

        assert_eq!(upload_log_slice_limit(&config, false), 128 * 1024);
    }
}

pub fn create_pending_report(
    root: &Path,
    state: &State<'_, AppState>,
    config: &LoggingConfig,
    trigger: &str,
    summary: &str,
    include_advanced_context: bool,
    metadata: Value,
) -> Result<DiagnosticReportRecord, String> {
    let report = DiagnosticReportRecord {
        id: crate::make_id("diagnostic-report"),
        trigger: trigger.to_string(),
        status: "pending".to_string(),
        created_at: now_iso(),
        updated_at: now_iso(),
        summary: summary.to_string(),
        include_advanced_context,
        last_error: metadata
            .get("error")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        uploaded_at: None,
        last_attempt_at: None,
        dedupe_key: None,
        bundle_file_name: None,
        metadata,
    };
    let bundle = build_report_bundle(root, state, config, &report)?;
    let mut persisted = report.clone();
    persisted.bundle_file_name = bundle
        .file_name()
        .map(|item| item.to_string_lossy().to_string());
    persist_report(root, "pending", &persisted)?;
    Ok(persisted)
}

pub fn create_startup_recovery_report(
    root: &Path,
    state: &State<'_, AppState>,
    config: &LoggingConfig,
) -> Result<DiagnosticReportRecord, String> {
    create_pending_report(
        root,
        state,
        config,
        "startup_recovery",
        "Detected previous unclean shutdown",
        false,
        json!({
            "reason": "previous_unclean_shutdown",
            "createdAt": now_iso(),
        }),
    )
}
