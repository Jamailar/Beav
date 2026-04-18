use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use crate::{
    now_iso, now_ms, payload_field, payload_string, AppState, AppStore, REDBOX_OFFICIAL_BASE_URL,
};

pub(crate) const AUTH_STATE_CHANGED_EVENT: &str = "auth:state-changed";
pub(crate) const AUTH_DATA_CHANGED_EVENT: &str = "auth:data-changed";

const AUTH_CACHE_FILE_NAME: &str = "auth-state.json";
const AUTH_VAULT_SERVICE: &str = "RedBox";
const AUTH_VAULT_REFRESH_TOKEN: &str = "official-refresh-token";
const AUTH_VAULT_TOKEN_FAMILY_ID: &str = "official-token-family-id";
const AUTH_VAULT_DEVICE_SECRET: &str = "official-device-secret";
const OFFICIAL_SOURCE_ID: &str = "redbox_official_auto";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthStatus {
    #[default]
    Anonymous,
    Restoring,
    Authenticated,
    Refreshing,
    Degraded,
    ReauthRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthErrorKind {
    NetworkTransient,
    ServerTransient,
    UnauthorizedRecoverable,
    ReauthRequired,
    MalformedResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AuthSecretBundle {
    pub refresh_token: Option<String>,
    pub token_family_id: Option<String>,
    pub device_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AuthRuntimeState {
    pub status: AuthStatus,
    pub session: Option<Value>,
    pub points: Option<Value>,
    pub models: Vec<Value>,
    pub call_records: Vec<Value>,
    pub degraded_reason: Option<String>,
    pub last_error: Option<String>,
    pub last_error_kind: Option<AuthErrorKind>,
    pub last_refresh_at: Option<String>,
    pub last_refresh_at_ms: Option<i64>,
    pub next_refresh_at_ms: Option<i64>,
    pub unknown_expiry_refresh_attempted: bool,
    pub secrets: AuthSecretBundle,
}

impl Default for AuthRuntimeState {
    fn default() -> Self {
        Self {
            status: AuthStatus::Anonymous,
            session: None,
            points: None,
            models: Vec::new(),
            call_records: Vec::new(),
            degraded_reason: None,
            last_error: None,
            last_error_kind: None,
            last_refresh_at: None,
            last_refresh_at_ms: None,
            next_refresh_at_ms: None,
            unknown_expiry_refresh_attempted: false,
            secrets: AuthSecretBundle::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AuthCacheRecord {
    pub session: Option<Value>,
    pub points: Option<Value>,
    pub models: Vec<Value>,
    pub call_records: Vec<Value>,
    pub updated_at: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AuthStateSnapshot {
    pub status: AuthStatus,
    pub logged_in: bool,
    pub session: Option<Value>,
    pub points: Option<Value>,
    pub models: Vec<Value>,
    pub call_records: Vec<Value>,
    pub degraded_reason: Option<String>,
    pub last_error: Option<String>,
    pub last_error_kind: Option<AuthErrorKind>,
    pub last_refresh_at: Option<String>,
    pub next_refresh_at_ms: Option<i64>,
}

impl Default for AuthStateSnapshot {
    fn default() -> Self {
        Self {
            status: AuthStatus::Anonymous,
            logged_in: false,
            session: None,
            points: None,
            models: Vec::new(),
            call_records: Vec::new(),
            degraded_reason: None,
            last_error: None,
            last_error_kind: None,
            last_refresh_at: None,
            next_refresh_at_ms: None,
        }
    }
}

fn cache_record_from_settings(settings: &Value) -> AuthCacheRecord {
    AuthCacheRecord {
        session: sanitize_session_for_cache(session_from_settings(settings).as_ref()),
        points: settings_json_value(settings, "redbox_auth_points_json"),
        models: settings_json_array(settings, "redbox_official_models_json"),
        call_records: settings_json_array(settings, "redbox_auth_call_records_json"),
        updated_at: now_iso(),
        updated_at_ms: now_ms() as i64,
    }
}

fn auth_cache_path_from_store_path(store_path: &Path) -> Result<PathBuf, String> {
    let root = store_path
        .parent()
        .ok_or_else(|| "RedBox store root is unavailable".to_string())?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    Ok(root.join(AUTH_CACHE_FILE_NAME))
}

fn settings_json_value(settings: &Value, key: &str) -> Option<Value> {
    payload_string(settings, key)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

fn settings_json_array(settings: &Value, key: &str) -> Vec<Value> {
    payload_string(settings, key)
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn session_from_settings(settings: &Value) -> Option<Value> {
    payload_string(settings, "redbox_auth_session_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|value| value.is_object())
}

fn session_access_token(session: Option<&Value>) -> Option<String> {
    session
        .and_then(|value| {
            payload_string(value, "accessToken").or_else(|| payload_string(value, "access_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn session_refresh_token(session: Option<&Value>) -> Option<String> {
    session
        .and_then(|value| {
            payload_string(value, "refreshToken").or_else(|| payload_string(value, "refresh_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn session_expires_at_ms(session: Option<&Value>) -> Option<i64> {
    session.and_then(|value| {
        payload_field(value, "expiresAt")
            .and_then(parse_time_candidate_ms)
            .or_else(|| payload_field(value, "expires_at").and_then(parse_time_candidate_ms))
            .or_else(|| {
                session_access_token(session)
                    .as_deref()
                    .and_then(jwt_expiration_ms)
            })
    })
}

fn session_token_type(session: Option<&Value>) -> String {
    session
        .and_then(|value| {
            payload_string(value, "tokenType").or_else(|| payload_string(value, "token_type"))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Bearer".to_string())
}

fn write_session_to_settings(settings: &mut Value, session: Option<&Value>) {
    if let Some(object) = settings.as_object_mut() {
        match session {
            Some(value) => {
                object.insert(
                    "redbox_auth_session_json".to_string(),
                    json!(serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())),
                );
            }
            None => {
                object.insert("redbox_auth_session_json".to_string(), json!(""));
            }
        }
    }
}

fn sanitize_session_for_cache(session: Option<&Value>) -> Option<Value> {
    let mut sanitized = session?.clone();
    let object = sanitized.as_object_mut()?;
    object.remove("accessToken");
    object.remove("access_token");
    object.remove("refreshToken");
    object.remove("refresh_token");
    object.remove("apiKey");
    object.remove("api_key");
    Some(sanitized)
}

pub(crate) fn parse_time_candidate_ms(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(if number > 10_000_000_000 {
            number
        } else {
            number.saturating_mul(1000)
        });
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number)
            .ok()
            .map(|item| if item > 10_000_000_000 { item } else { item.saturating_mul(1000) });
    }
    if let Some(text) = value.as_str().map(str::trim).filter(|item| !item.is_empty()) {
        if let Ok(number) = text.parse::<i64>() {
            return Some(if number > 10_000_000_000 {
                number
            } else {
                number.saturating_mul(1000)
            });
        }
        return parse_iso_like_ms(text);
    }
    None
}

fn parse_iso_like_ms(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = chrono_like_parse(trimmed)?;
    Some(parsed)
}

fn chrono_like_parse(text: &str) -> Option<i64> {
    let parsed = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

pub(crate) fn jwt_expiration_ms(token: &str) -> Option<i64> {
    let mut segments = token.split('.');
    let _header = segments.next()?;
    let payload = segments.next()?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let payload = serde_json::from_slice::<Value>(&decoded).ok()?;
    payload
        .get("exp")
        .and_then(|value| value.as_i64())
        .map(|value| value.saturating_mul(1000))
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(AUTH_VAULT_SERVICE, account).map_err(|error| error.to_string())
}

fn vault_read_entry(account: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            let text = error.to_string().to_lowercase();
            if text.contains("no entry")
                || text.contains("platform secure storage")
                || text.contains("not found")
            {
                Ok(None)
            } else {
                Err(error.to_string())
            }
        }
    }
}

fn vault_write_entry(account: &str, value: Option<&str>) -> Result<(), String> {
    let entry = keyring_entry(account)?;
    match value.map(str::trim).filter(|item| !item.is_empty()) {
        Some(secret) => entry.set_password(secret).map_err(|error| error.to_string()),
        None => match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(error) => {
                let text = error.to_string().to_lowercase();
                if text.contains("no entry") || text.contains("not found") {
                    Ok(())
                } else {
                    Err(error.to_string())
                }
            }
        },
    }
}

pub(crate) fn classify_auth_error(error: &str) -> AuthErrorKind {
    let normalized = error.trim().to_lowercase();
    if normalized.contains("invalid_grant")
        || normalized.contains("refresh token revoked")
        || normalized.contains("token revoked")
        || normalized.contains("refresh token reuse")
        || normalized.contains("account disabled")
        || normalized.contains("账号已禁用")
        || normalized.contains("refresh token invalid")
    {
        return AuthErrorKind::ReauthRequired;
    }
    if normalized.contains("401") || normalized.contains("unauthorized") {
        return AuthErrorKind::UnauthorizedRecoverable;
    }
    if normalized.contains("timeout")
        || normalized.contains("timed out")
        || normalized.contains("network")
        || normalized.contains("connection")
        || normalized.contains("temporarily unavailable")
    {
        return AuthErrorKind::NetworkTransient;
    }
    if normalized.contains("500")
        || normalized.contains("502")
        || normalized.contains("503")
        || normalized.contains("504")
        || normalized.contains("gateway")
        || normalized.contains("server")
    {
        return AuthErrorKind::ServerTransient;
    }
    AuthErrorKind::MalformedResponse
}

fn with_auth_runtime_mut<T>(
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut AuthRuntimeState) -> T,
) -> Result<T, String> {
    let mut runtime = state
        .auth_runtime
        .lock()
        .map_err(|_| "Auth runtime lock is poisoned".to_string())?;
    Ok(mutator(&mut runtime))
}

fn auth_state_snapshot_from_runtime(runtime: &AuthRuntimeState) -> AuthStateSnapshot {
    AuthStateSnapshot {
        status: runtime.status,
        logged_in: runtime.session.is_some() || runtime.secrets.refresh_token.is_some(),
        session: sanitize_session_for_cache(runtime.session.as_ref()),
        points: runtime.points.clone(),
        models: runtime.models.clone(),
        call_records: runtime.call_records.clone(),
        degraded_reason: runtime.degraded_reason.clone(),
        last_error: runtime.last_error.clone(),
        last_error_kind: runtime.last_error_kind,
        last_refresh_at: runtime.last_refresh_at.clone(),
        next_refresh_at_ms: runtime.next_refresh_at_ms,
    }
}

fn emit_auth_snapshot(app: &AppHandle, snapshot: &AuthStateSnapshot) {
    let _ = app.emit(AUTH_STATE_CHANGED_EVENT, snapshot.clone());
    let _ = app.emit(
        AUTH_DATA_CHANGED_EVENT,
        json!({
            "points": snapshot.points,
            "models": snapshot.models,
            "callRecords": snapshot.call_records,
            "updatedAt": now_iso(),
        }),
    );
}

fn persist_auth_cache(store_path: &Path, cache: &AuthCacheRecord) -> Result<(), String> {
    let path = auth_cache_path_from_store_path(store_path)?;
    let serialized = serde_json::to_string_pretty(cache).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn load_auth_cache(store_path: &Path) -> Result<AuthCacheRecord, String> {
    let path = auth_cache_path_from_store_path(store_path)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return Ok(AuthCacheRecord::default()),
    };
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_secrets(bundle: &AuthSecretBundle) -> Result<(), String> {
    vault_write_entry(AUTH_VAULT_REFRESH_TOKEN, bundle.refresh_token.as_deref())?;
    vault_write_entry(
        AUTH_VAULT_TOKEN_FAMILY_ID,
        bundle.token_family_id.as_deref(),
    )?;
    vault_write_entry(AUTH_VAULT_DEVICE_SECRET, bundle.device_secret.as_deref())?;
    Ok(())
}

fn load_secrets() -> Result<AuthSecretBundle, String> {
    Ok(AuthSecretBundle {
        refresh_token: vault_read_entry(AUTH_VAULT_REFRESH_TOKEN)?,
        token_family_id: vault_read_entry(AUTH_VAULT_TOKEN_FAMILY_ID)?,
        device_secret: vault_read_entry(AUTH_VAULT_DEVICE_SECRET)?,
    })
}

fn projected_session(
    session: Option<&Value>,
    secrets: &AuthSecretBundle,
    allow_access_token: bool,
) -> Option<Value> {
    let mut projected = session?.clone();
    let object = projected.as_object_mut()?;
    if !allow_access_token {
        object.remove("accessToken");
        object.remove("access_token");
        object.remove("apiKey");
        object.remove("api_key");
    }
    match secrets.refresh_token.as_deref().filter(|value| !value.trim().is_empty()) {
        Some(refresh_token) => {
            object.insert("refreshToken".to_string(), json!(refresh_token));
        }
        None => {
            object.remove("refreshToken");
            object.remove("refresh_token");
        }
    }
    if object.get("tokenType").is_none() {
        object.insert("tokenType".to_string(), json!(session_token_type(session)));
    }
    if object.get("expiresAt").is_none() {
        object.insert(
            "expiresAt".to_string(),
            json!(session_expires_at_ms(session).unwrap_or_default()),
        );
    }
    Some(projected)
}

fn write_cache_data_to_settings(settings: &mut Value, cache: &AuthCacheRecord) {
    if let Some(session) = cache.session.as_ref() {
        write_session_to_settings(settings, Some(session));
    }
    if let Some(points) = cache.points.as_ref() {
        if let Some(object) = settings.as_object_mut() {
            object.insert(
                "redbox_auth_points_json".to_string(),
                json!(serde_json::to_string(points).unwrap_or_else(|_| "{}".to_string())),
            );
        }
    }
    if !cache.models.is_empty() {
        if let Some(object) = settings.as_object_mut() {
            object.insert(
                "redbox_official_models_json".to_string(),
                json!(serde_json::to_string(&cache.models).unwrap_or_else(|_| "[]".to_string())),
            );
        }
    }
    if !cache.call_records.is_empty() {
        if let Some(object) = settings.as_object_mut() {
            object.insert(
                "redbox_auth_call_records_json".to_string(),
                json!(serde_json::to_string(&cache.call_records).unwrap_or_else(|_| "[]".to_string())),
            );
        }
    }
}

fn official_token_candidates(session: Option<&Value>) -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(value) = session_access_token(session) {
        tokens.push(value);
    }
    if let Some(value) = session.and_then(|item| {
        payload_string(item, "apiKey").or_else(|| payload_string(item, "api_key"))
    }) {
        if !tokens.iter().any(|existing| existing == &value) {
            tokens.push(value);
        }
    }
    tokens
}

fn scrub_official_source_secrets(settings: &mut Value, official_tokens: &[String]) {
    let Some(raw_sources) = payload_string(settings, "ai_sources_json") else {
        return;
    };
    let mut sources = serde_json::from_str::<Vec<Value>>(&raw_sources).unwrap_or_default();
    let mut changed = false;
    for source in &mut sources {
        let is_official = source
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value == OFFICIAL_SOURCE_ID)
            .unwrap_or(false);
        if !is_official {
            continue;
        }
        if let Some(object) = source.as_object_mut() {
            let current = object
                .get("apiKey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if official_tokens.is_empty()
                || current.is_empty()
                || official_tokens.iter().any(|item| item == &current)
            {
                object.insert("apiKey".to_string(), json!(""));
                changed = true;
            }
        }
    }
    if changed {
        if let Some(object) = settings.as_object_mut() {
            object.insert(
                "ai_sources_json".to_string(),
                json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
            );
        }
    }
}

fn clear_persisted_auth_fields(settings: &mut Value, session: Option<&Value>) {
    let official_tokens = official_token_candidates(session);
    scrub_official_source_secrets(settings, &official_tokens);
    let current_api_key = payload_string(settings, "api_key").unwrap_or_default();
    let current_video_api_key = payload_string(settings, "video_api_key").unwrap_or_default();
    if let Some(object) = settings.as_object_mut() {
        object.insert("redbox_auth_session_json".to_string(), json!(""));
        if !current_api_key.is_empty() && official_tokens.iter().any(|item| item == &current_api_key)
        {
            object.insert("api_key".to_string(), json!(""));
        }
        if !current_video_api_key.is_empty()
            && official_tokens.iter().any(|item| item == &current_video_api_key)
        {
            object.insert("video_api_key".to_string(), json!(""));
        }
    }
}

pub(crate) fn sanitize_store_for_persist(store: &mut AppStore) {
    let session = session_from_settings(&store.settings);
    clear_persisted_auth_fields(&mut store.settings, session.as_ref());
}

pub(crate) fn project_settings_for_runtime(settings: &Value, runtime: &AuthRuntimeState) -> Value {
    let mut projected = settings.clone();
    write_cache_data_to_settings(
        &mut projected,
        &AuthCacheRecord {
            session: runtime.session.clone(),
            points: runtime.points.clone(),
            models: runtime.models.clone(),
            call_records: runtime.call_records.clone(),
            updated_at: runtime
                .last_refresh_at
                .clone()
                .unwrap_or_else(now_iso),
            updated_at_ms: runtime.last_refresh_at_ms.unwrap_or_else(|| now_ms() as i64),
        },
    );
    if let Some(session) = projected_session(runtime.session.as_ref(), &runtime.secrets, true) {
        write_session_to_settings(&mut projected, Some(&session));
    }
    projected
}

pub(crate) fn auth_state_snapshot(state: &State<'_, AppState>) -> Result<AuthStateSnapshot, String> {
    with_auth_runtime_mut(state, |runtime| auth_state_snapshot_from_runtime(runtime))
}

pub(crate) fn sync_auth_runtime_from_settings(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    settings: &Value,
) -> Result<AuthStateSnapshot, String> {
    let cache = cache_record_from_settings(settings);
    let session = session_from_settings(settings);
    let secrets = AuthSecretBundle {
        refresh_token: session_refresh_token(session.as_ref()),
        token_family_id: None,
        device_secret: None,
    };
    let runtime_session = projected_session(session.as_ref(), &secrets, true);
    write_secrets(&secrets)?;
    persist_auth_cache(&state.store_path, &cache)?;
    let snapshot = with_auth_runtime_mut(state, |runtime| {
        runtime.session = runtime_session.clone();
        runtime.points = cache.points.clone();
        runtime.models = cache.models.clone();
        runtime.call_records = cache.call_records.clone();
        runtime.secrets = secrets.clone();
        runtime.last_refresh_at = Some(cache.updated_at.clone());
        runtime.last_refresh_at_ms = Some(cache.updated_at_ms);
        runtime.next_refresh_at_ms = session_expires_at_ms(session.as_ref()).map(|expires_at| {
            let refresh_window = 5 * 60 * 1000;
            expires_at.saturating_sub(refresh_window)
        });
        runtime.degraded_reason = None;
        runtime.last_error = None;
        runtime.last_error_kind = None;
        runtime.unknown_expiry_refresh_attempted = false;
        runtime.status = if session_access_token(session.as_ref()).is_some() {
            AuthStatus::Authenticated
        } else if secrets.refresh_token.is_some() {
            AuthStatus::Restoring
        } else if runtime.session.is_some() {
            AuthStatus::Degraded
        } else {
            AuthStatus::Anonymous
        };
        auth_state_snapshot_from_runtime(runtime)
    })?;
    if let Some(app_handle) = app {
        emit_auth_snapshot(app_handle, &snapshot);
    }
    Ok(snapshot)
}

pub(crate) fn mark_auth_degraded(
    app: &AppHandle,
    state: &State<'_, AppState>,
    message: impl Into<String>,
    kind: AuthErrorKind,
) -> Result<AuthStateSnapshot, String> {
    let message = message.into();
    let snapshot = with_auth_runtime_mut(state, |runtime| {
        runtime.status = if runtime.session.is_some() || runtime.secrets.refresh_token.is_some() {
            AuthStatus::Degraded
        } else {
            AuthStatus::Anonymous
        };
        runtime.degraded_reason = Some(message.clone());
        runtime.last_error = Some(message.clone());
        runtime.last_error_kind = Some(kind);
        auth_state_snapshot_from_runtime(runtime)
    })?;
    emit_auth_snapshot(app, &snapshot);
    Ok(snapshot)
}

pub(crate) fn mark_auth_refreshing(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<AuthStateSnapshot, String> {
    let snapshot = with_auth_runtime_mut(state, |runtime| {
        runtime.status = AuthStatus::Refreshing;
        auth_state_snapshot_from_runtime(runtime)
    })?;
    emit_auth_snapshot(app, &snapshot);
    Ok(snapshot)
}

pub(crate) fn mark_auth_reauth_required(
    app: &AppHandle,
    state: &State<'_, AppState>,
    message: impl Into<String>,
) -> Result<AuthStateSnapshot, String> {
    let message = message.into();
    write_secrets(&AuthSecretBundle::default())?;
    let snapshot = with_auth_runtime_mut(state, |runtime| {
        runtime.status = AuthStatus::ReauthRequired;
        runtime.session = None;
        runtime.secrets = AuthSecretBundle::default();
        runtime.degraded_reason = Some(message.clone());
        runtime.last_error = Some(message.clone());
        runtime.last_error_kind = Some(AuthErrorKind::ReauthRequired);
        auth_state_snapshot_from_runtime(runtime)
    })?;
    emit_auth_snapshot(app, &snapshot);
    Ok(snapshot)
}

pub(crate) fn mark_auth_logged_out(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<AuthStateSnapshot, String> {
    write_secrets(&AuthSecretBundle::default())?;
    let snapshot = with_auth_runtime_mut(state, |runtime| {
        *runtime = AuthRuntimeState::default();
        auth_state_snapshot_from_runtime(runtime)
    })?;
    emit_auth_snapshot(app, &snapshot);
    Ok(snapshot)
}

pub(crate) fn should_run_background_refresh(state: &State<'_, AppState>) -> bool {
    let Ok(snapshot) = auth_state_snapshot(state) else {
        return false;
    };
    if !snapshot.logged_in {
        return false;
    }
    let now = now_ms() as i64;
    if let Some(refresh_at) = snapshot.next_refresh_at_ms {
        return refresh_at <= now;
    }
    if snapshot.status == AuthStatus::Restoring {
        return true;
    }
    false
}

pub(crate) fn initialize_auth_runtime(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<AuthStateSnapshot, String> {
    let cache = load_auth_cache(&state.store_path)?;
    let secrets = load_secrets().unwrap_or_default();
    let cache_session = projected_session(cache.session.as_ref(), &secrets, false);
    crate::persistence::with_store_mut(state, |store| {
        write_cache_data_to_settings(&mut store.settings, &cache);
        write_session_to_settings(&mut store.settings, cache_session.as_ref());
        Ok(())
    })?;
    let snapshot = with_auth_runtime_mut(state, |runtime| {
        runtime.session = cache.session.clone();
        runtime.points = cache.points.clone();
        runtime.models = cache.models.clone();
        runtime.call_records = cache.call_records.clone();
        runtime.secrets = secrets.clone();
        runtime.last_refresh_at = if cache.updated_at.trim().is_empty() {
            None
        } else {
            Some(cache.updated_at.clone())
        };
        runtime.last_refresh_at_ms = if cache.updated_at_ms > 0 {
            Some(cache.updated_at_ms)
        } else {
            None
        };
        runtime.next_refresh_at_ms = session_expires_at_ms(cache.session.as_ref())
            .map(|expires_at| expires_at.saturating_sub(5 * 60 * 1000));
        runtime.status = if session_access_token(cache.session.as_ref()).is_some() {
            AuthStatus::Authenticated
        } else if secrets.refresh_token.is_some() {
            AuthStatus::Restoring
        } else if cache.session.is_some() {
            AuthStatus::Degraded
        } else {
            AuthStatus::Anonymous
        };
        auth_state_snapshot_from_runtime(runtime)
    })?;
    emit_auth_snapshot(app, &snapshot);
    Ok(snapshot)
}

pub(crate) fn migrate_legacy_auth_store(
    store_path: &Path,
    store: &mut AppStore,
) -> Result<(), String> {
    let legacy_session = session_from_settings(&store.settings);
    if legacy_session.is_none() {
        return Ok(());
    }
    let cache = cache_record_from_settings(&store.settings);
    let secrets = AuthSecretBundle {
        refresh_token: session_refresh_token(legacy_session.as_ref()),
        token_family_id: None,
        device_secret: None,
    };
    write_secrets(&secrets)?;
    persist_auth_cache(store_path, &cache)?;
    clear_persisted_auth_fields(&mut store.settings, legacy_session.as_ref());
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn official_bearer_token(state: &State<'_, AppState>) -> Option<String> {
    let runtime = state.auth_runtime.lock().ok()?;
    let access_token = session_access_token(runtime.session.as_ref());
    if access_token.is_some() {
        return access_token;
    }
    None
}

#[allow(dead_code)]
pub(crate) fn official_base_url(settings: &Value) -> String {
    payload_string(settings, "redbox_official_base_url")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| REDBOX_OFFICIAL_BASE_URL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_time_candidate_ms_supports_numeric_and_rfc3339_values() {
        assert_eq!(parse_time_candidate_ms(&json!(1_700_000_000)), Some(1_700_000_000_000));
        assert_eq!(
            parse_time_candidate_ms(&json!(1_700_000_000_123_i64)),
            Some(1_700_000_000_123)
        );
        assert_eq!(
            parse_time_candidate_ms(&json!("2026-04-19T14:24:16Z")),
            Some(1_776_608_656_000)
        );
    }

    #[test]
    fn jwt_expiration_ms_reads_exp_claim() {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(r#"{"exp":1776611056}"#);
        let token = format!("{header}.{payload}.signature");
        assert_eq!(jwt_expiration_ms(&token), Some(1_776_611_056_000));
    }

    #[test]
    fn classify_auth_error_recognizes_reauth_required_cases() {
        assert_eq!(
            classify_auth_error("invalid_grant: refresh token revoked"),
            AuthErrorKind::ReauthRequired
        );
        assert_eq!(
            classify_auth_error("network timeout while refreshing token"),
            AuthErrorKind::NetworkTransient
        );
    }
}
