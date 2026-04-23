use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogSource {
    Host,
    Renderer,
    Daemon,
    Crash,
    UploadQueue,
}

impl LogSource {
    pub fn sink_name(&self) -> &'static str {
        match self {
            Self::Host | Self::Daemon => "host",
            Self::Renderer => "renderer",
            Self::Crash => "crash",
            Self::UploadQueue => "upload-queue",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Renderer => "renderer",
            Self::Daemon => "daemon",
            Self::Crash => "crash",
            Self::UploadQueue => "upload_queue",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogPrivacy {
    Local,
    UploadRedacted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_tracing_level(&self) -> tracing::Level {
        match self {
            Self::Trace => tracing::Level::TRACE,
            Self::Debug => tracing::Level::DEBUG,
            Self::Info => tracing::Level::INFO,
            Self::Warn => tracing::Level::WARN,
            Self::Error => tracing::Level::ERROR,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogBuildMetadata {
    pub app_version: String,
    pub platform: String,
    pub channel: String,
    pub build_type: String,
    pub git_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEventRecord {
    pub ts: String,
    pub level: LogLevel,
    pub source: LogSource,
    pub category: String,
    pub event: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub fields: Value,
    pub build: LogBuildMetadata,
    pub privacy: LogPrivacy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReportRecord {
    pub id: String,
    pub trigger: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub summary: String,
    pub include_advanced_context: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploaded_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_file_name: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStateReceipt {
    pub boot_id: String,
    pub started_at: String,
    pub unclean_shutdown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsUploadResponse {
    pub report_id: String,
    pub received_at: String,
    pub retention_days: i64,
    pub dedupe_key: String,
}
