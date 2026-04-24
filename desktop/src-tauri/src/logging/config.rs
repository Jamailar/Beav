use serde_json::Value;

pub const DEFAULT_RELEASE_LOG_RETENTION_DAYS: usize = 7;
pub const DEFAULT_RELEASE_LOG_MAX_FILE_MB: usize = 10;
pub const DEFAULT_LOG_ARCHIVE_FILES_PER_SINK: usize = 5;
pub const DEFAULT_REPORT_TIME_WINDOW_MINUTES: i64 = 10;
pub const DEFAULT_LOCAL_RAW_BODY_LIMIT: usize = 16 * 1024;
pub const DEFAULT_UPLOAD_RAW_BODY_LIMIT: usize = 4 * 1024;
pub const DEFAULT_REPORT_BUNDLE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_REPORT_UPLOAD_TARGET_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct LoggingConfig {
    pub retention_days: usize,
    pub max_file_mb: usize,
    pub archive_files_per_sink: usize,
    pub recent_preview_limit: usize,
    pub report_time_window_minutes: i64,
    pub local_raw_body_limit: usize,
    pub upload_raw_body_limit: usize,
    pub report_bundle_limit_bytes: usize,
    pub report_upload_target_bytes: usize,
    pub upload_endpoint: Option<String>,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            retention_days: DEFAULT_RELEASE_LOG_RETENTION_DAYS,
            max_file_mb: DEFAULT_RELEASE_LOG_MAX_FILE_MB,
            archive_files_per_sink: DEFAULT_LOG_ARCHIVE_FILES_PER_SINK,
            recent_preview_limit: 200,
            report_time_window_minutes: DEFAULT_REPORT_TIME_WINDOW_MINUTES,
            local_raw_body_limit: DEFAULT_LOCAL_RAW_BODY_LIMIT,
            upload_raw_body_limit: DEFAULT_UPLOAD_RAW_BODY_LIMIT,
            report_bundle_limit_bytes: DEFAULT_REPORT_BUNDLE_LIMIT_BYTES,
            report_upload_target_bytes: DEFAULT_REPORT_UPLOAD_TARGET_BYTES,
            upload_endpoint: option_env!("REDBOX_DIAGNOSTICS_REPORT_URL")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
        }
    }
}

fn settings_number(settings: &Value, key: &str) -> Option<usize> {
    settings.get(key).and_then(|value| {
        value
            .as_u64()
            .map(|item| item as usize)
            .or_else(|| value.as_i64().map(|item| item.max(0) as usize))
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|item| item.trim().parse::<usize>().ok())
            })
    })
}

pub fn logging_config_from_settings(settings: &Value) -> LoggingConfig {
    let mut config = LoggingConfig::default();
    config.retention_days = settings_number(settings, "release_log_retention_days")
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RELEASE_LOG_RETENTION_DAYS);
    config.max_file_mb = settings_number(settings, "release_log_max_file_mb")
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RELEASE_LOG_MAX_FILE_MB);
    config.upload_endpoint = settings
        .get("diagnostics_report_endpoint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or(config.upload_endpoint);
    config
}
