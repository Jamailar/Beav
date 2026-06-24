use crate::store::settings as settings_store;
use crate::{
    now_iso, payload_field, payload_string, with_store, with_store_mut, AppState, GLOBAL_APP_HANDLE,
};
use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const BATCH_SCHEMA_VERSION: &str = "redbox.analytics.batch.v1";
const EVENT_SCHEMA_VERSION: &str = "redbox.analytics.event.v1";
const DEFAULT_ENDPOINT: &str = "https://redbox.ziz.hk/api/v1/telemetry/capture";
const MAX_EVENT_BYTES: usize = 8 * 1024;
const MAX_QUEUE_EVENTS: i64 = 5000;
const BATCH_SIZE: i64 = 40;
const FLUSH_RETRY_COOLDOWN_MS: u64 = 30_000;

static EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);
static FLUSH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static LAST_FLUSH_FAILURE_MS: AtomicU64 = AtomicU64::new(0);

struct FlushGuard;

impl Drop for FlushGuard {
    fn drop(&mut self) {
        FLUSH_IN_PROGRESS.store(false, Ordering::Release);
    }
}

fn analytics_root(store_path: &Path) -> Result<PathBuf, String> {
    let root = store_path
        .parent()
        .ok_or_else(|| "Cannot resolve store root".to_string())?
        .join("analytics");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn queue_path(store_path: &Path) -> Result<PathBuf, String> {
    Ok(analytics_root(store_path)?.join("events.sqlite3"))
}

fn open_queue(store_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(queue_path(store_path)?).map_err(|error| error.to_string())?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS analytics_events (
            id TEXT PRIMARY KEY,
            event TEXT NOT NULL,
            distinct_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TEXT,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
        ON analytics_events(created_at);
        "#,
    )
    .map_err(|error| error.to_string())?;
    Ok(conn)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn analytics_now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalize_analytics_timestamp(value: &str) -> String {
    let trimmed = value.trim();
    if let Ok(ms) = trimmed.parse::<i64>() {
        if let Some(timestamp) = Utc.timestamp_millis_opt(ms).single() {
            return timestamp.to_rfc3339_opts(SecondsFormat::Millis, true);
        }
    }
    trimmed.to_string()
}

fn normalize_event_payload_timestamp(mut payload: Value) -> Value {
    if let Some(timestamp) = payload_string(&payload, "timestamp") {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "timestamp".to_string(),
                json!(normalize_analytics_timestamp(&timestamp)),
            );
        }
    }
    payload
}

fn make_id(prefix: &str) -> String {
    let counter = EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}_{:x}{:x}{:x}",
        now_millis(),
        std::process::id(),
        counter
    )
}

fn analytics_consent(settings: &Value) -> String {
    payload_string(settings, "analytics_consent")
        .filter(|value| matches!(value.as_str(), "none" | "approved"))
        .unwrap_or_else(|| "approved".to_string())
}

fn analytics_endpoint(settings: &Value) -> String {
    payload_string(settings, "analytics_endpoint")
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
}

fn analytics_internal_device(settings: &Value) -> bool {
    payload_field(settings, "analytics_internal_device")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn ensure_device_id(state: &State<'_, AppState>) -> Result<String, String> {
    with_store_mut(state, |store| {
        let current = payload_string(&store.settings, "analytics_device_id")
            .filter(|value| value.starts_with("anon_device_"));
        if let Some(value) = current {
            return Ok(value);
        }
        let next = make_id("anon_device");
        if let Some(object) = store.settings.as_object_mut() {
            object.insert("analytics_device_id".to_string(), json!(next.clone()));
        }
        Ok(next)
    })
}

fn queue_count(store_path: &Path) -> Result<i64, String> {
    let conn = open_queue(store_path)?;
    conn.query_row("SELECT COUNT(*) FROM analytics_events", [], |row| {
        row.get(0)
    })
    .map_err(|error| error.to_string())
}

fn validate_event_name(event: &str) -> Result<(), String> {
    let len = event.len();
    if !(2..=80).contains(&len) {
        return Err("analytics event name length is invalid".to_string());
    }
    let mut chars = event.chars();
    if !chars
        .next()
        .map(|ch| ch.is_ascii_lowercase())
        .unwrap_or(false)
    {
        return Err("analytics event name must start with a lowercase letter".to_string());
    }
    if !event.chars().all(|ch| {
        ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | ':' | '.' | '-' | ' ')
    }) {
        return Err("analytics event name contains unsupported characters".to_string());
    }
    Ok(())
}

fn sanitize_string(value: &str, max_len: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max_len)
        .collect()
}

fn property_key_allowed(key: &str) -> bool {
    if key.is_empty() || key.len() > 64 {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    let blocked = [
        "prompt",
        "content",
        "text",
        "body",
        "path",
        "file",
        "filename",
        "url",
        "token",
        "secret",
        "cookie",
        "authorization",
        "api_key",
        "apikey",
        "password",
        "query",
        "dom",
        "html",
        "markdown",
        "transcript",
    ];
    if blocked.iter().any(|item| lower.contains(item)) {
        return false;
    }
    key.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn sanitize_properties(raw: Option<&Value>) -> Value {
    let mut next = Map::new();
    let Some(object) = raw.and_then(Value::as_object) else {
        return Value::Object(next);
    };
    for (key, value) in object {
        if !property_key_allowed(key) {
            continue;
        }
        let sanitized = match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Some(value.clone()),
            Value::String(value) => Some(json!(sanitize_string(value, 160))),
            _ => None,
        };
        if let Some(value) = sanitized {
            next.insert(key.clone(), value);
        }
    }
    Value::Object(next)
}

fn analytics_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.trim().as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn value_string_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload_string(value, key))
        .map(|value| sanitize_string(&value, 80))
        .filter(|value| !value.is_empty())
}

fn value_f64_any(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        payload_field(value, key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|number| number as f64))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<f64>().ok())
                })
        })
    })
}

fn nested_value<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| payload_field(value, key))
}

fn normalized_status(value: Option<String>) -> String {
    value
        .unwrap_or_else(|| "unknown".to_string())
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
}

fn official_session_user(settings: &Value) -> Option<Value> {
    crate::official_settings_session(settings)
        .and_then(|session| payload_field(&session, "user").cloned())
        .filter(|value| value.is_object())
}

fn official_user_hash(settings: &Value) -> Option<String> {
    let user = official_session_user(settings)?;
    value_string_any(
        &user,
        &[
            "id",
            "userId",
            "user_id",
            "uid",
            "sub",
            "accountId",
            "account_id",
        ],
    )
    .map(|value| analytics_hash(&format!("redbox-user:{value}")))
}

fn official_membership_type(settings: &Value) -> String {
    let Some(user) = official_session_user(settings) else {
        return "anonymous".to_string();
    };
    value_string_any(
        &user,
        &[
            "membership_type",
            "membershipType",
            "memberType",
            "planName",
            "plan",
            "tier",
        ],
    )
    .or_else(|| {
        nested_value(&user, &["membership", "subscription"])
            .and_then(|value| value_string_any(value, &["type", "name", "plan", "tier", "status"]))
    })
    .unwrap_or_else(|| "free".to_string())
}

fn official_membership_status(settings: &Value) -> String {
    let Some(user) = official_session_user(settings) else {
        return "anonymous".to_string();
    };
    value_string_any(
        &user,
        &[
            "membership_status",
            "membershipStatus",
            "subscriptionStatus",
            "status",
        ],
    )
    .or_else(|| {
        nested_value(&user, &["membership", "subscription"])
            .and_then(|value| value_string_any(value, &["status", "state"]))
    })
    .map(|value| normalized_status(Some(value)))
    .unwrap_or_else(|| {
        if official_membership_type(settings).eq_ignore_ascii_case("free") {
            "free".to_string()
        } else {
            "active".to_string()
        }
    })
}

fn membership_fingerprint(settings: &Value) -> String {
    format!(
        "{}:{}:{}",
        official_user_hash(settings).unwrap_or_else(|| "anonymous".to_string()),
        official_membership_type(settings),
        official_membership_status(settings)
    )
}

fn enrich_properties_with_identity(properties: Value, settings: &Value) -> Value {
    let mut object = properties.as_object().cloned().unwrap_or_default();
    if analytics_internal_device(settings) {
        object.insert("internalTester".to_string(), json!(true));
    }
    let user_hash = official_user_hash(settings);
    object.insert("loggedIn".to_string(), json!(user_hash.is_some()));
    if let Some(user_hash) = user_hash {
        object.insert("userIdHash".to_string(), json!(user_hash));
        object.insert(
            "membershipType".to_string(),
            json!(official_membership_type(settings)),
        );
        object.insert(
            "membershipStatus".to_string(),
            json!(official_membership_status(settings)),
        );
    }
    Value::Object(object)
}

fn order_id_hash(order: &Value) -> Option<String> {
    value_string_any(
        order,
        &["id", "orderId", "order_id", "out_trade_no", "outTradeNo"],
    )
    .map(|order_id| analytics_hash(&format!("redbox-order:{order_id}")))
}

fn app_metadata(surface: &str) -> Value {
    json!({
        "name": crate::app_brand_display_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "channel": if cfg!(debug_assertions) { "debug" } else { "release" },
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "locale": std::env::var("LANG").ok().and_then(|value| value.split('.').next().map(str::to_string)),
        "timezone": std::env::var("TZ").ok(),
        "surface": surface,
    })
}

fn build_event_payload(
    event_id: &str,
    event: &str,
    distinct_id: &str,
    surface: &str,
    origin: &str,
    properties: Value,
) -> Value {
    json!({
        "schemaVersion": EVENT_SCHEMA_VERSION,
        "eventId": event_id,
        "event": event,
        "distinctId": distinct_id,
        "timestamp": analytics_now_iso(),
        "source": {
            "kind": "desktop",
            "surface": surface,
            "origin": origin,
        },
        "app": app_metadata(surface),
        "session": {
            "appSessionId": distinct_id,
        },
        "properties": properties,
    })
}

fn enqueue_event(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let conn = open_queue(&state.store_path)?;
    let encoded = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    if encoded.as_bytes().len() > MAX_EVENT_BYTES {
        return Err("analytics event payload is too large".to_string());
    }
    let event_id =
        payload_string(payload, "eventId").ok_or_else(|| "eventId missing".to_string())?;
    let event = payload_string(payload, "event").ok_or_else(|| "event missing".to_string())?;
    let distinct_id =
        payload_string(payload, "distinctId").ok_or_else(|| "distinctId missing".to_string())?;
    let created_at = payload_string(payload, "timestamp").unwrap_or_else(analytics_now_iso);

    conn.execute(
        "INSERT OR IGNORE INTO analytics_events (id, event, distinct_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event_id, event, distinct_id, encoded, created_at],
    )
    .map_err(|error| error.to_string())?;
    prune_queue(&conn)?;
    Ok(json!({ "success": true, "queued": true }))
}

fn prune_queue(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM analytics_events", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    if count <= MAX_QUEUE_EVENTS {
        return Ok(());
    }
    let remove_count = count - MAX_QUEUE_EVENTS;
    conn.execute(
        "DELETE FROM analytics_events WHERE id IN (
            SELECT id FROM analytics_events ORDER BY created_at ASC LIMIT ?1
        )",
        params![remove_count],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_batch(conn: &Connection) -> Result<Vec<(String, Value)>, String> {
    let mut statement = conn
        .prepare("SELECT id, payload_json FROM analytics_events ORDER BY created_at ASC LIMIT ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![BATCH_SIZE], |row| {
            let id: String = row.get(0)?;
            let payload_json: String = row.get(1)?;
            Ok((id, payload_json))
        })
        .map_err(|error| error.to_string())?;
    let mut batch = Vec::new();
    for row in rows {
        let (id, raw) = row.map_err(|error| error.to_string())?;
        let value = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
        batch.push((id, value));
    }
    Ok(batch)
}

fn delete_batch(conn: &Connection, ids: &[String]) -> Result<(), String> {
    for id in ids {
        conn.execute("DELETE FROM analytics_events WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn mark_batch_failed(conn: &Connection, ids: &[String], error: &str) -> Result<(), String> {
    let now = now_iso();
    let trimmed = sanitize_string(error, 240);
    for id in ids {
        conn.execute(
            "UPDATE analytics_events SET attempt_count = attempt_count + 1, last_attempt_at = ?2, last_error = ?3 WHERE id = ?1",
            params![id, now, trimmed],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn upload_batch(endpoint: String, events: Vec<Value>) -> Result<(), String> {
    let body = json!({
        "schemaVersion": BATCH_SCHEMA_VERSION,
        "sentAt": analytics_now_iso(),
        "events": events,
    });
    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "analytics upload failed: HTTP {} {}",
            status.as_u16(),
            text
        ));
    }
    Ok(())
}

fn schedule_flush(app: &AppHandle, state: &State<'_, AppState>) {
    let last_failure = LAST_FLUSH_FAILURE_MS.load(Ordering::Acquire);
    if last_failure > 0
        && (now_millis() as u64).saturating_sub(last_failure) < FLUSH_RETRY_COOLDOWN_MS
    {
        return;
    }
    if FLUSH_IN_PROGRESS.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let store_path = state.store_path.clone();
    let settings = match with_store(state, |store| Ok(settings_store::settings_snapshot(&store))) {
        Ok(settings) => settings,
        Err(_) => {
            FLUSH_IN_PROGRESS.store(false, Ordering::Release);
            return;
        }
    };
    if analytics_consent(&settings) != "approved" {
        FLUSH_IN_PROGRESS.store(false, Ordering::Release);
        return;
    }
    let endpoint = analytics_endpoint(&settings);
    tauri::async_runtime::spawn(async move {
        let _guard = FlushGuard;
        loop {
            let result = (|| -> Result<Vec<(String, Value)>, String> {
                let conn = open_queue(&store_path)?;
                load_batch(&conn)
            })();
            let batch = match result {
                Ok(batch) if !batch.is_empty() => batch,
                _ => break,
            };
            let ids = batch.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
            let events = batch
                .into_iter()
                .map(|(_, event)| normalize_event_payload_timestamp(event))
                .collect::<Vec<_>>();
            let upload_result = upload_batch(endpoint.clone(), events).await;
            let conn = match open_queue(&store_path) {
                Ok(conn) => conn,
                Err(_) => break,
            };
            match upload_result {
                Ok(()) => {
                    LAST_FLUSH_FAILURE_MS.store(0, Ordering::Release);
                    let _ = delete_batch(&conn, &ids);
                }
                Err(error) => {
                    LAST_FLUSH_FAILURE_MS.store(now_millis() as u64, Ordering::Release);
                    let _ = mark_batch_failed(&conn, &ids, &error);
                    break;
                }
            }
            let _ = app.emit("analytics:flushed", json!({ "at": analytics_now_iso() }));
        }
    });
}

pub fn status_value(state: &State<'_, AppState>) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let pending_count = queue_count(&state.store_path).unwrap_or_default();
    Ok(json!({
        "consent": analytics_consent(&settings),
        "enabled": analytics_consent(&settings) == "approved",
        "endpoint": analytics_endpoint(&settings),
        "pendingCount": pending_count,
    }))
}

pub fn set_consent(state: &State<'_, AppState>, consent: &str) -> Result<Value, String> {
    let normalized = match consent {
        "none" | "prompt" | "approved" => consent,
        _ => return Err("Invalid analytics consent".to_string()),
    };
    with_store_mut(state, |store| {
        if let Some(object) = store.settings.as_object_mut() {
            object.insert("analytics_consent".to_string(), json!(normalized));
            object.insert("analytics_last_prompted_at".to_string(), json!(now_iso()));
        }
        Ok(())
    })?;
    if normalized == "none" {
        let _ = clear_queue(state);
    }
    Ok(json!({ "success": true, "consent": normalized }))
}

pub fn clear_queue(state: &State<'_, AppState>) -> Result<Value, String> {
    let conn = open_queue(&state.store_path)?;
    conn.execute("DELETE FROM analytics_events", [])
        .map_err(|error| error.to_string())?;
    Ok(json!({ "success": true, "pendingCount": 0 }))
}

pub fn track_event(
    app: &AppHandle,
    state: &State<'_, AppState>,
    payload: &Value,
) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    if analytics_consent(&settings) != "approved" {
        return Ok(json!({ "success": true, "queued": false, "skipped": "consent" }));
    }
    let event = payload_string(payload, "event").ok_or_else(|| "event is required".to_string())?;
    validate_event_name(&event)?;
    let surface = payload_string(payload, "surface")
        .map(|value| sanitize_string(&value, 64))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "app-shell".to_string());
    let origin = payload_string(payload, "origin")
        .map(|value| sanitize_string(&value, 64))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "renderer".to_string());
    let distinct_id = ensure_device_id(state)?;
    let event_id = make_id("evt");
    let properties = enrich_properties_with_identity(
        sanitize_properties(payload_field(payload, "properties")),
        &settings,
    );
    let event_payload = build_event_payload(
        &event_id,
        &event,
        &distinct_id,
        &surface,
        &origin,
        properties,
    );
    let response = enqueue_event(state, &event_payload)?;
    schedule_flush(app, state);
    Ok(response)
}

pub fn observe_runtime_event(state: &State<'_, AppState>, event_type: &str, payload: &Value) {
    let event = match event_type {
        "runtime:stream-start"
            if payload_string(payload, "phase").as_deref() == Some("thinking") =>
        {
            "ai_turn_started"
        }
        "runtime:done" => {
            let status = payload_string(payload, "status").unwrap_or_default();
            if matches!(status.as_str(), "completed" | "success" | "ok") {
                "ai_turn_completed"
            } else {
                "ai_turn_failed"
            }
        }
        _ => return,
    };
    let mut properties = Map::new();
    if let Some(runtime_mode) = payload_string(payload, "runtimeMode") {
        properties.insert(
            "runtimeMode".to_string(),
            json!(sanitize_string(&runtime_mode, 64)),
        );
    }
    if let Some(status) = payload_string(payload, "status") {
        properties.insert("status".to_string(), json!(sanitize_string(&status, 32)));
    }
    if let Some(reason) = payload_string(payload, "reason") {
        properties.insert("reason".to_string(), json!(sanitize_string(&reason, 64)));
    }
    let _ = track_internal_event(state, event, "runtime", "host", Value::Object(properties));
}

pub fn observe_media_generation_event(
    state: &State<'_, AppState>,
    media_kind: &str,
    event_type: &str,
    payload: &Value,
) {
    let event = match (media_kind, event_type) {
        ("image", "request.started") => "image_generation_started",
        ("image", "request.completed") => "image_generation_completed",
        ("image", "request.failed") => "image_generation_failed",
        ("video", "request.started") => "video_generation_started",
        ("video", "request.completed") => "video_generation_completed",
        ("video", "request.failed") => "video_generation_failed",
        _ => return,
    };
    let mut properties = Map::new();
    properties.insert("mediaKind".to_string(), json!(media_kind));
    properties.insert("eventType".to_string(), json!(event_type));
    for key in [
        "provider",
        "providerTemplate",
        "model",
        "generationMode",
        "channel",
        "errorCode",
    ] {
        if let Some(value) = payload_string(payload, key) {
            properties.insert(key.to_string(), json!(sanitize_string(&value, 80)));
        }
    }
    for key in [
        "referenceCount",
        "assetIndex",
        "assetCount",
        "durationSeconds",
        "elapsedMs",
    ] {
        if let Some(value) = payload_field(payload, key).and_then(Value::as_i64) {
            properties.insert(key.to_string(), json!(value));
        }
    }
    let _ = track_internal_event(
        state,
        event,
        "media-generation",
        "host",
        Value::Object(properties),
    );
}

pub fn observe_official_settings_update(
    state: &State<'_, AppState>,
    previous_settings: &Value,
    next_settings: &Value,
    source: &str,
) {
    let previous_user_hash = official_user_hash(previous_settings);
    let next_user_hash = official_user_hash(next_settings);
    let mut base_properties = Map::new();
    base_properties.insert("source".to_string(), json!(sanitize_string(source, 64)));
    if let Some(user_hash) = next_user_hash.clone().or(previous_user_hash.clone()) {
        base_properties.insert("userIdHash".to_string(), json!(user_hash));
    }

    match (previous_user_hash.as_ref(), next_user_hash.as_ref()) {
        (None, Some(_)) => {
            let mut properties = base_properties.clone();
            properties.insert(
                "membershipType".to_string(),
                json!(official_membership_type(next_settings)),
            );
            properties.insert(
                "membershipStatus".to_string(),
                json!(official_membership_status(next_settings)),
            );
            let _ = track_internal_event(
                state,
                "user_signed_in",
                "account",
                "host",
                Value::Object(properties),
            );
        }
        (Some(_), None) => {
            let _ = track_internal_event(
                state,
                "user_signed_out",
                "account",
                "host",
                Value::Object(base_properties.clone()),
            );
        }
        _ => {}
    }

    let previous_fingerprint = membership_fingerprint(previous_settings);
    let next_fingerprint = membership_fingerprint(next_settings);
    if previous_fingerprint == next_fingerprint {
        return;
    }

    let mut properties = base_properties;
    properties.insert(
        "membershipType".to_string(),
        json!(official_membership_type(next_settings)),
    );
    properties.insert(
        "membershipStatus".to_string(),
        json!(official_membership_status(next_settings)),
    );
    let _ = track_internal_event(
        state,
        "membership_status_loaded",
        "account",
        "host",
        Value::Object(properties.clone()),
    );

    let previous_status = official_membership_status(previous_settings);
    let next_status = official_membership_status(next_settings);
    if previous_status != "active" && next_status == "active" {
        let _ = track_internal_event(
            state,
            "membership_activated",
            "account",
            "host",
            Value::Object(properties),
        );
    }
}

pub fn observe_billing_order_created(
    state: &State<'_, AppState>,
    order: &Value,
    source: &str,
    payment_kind: &str,
) {
    let mut properties = Map::new();
    properties.insert("source".to_string(), json!(sanitize_string(source, 64)));
    properties.insert(
        "paymentKind".to_string(),
        json!(sanitize_string(payment_kind, 48)),
    );
    let order_hash = order_id_hash(order);
    if let Some(order_hash) = order_hash.as_ref() {
        properties.insert("orderIdHash".to_string(), json!(order_hash));
    }
    if let Some(product_id) = value_string_any(order, &["product_id", "productId", "sku"]) {
        properties.insert("productId".to_string(), json!(product_id));
    }
    if let Some(amount) = value_f64_any(order, &["amount", "amount_yuan", "amountYuan"]) {
        properties.insert("amount".to_string(), json!(amount));
    }
    if let Some(status) = value_string_any(order, &["status", "trade_status", "tradeStatus"]) {
        properties.insert(
            "orderStatus".to_string(),
            json!(normalized_status(Some(status))),
        );
    }
    let event_id = order_hash.map(|hash| format!("evt_checkout_started_{hash}"));
    let _ = track_internal_event_with_id(
        state,
        event_id.as_deref(),
        "checkout_started",
        "billing",
        "host",
        Value::Object(properties),
    );
}

pub fn observe_billing_order_status(state: &State<'_, AppState>, order: &Value, source: &str) {
    let status = normalized_status(value_string_any(
        order,
        &["status", "trade_status", "tradeStatus", "paymentStatus"],
    ));
    let mut properties = Map::new();
    properties.insert("source".to_string(), json!(sanitize_string(source, 64)));
    properties.insert("orderStatus".to_string(), json!(status.clone()));
    let order_hash = order_id_hash(order);
    if let Some(order_hash) = order_hash.as_ref() {
        properties.insert("orderIdHash".to_string(), json!(order_hash));
    }
    if let Some(product_id) = value_string_any(order, &["product_id", "productId", "sku"]) {
        properties.insert("productId".to_string(), json!(product_id));
    }
    if let Some(amount) = value_f64_any(order, &["amount", "amount_yuan", "amountYuan"]) {
        properties.insert("amount".to_string(), json!(amount));
    }
    let event = if matches!(
        status.as_str(),
        "paid" | "success" | "succeeded" | "completed" | "finished" | "trade_success"
    ) {
        "checkout_completed"
    } else if matches!(
        status.as_str(),
        "failed" | "closed" | "cancelled" | "canceled" | "expired"
    ) {
        "checkout_failed"
    } else {
        return;
    };
    let event_id = order_hash.map(|hash| format!("evt_{event}_{hash}"));
    let _ = track_internal_event_with_id(
        state,
        event_id.as_deref(),
        event,
        "billing",
        "host",
        Value::Object(properties),
    );
}

fn track_internal_event(
    state: &State<'_, AppState>,
    event: &str,
    surface: &str,
    origin: &str,
    properties: Value,
) -> Result<Value, String> {
    track_internal_event_with_id(state, None, event, surface, origin, properties)
}

fn track_internal_event_with_id(
    state: &State<'_, AppState>,
    event_id: Option<&str>,
    event: &str,
    surface: &str,
    origin: &str,
    properties: Value,
) -> Result<Value, String> {
    let settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    if analytics_consent(&settings) != "approved" {
        return Ok(json!({ "success": true, "queued": false, "skipped": "consent" }));
    }
    validate_event_name(event)?;
    let distinct_id = ensure_device_id(state)?;
    let event_id = event_id
        .map(str::to_string)
        .unwrap_or_else(|| make_id("evt"));
    let properties =
        enrich_properties_with_identity(sanitize_properties(Some(&properties)), &settings);
    let event_payload =
        build_event_payload(&event_id, event, &distinct_id, surface, origin, properties);
    let response = enqueue_event(state, &event_payload)?;
    if let Some(app) = GLOBAL_APP_HANDLE.get() {
        schedule_flush(app, state);
    }
    Ok(response)
}

pub fn flush_pending_now(app: &AppHandle, state: &State<'_, AppState>) -> Result<Value, String> {
    schedule_flush(app, state);
    Ok(json!({ "success": true, "scheduled": true }))
}
