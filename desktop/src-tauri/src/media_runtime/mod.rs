mod config;
mod followup;
mod types;

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::Duration;

use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::library::persist_media_workspace_catalog;
use crate::runtime::resolve_session_file_reference_inputs;
use crate::store::{media as media_store, settings as settings_store};
use crate::*;
use crate::{commands, with_store, with_store_mut, AppState};
use config::*;
pub use types::MediaGenerationRuntime;
use types::*;

static MEDIA_RUNTIME_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
const MEDIA_JOB_CANCEL_REQUESTED_ERROR: &str = "MEDIA_JOB_CANCEL_REQUESTED";

pub(crate) use followup::{
    spawn_media_job_followup, spawn_media_job_followup_for_kind, tick_media_followups,
};

fn media_runtime_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?.join(".redbox").join("media-runtime");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn media_runtime_db_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(media_runtime_root(state)?.join("media_jobs.sqlite"))
}

fn open_media_runtime_connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    let path = media_runtime_db_path(state)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS media_jobs (
                job_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                queue_mode TEXT NOT NULL DEFAULT 'ai_generation',
                priority TEXT NOT NULL,
                status TEXT NOT NULL,
                provider_key TEXT NOT NULL,
                provider_model TEXT,
                request_json TEXT NOT NULL,
                result_json TEXT,
                project_id TEXT,
                manuscript_path TEXT,
                video_project_path TEXT,
                owner_session_id TEXT,
                current_attempt_no INTEGER NOT NULL DEFAULT 1,
                cancel_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_media_jobs_status_priority_created
                ON media_jobs(status, priority, created_at, job_id);
            CREATE TABLE IF NOT EXISTS media_job_attempts (
                attempt_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                attempt_no INTEGER NOT NULL,
                status TEXT NOT NULL,
                provider_task_id TEXT,
                provider_status_url TEXT,
                idempotency_key TEXT NOT NULL,
                lease_owner TEXT,
                lease_expires_at INTEGER,
                next_poll_at INTEGER,
                retry_not_before_at INTEGER,
                last_error TEXT,
                response_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(job_id, attempt_no)
            );
            CREATE INDEX IF NOT EXISTS idx_media_job_attempts_job_attempt
                ON media_job_attempts(job_id, attempt_no);
            CREATE INDEX IF NOT EXISTS idx_media_job_attempts_due_poll
                ON media_job_attempts(next_poll_at, status, job_id);
            CREATE TABLE IF NOT EXISTS media_job_artifacts (
                artifact_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                relative_path TEXT,
                absolute_path TEXT,
                mime_type TEXT,
                preview_url TEXT,
                metadata_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_job_artifacts_job
                ON media_job_artifacts(job_id, created_at, artifact_id);
            CREATE TABLE IF NOT EXISTS media_job_events (
                event_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                attempt_id TEXT,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_job_events_job_created
                ON media_job_events(job_id, created_at, event_id);
            "#,
        )
        .map_err(|error| error.to_string())?;
    ensure_media_jobs_archive_columns(&connection)?;
    ensure_media_jobs_queue_mode_column(&connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_media_jobs_archived_updated ON media_jobs(archived_at, updated_at, job_id)",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_media_jobs_queue_mode_status_priority_created ON media_jobs(queue_mode, status, priority, created_at, job_id)",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_media_jobs_queue_mode_archived_updated ON media_jobs(queue_mode, archived_at, updated_at, job_id)",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn ensure_media_jobs_archive_columns(conn: &Connection) -> Result<(), String> {
    for (column, definition) in [
        (
            "archived_at",
            "ALTER TABLE media_jobs ADD COLUMN archived_at TEXT",
        ),
        (
            "archive_reason",
            "ALTER TABLE media_jobs ADD COLUMN archive_reason TEXT",
        ),
    ] {
        let exists = conn
            .prepare("PRAGMA table_info(media_jobs)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
                for row in rows {
                    if row? == column {
                        return Ok(true);
                    }
                }
                Ok(false)
            })
            .map_err(|error| error.to_string())?;
        if !exists {
            conn.execute(definition, [])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_media_jobs_queue_mode_column(conn: &Connection) -> Result<(), String> {
    let exists = conn
        .prepare("PRAGMA table_info(media_jobs)")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
            for row in rows {
                if row? == "queue_mode" {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|error| error.to_string())?;
    if !exists {
        conn.execute(
            "ALTER TABLE media_jobs ADD COLUMN queue_mode TEXT NOT NULL DEFAULT 'ai_generation'",
            [],
        )
        .map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE media_jobs
             SET queue_mode = CASE
                WHEN source = 'generation_studio'
                  AND owner_session_id IS NULL
                THEN 'free_creation'
                ELSE 'ai_generation'
             END",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn ensure_media_runtime_ready(state: &State<'_, AppState>) -> Result<(), String> {
    let _ = open_media_runtime_connection(state)?;
    Ok(())
}

pub(crate) fn media_runtime_pressure_snapshot(
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let conn = open_media_runtime_connection(state)?;
    let mut by_kind_status = Vec::<Value>::new();
    {
        let mut statement = conn
            .prepare(
                r#"
                SELECT kind, status, COUNT(*) AS count
                FROM media_jobs
                WHERE archived_at IS NULL
                GROUP BY kind, status
                ORDER BY kind ASC, status ASC
                "#,
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(json!({
                    "kind": row.get::<_, String>(0)?,
                    "status": row.get::<_, String>(1)?,
                    "count": row.get::<_, i64>(2)?,
                }))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            by_kind_status.push(row.map_err(|error| error.to_string())?);
        }
    }

    let now = now_i64();
    let due_video_polls = conn
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM media_jobs j
            JOIN media_job_attempts a
              ON a.job_id = j.job_id AND a.attempt_no = j.current_attempt_no
            WHERE j.kind = 'video'
              AND j.archived_at IS NULL
              AND j.status = 'polling'
              AND COALESCE(a.next_poll_at, 0) <= ?1
              AND COALESCE(a.retry_not_before_at, 0) <= ?1
              AND COALESCE(a.lease_expires_at, 0) <= ?1
            "#,
            params![now],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let leased_jobs = conn
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM media_jobs j
            JOIN media_job_attempts a
              ON a.job_id = j.job_id AND a.attempt_no = j.current_attempt_no
            WHERE COALESCE(a.lease_expires_at, 0) > ?1
              AND j.archived_at IS NULL
            "#,
            params![now],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let expired_leases = conn
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM media_jobs j
            JOIN media_job_attempts a
              ON a.job_id = j.job_id AND a.attempt_no = j.current_attempt_no
            WHERE COALESCE(a.lease_expires_at, 0) > 0
              AND COALESCE(a.lease_expires_at, 0) <= ?1
              AND j.archived_at IS NULL
            "#,
            params![now],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let dead_lettered_jobs = conn
        .query_row(
            "SELECT COUNT(*) FROM media_jobs WHERE archived_at IS NULL AND status = 'dead_lettered'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let oldest_queued_at = conn
        .query_row(
            "SELECT MIN(created_at) FROM media_jobs WHERE archived_at IS NULL AND status = 'queued'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| error.to_string())?;
    let oldest_queued_age_ms = oldest_queued_at
        .as_deref()
        .and_then(parse_timestamp_ms)
        .map(|created_at| now.saturating_sub(created_at));

    Ok(json!({
        "byKindStatus": by_kind_status,
        "dueVideoPolls": due_video_polls,
        "leasedJobs": leased_jobs,
        "expiredLeases": expired_leases,
        "deadLetteredJobs": dead_lettered_jobs,
        "oldestQueuedAt": oldest_queued_at,
        "oldestQueuedAgeMs": oldest_queued_age_ms,
        "limits": {
            "imageSubmitPerProvider": IMAGE_SUBMIT_LIMIT_PER_PROVIDER,
            "videoSubmitPerProvider": VIDEO_SUBMIT_LIMIT_PER_PROVIDER,
            "videoDownloadPerProvider": VIDEO_DOWNLOAD_LIMIT_PER_PROVIDER,
            "videoPollGlobal": VIDEO_POLL_LIMIT_GLOBAL,
            "dispatchTickMs": DISPATCH_TICK_MS,
            "mediaAwaitDefaultTimeoutMs": MEDIA_AWAIT_DEFAULT_TIMEOUT_MS,
            "videoProviderPollTimeoutMs": VIDEO_PROVIDER_POLL_TIMEOUT_MS,
        }
    }))
}

pub(crate) fn default_media_job_wait_timeout_ms() -> u64 {
    MEDIA_AWAIT_DEFAULT_TIMEOUT_MS
}

fn media_runtime_http_client() -> Result<&'static Client, String> {
    if let Some(client) = MEDIA_RUNTIME_HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let _ = MEDIA_RUNTIME_HTTP_CLIENT.set(client);
    MEDIA_RUNTIME_HTTP_CLIENT
        .get()
        .ok_or_else(|| "media runtime http client initialization failed".to_string())
}

async fn media_runtime_json_request(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    timeout: Option<Duration>,
) -> Result<HttpJsonResponse, String> {
    async fn attempt(
        client: &Client,
        method: &str,
        url: &str,
        api_key: Option<&str>,
        extra_headers: &[(&str, String)],
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<HttpJsonResponse, String> {
        let method =
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
        let mut request = client.request(method, url);
        if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
            request = request.bearer_auth(key);
        }
        for (header, value) in extra_headers {
            request = request.header(*header, value.as_str());
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| error.to_string())?;
        let body = if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text))
        };
        Ok(HttpJsonResponse { status, body })
    }

    let client = media_runtime_http_client()?;
    let initial = attempt(
        client,
        method,
        url,
        api_key,
        extra_headers,
        body.as_ref(),
        timeout,
    )
    .await?;
    if initial.status == 401 {
        if let Some(refreshed_api_key) =
            crate::try_refresh_official_auth_for_ai_request(url, api_key, "media-runtime-http-401")?
        {
            return attempt(
                client,
                method,
                url,
                Some(refreshed_api_key.as_str()),
                extra_headers,
                body.as_ref(),
                timeout,
            )
            .await;
        }
    }
    Ok(initial)
}

async fn media_runtime_bytes_request(
    method: &str,
    url: &str,
    api_key: Option<&str>,
    extra_headers: &[(&str, String)],
    body: Option<Value>,
    timeout: Option<Duration>,
) -> Result<Vec<u8>, String> {
    async fn attempt(
        client: &Client,
        method: &str,
        url: &str,
        api_key: Option<&str>,
        extra_headers: &[(&str, String)],
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Vec<u8>, String> {
        let method =
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
        let mut request = client.request(method, url);
        if let Some(key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
            request = request.bearer_auth(key);
        }
        for (header, value) in extra_headers {
            request = request.header(*header, value.as_str());
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {} {}", response.status().as_u16(), url));
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok(bytes.to_vec())
    }

    let client = media_runtime_http_client()?;
    match attempt(
        client,
        method,
        url,
        api_key,
        extra_headers,
        body.as_ref(),
        timeout,
    )
    .await
    {
        Ok(bytes) => Ok(bytes),
        Err(error) => {
            if error.starts_with("HTTP 401 ") {
                if let Some(refreshed_api_key) = crate::try_refresh_official_auth_for_ai_request(
                    url,
                    api_key,
                    "media-runtime-bytes-401",
                )? {
                    return attempt(
                        client,
                        method,
                        url,
                        Some(refreshed_api_key.as_str()),
                        extra_headers,
                        body.as_ref(),
                        timeout,
                    )
                    .await;
                }
            }
            Err(error)
        }
    }
}

fn json_to_text(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn parse_optional_json(value: Option<String>) -> Option<Value> {
    value
        .and_then(|item| serde_json::from_str::<Value>(&item).ok())
        .or(Some(Value::Null))
        .filter(|item| !item.is_null())
}

fn row_to_job(row: &rusqlite::Row<'_>) -> Result<MediaJobRecord, rusqlite::Error> {
    let request_json = row.get::<_, String>("request_json")?;
    let result_json = row.get::<_, Option<String>>("result_json")?;
    Ok(MediaJobRecord {
        job_id: row.get("job_id")?,
        kind: row.get("kind")?,
        source: row.get("source")?,
        queue_mode: row.get("queue_mode")?,
        priority: row.get("priority")?,
        status: row.get("status")?,
        provider_key: row.get("provider_key")?,
        provider_model: row.get("provider_model")?,
        request_json: serde_json::from_str(&request_json).unwrap_or(Value::Null),
        result_json: parse_optional_json(result_json),
        project_id: row.get("project_id")?,
        manuscript_path: row.get("manuscript_path")?,
        video_project_path: row.get("video_project_path")?,
        owner_session_id: row.get("owner_session_id")?,
        current_attempt_no: row.get("current_attempt_no")?,
        cancel_reason: row.get("cancel_reason")?,
        archived_at: row.get("archived_at")?,
        archive_reason: row.get("archive_reason")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        completed_at: row.get("completed_at")?,
    })
}

fn row_to_attempt(row: &rusqlite::Row<'_>) -> Result<MediaJobAttemptRecord, rusqlite::Error> {
    let response_json = row.get::<_, Option<String>>("response_json")?;
    Ok(MediaJobAttemptRecord {
        attempt_id: row.get("attempt_id")?,
        job_id: row.get("job_id")?,
        attempt_no: row.get("attempt_no")?,
        status: row.get("status")?,
        provider_task_id: row.get("provider_task_id")?,
        provider_status_url: row.get("provider_status_url")?,
        idempotency_key: row.get("idempotency_key")?,
        lease_owner: row.get("lease_owner")?,
        lease_expires_at: row.get("lease_expires_at")?,
        next_poll_at: row.get("next_poll_at")?,
        retry_not_before_at: row.get("retry_not_before_at")?,
        last_error: row.get("last_error")?,
        response_json: parse_optional_json(response_json),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_artifact(row: &rusqlite::Row<'_>) -> Result<MediaJobArtifactRecord, rusqlite::Error> {
    let metadata_json = row.get::<_, Option<String>>("metadata_json")?;
    Ok(MediaJobArtifactRecord {
        artifact_id: row.get("artifact_id")?,
        job_id: row.get("job_id")?,
        kind: row.get("kind")?,
        relative_path: row.get("relative_path")?,
        absolute_path: row.get("absolute_path")?,
        mime_type: row.get("mime_type")?,
        preview_url: row.get("preview_url")?,
        metadata_json: parse_optional_json(metadata_json),
        created_at: row.get("created_at")?,
    })
}

fn append_event_with_connection(
    conn: &Connection,
    job_id: &str,
    attempt_id: Option<&str>,
    event_type: &str,
    message: &str,
    payload: Option<&Value>,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO media_job_events (
            event_id, job_id, attempt_id, event_type, message, payload_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            make_id("media-job-event"),
            job_id,
            attempt_id,
            event_type,
            message,
            payload.map(json_to_text).transpose()?,
            now_iso(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_job_with_current_attempt(
    conn: &Connection,
    job_id: &str,
) -> Result<Option<LoadedJob>, String> {
    let job = conn
        .query_row(
            "SELECT * FROM media_jobs WHERE job_id = ?1",
            [job_id],
            row_to_job,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(job) = job else {
        return Ok(None);
    };
    let attempt = conn
        .query_row(
            r#"
            SELECT * FROM media_job_attempts
            WHERE job_id = ?1 AND attempt_no = ?2
            "#,
            params![job_id, job.current_attempt_no],
            row_to_attempt,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("attempt missing for job {}", job.job_id))?;
    Ok(Some(LoadedJob { job, attempt }))
}

fn load_artifacts_for_job(
    conn: &Connection,
    job_id: &str,
) -> Result<Vec<MediaJobArtifactRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT * FROM media_job_artifacts WHERE job_id = ?1 ORDER BY created_at ASC, artifact_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([job_id], row_to_artifact)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_recent_events_for_job(
    conn: &Connection,
    job_id: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare(
            "SELECT event_type, message, payload_json, created_at FROM media_job_events WHERE job_id = ?1 ORDER BY created_at DESC, event_id DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![job_id, limit as i64], |row| {
            Ok(json!({
                "eventType": row.get::<_, String>(0)?,
                "message": row.get::<_, String>(1)?,
                "payload": parse_optional_json(row.get::<_, Option<String>>(2)?),
                "createdAt": row.get::<_, String>(3)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn artifact_projection(record: &MediaJobArtifactRecord) -> Value {
    let mut value = json!({
        "artifactId": record.artifact_id,
        "jobId": record.job_id,
        "kind": record.kind,
        "relativePath": record.relative_path,
        "absolutePath": record.absolute_path,
        "mimeType": record.mime_type,
        "previewUrl": record.preview_url,
        "createdAt": record.created_at,
    });
    if let Some(metadata) = record.metadata_json.clone() {
        value["metadata"] = metadata;
    }
    value
}

fn job_projection(
    job: &MediaJobRecord,
    attempt: &MediaJobAttemptRecord,
    artifacts: &[MediaJobArtifactRecord],
    events: &[Value],
) -> Value {
    json!({
        "jobId": job.job_id,
        "kind": job.kind,
        "source": job.source,
        "queueMode": job.queue_mode,
        "priority": job.priority,
        "status": job.status,
        "providerKey": job.provider_key,
        "providerModel": job.provider_model,
        "request": job.request_json,
        "result": job.result_json,
        "projectId": job.project_id,
        "manuscriptPath": job.manuscript_path,
        "videoProjectPath": job.video_project_path,
        "ownerSessionId": job.owner_session_id,
        "cancelReason": job.cancel_reason,
        "archivedAt": job.archived_at,
        "archiveReason": job.archive_reason,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
        "completedAt": job.completed_at,
        "attempt": {
            "attemptId": attempt.attempt_id,
            "attemptNo": attempt.attempt_no,
            "status": attempt.status,
            "providerTaskId": attempt.provider_task_id,
            "providerStatusUrl": attempt.provider_status_url,
            "idempotencyKey": attempt.idempotency_key,
            "leaseOwner": attempt.lease_owner,
            "leaseExpiresAt": attempt.lease_expires_at,
            "nextPollAt": attempt.next_poll_at,
            "retryNotBeforeAt": attempt.retry_not_before_at,
            "lastError": attempt.last_error,
            "response": attempt.response_json,
            "createdAt": attempt.created_at,
            "updatedAt": attempt.updated_at,
        },
        "artifacts": artifacts.iter().map(artifact_projection).collect::<Vec<_>>(),
        "recentEvents": events,
    })
}

fn media_job_summary(
    job: &MediaJobRecord,
    attempt: &MediaJobAttemptRecord,
    artifact_count: i64,
) -> Value {
    let request = &job.request_json;
    let title = request
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            let count = request
                .get("imagePlanItems")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .or_else(|| {
                    request
                        .get("count")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                })
                .unwrap_or(1);
            match job.kind.as_str() {
                "image" if count > 1 => format!("图片生成 · {} 张", count),
                "image" => "图片生成".to_string(),
                "video" => "视频生成".to_string(),
                _ => "媒体生成".to_string(),
            }
        });
    let summary = request
        .get("prompt")
        .and_then(Value::as_str)
        .or_else(|| request.get("compiledPrompt").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(96).collect::<String>())
        .unwrap_or_else(|| title.clone());
    let progress_text = if job.kind == "image" {
        let completed_images = job
            .result_json
            .as_ref()
            .and_then(|value| value.pointer("/progress/completedImages"))
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or_else(|| artifact_count.max(0) as usize);
        let expected_images = job
            .result_json
            .as_ref()
            .and_then(|value| value.pointer("/progress/expectedImages"))
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .or_else(|| {
                request
                    .get("imagePlanItems")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
            })
            .or_else(|| {
                request
                    .get("count")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
            })
            .unwrap_or(completed_images.max(1));
        if completed_images > 0 && completed_images < expected_images {
            Some(format!("已生成 {completed_images}/{expected_images} 张"))
        } else {
            None
        }
    } else {
        None
    };
    let latest_text = attempt
        .last_error
        .clone()
        .or(progress_text)
        .or_else(|| {
            job.result_json
                .as_ref()
                .and_then(|value| value.get("error"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| match job.status.as_str() {
            "queued" => "等待执行".to_string(),
            "submitting" => "提交中".to_string(),
            "polling" => "轮询中".to_string(),
            "downloading" => "下载中".to_string(),
            "completed" => "已完成".to_string(),
            "failed" => "执行失败".to_string(),
            "cancel_requested" => "等待取消".to_string(),
            "cancelled" => "已取消".to_string(),
            _ => "处理中".to_string(),
        });
    json!({
        "jobId": job.job_id,
        "id": job.job_id,
        "kind": job.kind,
        "source": job.source,
        "queueMode": job.queue_mode,
        "priority": job.priority,
        "status": job.status,
        "providerKey": job.provider_key,
        "providerModel": job.provider_model,
        "title": title,
        "summary": summary,
        "latestText": latest_text,
        "ownerSessionId": job.owner_session_id,
        "projectId": job.project_id,
        "manuscriptPath": job.manuscript_path,
        "videoProjectPath": job.video_project_path,
        "cancelReason": job.cancel_reason,
        "archivedAt": job.archived_at,
        "archiveReason": job.archive_reason,
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
        "completedAt": job.completed_at,
        "attemptNo": attempt.attempt_no,
        "attemptStatus": attempt.status,
        "error": attempt.last_error,
        "artifactCount": artifact_count.max(0),
    })
}

fn get_job_projection_with_connection(conn: &Connection, job_id: &str) -> Result<Value, String> {
    let Some(loaded) = load_job_with_current_attempt(conn, job_id)? else {
        return Ok(Value::Null);
    };
    let artifacts = load_artifacts_for_job(conn, job_id)?;
    let events = load_recent_events_for_job(conn, job_id, 12)?;
    Ok(job_projection(
        &loaded.job,
        &loaded.attempt,
        &artifacts,
        &events,
    ))
}

pub(crate) fn get_media_job_projection(
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<Value, String> {
    let conn = open_media_runtime_connection(state)?;
    get_job_projection_with_connection(&conn, job_id)
}

fn artifact_count_for_job(conn: &Connection, job_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM media_job_artifacts WHERE job_id = ?1",
        params![job_id],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|error| error.to_string())
}

fn next_job_candidates(
    conn: &Connection,
    kind: &str,
    statuses: &[&str],
    due_poll_only: bool,
    limit: usize,
) -> Result<Vec<LoadedJob>, String> {
    if statuses.is_empty() {
        return Ok(Vec::new());
    }
    let now = now_i64();
    let quoted_statuses = statuses
        .iter()
        .map(|value| format!("'{}'", value.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    let poll_filter = if due_poll_only {
        format!(
            "AND COALESCE(a.next_poll_at, 0) <= {now} AND COALESCE(a.retry_not_before_at, 0) <= {now}"
        )
    } else {
        format!("AND COALESCE(a.retry_not_before_at, 0) <= {now}")
    };
    let sql = format!(
        r#"
        SELECT
            j.*,
            a.attempt_id AS a_attempt_id,
            a.job_id AS a_job_id,
            a.attempt_no AS a_attempt_no,
            a.status AS a_status,
            a.provider_task_id AS a_provider_task_id,
            a.provider_status_url AS a_provider_status_url,
            a.idempotency_key AS a_idempotency_key,
            a.lease_owner AS a_lease_owner,
            a.lease_expires_at AS a_lease_expires_at,
            a.next_poll_at AS a_next_poll_at,
            a.retry_not_before_at AS a_retry_not_before_at,
            a.last_error AS a_last_error,
            a.response_json AS a_response_json,
            a.created_at AS a_created_at,
            a.updated_at AS a_updated_at
        FROM media_jobs j
        JOIN media_job_attempts a
            ON a.job_id = j.job_id AND a.attempt_no = j.current_attempt_no
        WHERE j.kind = ?1
          AND j.archived_at IS NULL
          AND j.status IN ({quoted_statuses})
          AND COALESCE(a.lease_expires_at, 0) <= {now}
          {poll_filter}
        ORDER BY j.created_at ASC, j.job_id ASC
        LIMIT ?2
        "#,
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![kind, (limit * 4) as i64], |row| {
            let request_json = row.get::<_, String>("request_json")?;
            let result_json = row.get::<_, Option<String>>("result_json")?;
            let response_json = row.get::<_, Option<String>>("a_response_json")?;
            Ok(LoadedJob {
                job: MediaJobRecord {
                    job_id: row.get("job_id")?,
                    kind: row.get("kind")?,
                    source: row.get("source")?,
                    queue_mode: row.get("queue_mode")?,
                    priority: row.get("priority")?,
                    status: row.get("status")?,
                    provider_key: row.get("provider_key")?,
                    provider_model: row.get("provider_model")?,
                    request_json: serde_json::from_str(&request_json).unwrap_or(Value::Null),
                    result_json: parse_optional_json(result_json),
                    project_id: row.get("project_id")?,
                    manuscript_path: row.get("manuscript_path")?,
                    video_project_path: row.get("video_project_path")?,
                    owner_session_id: row.get("owner_session_id")?,
                    current_attempt_no: row.get("current_attempt_no")?,
                    cancel_reason: row.get("cancel_reason")?,
                    archived_at: row.get("archived_at")?,
                    archive_reason: row.get("archive_reason")?,
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    completed_at: row.get("completed_at")?,
                },
                attempt: MediaJobAttemptRecord {
                    attempt_id: row.get("a_attempt_id")?,
                    job_id: row.get("a_job_id")?,
                    attempt_no: row.get("a_attempt_no")?,
                    status: row.get("a_status")?,
                    provider_task_id: row.get("a_provider_task_id")?,
                    provider_status_url: row.get("a_provider_status_url")?,
                    idempotency_key: row.get("a_idempotency_key")?,
                    lease_owner: row.get("a_lease_owner")?,
                    lease_expires_at: row.get("a_lease_expires_at")?,
                    next_poll_at: row.get("a_next_poll_at")?,
                    retry_not_before_at: row.get("a_retry_not_before_at")?,
                    last_error: row.get("a_last_error")?,
                    response_json: parse_optional_json(response_json),
                    created_at: row.get("a_created_at")?,
                    updated_at: row.get("a_updated_at")?,
                },
            })
        })
        .map_err(|error| error.to_string())?;
    let loaded = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(weighted_priority_candidates(loaded, limit))
}

fn weighted_priority_candidates(candidates: Vec<LoadedJob>, limit: usize) -> Vec<LoadedJob> {
    if candidates.len() <= 1 || limit == 0 {
        return candidates.into_iter().take(limit).collect();
    }
    let mut free_interactive = VecDeque::new();
    let mut ai_interactive = VecDeque::new();
    let mut free_batch = VecDeque::new();
    let mut ai_batch = VecDeque::new();
    let mut free_background = VecDeque::new();
    let mut ai_background = VecDeque::new();
    for job in candidates {
        match (job.job.queue_mode.as_str(), job.job.priority.as_str()) {
            ("free_creation", "interactive") => free_interactive.push_back(job),
            (_, "interactive") => ai_interactive.push_back(job),
            ("free_creation", "batch") => free_batch.push_back(job),
            (_, "batch") => ai_batch.push_back(job),
            ("free_creation", _) => free_background.push_back(job),
            _ => ai_background.push_back(job),
        }
    }
    let mut ordered = Vec::with_capacity(limit.min(
        free_interactive.len()
            + ai_interactive.len()
            + free_batch.len()
            + ai_batch.len()
            + free_background.len()
            + ai_background.len(),
    ));
    let weights = [
        ("free_interactive", 5usize),
        ("ai_interactive", 3usize),
        ("free_batch", 2usize),
        ("ai_batch", 1usize),
        ("free_background", 1usize),
        ("ai_background", 1usize),
    ];
    while ordered.len() < limit
        && (!free_interactive.is_empty()
            || !ai_interactive.is_empty()
            || !free_batch.is_empty()
            || !ai_batch.is_empty()
            || !free_background.is_empty()
            || !ai_background.is_empty())
    {
        for (bucket, weight) in weights {
            for _ in 0..weight {
                if ordered.len() >= limit {
                    break;
                }
                let next = match bucket {
                    "free_interactive" => free_interactive.pop_front(),
                    "ai_interactive" => ai_interactive.pop_front(),
                    "free_batch" => free_batch.pop_front(),
                    "ai_batch" => ai_batch.pop_front(),
                    "free_background" => free_background.pop_front(),
                    _ => ai_background.pop_front(),
                };
                if let Some(job) = next {
                    ordered.push(job);
                }
            }
        }
    }
    ordered
}

fn update_job_and_attempt_status(
    conn: &Connection,
    loaded: &LoadedJob,
    next_status: &str,
    lease_owner: Option<&str>,
    lease_expires_at: Option<i64>,
    next_poll_at: Option<i64>,
    retry_not_before_at: Option<i64>,
    last_error: Option<&str>,
    response_json: Option<&Value>,
    completed: bool,
) -> Result<bool, String> {
    let expected_job_status = loaded.job.status.as_str();
    let expected_attempt_status = loaded.attempt.status.as_str();
    let now_iso = now_iso();
    let updated_jobs = conn
        .execute(
            r#"
            UPDATE media_jobs
            SET status = ?1,
                updated_at = ?2,
                completed_at = CASE WHEN ?3 = 1 THEN ?2 ELSE NULL END
            WHERE job_id = ?4 AND status = ?5
            "#,
            params![
                next_status,
                now_iso,
                if completed { 1 } else { 0 },
                loaded.job.job_id,
                expected_job_status,
            ],
        )
        .map_err(|error| error.to_string())?;
    if updated_jobs == 0 {
        return Ok(false);
    }
    conn.execute(
        r#"
        UPDATE media_job_attempts
        SET status = ?1,
            lease_owner = ?2,
            lease_expires_at = ?3,
            next_poll_at = ?4,
            retry_not_before_at = ?5,
            last_error = ?6,
            response_json = COALESCE(?7, response_json),
            updated_at = ?8
        WHERE attempt_id = ?9 AND status = ?10
        "#,
        params![
            next_status,
            lease_owner,
            lease_expires_at,
            next_poll_at,
            retry_not_before_at,
            last_error,
            response_json.map(json_to_text).transpose()?,
            now_iso,
            loaded.attempt.attempt_id,
            expected_attempt_status,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(true)
}

fn claim_job_for_stage(
    conn: &Connection,
    loaded: &LoadedJob,
    next_status: &str,
    lease_owner: &str,
    lease_expires_at: i64,
) -> Result<bool, String> {
    update_job_and_attempt_status(
        conn,
        loaded,
        next_status,
        Some(lease_owner),
        Some(lease_expires_at),
        loaded.attempt.next_poll_at,
        None,
        loaded.attempt.last_error.as_deref(),
        loaded.attempt.response_json.as_ref(),
        false,
    )
}

fn update_job_result_json(
    conn: &Connection,
    job_id: &str,
    result_json: &Value,
    completed: bool,
) -> Result<(), String> {
    let now_iso = now_iso();
    conn.execute(
        r#"
        UPDATE media_jobs
        SET result_json = ?1,
            updated_at = ?2,
            completed_at = CASE WHEN ?3 = 1 THEN ?2 ELSE completed_at END
        WHERE job_id = ?4
        "#,
        params![
            json_to_text(result_json)?,
            now_iso,
            if completed { 1 } else { 0 },
            job_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn set_attempt_details(
    conn: &Connection,
    loaded: &LoadedJob,
    next_status: &str,
    provider_task_id: Option<&str>,
    provider_status_url: Option<&str>,
    next_poll_at: Option<i64>,
    response_json: Option<&Value>,
    last_error: Option<&str>,
    clear_lease: bool,
) -> Result<(), String> {
    let now_iso = now_iso();
    conn.execute(
        r#"
        UPDATE media_jobs
        SET status = ?1, updated_at = ?2
        WHERE job_id = ?3
        "#,
        params![next_status, now_iso, loaded.job.job_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        UPDATE media_job_attempts
        SET status = ?1,
            provider_task_id = COALESCE(?2, provider_task_id),
            provider_status_url = COALESCE(?3, provider_status_url),
            lease_owner = CASE WHEN ?4 = 1 THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN ?4 = 1 THEN NULL ELSE lease_expires_at END,
            next_poll_at = ?5,
            retry_not_before_at = NULL,
            response_json = COALESCE(?6, response_json),
            last_error = ?7,
            updated_at = ?8
        WHERE attempt_id = ?9
        "#,
        params![
            next_status,
            provider_task_id,
            provider_status_url,
            if clear_lease { 1 } else { 0 },
            next_poll_at,
            response_json.map(json_to_text).transpose()?,
            last_error,
            now_iso,
            loaded.attempt.attempt_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn set_job_terminal_failure(
    conn: &Connection,
    loaded: &LoadedJob,
    status: &str,
    message: &str,
    result_json: Option<&Value>,
) -> Result<(), String> {
    let now_iso = now_iso();
    conn.execute(
        r#"
        UPDATE media_jobs
        SET status = ?1,
            cancel_reason = CASE WHEN ?1 = 'cancelled' THEN ?2 ELSE cancel_reason END,
            result_json = COALESCE(?3, result_json),
            updated_at = ?4,
            completed_at = ?4
        WHERE job_id = ?5
        "#,
        params![
            status,
            message,
            result_json.map(json_to_text).transpose()?,
            now_iso,
            loaded.job.job_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        UPDATE media_job_attempts
        SET status = ?1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_poll_at = NULL,
            retry_not_before_at = NULL,
            last_error = ?2,
            response_json = COALESCE(?3, response_json),
            updated_at = ?4
        WHERE attempt_id = ?5
        "#,
        params![
            status,
            message,
            result_json.map(json_to_text).transpose()?,
            now_iso,
            loaded.attempt.attempt_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn retry_policy_for_stage(stage: &str) -> Option<(&'static str, &'static str, usize, i64)> {
    match stage {
        "image-submit" => Some(("queued", "retry_image_submit", 3, 1_500)),
        "video-submit" => Some(("queued", "retry_video_submit", 3, 2_500)),
        "video-sequence-submit" => Some(("queued", "retry_video_sequence_submit", 2, 5_000)),
        "video-poll" => Some(("polling", "retry_video_poll", 120, 5_000)),
        "video-download" => Some(("downloading", "retry_video_download", 3, 2_500)),
        "audio-submit" => Some(("queued", "retry_audio_submit", 3, 1_500)),
        "audio-sequence-submit" => Some(("queued", "retry_audio_sequence_submit", 3, 1_500)),
        "voice-clone-submit" => Some(("queued", "retry_voice_clone_submit", 3, 2_500)),
        _ => None,
    }
}

fn is_non_retryable_media_error(stage: &str, message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("missing_provider_task_id")
        || normalized.contains("provider did not return")
        || normalized.contains("未返回 taskid")
        || normalized.contains("缺少 provider taskid")
    {
        return true;
    }
    if stage.starts_with("video-") {
        return normalized.contains("http 400")
            || normalized.contains("http 401")
            || normalized.contains("http 403")
            || normalized.contains("http 404")
            || normalized.contains("request too large")
            || normalized.contains("payload too large");
    }
    false
}

fn is_non_retryable_voice_clone_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("http 404")
        || normalized.contains("no active source available for this model")
}

fn schedule_stage_retry_or_dead_letter(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    message: &str,
    result_json: Option<&Value>,
) -> Result<(), String> {
    if stage == "voice-clone-submit" && is_non_retryable_voice_clone_error(message) {
        return fail_job(app, job_id, message, result_json);
    }
    if is_non_retryable_media_error(stage, message) {
        return fail_job(app, job_id, message, result_json);
    }
    let Some((next_status, retry_event_type, retry_limit, base_delay_ms)) =
        retry_policy_for_stage(stage)
    else {
        return fail_job(app, job_id, message, result_json);
    };
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Ok(());
    };
    let retry_count = conn
        .query_row(
            "SELECT COUNT(*) FROM media_job_events WHERE attempt_id = ?1 AND event_type = ?2",
            params![loaded.attempt.attempt_id, retry_event_type],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as usize;
    if retry_count >= retry_limit {
        set_job_terminal_failure(&conn, &loaded, "dead_lettered", message, result_json)?;
        append_event_with_connection(
            &conn,
            job_id,
            Some(&loaded.attempt.attempt_id),
            "dead_lettered",
            message,
            result_json,
        )?;
        emit_job_updated(app, &state, job_id);
        return Ok(());
    }
    let delay_ms = base_delay_ms.saturating_mul(1_i64 << retry_count.min(6));
    let retry_not_before_at = now_i64() + delay_ms;
    let now_iso = now_iso();
    conn.execute(
        r#"
        UPDATE media_jobs
        SET status = ?1, updated_at = ?2
        WHERE job_id = ?3
        "#,
        params![next_status, now_iso, job_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        UPDATE media_job_attempts
        SET status = ?1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_poll_at = CASE WHEN ?1 = 'polling' THEN COALESCE(next_poll_at, ?2) ELSE next_poll_at END,
            retry_not_before_at = ?2,
            last_error = ?3,
            response_json = COALESCE(?4, response_json),
            updated_at = ?5
        WHERE attempt_id = ?6
        "#,
        params![
            next_status,
            retry_not_before_at,
            message,
            result_json.map(json_to_text).transpose()?,
            now_iso,
            loaded.attempt.attempt_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&loaded.attempt.attempt_id),
        retry_event_type,
        &format!("Retrying {stage} after failure"),
        Some(&json!({
            "message": message,
            "retryCount": retry_count + 1,
            "retryLimit": retry_limit,
            "retryNotBeforeAt": retry_not_before_at,
        })),
    )?;
    emit_job_updated(app, &state, job_id);
    Ok(())
}

fn create_media_job_with_connection(
    conn: &Connection,
    kind: &str,
    source: &str,
    queue_mode: &str,
    priority: &str,
    provider_key: &str,
    provider_model: Option<&str>,
    payload: &Value,
    project_id: Option<&str>,
    manuscript_path: Option<&str>,
    video_project_path: Option<&str>,
    owner_session_id: Option<&str>,
) -> Result<String, String> {
    let job_id = make_id("media-job");
    let attempt_id = make_id("media-job-attempt");
    let idempotency_key = make_id("media-idempotency");
    let now_iso = now_iso();
    conn.execute(
        r#"
        INSERT INTO media_jobs (
            job_id, kind, source, queue_mode, priority, status, provider_key, provider_model,
            request_json, result_json, project_id, manuscript_path, video_project_path,
            owner_session_id, current_attempt_no, cancel_reason, created_at, updated_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12, 1, NULL, ?13, ?13, NULL)
        "#,
        params![
            job_id,
            kind,
            source,
            queue_mode,
            priority,
            provider_key,
            provider_model,
            json_to_text(payload)?,
            project_id,
            manuscript_path,
            video_project_path,
            owner_session_id,
            now_iso,
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        INSERT INTO media_job_attempts (
            attempt_id, job_id, attempt_no, status, provider_task_id, provider_status_url,
            idempotency_key, lease_owner, lease_expires_at, next_poll_at, retry_not_before_at,
            last_error, response_json, created_at, updated_at
        ) VALUES (?1, ?2, 1, 'queued', NULL, NULL, ?3, NULL, NULL, NULL, NULL, NULL, NULL, ?4, ?4)
        "#,
        params![attempt_id, job_id, idempotency_key, now_iso],
    )
    .map_err(|error| error.to_string())?;
    append_event_with_connection(
        conn,
        &job_id,
        Some(&attempt_id),
        "accepted",
        "Media generation job accepted",
        Some(payload),
    )?;
    Ok(job_id)
}

fn infer_job_source(payload: &Value) -> String {
    payload_string(payload, "source")
        .or_else(|| {
            if payload.get("videoProjectPath").is_some() || payload.get("manuscriptPath").is_some()
            {
                Some("manuscripts".to_string())
            } else if payload.get("toolCallId").is_some() || payload.get("sessionId").is_some() {
                Some("tool".to_string())
            } else {
                Some("generation_studio".to_string())
            }
        })
        .unwrap_or_else(|| "generation_studio".to_string())
}

fn infer_job_priority(source: &str, payload: &Value) -> String {
    payload_string(payload, "priority").unwrap_or_else(|| match source {
        "redclaw" => "batch".to_string(),
        "tool"
            if payload
                .get("waitForCompletion")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            "interactive".to_string()
        }
        "background" => "background".to_string(),
        _ => "interactive".to_string(),
    })
}

fn normalize_queue_mode(value: &str) -> Option<String> {
    match value.trim() {
        "free_creation" => Some("free_creation".to_string()),
        "ai_generation" => Some("ai_generation".to_string()),
        _ => None,
    }
}

fn infer_job_queue_mode(_source: &str, payload: &Value) -> String {
    payload_string(payload, "queueMode")
        .or_else(|| payload_string(payload, "queue_mode"))
        .and_then(|value| normalize_queue_mode(&value))
        .unwrap_or_else(|| "ai_generation".to_string())
}

fn looks_like_video_model_id(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    [
        "video",
        "text-to-video",
        "image-to-video",
        "t2v",
        "i2v",
        "r2v",
        "kling",
        "veo",
        "seedance",
        "hailuo",
        "runway",
    ]
    .iter()
    .any(|keyword| normalized.contains(keyword))
}

fn resolve_image_provider_model(
    configured_model: Option<String>,
    requested_model: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(model) = requested_model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
    {
        crate::append_debug_trace_global(format!(
            "[media-runtime] ignoring requested image model and using configured default requestedModel={}",
            model.trim()
        ));
    }
    let configured_model = normalize_optional_string(configured_model);
    if let Some(model) = configured_model.as_deref() {
        if looks_like_video_model_id(model) {
            return Err(format!(
                "图片生成配置无效：当前默认图片模型 `{model}` 看起来是视频模型。请到设置里改成图片模型。"
            ));
        }
    }
    Ok(configured_model)
}

fn route_model_from_settings(settings: &Value, scope: &str) -> Option<String> {
    payload_string(settings, "ai_model_routes_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|routes| {
            routes
                .get(scope)
                .and_then(|route| route.get("model").or_else(|| route.get("modelName")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn configured_image_model_from_settings(settings: &Value) -> Option<String> {
    route_model_from_settings(settings, "image").or_else(|| payload_string(settings, "image_model"))
}

fn ensure_image_model_settings(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    if configured_image_model_from_settings(&settings).is_some() {
        return Ok(settings);
    }

    crate::ai_model_manager::defaults::repair_missing_official_defaults_for_store(
        Some(app),
        state,
        "media-runtime-model-defaults-repair",
    )?;
    let repaired_settings =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let Some(model) = configured_image_model_from_settings(&repaired_settings) else {
        return Err("生图默认模型未初始化，请重新登录官方账号或在设置中选择生图模型".to_string());
    };
    if looks_like_video_model_id(&model) {
        return Err(format!(
            "图片生成配置无效：当前默认图片模型 `{model}` 看起来是视频模型。请到设置里改成图片模型。"
        ));
    }
    Ok(repaired_settings)
}

fn resolve_provider_metadata(
    app: &AppHandle,
    state: &State<'_, AppState>,
    kind: &str,
    payload: &Value,
) -> Result<(String, Option<String>), String> {
    let settings = if kind == "image" {
        ensure_image_model_settings(app, state)?
    } else {
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?
    };
    let provider = match kind {
        "image" => payload_string(payload, "provider")
            .or_else(|| payload_string(&settings, "image_provider"))
            .unwrap_or_else(|| "openai-compatible".to_string()),
        "audio" | "audio_sequence" | "voice_clone" => payload_string(payload, "provider")
            .or_else(|| payload_string(&settings, "voice_provider"))
            .or_else(|| payload_string(&settings, "tts_provider"))
            .unwrap_or_else(|| "voice".to_string()),
        "video_sequence" => payload_string(payload, "provider")
            .or_else(|| payload_string(&settings, "video_provider"))
            .unwrap_or_else(|| "redbox-official".to_string()),
        _ => payload_string(payload, "provider").unwrap_or_else(|| "redbox-official".to_string()),
    };
    let model = match kind {
        "image" => {
            let model = resolve_image_provider_model(
                configured_image_model_from_settings(&settings),
                payload_string(payload, "model"),
            )?;
            if model.is_none() {
                return Err(
                    "生图默认模型未初始化，请重新登录官方账号或在设置中选择生图模型".to_string(),
                );
            }
            model
        }
        "audio" | "audio_sequence" => {
            let route = crate::ai_model_manager::AiModelManager::resolve(
                &settings,
                crate::ai_model_manager::AiModelScope::VoiceTts,
                Some(payload),
            );
            normalize_optional_string(payload_string(payload, "model"))
                .or_else(|| {
                    route
                        .as_ref()
                        .map(|route| route.model_name.clone())
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| payload_string(&settings, "voice_tts_model"))
                .or_else(|| payload_string(&settings, "tts_model"))
        }
        "voice_clone" => {
            let route = crate::ai_model_manager::AiModelManager::resolve(
                &settings,
                crate::ai_model_manager::AiModelScope::VoiceClone,
                Some(payload),
            );
            normalize_optional_string(payload_string(payload, "model"))
                .or_else(|| {
                    route
                        .as_ref()
                        .map(|route| route.model_name.clone())
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| payload_string(&settings, "voice_clone_model"))
        }
        "video" if is_video_retalk_request(payload, None) => Some("videoretalk".to_string()),
        "video_sequence" if is_video_retalk_request(payload, None) => {
            Some("videoretalk".to_string())
        }
        _ => normalize_optional_string(payload_string(payload, "model")).or_else(|| {
            resolve_video_generation_settings_with_override(&settings, Some(payload))
                .map(|(_, _, model)| model)
        }),
    };
    Ok((provider, model))
}

fn is_video_retalk_request(payload: &Value, provider_model: Option<&str>) -> bool {
    let model = provider_model
        .map(ToString::to_string)
        .or_else(|| payload_string(payload, "model"))
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let mode = payload_string(payload, "generationMode")
        .or_else(|| payload_string(payload, "generation_mode"))
        .or_else(|| payload_string(payload, "mediaMode"))
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    model == "videoretalk" || mode == "video-retalk" || mode == "videoretalk"
}

fn payload_i64_any(payload: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        payload_field(payload, key).and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
        })
    })
}

fn video_sequence_requested(payload: &Value) -> bool {
    payload
        .get("videoSegments")
        .or_else(|| payload.get("segments"))
        .and_then(Value::as_array)
        .is_some_and(|items| items.len() > 1)
        || payload_i64_any(
            payload,
            &["durationSeconds", "duration_seconds", "duration", "seconds"],
        )
        .is_some_and(|seconds| seconds > MAX_VIDEO_SEGMENT_SECONDS)
}

fn effective_media_job_kind(kind: &str, payload: &Value) -> String {
    if kind == "video" && video_sequence_requested(payload) {
        "video_sequence".to_string()
    } else {
        kind.to_string()
    }
}

pub(crate) fn submit_media_job(
    app: &AppHandle,
    state: &State<'_, AppState>,
    kind: &str,
    payload: &Value,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let kind = effective_media_job_kind(kind, payload);
    let kind = kind.as_str();
    let payload = normalize_media_job_file_references(state, kind, payload)?;
    let source = infer_job_source(&payload);
    let queue_mode = infer_job_queue_mode(&source, &payload);
    let priority = infer_job_priority(&source, &payload);
    let (provider_key, provider_model) = resolve_provider_metadata(app, state, kind, &payload)?;
    let conn = open_media_runtime_connection(state)?;
    let job_id = create_media_job_with_connection(
        &conn,
        kind,
        &source,
        &queue_mode,
        &priority,
        &provider_key,
        provider_model.as_deref(),
        &payload,
        normalize_optional_string(payload_string(&payload, "projectId")).as_deref(),
        normalize_optional_string(payload_string(&payload, "manuscriptPath")).as_deref(),
        normalize_optional_string(payload_string(&payload, "videoProjectPath")).as_deref(),
        normalize_optional_string(
            payload_string(&payload, "sessionId")
                .or_else(|| payload_string(&payload, "ownerSessionId")),
        )
        .as_deref(),
    )?;
    let _ = ensure_media_generation_runtime_running(app, state)?;
    emit_job_updated(app, state, &job_id);
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "status": "queued",
        "kind": kind,
        "source": source,
        "queueMode": queue_mode,
        "priority": priority,
        "providerKey": provider_key,
        "providerModel": provider_model,
        "acceptedAt": now_iso(),
    }))
}

fn normalize_media_job_file_references(
    state: &State<'_, AppState>,
    kind: &str,
    payload: &Value,
) -> Result<Value, String> {
    let Some(session_id) =
        payload_string(payload, "sessionId").or_else(|| payload_string(payload, "ownerSessionId"))
    else {
        return Ok(payload.clone());
    };
    let mut normalized = payload.clone();
    match kind {
        "image" => {
            normalize_media_reference_array(
                state,
                &session_id,
                &mut normalized,
                "referenceImages",
            )?;
            normalize_media_reference_array(state, &session_id, &mut normalized, "images")?;
        }
        "video" | "video_sequence" => {
            normalize_media_reference_array(
                state,
                &session_id,
                &mut normalized,
                "referenceImages",
            )?;
            normalize_media_reference_array(state, &session_id, &mut normalized, "images")?;
            normalize_media_reference_string(state, &session_id, &mut normalized, "drivingAudio")?;
            normalize_media_reference_string(state, &session_id, &mut normalized, "firstClip")?;
        }
        _ => {}
    }
    Ok(normalized)
}

fn normalize_media_reference_array(
    state: &State<'_, AppState>,
    session_id: &str,
    payload: &mut Value,
    field: &str,
) -> Result<(), String> {
    let Some(values) = payload.get(field).and_then(Value::as_array).cloned() else {
        return Ok(());
    };
    let mut string_indices = Vec::<usize>::new();
    let mut raw_inputs = Vec::<String>::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(raw) = value
            .as_str()
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            string_indices.push(index);
            raw_inputs.push(raw.to_string());
        }
    }
    if raw_inputs.is_empty() {
        return Ok(());
    }
    let resolved = resolve_session_file_reference_inputs(state, session_id, raw_inputs);
    let mut next_values = values;
    for (index, resolved_value) in string_indices.into_iter().zip(resolved.into_iter()) {
        validate_resolved_media_reference(field, &resolved_value)?;
        next_values[index] = json!(resolved_value);
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert(field.to_string(), Value::Array(next_values));
    }
    Ok(())
}

fn normalize_media_reference_string(
    state: &State<'_, AppState>,
    session_id: &str,
    payload: &mut Value,
    field: &str,
) -> Result<(), String> {
    let Some(raw) = payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
    else {
        return Ok(());
    };
    let resolved = resolve_session_file_reference_inputs(state, session_id, vec![raw])
        .into_iter()
        .next()
        .unwrap_or_default();
    validate_resolved_media_reference(field, &resolved)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert(field.to_string(), json!(resolved));
    }
    Ok(())
}

fn validate_resolved_media_reference(field: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("file://")
        || Path::new(trimmed).exists()
    {
        return Ok(());
    }
    Err(format!(
        "RESOURCE_RESOLUTION_FAILED: {field} references `{trimmed}`, but it was not found in the current session attachments, tool results, workspace, or media cache. Use an attached file resource instead of a bare filename."
    ))
}

pub(crate) fn list_media_jobs(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let conn = open_media_runtime_connection(state)?;
    let limit = payload_field(payload, "limit")
        .and_then(Value::as_i64)
        .unwrap_or(100)
        .clamp(1, 300);
    let kind_filter = normalize_optional_string(payload_string(payload, "kind"));
    let status_filter = normalize_optional_string(payload_string(payload, "status"));
    let source_filter = normalize_optional_string(payload_string(payload, "source"));
    let queue_mode_filter = normalize_optional_string(payload_string(payload, "queueMode"))
        .or_else(|| normalize_optional_string(payload_string(payload, "queue_mode")))
        .and_then(|value| normalize_queue_mode(&value));
    let manuscript_path_filter =
        normalize_optional_string(payload_string(payload, "manuscriptPath"));
    let video_project_path_filter =
        normalize_optional_string(payload_string(payload, "videoProjectPath"));
    let owner_session_id_filter =
        normalize_optional_string(payload_string(payload, "ownerSessionId"));
    let include_archived = payload_field(payload, "includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut statement = conn
        .prepare(
            "SELECT job_id FROM media_jobs
             WHERE (?1 IS NULL OR kind = ?1)
               AND (?2 IS NULL OR status = ?2)
               AND (?3 IS NULL OR source = ?3)
               AND (?4 IS NULL OR queue_mode = ?4)
               AND (?5 IS NULL OR manuscript_path = ?5)
               AND (?6 IS NULL OR video_project_path = ?6)
               AND (?7 IS NULL OR owner_session_id = ?7)
               AND (?8 OR archived_at IS NULL)
             ORDER BY updated_at DESC, job_id DESC
             LIMIT ?9",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                kind_filter.as_deref(),
                status_filter.as_deref(),
                source_filter.as_deref(),
                queue_mode_filter.as_deref(),
                manuscript_path_filter.as_deref(),
                video_project_path_filter.as_deref(),
                owner_session_id_filter.as_deref(),
                include_archived,
                limit
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    let ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut items = Vec::with_capacity(ids.len());
    for job_id in ids {
        items.push(get_job_projection_with_connection(&conn, &job_id)?);
    }
    Ok(json!({ "success": true, "items": items }))
}

pub(crate) fn list_media_job_summaries(
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let conn = open_media_runtime_connection(state)?;
    let limit = payload_field(payload, "limit")
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 200);
    let kind_filter = normalize_optional_string(payload_string(payload, "kind"));
    let status_filter = normalize_optional_string(payload_string(payload, "status"));
    let source_filter = normalize_optional_string(payload_string(payload, "source"));
    let queue_mode_filter = normalize_optional_string(payload_string(payload, "queueMode"))
        .or_else(|| normalize_optional_string(payload_string(payload, "queue_mode")))
        .and_then(|value| normalize_queue_mode(&value));
    let owner_session_id_filter =
        normalize_optional_string(payload_string(payload, "ownerSessionId"));
    let include_archived = payload_field(payload, "includeArchived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut statement = conn
        .prepare(
            "SELECT job_id FROM media_jobs
             WHERE (?1 IS NULL OR kind = ?1)
               AND (?2 IS NULL OR status = ?2)
               AND (?3 IS NULL OR source = ?3)
               AND (?4 IS NULL OR queue_mode = ?4)
               AND (?5 IS NULL OR owner_session_id = ?5)
               AND (?6 OR archived_at IS NULL)
             ORDER BY updated_at DESC, job_id DESC
             LIMIT ?7",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                kind_filter.as_deref(),
                status_filter.as_deref(),
                source_filter.as_deref(),
                queue_mode_filter.as_deref(),
                owner_session_id_filter.as_deref(),
                include_archived,
                limit
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    let ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut items = Vec::with_capacity(ids.len());
    for job_id in ids {
        let Some(loaded) = load_job_with_current_attempt(&conn, &job_id)? else {
            continue;
        };
        let artifact_count = artifact_count_for_job(&conn, &job_id)?;
        items.push(media_job_summary(
            &loaded.job,
            &loaded.attempt,
            artifact_count,
        ));
    }
    Ok(json!({ "success": true, "items": items }))
}

pub(crate) fn get_media_job_artifacts(
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let conn = open_media_runtime_connection(state)?;
    let artifacts = load_artifacts_for_job(&conn, job_id)?;
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "items": artifacts.iter().map(artifact_projection).collect::<Vec<_>>(),
    }))
}

pub(crate) fn cancel_media_job(
    app: &AppHandle,
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let conn = open_media_runtime_connection(state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Err("media job not found".to_string());
    };
    let terminal = matches!(
        loaded.job.status.as_str(),
        "completed" | "failed" | "cancelled" | "dead_lettered"
    );
    if terminal {
        return Ok(json!({ "success": true, "jobId": job_id, "status": loaded.job.status }));
    }
    let active = matches!(
        loaded.job.status.as_str(),
        "submitting" | "downloading" | "binding"
    ) && loaded.attempt.lease_owner.is_some();
    let now_iso = now_iso();
    conn.execute(
        r#"
        UPDATE media_jobs
        SET status = ?1, cancel_reason = ?2, updated_at = ?3, completed_at = CASE WHEN ?1 = 'cancelled' THEN ?3 ELSE completed_at END
        WHERE job_id = ?4
        "#,
        params![
            if active { "cancel_requested" } else { "cancelled" },
            "User requested cancellation",
            now_iso,
            job_id
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        UPDATE media_job_attempts
        SET status = ?1, last_error = ?2, updated_at = ?3
        WHERE attempt_id = ?4
        "#,
        params![
            if active {
                "cancel_requested"
            } else {
                "cancelled"
            },
            "User requested cancellation",
            now_iso,
            loaded.attempt.attempt_id
        ],
    )
    .map_err(|error| error.to_string())?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&loaded.attempt.attempt_id),
        "cancel_requested",
        "Media generation job cancellation requested",
        None,
    )?;
    emit_job_updated(app, state, job_id);
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "status": if active { "cancel_requested" } else { "cancelled" },
    }))
}

pub(crate) fn delete_media_job(
    app: &AppHandle,
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let conn = open_media_runtime_connection(state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Err("media job not found".to_string());
    };
    let now_iso = now_iso();
    let active = matches!(
        loaded.job.status.as_str(),
        "submitting" | "polling" | "downloading" | "binding"
    );
    let queued = matches!(
        loaded.job.status.as_str(),
        "queued" | "accepted" | "submitted"
    );
    let next_status = if active {
        "cancel_requested"
    } else if queued {
        "cancelled"
    } else {
        loaded.job.status.as_str()
    };
    conn.execute(
        r#"
        UPDATE media_jobs
        SET status = ?1,
            cancel_reason = CASE WHEN ?2 THEN 'User archived media job' ELSE cancel_reason END,
            archived_at = ?3,
            archive_reason = ?4,
            updated_at = ?3,
            completed_at = CASE WHEN ?1 = 'cancelled' THEN ?3 ELSE completed_at END
        WHERE job_id = ?5
        "#,
        params![
            next_status,
            active || queued,
            now_iso,
            "User archived media job",
            job_id
        ],
    )
    .map_err(|error| error.to_string())?;
    if active || queued {
        conn.execute(
            r#"
            UPDATE media_job_attempts
            SET status = ?1,
                last_error = 'User archived media job',
                updated_at = ?2
            WHERE attempt_id = ?3
            "#,
            params![
                if active {
                    "cancel_requested"
                } else {
                    "cancelled"
                },
                now_iso,
                loaded.attempt.attempt_id
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    let archive_payload = json!({ "status": next_status });
    append_event_with_connection(
        &conn,
        job_id,
        Some(&loaded.attempt.attempt_id),
        "archived",
        "Media generation job archived",
        Some(&archive_payload),
    )?;
    emit_job_updated(app, state, job_id);
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "status": next_status,
        "archivedAt": now_iso,
    }))
}

pub(crate) fn retry_media_job(
    app: &AppHandle,
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<Value, String> {
    ensure_media_runtime_ready(state)?;
    let conn = open_media_runtime_connection(state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Err("media job not found".to_string());
    };
    if matches!(
        loaded.job.status.as_str(),
        "queued" | "submitting" | "polling" | "downloading" | "binding"
    ) {
        return Err("media job is already active".to_string());
    }
    let next_attempt_no = loaded.job.current_attempt_no + 1;
    let attempt_id = make_id("media-job-attempt");
    let now_iso = now_iso();
    conn.execute(
        r#"
        INSERT INTO media_job_attempts (
            attempt_id, job_id, attempt_no, status, provider_task_id, provider_status_url,
            idempotency_key, lease_owner, lease_expires_at, next_poll_at, retry_not_before_at,
            last_error, response_json, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'queued', NULL, NULL, ?4, NULL, NULL, NULL, NULL, NULL, NULL, ?5, ?5)
        "#,
        params![
            attempt_id,
            job_id,
            next_attempt_no,
            make_id("media-idempotency"),
            now_iso,
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        UPDATE media_jobs
        SET status = 'queued',
            current_attempt_no = ?1,
            cancel_reason = NULL,
            archived_at = NULL,
            archive_reason = NULL,
            completed_at = NULL,
            updated_at = ?2
        WHERE job_id = ?3
        "#,
        params![next_attempt_no, now_iso, job_id],
    )
    .map_err(|error| error.to_string())?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&attempt_id),
        "retried",
        "Media generation job requeued",
        None,
    )?;
    let _ = ensure_media_generation_runtime_running(app, state)?;
    emit_job_updated(app, state, job_id);
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "status": "queued",
        "attemptNo": next_attempt_no,
    }))
}

fn clear_expired_leases(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let conn = open_media_runtime_connection(state)?;
    let now = now_i64();
    let mut statement = conn
        .prepare(
            r#"
            SELECT j.job_id
            FROM media_jobs j
            JOIN media_job_attempts a
              ON a.job_id = j.job_id AND a.attempt_no = j.current_attempt_no
            WHERE COALESCE(a.lease_expires_at, 0) > 0
              AND a.lease_expires_at <= ?1
              AND j.status IN ('submitting', 'polling', 'downloading', 'binding', 'cancel_requested')
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([now], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for job_id in ids {
        let Some(loaded) = load_job_with_current_attempt(&conn, &job_id)? else {
            continue;
        };
        if loaded.job.status == "cancel_requested" {
            let next_status = "cancelled";
            set_attempt_details(
                &conn,
                &loaded,
                next_status,
                loaded.attempt.provider_task_id.as_deref(),
                loaded.attempt.provider_status_url.as_deref(),
                loaded.attempt.next_poll_at,
                loaded.attempt.response_json.as_ref(),
                Some("User requested cancellation"),
                true,
            )?;
            append_event_with_connection(
                &conn,
                &job_id,
                Some(&loaded.attempt.attempt_id),
                "cancelled",
                "Media generation job cancellation completed",
                None,
            )?;
            emit_job_updated(app, state, &job_id);
            continue;
        }
        if matches!(
            loaded.job.status.as_str(),
            "submitting" | "polling" | "downloading"
        ) {
            let recovery_count = conn
                .query_row(
                    "SELECT COUNT(*) FROM media_job_events WHERE attempt_id = ?1 AND event_type = 'lease_recovered'",
                    params![loaded.attempt.attempt_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())?;
            if recovery_count < 3 {
                let next_status = if loaded.job.status == "submitting" {
                    "queued"
                } else {
                    loaded.job.status.as_str()
                };
                set_attempt_details(
                    &conn,
                    &loaded,
                    next_status,
                    loaded.attempt.provider_task_id.as_deref(),
                    loaded.attempt.provider_status_url.as_deref(),
                    if next_status == "polling" {
                        Some(now + DEFAULT_POLL_INTERVAL_MS)
                    } else {
                        loaded.attempt.next_poll_at
                    },
                    loaded.attempt.response_json.as_ref(),
                    Some("Recovered expired media generation lease"),
                    true,
                )?;
                append_event_with_connection(
                    &conn,
                    &job_id,
                    Some(&loaded.attempt.attempt_id),
                    "lease_recovered",
                    "Media generation stage lease expired; job released for retry",
                    Some(&json!({
                        "previousStatus": loaded.job.status,
                        "nextStatus": next_status,
                        "leaseOwner": loaded.attempt.lease_owner,
                        "leaseExpiresAt": loaded.attempt.lease_expires_at,
                        "recoveryCount": recovery_count + 1,
                    })),
                )?;
                emit_job_updated(app, state, &job_id);
                continue;
            }
        }
        let timeout_message = format!("{} stage lease expired", loaded.job.kind);
        set_job_terminal_failure(&conn, &loaded, "failed", &timeout_message, None)?;
        append_event_with_connection(
            &conn,
            &job_id,
            Some(&loaded.attempt.attempt_id),
            "failed",
            &timeout_message,
            Some(&json!({
                "reason": "lease_expired",
                "previousStatus": loaded.job.status,
                "leaseOwner": loaded.attempt.lease_owner,
                "leaseExpiresAt": loaded.attempt.lease_expires_at,
            })),
        )?;
        emit_job_updated(app, state, &job_id);
    }
    Ok(())
}

fn expire_timed_out_video_jobs(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let conn = open_media_runtime_connection(state)?;
    let mut statement = conn
        .prepare(
            r#"
            SELECT j.job_id
            FROM media_jobs j
            JOIN media_job_attempts a
              ON a.job_id = j.job_id AND a.attempt_no = j.current_attempt_no
            WHERE j.kind = 'video'
              AND j.status = 'polling'
              AND a.lease_owner IS NULL
            ORDER BY j.created_at ASC, j.job_id ASC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let now = now_i64();
    for job_id in ids {
        let Some(loaded) = load_job_with_current_attempt(&conn, &job_id)? else {
            continue;
        };
        if !video_attempt_timed_out(&conn, &loaded, now)? {
            continue;
        }
        let message = video_timeout_failure_message();
        let elapsed_ms = video_provider_poll_elapsed_ms(&conn, &loaded, now)?
            .unwrap_or(VIDEO_PROVIDER_POLL_TIMEOUT_MS);
        let result_json = json!({
            "error": message,
            "reason": "provider_poll_timeout",
            "timeoutMs": VIDEO_PROVIDER_POLL_TIMEOUT_MS,
            "elapsedMs": elapsed_ms,
            "providerTaskId": loaded.attempt.provider_task_id.clone(),
            "providerStatusUrl": loaded.attempt.provider_status_url.clone(),
            "attemptNo": loaded.attempt.attempt_no,
        });
        set_job_terminal_failure(&conn, &loaded, "failed", &message, Some(&result_json))?;
        append_event_with_connection(
            &conn,
            &job_id,
            Some(&loaded.attempt.attempt_id),
            "failed",
            &message,
            Some(&result_json),
        )?;
        emit_job_updated(app, state, &job_id);
    }
    Ok(())
}

fn emit_job_log(app: &AppHandle, job_id: &str, message: &str, payload: Option<Value>) {
    let _ = app.emit(
        MEDIA_JOB_EVENT_LOG,
        json!({
            "jobId": job_id,
            "message": message,
            "payload": payload,
            "createdAt": now_iso(),
        }),
    );
}

fn emit_job_updated(app: &AppHandle, state: &State<'_, AppState>, job_id: &str) {
    if let Ok(value) = get_media_job_projection(state, job_id) {
        let _ = app.emit(MEDIA_JOB_EVENT_UPDATED, value);
    }
}

fn provider_key_for_slots(loaded: &LoadedJob) -> String {
    if loaded.job.provider_key.trim().is_empty() {
        "default".to_string()
    } else {
        loaded.job.provider_key.clone()
    }
}

fn slot_has_capacity(slots: &RuntimeSlots, loaded: &LoadedJob, stage: &str) -> bool {
    let provider_key = provider_key_for_slots(loaded);
    match stage {
        "image-submit" => {
            slots
                .image_submit_by_provider
                .get(&provider_key)
                .copied()
                .unwrap_or(0)
                < IMAGE_SUBMIT_LIMIT_PER_PROVIDER
        }
        "video-submit" | "video-sequence-submit" => {
            slots
                .video_submit_by_provider
                .get(&provider_key)
                .copied()
                .unwrap_or(0)
                < VIDEO_SUBMIT_LIMIT_PER_PROVIDER
        }
        "audio-submit" | "audio-sequence-submit" => {
            slots
                .audio_submit_by_provider
                .get(&provider_key)
                .copied()
                .unwrap_or(0)
                < AUDIO_SUBMIT_LIMIT_PER_PROVIDER
        }
        "voice-clone-submit" => {
            slots
                .voice_clone_submit_by_provider
                .get(&provider_key)
                .copied()
                .unwrap_or(0)
                < VOICE_CLONE_SUBMIT_LIMIT_PER_PROVIDER
        }
        "video-download" => {
            slots
                .video_download_by_provider
                .get(&provider_key)
                .copied()
                .unwrap_or(0)
                < VIDEO_DOWNLOAD_LIMIT_PER_PROVIDER
        }
        "video-poll" => slots.active_video_polls < VIDEO_POLL_LIMIT_GLOBAL,
        _ => false,
    }
}

fn reserve_slot(slots: &Arc<Mutex<RuntimeSlots>>, loaded: &LoadedJob, stage: &str) -> bool {
    let mut guard = match slots.lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    if !slot_has_capacity(&guard, loaded, stage) {
        return false;
    }
    let provider_key = provider_key_for_slots(loaded);
    match stage {
        "image-submit" => {
            *guard
                .image_submit_by_provider
                .entry(provider_key)
                .or_insert(0) += 1;
        }
        "video-submit" | "video-sequence-submit" => {
            *guard
                .video_submit_by_provider
                .entry(provider_key)
                .or_insert(0) += 1;
        }
        "audio-submit" | "audio-sequence-submit" => {
            *guard
                .audio_submit_by_provider
                .entry(provider_key)
                .or_insert(0) += 1;
        }
        "voice-clone-submit" => {
            *guard
                .voice_clone_submit_by_provider
                .entry(provider_key)
                .or_insert(0) += 1;
        }
        "video-download" => {
            *guard
                .video_download_by_provider
                .entry(provider_key)
                .or_insert(0) += 1;
        }
        "video-poll" => guard.active_video_polls += 1,
        _ => return false,
    }
    true
}

fn release_slot(slots: &Arc<Mutex<RuntimeSlots>>, loaded: &LoadedJob, stage: &str) {
    let Ok(mut guard) = slots.lock() else {
        return;
    };
    let provider_key = provider_key_for_slots(loaded);
    let decrement = |map: &mut HashMap<String, usize>, key: String| {
        if let Some(count) = map.get_mut(&key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&key);
            }
        }
    };
    match stage {
        "image-submit" => decrement(&mut guard.image_submit_by_provider, provider_key),
        "video-submit" | "video-sequence-submit" => {
            decrement(&mut guard.video_submit_by_provider, provider_key)
        }
        "audio-submit" | "audio-sequence-submit" => {
            decrement(&mut guard.audio_submit_by_provider, provider_key)
        }
        "voice-clone-submit" => decrement(&mut guard.voice_clone_submit_by_provider, provider_key),
        "video-download" => decrement(&mut guard.video_download_by_provider, provider_key),
        "video-poll" => {
            guard.active_video_polls = guard.active_video_polls.saturating_sub(1);
        }
        _ => {}
    }
}

fn write_video_bytes_to_generated_path(
    state: &State<'_, AppState>,
    bytes: &[u8],
) -> Result<(String, String, String), String> {
    let media_root = media_root(state)?;
    let relative_path = format!("generated/media-{}.mp4", now_ms());
    let absolute_path = media_root.join(&relative_path);
    let temp_path = absolute_path.with_extension("mp4.tmp");
    if let Some(parent) = temp_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    {
        let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
        use std::io::Write as _;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temp_path, &absolute_path).map_err(|error| error.to_string())?;
    if let Some(parent) = absolute_path.parent() {
        let dir = File::open(parent).map_err(|error| error.to_string())?;
        dir.sync_all().map_err(|error| error.to_string())?;
    }
    Ok((
        relative_path,
        absolute_path.display().to_string(),
        file_url_for_path(&absolute_path),
    ))
}

fn create_video_artifact_metadata(
    loaded: &LoadedJob,
    relative_path: &str,
    absolute_path: &str,
    preview_url: &str,
    thumbnail_url: Option<&str>,
) -> Value {
    let request = loaded.job.request_json.clone();
    json!({
        "id": make_id("media"),
        "source": "generated",
        "projectId": loaded.job.project_id,
        "title": request
            .get("title")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .or_else(|| request.get("prompt").and_then(Value::as_str).map(|value| value.chars().take(24).collect::<String>())),
        "prompt": request.get("prompt").and_then(Value::as_str).map(|value| value.to_string()),
        "provider": Some(loaded.job.provider_key.clone()),
        "providerTemplate": Value::Null,
        "model": loaded.job.provider_model,
        "aspectRatio": request.get("aspectRatio"),
        "mimeType": "video/mp4",
        "relativePath": relative_path,
        "absolutePath": absolute_path,
        "previewUrl": preview_url,
        "thumbnailUrl": thumbnail_url,
        "exists": true,
        "updatedAt": now_iso(),
    })
}

fn insert_artifact_with_connection(
    conn: &Connection,
    job_id: &str,
    kind: &str,
    relative_path: Option<&str>,
    absolute_path: Option<&str>,
    mime_type: Option<&str>,
    preview_url: Option<&str>,
    metadata: Option<&Value>,
) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO media_job_artifacts (
            artifact_id, job_id, kind, relative_path, absolute_path, mime_type, preview_url, metadata_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            make_id("media-job-artifact"),
            job_id,
            kind,
            relative_path,
            absolute_path,
            mime_type,
            preview_url,
            metadata.map(json_to_text).transpose()?,
            now_iso(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn final_job_error_message(projection: &Value) -> String {
    projection
        .pointer("/attempt/lastError")
        .and_then(Value::as_str)
        .or_else(|| projection.pointer("/result/error").and_then(Value::as_str))
        .or_else(|| projection.get("cancelReason").and_then(Value::as_str))
        .unwrap_or("media generation failed")
        .to_string()
}

fn video_provider_poll_started_at_ms(
    conn: &Connection,
    loaded: &LoadedJob,
) -> Result<Option<i64>, String> {
    let event_started_at = conn
        .query_row(
            r#"
            SELECT MIN(created_at)
            FROM media_job_events
            WHERE attempt_id = ?1
              AND event_type IN ('submitted', 'poll_pending')
            "#,
            params![loaded.attempt.attempt_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .and_then(|value| parse_timestamp_ms(&value));
    if event_started_at.is_some() {
        return Ok(event_started_at);
    }
    if loaded.attempt.provider_task_id.is_some() {
        return Ok(parse_timestamp_ms(&loaded.attempt.created_at)
            .or_else(|| parse_timestamp_ms(&loaded.job.created_at)));
    }
    Ok(None)
}

fn video_provider_poll_elapsed_ms(
    conn: &Connection,
    loaded: &LoadedJob,
    now_ms: i64,
) -> Result<Option<i64>, String> {
    let Some(started_at) = video_provider_poll_started_at_ms(conn, loaded)? else {
        return Ok(None);
    };
    Ok(Some(now_ms.saturating_sub(started_at)))
}

fn video_attempt_timed_out(
    conn: &Connection,
    loaded: &LoadedJob,
    now_ms: i64,
) -> Result<bool, String> {
    if loaded.job.kind != "video" {
        return Ok(false);
    }
    Ok(video_provider_poll_elapsed_ms(conn, loaded, now_ms)?
        .map(|elapsed| elapsed >= VIDEO_PROVIDER_POLL_TIMEOUT_MS)
        .unwrap_or(false))
}

fn video_timeout_failure_message() -> String {
    "视频生成超时：2 小时内未完成，已停止轮询。".to_string()
}

pub(crate) fn await_media_job_completion(
    state: &State<'_, AppState>,
    job_id: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    loop {
        let value = get_media_job_projection(state, job_id)?;
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match status.as_str() {
            "completed" => return Ok(value),
            "failed" | "cancelled" | "dead_lettered" => {
                return Err(final_job_error_message(&value));
            }
            _ => {}
        }
        if started.elapsed().as_millis() as u64 >= timeout_ms {
            return Err(format!("media job timed out after {}ms", timeout_ms));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

pub(crate) fn compat_generate_and_wait(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Result<Value, String> {
    let kind = if channel == "video-gen:generate" {
        "video"
    } else {
        "image"
    };
    let mut runtime_payload = payload.clone();
    if let Some(object) = runtime_payload.as_object_mut() {
        let inferred_source =
            if object.get("videoProjectPath").is_some() || object.get("manuscriptPath").is_some() {
                "manuscripts"
            } else if object.get("toolCallId").is_some() || object.get("sessionId").is_some() {
                "tool"
            } else {
                "generation_studio"
            };
        object
            .entry("source".to_string())
            .or_insert_with(|| json!(inferred_source));
        object.insert("waitForCompletion".to_string(), json!(true));
    }
    let submitted = submit_media_job(app, state, kind, &runtime_payload)?;
    let job_id = submitted
        .get("jobId")
        .and_then(Value::as_str)
        .ok_or_else(|| "media runtime did not return jobId".to_string())?;
    let projection = await_media_job_completion(state, job_id, MEDIA_AWAIT_DEFAULT_TIMEOUT_MS)?;
    let artifacts = projection
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let legacy_assets = artifacts
        .iter()
        .filter_map(|artifact| artifact.get("metadata").cloned())
        .collect::<Vec<_>>();
    Ok(json!({
        "success": true,
        "jobId": job_id,
        "status": "completed",
        "kind": if kind == "video" { "generated-videos" } else { "generated-images" },
        "assets": legacy_assets
    }))
}

fn persist_generated_image_artifact(
    app: &AppHandle,
    loaded: &LoadedJob,
    asset: &MediaAssetRecord,
    completed_count: usize,
    total_count: usize,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    let asset_value =
        serde_json::to_value(asset).map_err(|error| format!("serialize media asset: {error}"))?;
    insert_artifact_with_connection(
        &conn,
        &loaded.job.job_id,
        "media",
        asset.relative_path.as_deref(),
        asset.absolute_path.as_deref(),
        asset.mime_type.as_deref(),
        asset.preview_url.as_deref(),
        Some(&asset_value),
    )?;
    set_attempt_details(
        &conn,
        &current,
        "persisting",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        current.attempt.next_poll_at,
        current.attempt.response_json.as_ref(),
        None,
        false,
    )?;
    append_event_with_connection(
        &conn,
        &loaded.job.job_id,
        Some(&current.attempt.attempt_id),
        "artifact_persisted",
        &format!("Image {completed_count}/{total_count} persisted"),
        Some(&json!({
            "completedImages": completed_count,
            "expectedImages": total_count,
            "asset": asset_value.clone(),
        })),
    )?;
    with_store_mut(&state, |store| {
        media_store::push_asset(store, asset.clone());
        Ok(())
    })?;
    persist_media_workspace_catalog(&state)?;
    let artifacts = load_artifacts_for_job(&conn, &loaded.job.job_id)?;
    update_job_result_json(
        &conn,
        &loaded.job.job_id,
        &json!({
            "assets": artifacts.iter().map(artifact_projection).collect::<Vec<_>>(),
            "progress": {
                "completedImages": completed_count,
                "expectedImages": total_count,
            },
            "lastCompletedAsset": asset_value,
        }),
        false,
    )?;
    emit_job_updated(app, &state, &loaded.job.job_id);
    Ok(())
}

fn run_image_job_sync(
    app: &AppHandle,
    loaded: &LoadedJob,
) -> Result<Vec<MediaAssetRecord>, String> {
    let state = app.state::<AppState>();
    let mut payload = loaded.job.request_json.clone();
    if let Some(object) = payload.as_object_mut() {
        object.insert("runtimeBypass".to_string(), json!(true));
        object.insert("source".to_string(), json!(loaded.job.source.clone()));
    }
    commands::generation::generate_image_assets(&state, &payload, |asset, completed, total| {
        persist_generated_image_artifact(app, loaded, asset, completed, total)
    })
    .map(|execution| execution.assets)
}

fn complete_image_job(
    app: &AppHandle,
    job_id: &str,
    assets: &[MediaAssetRecord],
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Ok(());
    };
    let asset_values = assets
        .iter()
        .map(|asset| {
            serde_json::to_value(asset).map_err(|error| format!("serialize media asset: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let result_json = json!({
        "assets": asset_values,
        "progress": {
            "completedImages": assets.len(),
            "expectedImages": assets.len(),
        },
    });
    update_job_result_json(&conn, job_id, &result_json, true)?;
    set_attempt_details(
        &conn,
        &loaded,
        "completed",
        loaded.attempt.provider_task_id.as_deref(),
        loaded.attempt.provider_status_url.as_deref(),
        None,
        Some(&result_json),
        None,
        true,
    )?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&loaded.attempt.attempt_id),
        "completed",
        "Image generation completed",
        Some(&json!({
            "completedImages": assets.len(),
            "expectedImages": assets.len(),
        })),
    )?;
    emit_job_updated(app, &state, job_id);
    Ok(())
}

fn complete_audio_job(app: &AppHandle, loaded: &LoadedJob, result: &Value) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    let asset = result.get("asset").cloned().unwrap_or(Value::Null);
    insert_artifact_with_connection(
        &conn,
        &loaded.job.job_id,
        "audio",
        result
            .get("relativePath")
            .and_then(Value::as_str)
            .or_else(|| asset.get("relativePath").and_then(Value::as_str)),
        result
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| asset.get("absolutePath").and_then(Value::as_str)),
        asset.get("mimeType").and_then(Value::as_str),
        asset.get("previewUrl").and_then(Value::as_str),
        Some(&json!({
            "asset": asset,
            "voiceId": result.get("voiceId").cloned().unwrap_or(Value::Null),
        })),
    )?;
    update_job_result_json(&conn, &loaded.job.job_id, result, true)?;
    set_attempt_details(
        &conn,
        &current,
        "completed",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        None,
        Some(result),
        None,
        true,
    )?;
    append_event_with_connection(
        &conn,
        &loaded.job.job_id,
        Some(&current.attempt.attempt_id),
        "completed",
        "Speech synthesis completed",
        Some(result),
    )?;
    emit_job_updated(app, &state, &loaded.job.job_id);
    Ok(())
}

fn audio_sequence_format(request: &Value) -> String {
    let raw = payload_string(request, "responseFormat")
        .or_else(|| payload_string(request, "response_format"))
        .or_else(|| payload_string(request, "format"))
        .or_else(|| {
            request
                .pointer("/audio_setting/format")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "mp3".to_string());
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.contains("wav") {
        "wav".to_string()
    } else if normalized.contains("m4a") || normalized.contains("aac") {
        "m4a".to_string()
    } else if normalized.contains("ogg") || normalized.contains("opus") {
        "ogg".to_string()
    } else if normalized.contains("flac") {
        "flac".to_string()
    } else {
        "mp3".to_string()
    }
}

fn audio_sequence_codec_args(extension: &str) -> Vec<String> {
    match extension {
        "wav" => vec!["-c:a".to_string(), "pcm_s16le".to_string()],
        "m4a" => vec!["-c:a".to_string(), "aac".to_string()],
        "ogg" => vec!["-c:a".to_string(), "libopus".to_string()],
        "flac" => vec!["-c:a".to_string(), "flac".to_string()],
        _ => vec![
            "-c:a".to_string(),
            "libmp3lame".to_string(),
            "-b:a".to_string(),
            "128k".to_string(),
        ],
    }
}

fn payload_f64_any(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        payload_field(payload, key).and_then(|value| {
            value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
        })
    })
}

fn audio_sequence_boundary_pause_seconds(
    segment: &Value,
    before: bool,
) -> Result<Option<f64>, String> {
    let keys: &[&str] = if before {
        &[
            "pauseBeforeSeconds",
            "pause_before_seconds",
            "pauseBefore",
            "pause_before",
            "silenceBeforeSeconds",
            "silence_before_seconds",
        ]
    } else {
        &[
            "pauseAfterSeconds",
            "pause_after_seconds",
            "pauseAfter",
            "pause_after",
            "silenceAfterSeconds",
            "silence_after_seconds",
        ]
    };
    let Some(seconds) = payload_f64_any(segment, keys) else {
        return Ok(None);
    };
    if seconds <= 0.0 {
        return Ok(None);
    }
    if seconds > 10.0 {
        return Err("audio sequence boundary pause must be <= 10 seconds".to_string());
    }
    Ok(Some((seconds * 1000.0).round() / 1000.0))
}

fn create_audio_sequence_silence_file(
    app: &AppHandle,
    state: &State<'_, AppState>,
    job_id: &str,
    extension: &str,
    label: &str,
    seconds: f64,
) -> Result<PathBuf, String> {
    let work_dir = media_runtime_root(state)?
        .join("audio-sequences")
        .join(job_id);
    fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let path = work_dir.join(format!("{label}-silence.{extension}"));
    let mut command = background_command(ffmpeg_program(Some(app))?);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("lavfi")
        .arg("-i")
        .arg("anullsrc=r=44100:cl=mono")
        .arg("-t")
        .arg(format!("{seconds:.3}"))
        .arg("-vn");
    for arg in audio_sequence_codec_args(extension) {
        command.arg(arg);
    }
    command.arg(&path);
    let output = command.output().map_err(|error| {
        format!("audio sequence silence generation could not start ffmpeg: {error}")
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&path);
        return Err(if detail.is_empty() {
            "audio sequence silence generation failed".to_string()
        } else {
            format!("audio sequence silence generation failed: {detail}")
        });
    }
    Ok(path)
}

fn concat_list_line(path: &PathBuf) -> String {
    let escaped = path
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    format!("file '{}'\n", escaped)
}

fn audio_sequence_prompt_text(segments: &[Value]) -> String {
    segments
        .iter()
        .filter_map(|segment| {
            payload_string(segment, "input")
                .or_else(|| payload_string(segment, "text"))
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn audio_sequence_output_paths(
    state: &State<'_, AppState>,
    job_id: &str,
    extension: &str,
) -> Result<(String, PathBuf), String> {
    let relative_path = format!("generated/tts/{job_id}-sequence.{extension}");
    let absolute_path = media_root(state)?.join(&relative_path);
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok((relative_path, absolute_path))
}

fn remove_existing_audio_sequence_artifacts(
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<(), String> {
    let conn = open_media_runtime_connection(state)?;
    let mut statement = conn
        .prepare(
            r#"
            SELECT absolute_path
            FROM media_job_artifacts
            WHERE job_id = ?1 AND kind IN ('audio', 'audio_segment')
            "#,
        )
        .map_err(|error| error.to_string())?;
    let paths = statement
        .query_map(params![job_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| error.to_string())?
        .filter_map(|row| row.ok().flatten())
        .collect::<Vec<_>>();
    drop(statement);
    for path in paths {
        let _ = fs::remove_file(path);
    }
    conn.execute(
        "DELETE FROM media_job_artifacts WHERE job_id = ?1 AND kind IN ('audio', 'audio_segment')",
        params![job_id],
    )
    .map_err(|error| error.to_string())?;
    let work_dir = media_runtime_root(state)?
        .join("audio-sequences")
        .join(job_id);
    let _ = fs::remove_dir_all(work_dir);
    Ok(())
}

fn remove_existing_video_sequence_artifacts(
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<(), String> {
    let conn = open_media_runtime_connection(state)?;
    let mut statement = conn
        .prepare(
            r#"
            SELECT absolute_path
            FROM media_job_artifacts
            WHERE job_id = ?1 AND kind IN ('media', 'video_segment')
            "#,
        )
        .map_err(|error| error.to_string())?;
    let paths = statement
        .query_map(params![job_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| error.to_string())?
        .filter_map(|row| row.ok().flatten())
        .collect::<Vec<_>>();
    drop(statement);
    for path in paths {
        let _ = fs::remove_file(path);
    }
    conn.execute(
        "DELETE FROM media_job_artifacts WHERE job_id = ?1 AND kind IN ('media', 'video_segment')",
        params![job_id],
    )
    .map_err(|error| error.to_string())?;
    let work_dir = media_runtime_root(state)?
        .join("video-sequences")
        .join(job_id);
    let _ = fs::remove_dir_all(work_dir);
    Ok(())
}

fn merge_audio_sequence_with_ffmpeg(
    app: &AppHandle,
    state: &State<'_, AppState>,
    job_id: &str,
    segment_paths: &[PathBuf],
    extension: &str,
) -> Result<(String, PathBuf), String> {
    if segment_paths.is_empty() {
        return Err("audio sequence has no generated segments to merge".to_string());
    }
    let work_dir = media_runtime_root(state)?
        .join("audio-sequences")
        .join(job_id);
    fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let concat_path = work_dir.join("concat.txt");
    {
        let mut file = File::create(&concat_path).map_err(|error| error.to_string())?;
        use std::io::Write as _;
        for path in segment_paths {
            file.write_all(concat_list_line(path).as_bytes())
                .map_err(|error| error.to_string())?;
        }
        file.sync_all().map_err(|error| error.to_string())?;
    }

    let (relative_path, absolute_path) = audio_sequence_output_paths(state, job_id, extension)?;
    let temp_path = absolute_path.with_file_name(format!("{job_id}-sequence.tmp.{extension}"));
    let mut command = background_command(ffmpeg_program(Some(app))?);
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&concat_path)
        .arg("-vn");
    for arg in audio_sequence_codec_args(extension) {
        command.arg(arg);
    }
    command.arg(&temp_path);
    let output = command
        .output()
        .map_err(|error| format!("audio sequence merge could not start ffmpeg: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&temp_path);
        return Err(if detail.is_empty() {
            "audio sequence merge failed".to_string()
        } else {
            format!("audio sequence merge failed: {detail}")
        });
    }
    fs::rename(&temp_path, &absolute_path).map_err(|error| error.to_string())?;
    Ok((relative_path, absolute_path))
}

fn register_audio_sequence_asset(
    state: &State<'_, AppState>,
    loaded: &LoadedJob,
    relative_path: String,
    absolute_path: PathBuf,
    prompt: String,
) -> Result<MediaAssetRecord, String> {
    let request = &loaded.job.request_json;
    let (mime_type, _, _) = guess_mime_and_kind(&absolute_path);
    let title = payload_string(request, "title").unwrap_or_else(|| "TTS sequence".to_string());
    let voice_id = payload_string(request, "voiceId")
        .or_else(|| payload_string(request, "voice_id"))
        .or_else(|| payload_string(request, "voice"));
    let now = now_rfc3339();
    let asset = MediaAssetRecord {
        id: make_id("media"),
        source: "generated".to_string(),
        source_domain: Some("voice".to_string()),
        source_link: voice_id.as_ref().map(|value| format!("voice:{value}")),
        project_id: loaded.job.project_id.clone(),
        title: Some(title),
        prompt: Some(prompt),
        provider: Some("voice".to_string()),
        provider_template: Some("tts.sequence".to_string()),
        model: loaded.job.provider_model.clone(),
        aspect_ratio: None,
        size: None,
        quality: None,
        mime_type: Some(mime_type),
        content_hash: file_content_hash(&absolute_path).ok(),
        relative_path: Some(relative_path),
        bound_manuscript_path: payload_string(request, "boundManuscriptPath")
            .or_else(|| loaded.job.manuscript_path.clone()),
        created_at: now.clone(),
        updated_at: now,
        absolute_path: Some(absolute_path.display().to_string()),
        preview_url: Some(file_url_for_path(&absolute_path)),
        thumbnail_url: None,
        exists: absolute_path.is_file(),
    };
    with_store_mut(state, |store| {
        media_store::prepend_asset(store, asset.clone());
        Ok(())
    })?;
    persist_media_workspace_catalog(state)?;
    Ok(asset)
}

fn complete_audio_sequence_job(
    app: &AppHandle,
    loaded: &LoadedJob,
    result: &Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    let asset = result.get("asset").cloned().unwrap_or(Value::Null);
    insert_artifact_with_connection(
        &conn,
        &loaded.job.job_id,
        "audio",
        result
            .get("relativePath")
            .and_then(Value::as_str)
            .or_else(|| asset.get("relativePath").and_then(Value::as_str)),
        result
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| asset.get("absolutePath").and_then(Value::as_str)),
        asset.get("mimeType").and_then(Value::as_str),
        asset.get("previewUrl").and_then(Value::as_str),
        Some(&json!({
            "asset": asset,
            "voiceId": result.get("voiceId").cloned().unwrap_or(Value::Null),
            "segments": result.get("segments").cloned().unwrap_or(Value::Null),
        })),
    )?;
    update_job_result_json(&conn, &loaded.job.job_id, result, true)?;
    set_attempt_details(
        &conn,
        &current,
        "completed",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        None,
        Some(result),
        None,
        true,
    )?;
    append_event_with_connection(
        &conn,
        &loaded.job.job_id,
        Some(&current.attempt.attempt_id),
        "completed",
        "Speech sequence synthesis completed",
        Some(result),
    )?;
    emit_job_updated(app, &state, &loaded.job.job_id);
    Ok(())
}

fn complete_voice_clone_job(
    app: &AppHandle,
    loaded: &LoadedJob,
    result: &Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    update_job_result_json(&conn, &loaded.job.job_id, result, true)?;
    set_attempt_details(
        &conn,
        &current,
        "completed",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        None,
        Some(result),
        None,
        true,
    )?;
    append_event_with_connection(
        &conn,
        &loaded.job.job_id,
        Some(&current.attempt.attempt_id),
        "completed",
        "Voice clone completed",
        Some(result),
    )?;
    emit_job_updated(app, &state, &loaded.job.job_id);
    Ok(())
}

fn fail_job(
    app: &AppHandle,
    job_id: &str,
    message: &str,
    result_json: Option<&Value>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Ok(());
    };
    set_job_terminal_failure(&conn, &loaded, "failed", message, result_json)?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&loaded.attempt.attempt_id),
        "failed",
        message,
        result_json,
    )?;
    emit_job_updated(app, &state, job_id);
    Ok(())
}

fn complete_job_cancelled(app: &AppHandle, job_id: &str, message: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Ok(());
    };
    set_job_terminal_failure(&conn, &loaded, "cancelled", message, None)?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&loaded.attempt.attempt_id),
        "cancelled",
        message,
        None,
    )?;
    emit_job_updated(app, &state, job_id);
    Ok(())
}

fn is_media_job_cancel_requested(
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<bool, String> {
    let conn = open_media_runtime_connection(state)?;
    let status = conn
        .query_row(
            "SELECT status FROM media_jobs WHERE job_id = ?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(status.as_deref() == Some("cancel_requested"))
}

fn renew_media_job_stage_lease(
    state: &State<'_, AppState>,
    loaded: &LoadedJob,
    lease_owner: &str,
    expected_attempt_status: &str,
) -> Result<(), String> {
    let conn = open_media_runtime_connection(state)?;
    conn.execute(
        r#"
        UPDATE media_job_attempts
        SET lease_expires_at = ?1,
            updated_at = ?2
        WHERE attempt_id = ?3
          AND status = ?4
          AND lease_owner = ?5
          AND lease_expires_at IS NOT NULL
        "#,
        params![
            now_i64() + ACTIVE_STAGE_LEASE_MS,
            now_iso(),
            loaded.attempt.attempt_id,
            expected_attempt_status,
            lease_owner,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

async fn run_video_generation_request_async(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let create_urls = build_compatible_video_route_urls(endpoint, "/videos/generations/async");
    let body = build_video_request_body(endpoint, model, payload)?;
    let mut last_error = None;
    for url in create_urls {
        match media_runtime_json_request(
            "POST",
            &url,
            api_key,
            &[],
            Some(body.clone()),
            Some(Duration::from_secs(45)),
        )
        .await
        {
            Ok(response) => {
                if (200..300).contains(&response.status) {
                    return Ok(response.body);
                }
                let error = format!(
                    "[{url}] HTTP {} {}",
                    response.status,
                    summarize_json_body(&response.body)
                );
                if response.status != 404 {
                    return Err(error);
                }
                last_error = Some(error);
            }
            Err(error) => last_error = Some(format!("[{url}] {error}")),
        }
    }
    Err(last_error.unwrap_or_else(|| "video generation request failed".to_string()))
}

fn resolve_video_retalk_settings(settings: &Value) -> (String, Option<String>) {
    let resolved = crate::ai_model_manager::AiModelManager::resolve(
        settings,
        crate::ai_model_manager::AiModelScope::Video,
        None,
    );
    let endpoint = resolved
        .as_ref()
        .map(|route| route.base_url.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| payload_string(settings, "video_endpoint"))
        .map(|value| normalize_base_url(&value))
        .unwrap_or_else(|| crate::official_base_url_from_settings(settings));
    let api_key = if crate::media_generation::is_redbox_official_endpoint(&endpoint) {
        crate::official_access_token_from_settings(settings)
            .or_else(|| resolved.as_ref().and_then(|route| route.api_key.clone()))
            .or_else(|| payload_string(settings, "video_api_key"))
            .or_else(|| crate::official_ai_api_key_from_settings(settings))
            .or_else(|| payload_string(settings, "api_key"))
    } else {
        resolved
            .as_ref()
            .and_then(|route| route.api_key.clone())
            .or_else(|| payload_string(settings, "video_api_key"))
            .or_else(|| crate::official_ai_api_key_from_settings(settings))
            .or_else(|| payload_string(settings, "api_key"))
    };
    (endpoint, api_key)
}

fn video_retalk_route_url(endpoint: &str, suffix: &str) -> String {
    let base = normalize_base_url(endpoint);
    let normalized_base = if let Some((prefix, _)) = base.split_once("/ai/video-retalk/") {
        prefix
    } else if let Some((prefix, _)) = base.split_once("/videos/") {
        prefix
    } else {
        base.as_str()
    }
    .trim_end_matches('/');
    format!("{normalized_base}{suffix}")
}

fn video_retalk_payload_string(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload_string(payload, key).or_else(|| {
            payload
                .pointer(&format!("/input/{key}"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
    })
}

fn validate_video_retalk_remote_url(field: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(())
    } else {
        Err(format!(
            "media.videoRetalk requires a remote {field}; upload local files before submitting VideoRetalk"
        ))
    }
}

fn build_video_retalk_request_body(payload: &Value) -> Result<Value, String> {
    let video_url = video_retalk_payload_string(payload, &["video_url", "videoUrl"])
        .ok_or_else(|| "media.videoRetalk requires input.video_url or videoUrl".to_string())?;
    let audio_url = video_retalk_payload_string(payload, &["audio_url", "audioUrl"])
        .ok_or_else(|| "media.videoRetalk requires input.audio_url or audioUrl".to_string())?;
    validate_video_retalk_remote_url("video_url", &video_url)?;
    validate_video_retalk_remote_url("audio_url", &audio_url)?;
    let duration_seconds = payload_field(payload, "duration_seconds")
        .or_else(|| payload_field(payload, "durationSeconds"))
        .and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
        })
        .ok_or_else(|| "media.videoRetalk requires durationSeconds for billing".to_string())?;
    if duration_seconds <= 0 {
        return Err("media.videoRetalk durationSeconds must be positive".to_string());
    }
    let resolution = payload_string(payload, "resolution")
        .ok_or_else(|| "media.videoRetalk requires resolution for billing".to_string())?;
    let mut parameters = payload
        .get("parameters")
        .and_then(Value::as_object)
        .map(|object| Value::Object(object.clone()))
        .unwrap_or_else(|| json!({}));
    if let Some(video_extension) = payload_field(payload, "video_extension")
        .or_else(|| payload_field(payload, "videoExtension"))
        .and_then(Value::as_bool)
    {
        if let Some(object) = parameters.as_object_mut() {
            object.insert("video_extension".to_string(), json!(video_extension));
        }
    }
    Ok(json!({
        "input": {
            "video_url": video_url.trim(),
            "audio_url": audio_url.trim(),
        },
        "parameters": parameters,
        "duration_seconds": duration_seconds,
        "resolution": resolution.trim(),
    }))
}

async fn run_video_retalk_request_async(
    endpoint: &str,
    api_key: Option<&str>,
    payload: &Value,
) -> Result<Value, String> {
    let url = video_retalk_route_url(endpoint, "/ai/video-retalk/jobs");
    let body = build_video_retalk_request_body(payload)?;
    let response = media_runtime_json_request(
        "POST",
        &url,
        api_key,
        &[],
        Some(body),
        Some(Duration::from_secs(45)),
    )
    .await?;
    if (200..300).contains(&response.status) {
        return Ok(response.body);
    }
    Err(format!(
        "[{url}] HTTP {} {}",
        response.status,
        summarize_json_body(&response.body)
    ))
}

fn extract_video_retalk_output_url(value: &Value) -> Option<String> {
    for pointer in [
        "/video_url",
        "/videoUrl",
        "/output_url",
        "/outputUrl",
        "/url",
        "/output/video_url",
        "/output/videoUrl",
        "/output/output_url",
        "/output/outputUrl",
        "/output/url",
        "/result/video_url",
        "/result/videoUrl",
        "/result/output_url",
        "/result/outputUrl",
        "/result/url",
        "/data/output/video_url",
        "/data/output/videoUrl",
        "/data/output/url",
        "/data/result/video_url",
        "/data/result/videoUrl",
        "/data/result/url",
        "/data/output_url",
        "/data/outputUrl",
    ] {
        if let Some(url) = value.pointer(pointer).and_then(Value::as_str) {
            let trimmed = url.trim();
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                return Some(trimmed.to_string());
            }
        }
    }
    for item in value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for key in ["video_url", "videoUrl", "output_url", "outputUrl", "url"] {
            if let Some(url) = item.get(key).and_then(Value::as_str) {
                let trimmed = url.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

async fn poll_video_retalk_once(
    endpoint: &str,
    api_key: Option<&str>,
    provider_task_id: &str,
) -> Result<VideoPollState, String> {
    let url = video_retalk_route_url(endpoint, "/ai/video-retalk/jobs/query");
    let response = media_runtime_json_request(
        "POST",
        &url,
        api_key,
        &[],
        Some(json!({ "task_id": provider_task_id })),
        Some(Duration::from_secs(45)),
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "[{url}] HTTP {} {}",
            response.status,
            summarize_json_body(&response.body)
        ));
    }
    if let Some(url) = extract_video_retalk_output_url(&response.body) {
        return Ok(VideoPollState::Ready {
            response: response.body,
            inline_base64: None,
            download_url: Some(url),
        });
    }
    let status = extract_video_generation_status(&response.body);
    if status.contains("failed") || status.contains("error") || status.contains("cancel") {
        let message = extract_video_generation_failure_message(&response.body)
            .unwrap_or_else(|| format!("VideoRetalk failed with status {status}"));
        return Ok(VideoPollState::Failed {
            response: response.body,
            message,
        });
    }
    Ok(VideoPollState::Pending {
        response: response.body,
        next_poll_at: now_i64() + DEFAULT_POLL_INTERVAL_MS,
    })
}

async fn poll_video_generation_once(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    provider_task_id: &str,
    provider_status_url: Option<&str>,
) -> Result<VideoPollState, String> {
    if is_redbox_compatible_endpoint(endpoint) {
        let query_urls =
            build_compatible_video_route_urls(endpoint, "/videos/generations/tasks/query");
        for query_url in &query_urls {
            match media_runtime_json_request(
                "POST",
                query_url,
                api_key,
                &[],
                Some(json!({
                    "model": model,
                    "task_id": provider_task_id,
                })),
                Some(Duration::from_secs(45)),
            )
            .await
            {
                Ok(response) => {
                    if !(200..300).contains(&response.status) {
                        if response.status == 404 {
                            continue;
                        }
                        return Err(format!(
                            "[{query_url}] HTTP {} {}",
                            response.status,
                            summarize_json_body(&response.body)
                        ));
                    }
                    if let Some(item) = extract_first_media_result(&response.body) {
                        if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
                            let inline_base64 = b64.to_string();
                            return Ok(VideoPollState::Ready {
                                response: response.body,
                                inline_base64: Some(inline_base64),
                                download_url: None,
                            });
                        }
                    }
                    if let Some(url) = extract_media_url(&response.body) {
                        return Ok(VideoPollState::Ready {
                            response: response.body,
                            inline_base64: None,
                            download_url: Some(url),
                        });
                    }
                    let status = extract_video_generation_status(&response.body);
                    if status.contains("failed")
                        || status.contains("error")
                        || status.contains("cancel")
                    {
                        let message = extract_video_generation_failure_message(&response.body)
                            .unwrap_or_else(|| {
                                format!("video generation failed with status {status}")
                            });
                        return Ok(VideoPollState::Failed {
                            response: response.body,
                            message,
                        });
                    }
                    return Ok(VideoPollState::Pending {
                        response: response.body,
                        next_poll_at: now_i64() + DEFAULT_POLL_INTERVAL_MS,
                    });
                }
                Err(_) => continue,
            }
        }
        return Ok(VideoPollState::Pending {
            response: Value::Null,
            next_poll_at: now_i64() + DEFAULT_POLL_INTERVAL_MS,
        });
    }

    let poll_url = video_poll_url(
        endpoint,
        provider_task_id,
        provider_status_url.map(ToString::to_string),
    );
    let response = media_runtime_json_request(
        "GET",
        &poll_url,
        api_key,
        &[],
        None,
        Some(Duration::from_secs(45)),
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "[{poll_url}] HTTP {} {}",
            response.status,
            summarize_json_body(&response.body)
        ));
    }
    if let Some(item) = extract_first_media_result(&response.body) {
        if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
            let inline_base64 = b64.to_string();
            return Ok(VideoPollState::Ready {
                response: response.body,
                inline_base64: Some(inline_base64),
                download_url: None,
            });
        }
    }
    if let Some(url) = extract_media_url(&response.body) {
        return Ok(VideoPollState::Ready {
            response: response.body,
            inline_base64: None,
            download_url: Some(url),
        });
    }
    let status = extract_video_generation_status(&response.body);
    if status.contains("failed") || status.contains("error") || status.contains("cancel") {
        let message = extract_video_generation_failure_message(&response.body)
            .unwrap_or_else(|| format!("video generation failed with status {status}"));
        return Ok(VideoPollState::Failed {
            response: response.body,
            message,
        });
    }
    Ok(VideoPollState::Pending {
        response: response.body,
        next_poll_at: now_i64() + DEFAULT_POLL_INTERVAL_MS,
    })
}

fn transition_video_job_to_polling(
    app: &AppHandle,
    loaded: &LoadedJob,
    provider_task_id: &str,
    provider_status_url: Option<&str>,
    response: &Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    set_attempt_details(
        &conn,
        &current,
        "polling",
        Some(provider_task_id),
        provider_status_url,
        Some(now_i64() + DEFAULT_POLL_INTERVAL_MS),
        Some(response),
        None,
        true,
    )?;
    update_job_result_json(
        &conn,
        &current.job.job_id,
        &json!({
            "providerTaskId": provider_task_id,
            "providerStatusUrl": provider_status_url,
            "lastResponse": response,
        }),
        false,
    )?;
    append_event_with_connection(
        &conn,
        &current.job.job_id,
        Some(&current.attempt.attempt_id),
        "submitted",
        "Video generation submitted to provider",
        Some(response),
    )?;
    emit_job_updated(app, &state, &current.job.job_id);
    Ok(())
}

fn transition_video_job_to_downloading(
    app: &AppHandle,
    loaded: &LoadedJob,
    response: &Value,
    inline_base64: Option<String>,
    download_url: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    let result_json = json!({
        "ready": true,
        "inlineBase64": inline_base64,
        "downloadUrl": download_url,
        "response": response,
    });
    set_attempt_details(
        &conn,
        &current,
        "downloading",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        None,
        Some(&result_json),
        None,
        true,
    )?;
    update_job_result_json(&conn, &current.job.job_id, &result_json, false)?;
    append_event_with_connection(
        &conn,
        &current.job.job_id,
        Some(&current.attempt.attempt_id),
        "ready_for_download",
        "Video generation artifact is ready for download",
        Some(&result_json),
    )?;
    emit_job_updated(app, &state, &current.job.job_id);
    Ok(())
}

async fn video_ready_bytes(
    inline_base64: Option<String>,
    download_url: Option<String>,
) -> Result<Vec<u8>, String> {
    if let Some(b64) = inline_base64 {
        decode_base64_bytes(&b64)
    } else if let Some(url) = download_url {
        media_runtime_bytes_request("GET", &url, None, &[], None, Some(Duration::from_secs(120)))
            .await
    } else {
        Err("video job did not contain a ready artifact".to_string())
    }
}

async fn complete_video_download_and_bind(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(loaded) = load_job_with_current_attempt(&conn, job_id)? else {
        return Ok(());
    };
    if loaded.job.status == "cancel_requested" {
        return complete_job_cancelled(app, job_id, "User requested cancellation");
    }
    let result = loaded.job.result_json.clone().unwrap_or(Value::Null);
    let inline_base64 = result
        .get("inlineBase64")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let download_url = result
        .get("downloadUrl")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let bytes = video_ready_bytes(inline_base64, download_url).await?;
    let (relative_path, absolute_path, preview_url) =
        write_video_bytes_to_generated_path(&state, &bytes)?;
    let thumbnail_url =
        ensure_video_thumbnail_for_path(Some(app), &state, PathBuf::from(&absolute_path).as_path());
    let metadata = create_video_artifact_metadata(
        &loaded,
        &relative_path,
        &absolute_path,
        &preview_url,
        thumbnail_url.as_deref(),
    );
    insert_artifact_with_connection(
        &conn,
        job_id,
        "media",
        Some(&relative_path),
        Some(&absolute_path),
        Some("video/mp4"),
        Some(&preview_url),
        Some(&metadata),
    )?;

    let media_asset = MediaAssetRecord {
        id: metadata
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source: "generated".to_string(),
        source_domain: None,
        source_link: None,
        project_id: loaded.job.project_id.clone(),
        title: metadata
            .get("title")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        prompt: loaded
            .job
            .request_json
            .get("prompt")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        provider: Some(loaded.job.provider_key.clone()),
        provider_template: None,
        model: loaded.job.provider_model.clone(),
        aspect_ratio: loaded
            .job
            .request_json
            .get("aspectRatio")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        size: loaded
            .job
            .request_json
            .get("resolution")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        quality: None,
        mime_type: Some("video/mp4".to_string()),
        content_hash: file_content_hash(PathBuf::from(&absolute_path).as_path()).ok(),
        relative_path: Some(relative_path.clone()),
        bound_manuscript_path: loaded.job.manuscript_path.clone(),
        created_at: now_iso(),
        updated_at: now_iso(),
        absolute_path: Some(absolute_path.clone()),
        preview_url: Some(preview_url.clone()),
        thumbnail_url,
        exists: true,
    };
    with_store_mut(&state, |store| {
        media_store::push_asset(store, media_asset.clone());
        store.work_items.push(create_work_item(
            "video-generation",
            media_asset
                .title
                .clone()
                .unwrap_or_else(|| "视频生成".to_string()),
            Some(format!(
                "{} 已通过独立媒体 runtime 完成视频生成。",
                app_brand_display_name()
            )),
            media_asset.prompt.clone(),
            Some(json!({
                "jobId": job_id,
                "generationChannel": "video-gen:generate",
                "providerKey": loaded.job.provider_key,
                "relativePath": relative_path,
            })),
            2,
        ));
        Ok(())
    })?;
    persist_media_workspace_catalog(&state)?;
    if let Some(video_project_path) = loaded.job.video_project_path.clone() {
        let _ = commands::manuscripts::handle_manuscripts_channel(
            app,
            &state,
            "manuscripts:add-package-clip",
            &json!({
                "filePath": video_project_path,
                "assetId": media_asset.id,
            }),
        );
    }
    update_job_result_json(
        &conn,
        job_id,
        &json!({
            "response": result.get("response").cloned().unwrap_or(Value::Null),
            "assets": [metadata.clone()],
            "downloaded": true,
        }),
        true,
    )?;
    let Some(current) = load_job_with_current_attempt(&conn, job_id)? else {
        return Ok(());
    };
    set_attempt_details(
        &conn,
        &current,
        "completed",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        None,
        current.attempt.response_json.as_ref(),
        None,
        true,
    )?;
    append_event_with_connection(
        &conn,
        job_id,
        Some(&current.attempt.attempt_id),
        "completed",
        "Video generation completed",
        Some(&metadata),
    )?;
    emit_job_updated(app, &state, job_id);
    Ok(())
}

fn video_sequence_segments(request: &Value) -> Result<Vec<Value>, String> {
    let explicit_segments = request
        .get("videoSegments")
        .or_else(|| request.get("segments"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !explicit_segments.is_empty() {
        let total = explicit_segments.len();
        return explicit_segments
            .into_iter()
            .enumerate()
            .map(|(index, segment)| {
                let mut payload = request.clone();
                if let (Some(base), Some(patch)) = (payload.as_object_mut(), segment.as_object()) {
                    for (key, value) in patch {
                        base.insert(key.clone(), value.clone());
                    }
                }
                let prompt = payload_string(&segment, "prompt")
                    .or_else(|| payload_string(&segment, "text"))
                    .or_else(|| payload_string(&segment, "description"))
                    .or_else(|| payload_string(request, "prompt"))
                    .unwrap_or_default();
                if prompt.trim().is_empty() {
                    return Err(format!(
                        "video sequence segment {} is missing prompt",
                        index + 1
                    ));
                }
                let duration = payload_i64_any(
                    &segment,
                    &["durationSeconds", "duration_seconds", "duration", "seconds"],
                )
                .or_else(|| {
                    payload_i64_any(
                        request,
                        &["durationSeconds", "duration_seconds", "duration", "seconds"],
                    )
                })
                .unwrap_or(MAX_VIDEO_SEGMENT_SECONDS)
                .clamp(1, MAX_VIDEO_SEGMENT_SECONDS);
                if let Some(object) = payload.as_object_mut() {
                    object.insert("prompt".to_string(), json!(prompt));
                    object.insert("durationSeconds".to_string(), json!(duration));
                    object.insert("segmentIndex".to_string(), json!(index));
                    object.insert("segmentNumber".to_string(), json!(index + 1));
                    object.insert("segmentTotal".to_string(), json!(total));
                    object.remove("videoSegments");
                    object.remove("segments");
                }
                Ok(payload)
            })
            .collect();
    }

    let total_duration = payload_i64_any(
        request,
        &["durationSeconds", "duration_seconds", "duration", "seconds"],
    )
    .unwrap_or(MAX_VIDEO_SEGMENT_SECONDS)
    .max(1);
    let segment_count = ((total_duration + MAX_VIDEO_SEGMENT_SECONDS - 1)
        / MAX_VIDEO_SEGMENT_SECONDS)
        .max(1) as usize;
    let base_prompt = payload_string(request, "prompt").unwrap_or_default();
    if base_prompt.trim().is_empty() {
        return Err("video sequence requires prompt".to_string());
    }
    let mut remaining = total_duration;
    let mut segments = Vec::with_capacity(segment_count);
    for index in 0..segment_count {
        let duration = remaining.min(MAX_VIDEO_SEGMENT_SECONDS).max(1);
        remaining -= duration;
        let mut payload = request.clone();
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "prompt".to_string(),
                json!(format!(
                    "{base_prompt}\n\nThis is segment {}/{} of one continuous video. Keep visual continuity and pacing with the surrounding segments.",
                    index + 1,
                    segment_count
                )),
            );
            object.insert("durationSeconds".to_string(), json!(duration));
            object.insert("segmentIndex".to_string(), json!(index));
            object.insert("segmentNumber".to_string(), json!(index + 1));
            object.insert("segmentTotal".to_string(), json!(segment_count));
        }
        segments.push(payload);
    }
    Ok(segments)
}

async fn run_video_segment_generation(
    state: &State<'_, AppState>,
    settings: &Value,
    loaded: &LoadedJob,
    payload: &Value,
) -> Result<(Value, Vec<u8>), String> {
    if is_video_retalk_request(payload, loaded.job.provider_model.as_deref()) {
        return Err("video sequence does not support VideoRetalk segments yet".to_string());
    }
    let (endpoint, api_key, default_model) =
        resolve_video_generation_settings_with_override(settings, Some(payload))
            .ok_or_else(|| "video generation requires a configured video provider".to_string())?;
    let effective_model = loaded
        .job
        .provider_model
        .clone()
        .unwrap_or_else(|| default_model.clone());
    let response = run_video_generation_request_async(
        &endpoint,
        api_key.as_deref(),
        &effective_model,
        payload,
    )
    .await?;
    if let Some(item) = extract_first_media_result(&response) {
        if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
            let bytes = video_ready_bytes(Some(b64.to_string()), None).await?;
            return Ok((response, bytes));
        }
    }
    if let Some(url) = extract_media_url(&response) {
        let bytes = video_ready_bytes(None, Some(url)).await?;
        return Ok((response, bytes));
    }
    let Some((provider_task_id, _)) = extract_task_id_details(&response) else {
        return Err("视频片段任务创建失败：provider 未返回 taskId。".to_string());
    };
    let provider_status_url = extract_status_url(&response);
    let deadline = now_i64() + VIDEO_PROVIDER_POLL_TIMEOUT_MS;
    let mut last_lease_renewal_at = 0_i64;
    loop {
        let now = now_i64();
        if now > deadline {
            return Err("video sequence segment timed out while polling provider".to_string());
        }
        if is_media_job_cancel_requested(state, &loaded.job.job_id)? {
            return Err(MEDIA_JOB_CANCEL_REQUESTED_ERROR.to_string());
        }
        if now.saturating_sub(last_lease_renewal_at) >= ACTIVE_STAGE_LEASE_MS / 3 {
            renew_media_job_stage_lease(
                state,
                loaded,
                "media-runtime:video-sequence-submit",
                "submitting",
            )?;
            last_lease_renewal_at = now;
        }
        tokio::time::sleep(Duration::from_millis(DEFAULT_POLL_INTERVAL_MS as u64)).await;
        match poll_video_generation_once(
            &endpoint,
            api_key.as_deref(),
            &effective_model,
            &provider_task_id,
            provider_status_url.as_deref(),
        )
        .await?
        {
            VideoPollState::Pending { .. } => {}
            VideoPollState::Ready {
                response,
                inline_base64,
                download_url,
            } => {
                let bytes = video_ready_bytes(inline_base64, download_url).await?;
                return Ok((response, bytes));
            }
            VideoPollState::Failed { message, .. } => return Err(message),
        }
    }
}

fn write_video_sequence_segment_bytes(
    state: &State<'_, AppState>,
    job_id: &str,
    index: usize,
    bytes: &[u8],
) -> Result<(String, String, String, PathBuf), String> {
    let relative_path = format!("generated/video-sequences/{job_id}/segment-{index:03}.mp4");
    let absolute_path = media_root(state)?.join(&relative_path);
    let temp_path = absolute_path.with_extension("mp4.tmp");
    if let Some(parent) = temp_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    {
        let mut file = File::create(&temp_path).map_err(|error| error.to_string())?;
        use std::io::Write as _;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temp_path, &absolute_path).map_err(|error| error.to_string())?;
    Ok((
        relative_path,
        absolute_path.display().to_string(),
        file_url_for_path(&absolute_path),
        absolute_path,
    ))
}

fn video_sequence_output_paths(
    state: &State<'_, AppState>,
    job_id: &str,
) -> Result<(String, PathBuf), String> {
    let relative_path = format!("generated/video-sequences/{job_id}/final.mp4");
    let absolute_path = media_root(state)?.join(&relative_path);
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok((relative_path, absolute_path))
}

fn merge_video_sequence_with_ffmpeg(
    app: &AppHandle,
    state: &State<'_, AppState>,
    job_id: &str,
    segment_paths: &[PathBuf],
) -> Result<(String, PathBuf), String> {
    if segment_paths.is_empty() {
        return Err("video sequence has no segments to merge".to_string());
    }
    let work_dir = media_runtime_root(state)?
        .join("video-sequences")
        .join(job_id);
    fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let list_path = work_dir.join("concat.txt");
    let list_body = segment_paths
        .iter()
        .map(concat_list_line)
        .collect::<String>();
    fs::write(&list_path, list_body).map_err(|error| error.to_string())?;
    let (relative_path, absolute_path) = video_sequence_output_paths(state, job_id)?;
    let temp_path = absolute_path.with_extension("mp4.tmp");
    let output = background_command(ffmpeg_program(Some(app))?)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("concat")
        .arg("-safe")
        .arg("0")
        .arg("-i")
        .arg(&list_path)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a?")
        .arg("-c:v")
        .arg("libx264")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-movflags")
        .arg("+faststart")
        .arg(&temp_path)
        .output()
        .map_err(|error| format!("video sequence merge could not start ffmpeg: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = fs::remove_file(&temp_path);
        return Err(if detail.is_empty() {
            "video sequence merge failed".to_string()
        } else {
            format!("video sequence merge failed: {detail}")
        });
    }
    fs::rename(&temp_path, &absolute_path).map_err(|error| error.to_string())?;
    Ok((relative_path, absolute_path))
}

fn register_video_sequence_asset(
    app: &AppHandle,
    state: &State<'_, AppState>,
    loaded: &LoadedJob,
    relative_path: String,
    absolute_path: PathBuf,
) -> Result<Value, String> {
    let absolute_path_text = absolute_path.display().to_string();
    let preview_url = file_url_for_path(&absolute_path);
    let thumbnail_url = ensure_video_thumbnail_for_path(Some(app), state, &absolute_path);
    let metadata = create_video_artifact_metadata(
        loaded,
        &relative_path,
        &absolute_path_text,
        &preview_url,
        thumbnail_url.as_deref(),
    );
    let media_asset = MediaAssetRecord {
        id: metadata
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source: "generated".to_string(),
        source_domain: None,
        source_link: None,
        project_id: loaded.job.project_id.clone(),
        title: metadata
            .get("title")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        prompt: loaded
            .job
            .request_json
            .get("prompt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        provider: Some(loaded.job.provider_key.clone()),
        provider_template: Some("video.sequence".to_string()),
        model: loaded.job.provider_model.clone(),
        aspect_ratio: loaded
            .job
            .request_json
            .get("aspectRatio")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        size: loaded
            .job
            .request_json
            .get("resolution")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        quality: None,
        mime_type: Some("video/mp4".to_string()),
        content_hash: file_content_hash(&absolute_path).ok(),
        relative_path: Some(relative_path.clone()),
        bound_manuscript_path: loaded.job.manuscript_path.clone(),
        created_at: now_iso(),
        updated_at: now_iso(),
        absolute_path: Some(absolute_path_text.clone()),
        preview_url: Some(preview_url.clone()),
        thumbnail_url,
        exists: absolute_path.is_file(),
    };
    with_store_mut(state, |store| {
        media_store::push_asset(store, media_asset.clone());
        store.work_items.push(create_work_item(
            "video-generation",
            media_asset
                .title
                .clone()
                .unwrap_or_else(|| "视频生成".to_string()),
            Some(format!(
                "{} 已通过独立媒体 runtime 完成长视频拼接。",
                app_brand_display_name()
            )),
            media_asset.prompt.clone(),
            Some(json!({
                "jobId": loaded.job.job_id,
                "generationChannel": "video.sequence",
                "providerKey": loaded.job.provider_key,
                "relativePath": relative_path,
            })),
            2,
        ));
        Ok(())
    })?;
    persist_media_workspace_catalog(state)?;
    Ok(metadata)
}

fn complete_video_sequence_job(
    app: &AppHandle,
    loaded: &LoadedJob,
    result: &Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = open_media_runtime_connection(&state)?;
    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)? else {
        return Ok(());
    };
    let asset = result.get("asset").cloned().unwrap_or(Value::Null);
    insert_artifact_with_connection(
        &conn,
        &loaded.job.job_id,
        "media",
        result
            .get("relativePath")
            .and_then(Value::as_str)
            .or_else(|| asset.get("relativePath").and_then(Value::as_str)),
        result
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| asset.get("absolutePath").and_then(Value::as_str)),
        Some("video/mp4"),
        asset.get("previewUrl").and_then(Value::as_str),
        Some(&asset),
    )?;
    update_job_result_json(&conn, &loaded.job.job_id, result, true)?;
    set_attempt_details(
        &conn,
        &current,
        "completed",
        current.attempt.provider_task_id.as_deref(),
        current.attempt.provider_status_url.as_deref(),
        None,
        Some(result),
        None,
        true,
    )?;
    append_event_with_connection(
        &conn,
        &loaded.job.job_id,
        Some(&current.attempt.attempt_id),
        "completed",
        "Video sequence generation completed",
        Some(result),
    )?;
    emit_job_updated(app, &state, &loaded.job.job_id);
    Ok(())
}

fn run_image_submit_worker(app: AppHandle, loaded: LoadedJob, slots: Arc<Mutex<RuntimeSlots>>) {
    let job_id = loaded.job.job_id.clone();
    let result = run_image_job_sync(&app, &loaded)
        .and_then(|assets| complete_image_job(&app, &job_id, &assets));
    if let Err(error) = result {
        let state = app.state::<AppState>();
        let partial_artifact_count = open_media_runtime_connection(&state)
            .and_then(|conn| artifact_count_for_job(&conn, &job_id))
            .unwrap_or(0);
        if partial_artifact_count > 0 {
            let result_json = json!({
                "error": error.clone(),
                "partial": true,
                "completedImages": partial_artifact_count,
            });
            let _ = fail_job(&app, &job_id, &error, Some(&result_json));
        } else {
            let _ =
                schedule_stage_retry_or_dead_letter(&app, &job_id, "image-submit", &error, None);
        }
        emit_job_log(
            &app,
            &job_id,
            &format!("image worker failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "image-submit");
}

fn run_audio_submit_worker(app: AppHandle, loaded: LoadedJob, slots: Arc<Mutex<RuntimeSlots>>) {
    let result = (|| {
        let state = app.state::<AppState>();
        if get_media_job_projection(&state, &loaded.job.job_id)?
            .get("status")
            .and_then(Value::as_str)
            == Some("cancel_requested")
        {
            return complete_job_cancelled(&app, &loaded.job.job_id, "User requested cancellation");
        }
        let mut payload = loaded.job.request_json.clone();
        if let Some(object) = payload.as_object_mut() {
            if let Some(model) = loaded.job.provider_model.clone() {
                object.entry("model".to_string()).or_insert(json!(model));
            }
            object.insert("runtimeBypass".to_string(), json!(true));
            object.insert("source".to_string(), json!(loaded.job.source.clone()));
            object.insert("jobId".to_string(), json!(loaded.job.job_id.clone()));
        }
        let result = crate::voice_service::synthesize_speech(&state, &payload)?;
        complete_audio_job(&app, &loaded, &result)
    })();
    if let Err(error) = result {
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "audio-submit",
            &error,
            None,
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("audio submit failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "audio-submit");
}

fn run_audio_sequence_submit_worker(
    app: AppHandle,
    loaded: LoadedJob,
    slots: Arc<Mutex<RuntimeSlots>>,
) {
    let result = (|| {
        let state = app.state::<AppState>();
        remove_existing_audio_sequence_artifacts(&state, &loaded.job.job_id)?;
        let segments = crate::voice_service::speech_sequence_segments(&loaded.job.request_json)?;
        let total = segments.len();
        let extension = audio_sequence_format(&loaded.job.request_json);
        let mut segment_results = Vec::<Value>::with_capacity(total);
        let mut segment_paths = Vec::<PathBuf>::with_capacity(total);
        let prompt = audio_sequence_prompt_text(&segments);

        for (index, segment) in segments.iter().enumerate() {
            if get_media_job_projection(&state, &loaded.job.job_id)?
                .get("status")
                .and_then(Value::as_str)
                == Some("cancel_requested")
            {
                return complete_job_cancelled(
                    &app,
                    &loaded.job.job_id,
                    "User requested cancellation",
                );
            }
            let mut payload = crate::voice_service::speech_sequence_segment_payload(
                &loaded.job.request_json,
                segment,
                index,
            )?;
            if let Some(object) = payload.as_object_mut() {
                if let Some(model) = loaded.job.provider_model.clone() {
                    object.entry("model".to_string()).or_insert(json!(model));
                }
                object.insert("source".to_string(), json!(loaded.job.source.clone()));
                object.insert("jobId".to_string(), json!(loaded.job.job_id.clone()));
            }
            let segment_result =
                crate::voice_service::synthesize_speech_artifact(&state, &payload)?;
            let segment_path = segment_result
                .get("path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .ok_or_else(|| "voice.speech segment did not return path".to_string())?;
            let pause_before = audio_sequence_boundary_pause_seconds(segment, true)?.unwrap_or(0.0);
            let pause_after = audio_sequence_boundary_pause_seconds(segment, false)?.unwrap_or(0.0);
            let asset = segment_result.get("asset").cloned().unwrap_or(Value::Null);
            let metadata = json!({
                "segmentIndex": index,
                "segmentNumber": index + 1,
                "inputPreview": payload_string(&payload, "input")
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect::<String>(),
                "speed": payload_field(&payload, "speed").cloned().unwrap_or(Value::Null),
                "pitch": payload_field(&payload, "pitch").cloned().unwrap_or(Value::Null),
                "emotion": payload_field(&payload, "emotion").cloned().unwrap_or(Value::Null),
                "pauseBeforeSeconds": pause_before,
                "pauseAfterSeconds": pause_after,
                "asset": asset,
            });
            let conn = open_media_runtime_connection(&state)?;
            insert_artifact_with_connection(
                &conn,
                &loaded.job.job_id,
                "audio_segment",
                segment_result
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .or_else(|| asset.get("relativePath").and_then(Value::as_str)),
                segment_result
                    .get("path")
                    .and_then(Value::as_str)
                    .or_else(|| asset.get("absolutePath").and_then(Value::as_str)),
                asset.get("mimeType").and_then(Value::as_str),
                asset.get("previewUrl").and_then(Value::as_str),
                Some(&metadata),
            )?;
            if pause_before > 0.0 {
                segment_paths.push(create_audio_sequence_silence_file(
                    &app,
                    &state,
                    &loaded.job.job_id,
                    &extension,
                    &format!("segment-{}-before", index + 1),
                    pause_before,
                )?);
            }
            segment_paths.push(segment_path);
            if pause_after > 0.0 {
                segment_paths.push(create_audio_sequence_silence_file(
                    &app,
                    &state,
                    &loaded.job.job_id,
                    &extension,
                    &format!("segment-{}-after", index + 1),
                    pause_after,
                )?);
            }
            segment_results.push(json!({
                "index": index,
                "path": segment_result.get("path").cloned().unwrap_or(Value::Null),
                "relativePath": segment_result.get("relativePath").cloned().unwrap_or(Value::Null),
                "speed": payload_field(&payload, "speed").cloned().unwrap_or(Value::Null),
                "pitch": payload_field(&payload, "pitch").cloned().unwrap_or(Value::Null),
                "emotion": payload_field(&payload, "emotion").cloned().unwrap_or(Value::Null),
                "pauseBeforeSeconds": pause_before,
                "pauseAfterSeconds": pause_after,
            }));
            let progress = json!({
                "progress": {
                    "completedSegments": index + 1,
                    "expectedSegments": total,
                },
                "segments": segment_results.clone(),
            });
            update_job_result_json(&conn, &loaded.job.job_id, &progress, false)?;
            append_event_with_connection(
                &conn,
                &loaded.job.job_id,
                Some(&loaded.attempt.attempt_id),
                "segment_completed",
                &format!("Speech segment {}/{} completed", index + 1, total),
                Some(&metadata),
            )?;
            drop(conn);
            emit_job_updated(&app, &state, &loaded.job.job_id);
        }

        if get_media_job_projection(&state, &loaded.job.job_id)?
            .get("status")
            .and_then(Value::as_str)
            == Some("cancel_requested")
        {
            return complete_job_cancelled(&app, &loaded.job.job_id, "User requested cancellation");
        }

        let (relative_path, absolute_path) = merge_audio_sequence_with_ffmpeg(
            &app,
            &state,
            &loaded.job.job_id,
            &segment_paths,
            &extension,
        )?;
        let asset = register_audio_sequence_asset(
            &state,
            &loaded,
            relative_path.clone(),
            absolute_path.clone(),
            prompt,
        )?;
        let result = json!({
            "success": true,
            "asset": asset,
            "voiceId": payload_string(&loaded.job.request_json, "voiceId")
                .or_else(|| payload_string(&loaded.job.request_json, "voice_id"))
                .or_else(|| payload_string(&loaded.job.request_json, "voice")),
            "path": absolute_path.display().to_string(),
            "relativePath": relative_path,
            "segments": segment_results,
            "progress": {
                "completedSegments": total,
                "expectedSegments": total,
            },
        });
        complete_audio_sequence_job(&app, &loaded, &result)
    })();
    if let Err(error) = result {
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "audio-sequence-submit",
            &error,
            None,
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("audio sequence submit failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "audio-sequence-submit");
}

fn run_voice_clone_submit_worker(
    app: AppHandle,
    loaded: LoadedJob,
    slots: Arc<Mutex<RuntimeSlots>>,
) {
    let result = (|| {
        let state = app.state::<AppState>();
        if get_media_job_projection(&state, &loaded.job.job_id)?
            .get("status")
            .and_then(Value::as_str)
            == Some("cancel_requested")
        {
            return complete_job_cancelled(&app, &loaded.job.job_id, "User requested cancellation");
        }
        let mut payload = loaded.job.request_json.clone();
        if let Some(object) = payload.as_object_mut() {
            if let Some(model) = loaded.job.provider_model.clone() {
                object.entry("model".to_string()).or_insert(json!(model));
            }
            object.insert("runtimeBypass".to_string(), json!(true));
            object.insert("source".to_string(), json!(loaded.job.source.clone()));
            object.insert("jobId".to_string(), json!(loaded.job.job_id.clone()));
        }
        let clone_model =
            payload_string(&payload, "model").or_else(|| loaded.job.provider_model.clone());
        let target_tts_model = payload_string(&payload, "targetTtsModel")
            .or_else(|| payload_string(&payload, "target_tts_model"))
            .or_else(|| payload_string(&payload, "ttsModel"))
            .or_else(|| payload_string(&payload, "tts_model"));
        {
            let conn = open_media_runtime_connection(&state)?;
            let current = load_job_with_current_attempt(&conn, &loaded.job.job_id)?;
            append_event_with_connection(
                &conn,
                &loaded.job.job_id,
                current
                    .as_ref()
                    .map(|item| item.attempt.attempt_id.as_str()),
                "voice_clone_request",
                "Voice clone request started",
                Some(&json!({
                    "model": clone_model,
                    "targetTtsModel": target_tts_model,
                    "providerModel": loaded.job.provider_model,
                    "providerKey": loaded.job.provider_key,
                    "ownerAssetId": payload_string(&payload, "ownerAssetId")
                        .or_else(|| payload_string(&payload, "assetId"))
                        .or_else(|| payload_string(&payload, "subjectId")),
                    "sampleFileKey": payload_string(&payload, "sampleFileKey")
                        .or_else(|| payload_string(&payload, "sample_file_key")),
                    "samplePath": payload_string(&payload, "samplePath"),
                })),
            )?;
        }
        let result = crate::voice_service::clone_voice(Some(&app), &state, &payload)?;
        complete_voice_clone_job(&app, &loaded, &result)
    })();
    if let Err(error) = result {
        let clone_model = payload_string(&loaded.job.request_json, "model")
            .or_else(|| loaded.job.provider_model.clone());
        let target_tts_model = payload_string(&loaded.job.request_json, "targetTtsModel")
            .or_else(|| payload_string(&loaded.job.request_json, "target_tts_model"))
            .or_else(|| payload_string(&loaded.job.request_json, "ttsModel"))
            .or_else(|| payload_string(&loaded.job.request_json, "tts_model"));
        if let Some(subject_id) = loaded
            .job
            .request_json
            .get("ownerAssetId")
            .and_then(Value::as_str)
        {
            let state = app.state::<AppState>();
            let _ = crate::voice_service::patch_subject_voice_failure(
                &state,
                subject_id,
                error.clone(),
            );
        }
        let error_payload = json!({
            "model": clone_model.clone(),
            "targetTtsModel": target_tts_model.clone(),
            "providerModel": loaded.job.provider_model.clone(),
            "providerKey": loaded.job.provider_key.clone(),
            "upstreamError": error.clone(),
        });
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "voice-clone-submit",
            &error,
            Some(&error_payload),
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("voice clone submit failed: {error}"),
            Some(error_payload),
        );
    }
    release_slot(&slots, &loaded, "voice-clone-submit");
}

async fn run_video_sequence_submit_worker(
    app: AppHandle,
    loaded: LoadedJob,
    slots: Arc<Mutex<RuntimeSlots>>,
) {
    let result = async {
        let state = app.state::<AppState>();
        let settings = with_store(&state, |store| {
            Ok(settings_store::settings_snapshot(&store))
        })?;
        remove_existing_video_sequence_artifacts(&state, &loaded.job.job_id)?;
        let segments = video_sequence_segments(&loaded.job.request_json)?;
        if segments.len() <= 1 {
            return Err("video sequence requires more than one segment".to_string());
        }
        let total = segments.len();
        let mut segment_results = Vec::<Value>::with_capacity(total);
        let mut segment_paths = Vec::<PathBuf>::with_capacity(total);

        for (index, segment_payload) in segments.iter().enumerate() {
            if get_media_job_projection(&state, &loaded.job.job_id)?
                .get("status")
                .and_then(Value::as_str)
                == Some("cancel_requested")
            {
                return complete_job_cancelled(
                    &app,
                    &loaded.job.job_id,
                    "User requested cancellation",
                );
            }
            let (provider_response, bytes) =
                match run_video_segment_generation(&state, &settings, &loaded, segment_payload)
                    .await
                {
                    Ok(result) => result,
                    Err(error) if error == MEDIA_JOB_CANCEL_REQUESTED_ERROR => {
                        return complete_job_cancelled(
                            &app,
                            &loaded.job.job_id,
                            "User requested cancellation",
                        );
                    }
                    Err(error) => return Err(error),
                };
            let (relative_path, absolute_path, preview_url, segment_path) =
                write_video_sequence_segment_bytes(&state, &loaded.job.job_id, index + 1, &bytes)?;
            let metadata = json!({
                "segmentIndex": index,
                "segmentNumber": index + 1,
                "segmentTotal": total,
                "durationSeconds": payload_i64_any(segment_payload, &["durationSeconds", "duration_seconds", "duration", "seconds"]),
                "prompt": payload_string(segment_payload, "prompt"),
                "providerResponse": provider_response,
            });
            let conn = open_media_runtime_connection(&state)?;
            insert_artifact_with_connection(
                &conn,
                &loaded.job.job_id,
                "video_segment",
                Some(&relative_path),
                Some(&absolute_path),
                Some("video/mp4"),
                Some(&preview_url),
                Some(&metadata),
            )?;
            segment_paths.push(segment_path);
            segment_results.push(json!({
                "segmentIndex": index,
                "segmentNumber": index + 1,
                "relativePath": relative_path,
                "path": absolute_path,
                "previewUrl": preview_url,
                "metadata": metadata,
            }));
            let progress = json!({
                "progress": {
                    "completedSegments": index + 1,
                    "expectedSegments": total,
                },
                "segments": segment_results.clone(),
            });
            update_job_result_json(&conn, &loaded.job.job_id, &progress, false)?;
            append_event_with_connection(
                &conn,
                &loaded.job.job_id,
                Some(&loaded.attempt.attempt_id),
                "segment_completed",
                &format!("Video segment {}/{} completed", index + 1, total),
                Some(&progress),
            )?;
            drop(conn);
            emit_job_updated(&app, &state, &loaded.job.job_id);
        }

        if get_media_job_projection(&state, &loaded.job.job_id)?
            .get("status")
            .and_then(Value::as_str)
            == Some("cancel_requested")
        {
            return complete_job_cancelled(&app, &loaded.job.job_id, "User requested cancellation");
        }

        let (relative_path, absolute_path) =
            merge_video_sequence_with_ffmpeg(&app, &state, &loaded.job.job_id, &segment_paths)?;
        let asset = register_video_sequence_asset(
            &app,
            &state,
            &loaded,
            relative_path.clone(),
            absolute_path.clone(),
        )?;
        let result = json!({
            "success": true,
            "asset": asset,
            "path": absolute_path.display().to_string(),
            "relativePath": relative_path,
            "segments": segment_results,
            "progress": {
                "completedSegments": total,
                "expectedSegments": total,
            },
        });
        complete_video_sequence_job(&app, &loaded, &result)
    }
    .await;
    if let Err(error) = result {
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "video-sequence-submit",
            &error,
            None,
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("video sequence submit failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "video-sequence-submit");
}

async fn run_video_submit_worker(
    app: AppHandle,
    loaded: LoadedJob,
    slots: Arc<Mutex<RuntimeSlots>>,
) {
    let result = async {
        let state = app.state::<AppState>();
        if get_media_job_projection(&state, &loaded.job.job_id)?
            .get("status")
            .and_then(Value::as_str)
            == Some("cancel_requested")
        {
            return complete_job_cancelled(&app, &loaded.job.job_id, "User requested cancellation");
        }
        let settings = with_store(&state, |store| {
            Ok(settings_store::settings_snapshot(&store))
        })?;
        if is_video_retalk_request(
            &loaded.job.request_json,
            loaded.job.provider_model.as_deref(),
        ) {
            let (endpoint, api_key) = resolve_video_retalk_settings(&settings);
            let response = run_video_retalk_request_async(
                &endpoint,
                api_key.as_deref(),
                &loaded.job.request_json,
            )
            .await?;
            let Some((provider_task_id, _)) = extract_task_id_details(&response) else {
                let message = "VideoRetalk task creation failed: provider did not return task_id."
                    .to_string();
                let failure = json!({
                    "error": message,
                    "reason": "missing_provider_task_id",
                    "providerResponse": response,
                });
                return fail_job(&app, &loaded.job.job_id, &message, Some(&failure));
            };
            return transition_video_job_to_polling(
                &app,
                &loaded,
                &provider_task_id,
                None,
                &response,
            );
        }
        let (endpoint, api_key, default_model) = resolve_video_generation_settings_with_override(
            &settings,
            Some(&loaded.job.request_json),
        )
        .ok_or_else(|| "video generation requires a configured video provider".to_string())?;
        let effective_model = loaded
            .job
            .provider_model
            .clone()
            .unwrap_or_else(|| default_model.clone());
        let response = run_video_generation_request_async(
            &endpoint,
            api_key.as_deref(),
            &effective_model,
            &loaded.job.request_json,
        )
        .await?;
        if let Some(item) = extract_first_media_result(&response) {
            if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
                return transition_video_job_to_downloading(
                    &app,
                    &loaded,
                    &response,
                    Some(b64.to_string()),
                    None,
                );
            }
        }
        if let Some(url) = extract_media_url(&response) {
            return transition_video_job_to_downloading(&app, &loaded, &response, None, Some(url));
        }
        let Some((provider_task_id, _)) = extract_task_id_details(&response) else {
            let message = "视频任务创建失败：provider 未返回 taskId，已停止轮询。".to_string();
            let failure = json!({
                "error": message,
                "reason": "missing_provider_task_id",
                "providerResponse": response,
            });
            return fail_job(&app, &loaded.job.job_id, &message, Some(&failure));
        };
        transition_video_job_to_polling(
            &app,
            &loaded,
            &provider_task_id,
            extract_status_url(&response).as_deref(),
            &response,
        )
    }
    .await;
    if let Err(error) = result {
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "video-submit",
            &error,
            None,
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("video submit failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "video-submit");
}

async fn run_video_poll_worker(app: AppHandle, loaded: LoadedJob, slots: Arc<Mutex<RuntimeSlots>>) {
    let result = async {
        let state = app.state::<AppState>();
        if get_media_job_projection(&state, &loaded.job.job_id)?
            .get("status")
            .and_then(Value::as_str)
            == Some("cancel_requested")
        {
            return complete_job_cancelled(&app, &loaded.job.job_id, "User requested cancellation");
        }
        let settings = with_store(&state, |store| {
            Ok(settings_store::settings_snapshot(&store))
        })?;
        if is_video_retalk_request(
            &loaded.job.request_json,
            loaded.job.provider_model.as_deref(),
        ) {
            let (endpoint, api_key) = resolve_video_retalk_settings(&settings);
            let Some(provider_task_id) = loaded.attempt.provider_task_id.clone() else {
                let message =
                    "VideoRetalk task state is corrupted: missing provider task_id.".to_string();
                let failure = json!({
                    "error": message,
                    "reason": "missing_provider_task_id",
                    "attemptNo": loaded.attempt.attempt_no,
                });
                return fail_job(&app, &loaded.job.job_id, &message, Some(&failure));
            };
            match poll_video_retalk_once(&endpoint, api_key.as_deref(), &provider_task_id).await? {
                VideoPollState::Pending {
                    response,
                    next_poll_at,
                } => {
                    let conn = open_media_runtime_connection(&state)?;
                    let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)?
                    else {
                        return Ok(());
                    };
                    set_attempt_details(
                        &conn,
                        &current,
                        "polling",
                        current.attempt.provider_task_id.as_deref(),
                        current.attempt.provider_status_url.as_deref(),
                        Some(next_poll_at),
                        Some(&response),
                        None,
                        true,
                    )?;
                    update_job_result_json(
                        &conn,
                        &current.job.job_id,
                        &json!({
                            "providerTaskId": provider_task_id,
                            "lastResponse": response,
                            "nextPollAt": next_poll_at,
                        }),
                        false,
                    )?;
                    append_event_with_connection(
                        &conn,
                        &current.job.job_id,
                        Some(&current.attempt.attempt_id),
                        "poll_pending",
                        "VideoRetalk is still pending",
                        Some(&response),
                    )?;
                    emit_job_updated(&app, &state, &current.job.job_id);
                    return Ok(());
                }
                VideoPollState::Ready {
                    response,
                    inline_base64,
                    download_url,
                } => {
                    return transition_video_job_to_downloading(
                        &app,
                        &loaded,
                        &response,
                        inline_base64,
                        download_url,
                    );
                }
                VideoPollState::Failed { response, message } => {
                    return fail_job(&app, &loaded.job.job_id, &message, Some(&response));
                }
            }
        }
        let (endpoint, api_key, default_model) = resolve_video_generation_settings_with_override(
            &settings,
            Some(&loaded.job.request_json),
        )
        .ok_or_else(|| "video generation requires a configured video provider".to_string())?;
        let model = loaded.job.provider_model.clone().unwrap_or(default_model);
        let Some(provider_task_id) = loaded.attempt.provider_task_id.clone() else {
            let message = "视频任务状态损坏：缺少 provider taskId，已停止轮询。".to_string();
            let failure = json!({
                "error": message,
                "reason": "missing_provider_task_id",
                "providerStatusUrl": loaded.attempt.provider_status_url.clone(),
                "attemptNo": loaded.attempt.attempt_no,
            });
            return fail_job(&app, &loaded.job.job_id, &message, Some(&failure));
        };
        match poll_video_generation_once(
            &endpoint,
            api_key.as_deref(),
            &model,
            &provider_task_id,
            loaded.attempt.provider_status_url.as_deref(),
        )
        .await?
        {
            VideoPollState::Pending {
                response,
                next_poll_at,
            } => {
                let conn = open_media_runtime_connection(&state)?;
                let Some(current) = load_job_with_current_attempt(&conn, &loaded.job.job_id)?
                else {
                    return Ok(());
                };
                set_attempt_details(
                    &conn,
                    &current,
                    "polling",
                    current.attempt.provider_task_id.as_deref(),
                    current.attempt.provider_status_url.as_deref(),
                    Some(next_poll_at),
                    Some(&response),
                    None,
                    true,
                )?;
                update_job_result_json(
                    &conn,
                    &current.job.job_id,
                    &json!({
                        "providerTaskId": provider_task_id,
                        "lastResponse": response,
                        "nextPollAt": next_poll_at,
                    }),
                    false,
                )?;
                append_event_with_connection(
                    &conn,
                    &current.job.job_id,
                    Some(&current.attempt.attempt_id),
                    "poll_pending",
                    "Video generation is still pending",
                    Some(&response),
                )?;
                emit_job_updated(&app, &state, &current.job.job_id);
                Ok(())
            }
            VideoPollState::Ready {
                response,
                inline_base64,
                download_url,
            } => transition_video_job_to_downloading(
                &app,
                &loaded,
                &response,
                inline_base64,
                download_url,
            ),
            VideoPollState::Failed { response, message } => {
                fail_job(&app, &loaded.job.job_id, &message, Some(&response))
            }
        }
    }
    .await;
    if let Err(error) = result {
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "video-poll",
            &error,
            None,
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("video poll failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "video-poll");
}

async fn run_video_download_worker(
    app: AppHandle,
    loaded: LoadedJob,
    slots: Arc<Mutex<RuntimeSlots>>,
) {
    let result = complete_video_download_and_bind(&app, &loaded.job.job_id).await;
    if let Err(error) = result {
        let _ = schedule_stage_retry_or_dead_letter(
            &app,
            &loaded.job.job_id,
            "video-download",
            &error,
            None,
        );
        emit_job_log(
            &app,
            &loaded.job.job_id,
            &format!("video download failed: {error}"),
            None,
        );
    }
    release_slot(&slots, &loaded, "video-download");
}

fn spawn_worker(
    app: &AppHandle,
    loaded: LoadedJob,
    slots: Arc<Mutex<RuntimeSlots>>,
    stage: &'static str,
) {
    let app_handle = app.clone();
    match stage {
        "image-submit" => {
            tauri::async_runtime::spawn_blocking(move || {
                run_image_submit_worker(app_handle, loaded, slots)
            });
        }
        "audio-submit" => {
            tauri::async_runtime::spawn_blocking(move || {
                run_audio_submit_worker(app_handle, loaded, slots)
            });
        }
        "audio-sequence-submit" => {
            tauri::async_runtime::spawn_blocking(move || {
                run_audio_sequence_submit_worker(app_handle, loaded, slots)
            });
        }
        "voice-clone-submit" => {
            tauri::async_runtime::spawn_blocking(move || {
                run_voice_clone_submit_worker(app_handle, loaded, slots)
            });
        }
        "video-sequence-submit" => {
            tauri::async_runtime::spawn(async move {
                run_video_sequence_submit_worker(app_handle, loaded, slots).await;
            });
        }
        "video-submit" => {
            tauri::async_runtime::spawn(async move {
                run_video_submit_worker(app_handle, loaded, slots).await;
            });
        }
        "video-poll" => {
            tauri::async_runtime::spawn(async move {
                run_video_poll_worker(app_handle, loaded, slots).await;
            });
        }
        "video-download" => {
            tauri::async_runtime::spawn(async move {
                run_video_download_worker(app_handle, loaded, slots).await;
            });
        }
        _ => {}
    }
}

fn dispatch_stage(
    app: &AppHandle,
    state: &State<'_, AppState>,
    slots: &Arc<Mutex<RuntimeSlots>>,
    kind: &str,
    statuses: &[&str],
    stage: &'static str,
    due_poll_only: bool,
    lease_owner: &str,
) -> Result<(), String> {
    let conn = open_media_runtime_connection(state)?;
    let candidates = next_job_candidates(&conn, kind, statuses, due_poll_only, 24)?;
    drop(conn);
    for loaded in candidates {
        if !reserve_slot(slots, &loaded, stage) {
            continue;
        }
        let conn = open_media_runtime_connection(state)?;
        let claimed = claim_job_for_stage(
            &conn,
            &loaded,
            match stage {
                "image-submit"
                | "video-submit"
                | "video-sequence-submit"
                | "audio-submit"
                | "audio-sequence-submit"
                | "voice-clone-submit" => "submitting",
                "video-poll" => "polling",
                "video-download" => "downloading",
                _ => loaded.job.status.as_str(),
            },
            lease_owner,
            now_i64() + ACTIVE_STAGE_LEASE_MS,
        )?;
        drop(conn);
        if !claimed {
            release_slot(slots, &loaded, stage);
            continue;
        }
        emit_job_updated(app, state, &loaded.job.job_id);
        spawn_worker(app, loaded, Arc::clone(slots), stage);
    }
    Ok(())
}

fn run_media_generation_dispatcher(
    app: AppHandle,
    stop: Arc<AtomicBool>,
    slots: Arc<Mutex<RuntimeSlots>>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(DISPATCH_TICK_MS));
        while !stop.load(Ordering::Relaxed) {
            interval.tick().await;
            let state = app.state::<AppState>();
            let _ = ensure_media_runtime_ready(&state);
            let _ = expire_timed_out_video_jobs(&app, &state);
            let _ = clear_expired_leases(&app, &state);
            let _ = tick_media_followups(&app, &state);
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "image",
                &["queued"],
                "image-submit",
                false,
                "media-runtime:image-submit",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "video",
                &["queued"],
                "video-submit",
                false,
                "media-runtime:video-submit",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "video_sequence",
                &["queued"],
                "video-sequence-submit",
                false,
                "media-runtime:video-sequence-submit",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "audio",
                &["queued"],
                "audio-submit",
                false,
                "media-runtime:audio-submit",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "audio_sequence",
                &["queued"],
                "audio-sequence-submit",
                false,
                "media-runtime:audio-sequence-submit",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "voice_clone",
                &["queued"],
                "voice-clone-submit",
                false,
                "media-runtime:voice-clone-submit",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "video",
                &["polling"],
                "video-poll",
                true,
                "media-runtime:video-poll",
            );
            let _ = dispatch_stage(
                &app,
                &state,
                &slots,
                "video",
                &["downloading"],
                "video-download",
                false,
                "media-runtime:video-download",
            );
        }
    })
}

pub(crate) fn ensure_media_generation_runtime_running(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<bool, String> {
    ensure_media_runtime_ready(state)?;
    let mut guard = state
        .media_generation_runtime
        .lock()
        .map_err(|_| "media generation runtime lock is poisoned".to_string())?;
    if guard.is_some() {
        return Ok(false);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let slots = Arc::new(Mutex::new(RuntimeSlots::default()));
    let dispatcher_join = run_media_generation_dispatcher(app.clone(), stop.clone(), slots);
    *guard = Some(MediaGenerationRuntime {
        stop,
        dispatcher_join: Some(dispatcher_join),
    });
    Ok(true)
}

pub(crate) fn stop_media_generation_runtime(runtime: &mut MediaGenerationRuntime) {
    runtime.stop.store(true, Ordering::Relaxed);
    if let Some(join) = runtime.dispatcher_join.take() {
        join.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_loaded_job(priority: &str, job_id: &str) -> LoadedJob {
        LoadedJob {
            job: MediaJobRecord {
                job_id: job_id.to_string(),
                kind: "video".to_string(),
                source: "generation_studio".to_string(),
                queue_mode: "free_creation".to_string(),
                priority: priority.to_string(),
                status: "queued".to_string(),
                provider_key: "redbox-official".to_string(),
                provider_model: Some("seedance-2.0".to_string()),
                request_json: json!({}),
                result_json: None,
                project_id: None,
                manuscript_path: None,
                video_project_path: None,
                owner_session_id: None,
                current_attempt_no: 1,
                cancel_reason: None,
                archived_at: None,
                archive_reason: None,
                created_at: now_iso(),
                updated_at: now_iso(),
                completed_at: None,
            },
            attempt: MediaJobAttemptRecord {
                attempt_id: format!("attempt-{job_id}"),
                job_id: job_id.to_string(),
                attempt_no: 1,
                status: "queued".to_string(),
                provider_task_id: None,
                provider_status_url: None,
                idempotency_key: format!("idempotency-{job_id}"),
                lease_owner: None,
                lease_expires_at: None,
                next_poll_at: None,
                retry_not_before_at: None,
                last_error: None,
                response_json: None,
                created_at: now_iso(),
                updated_at: now_iso(),
            },
        }
    }

    #[test]
    fn infer_job_source_prefers_explicit_value() {
        assert_eq!(infer_job_source(&json!({ "source": "redclaw" })), "redclaw");
    }

    #[test]
    fn infer_job_priority_defaults_interactive() {
        assert_eq!(
            infer_job_priority("generation_studio", &json!({})),
            "interactive"
        );
        assert_eq!(infer_job_priority("redclaw", &json!({})), "batch");
    }

    #[test]
    fn infer_job_queue_mode_defaults_to_ai_unless_explicit() {
        assert_eq!(
            infer_job_queue_mode("generation_studio", &json!({})),
            "ai_generation"
        );
        assert_eq!(
            infer_job_queue_mode(
                "generation_studio",
                &json!({ "queueMode": "free_creation" })
            ),
            "free_creation"
        );
        assert_eq!(
            infer_job_queue_mode("tool", &json!({ "queueMode": "unknown" })),
            "ai_generation"
        );
    }

    #[test]
    fn media_reference_validation_rejects_unresolved_bare_filename() {
        let error = validate_resolved_media_reference("referenceImages", "WechatIMG1615.jpg")
            .expect_err("bare filenames should not reach provider submission");
        assert!(error.contains("RESOURCE_RESOLUTION_FAILED"));
    }

    #[test]
    fn media_reference_validation_accepts_url_data_and_existing_paths() {
        validate_resolved_media_reference("referenceImages", "https://example.com/a.png").unwrap();
        validate_resolved_media_reference("referenceImages", "data:image/png;base64,abc").unwrap();
        validate_resolved_media_reference("referenceImages", file!()).unwrap();
    }

    #[test]
    fn image_jobs_ignore_requested_model_and_use_configured_default() {
        let resolved = resolve_image_provider_model(
            Some("gpt-image-2-cheap".to_string()),
            Some("seedance-2.0".to_string()),
        )
        .expect("configured image model should be used");
        assert_eq!(resolved, Some("gpt-image-2-cheap".to_string()));
    }

    #[test]
    fn image_jobs_do_not_invent_default_model() {
        let resolved = resolve_image_provider_model(None, None)
            .expect("missing config should be handled by the caller");
        assert_eq!(resolved, None);
    }

    #[test]
    fn configured_image_model_comes_from_settings_route_or_legacy_field() {
        let route_settings = json!({
            "ai_model_routes_json": serde_json::to_string(&json!({
                "image": {
                    "mode": "official",
                    "sourceId": "redbox_official_auto",
                    "model": "gpt-image-2-cheap"
                }
            })).unwrap(),
            "image_model": "legacy-image-model"
        });
        assert_eq!(
            configured_image_model_from_settings(&route_settings).as_deref(),
            Some("gpt-image-2-cheap")
        );

        let legacy_settings = json!({ "image_model": "legacy-image-model" });
        assert_eq!(
            configured_image_model_from_settings(&legacy_settings).as_deref(),
            Some("legacy-image-model")
        );
    }

    #[test]
    fn image_jobs_reject_video_model_as_default_config() {
        let error = resolve_image_provider_model(Some("seedance-2.0".to_string()), None)
            .expect_err("video model should not be accepted as image default");
        assert!(error.contains("默认图片模型"));
    }

    #[test]
    fn weighted_priority_candidates_rotates_by_weight() {
        let ordered = weighted_priority_candidates(
            vec![
                test_loaded_job("background", "bg-1"),
                test_loaded_job("batch", "batch-1"),
                test_loaded_job("interactive", "int-1"),
                test_loaded_job("interactive", "int-2"),
                test_loaded_job("interactive", "int-3"),
                test_loaded_job("interactive", "int-4"),
                test_loaded_job("interactive", "int-5"),
                test_loaded_job("interactive", "int-6"),
                test_loaded_job("batch", "batch-2"),
                test_loaded_job("background", "bg-2"),
            ],
            8,
        );
        let ids = ordered
            .into_iter()
            .map(|item| item.job.job_id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["int-1", "int-2", "int-3", "int-4", "int-5", "batch-1", "batch-2", "bg-1"]
        );
    }

    #[test]
    fn retry_policy_is_defined_for_runtime_stages() {
        assert_eq!(
            retry_policy_for_stage("image-submit"),
            Some(("queued", "retry_image_submit", 3, 1_500))
        );
        assert_eq!(
            retry_policy_for_stage("video-submit"),
            Some(("queued", "retry_video_submit", 3, 2_500))
        );
        assert_eq!(
            retry_policy_for_stage("video-sequence-submit"),
            Some(("queued", "retry_video_sequence_submit", 2, 5_000))
        );
        assert_eq!(
            retry_policy_for_stage("video-poll"),
            Some(("polling", "retry_video_poll", 120, 5_000))
        );
        assert_eq!(
            retry_policy_for_stage("video-download"),
            Some(("downloading", "retry_video_download", 3, 2_500))
        );
        assert_eq!(retry_policy_for_stage("unknown-stage"), None);
    }

    #[test]
    fn video_attempt_timeout_uses_provider_poll_start_time() {
        let conn = Connection::open_in_memory().expect("memory sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE media_job_events (
                event_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                attempt_id TEXT,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL
            );
            "#,
        )
        .expect("create events table");
        let mut loaded = test_loaded_job("interactive", "video-timeout");
        let attempt_started_at = 1_700_000_000_000_i64;
        let poll_started_at = attempt_started_at + 20 * 60 * 1000;
        loaded.job.kind = "video".to_string();
        loaded.job.created_at = (attempt_started_at - 30_000).to_string();
        loaded.attempt.created_at = attempt_started_at.to_string();
        loaded.attempt.provider_task_id = Some("task-1".to_string());
        conn.execute(
            r#"
            INSERT INTO media_job_events (
                event_id, job_id, attempt_id, event_type, message, payload_json, created_at
            ) VALUES ('event-1', ?1, ?2, 'submitted', 'submitted', NULL, ?3)
            "#,
            params![
                loaded.job.job_id,
                loaded.attempt.attempt_id,
                poll_started_at.to_string()
            ],
        )
        .expect("insert submitted event");

        assert!(!video_attempt_timed_out(
            &conn,
            &loaded,
            poll_started_at + VIDEO_PROVIDER_POLL_TIMEOUT_MS - 1,
        )
        .expect("timeout check"));
        assert!(video_attempt_timed_out(
            &conn,
            &loaded,
            poll_started_at + VIDEO_PROVIDER_POLL_TIMEOUT_MS,
        )
        .expect("timeout check"));
    }

    #[test]
    fn video_attempt_timeout_ignores_queued_jobs_without_provider_task() {
        let conn = Connection::open_in_memory().expect("memory sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE media_job_events (
                event_id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                attempt_id TEXT,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL
            );
            "#,
        )
        .expect("create events table");
        let mut loaded = test_loaded_job("interactive", "image-job");
        loaded.job.kind = "video".to_string();
        loaded.attempt.created_at = "1700000000000".to_string();

        assert!(!video_attempt_timed_out(
            &conn,
            &loaded,
            1_700_000_000_000_i64 + VIDEO_PROVIDER_POLL_TIMEOUT_MS * 4,
        )
        .expect("timeout check"));
    }

    #[test]
    fn video_retalk_body_matches_fixed_api_contract() {
        let body = build_video_retalk_request_body(&json!({
            "input": {
                "video_url": "https://example.com/input.mp4",
                "audio_url": "https://example.com/audio.wav"
            },
            "parameters": {
                "video_extension": false
            },
            "durationSeconds": 8,
            "resolution": "720p"
        }))
        .expect("valid VideoRetalk payload");

        assert_eq!(
            body,
            json!({
                "input": {
                    "video_url": "https://example.com/input.mp4",
                    "audio_url": "https://example.com/audio.wav"
                },
                "parameters": {
                    "video_extension": false
                },
                "duration_seconds": 8,
                "resolution": "720p"
            })
        );
    }

    #[test]
    fn video_retalk_rejects_local_urls_before_submit() {
        let error = build_video_retalk_request_body(&json!({
            "input": {
                "video_url": "media/generated/input.mp4",
                "audio_url": "https://example.com/audio.wav"
            },
            "durationSeconds": 8,
            "resolution": "720p"
        }))
        .expect_err("local files must not be sent to the remote API directly");

        assert!(error.contains("remote video_url"));
    }

    #[test]
    fn video_retalk_route_keeps_gateway_base() {
        assert_eq!(
            video_retalk_route_url(
                "https://api.ziz.hk/redbox/v1/videos/generations/async",
                "/ai/video-retalk/jobs"
            ),
            "https://api.ziz.hk/redbox/v1/ai/video-retalk/jobs"
        );
        assert_eq!(
            video_retalk_route_url(
                "https://api.ziz.hk/redbox/v1/ai/video-retalk/jobs/query",
                "/ai/video-retalk/jobs"
            ),
            "https://api.ziz.hk/redbox/v1/ai/video-retalk/jobs"
        );
    }

    #[test]
    fn video_retalk_official_endpoint_uses_access_token() {
        let settings = json!({
            "video_endpoint": "https://api.ziz.hk/redbox/v1",
            "video_api_key": "rbx-api-key",
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "jwt-access-token",
                "apiKey": "rbx-session-key"
            })).expect("session json")
        });

        let (_endpoint, token) = resolve_video_retalk_settings(&settings);
        assert_eq!(token.as_deref(), Some("jwt-access-token"));
    }

    #[test]
    fn video_retalk_extracts_output_url_only_from_result_fields() {
        let pending_echo = json!({
            "status": "running",
            "input": { "video_url": "https://example.com/input.mp4" }
        });
        assert_eq!(extract_video_retalk_output_url(&pending_echo), None);

        let fixed_api_completed = json!({
            "task_status": "SUCCEEDED",
            "data": [{
                "mime_type": "video/mp4",
                "url": "https://example.com/result-from-data.mp4"
            }],
            "video_url": "https://example.com/result-from-root.mp4"
        });
        assert_eq!(
            extract_video_retalk_output_url(&fixed_api_completed).as_deref(),
            Some("https://example.com/result-from-root.mp4")
        );
        let fixed_api_data_only = json!({
            "task_status": "SUCCEEDED",
            "data": [{
                "mime_type": "video/mp4",
                "url": "https://example.com/result-from-data.mp4"
            }]
        });
        assert_eq!(
            extract_video_retalk_output_url(&fixed_api_data_only).as_deref(),
            Some("https://example.com/result-from-data.mp4")
        );

        let completed = json!({
            "status": "succeeded",
            "data": {
                "output_url": "https://example.com/output.mp4"
            }
        });
        assert_eq!(
            extract_video_retalk_output_url(&completed).as_deref(),
            Some("https://example.com/output.mp4")
        );
    }
}
