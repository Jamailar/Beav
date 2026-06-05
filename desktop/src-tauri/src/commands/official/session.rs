use serde_json::{json, Value};

use super::call_records::value_as_i64;
use crate::{auth, now_ms, official_settings_session, payload_string};

const OFFICIAL_SESSION_MIN_REFRESH_WINDOW_MS: i64 = 60_000;
const OFFICIAL_SESSION_MAX_REFRESH_WINDOW_MS: i64 = 5 * 60_000;

pub(super) fn session_access_token(settings: &Value) -> Option<String> {
    official_settings_session(settings)
        .and_then(|session| {
            payload_string(&session, "accessToken")
                .or_else(|| payload_string(&session, "access_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn session_created_at(settings: &Value) -> Option<i64> {
    official_settings_session(settings).and_then(|session| {
        session
            .get("createdAt")
            .or_else(|| session.get("updatedAt"))
            .and_then(value_as_i64)
    })
}

pub(super) fn session_refresh_window_ms(settings: &Value) -> i64 {
    let expires_at = session_expires_at(settings).unwrap_or_default();
    let created_at = session_created_at(settings).unwrap_or_else(|| (now_ms() as i64) - 900_000);
    let ttl_ms = expires_at.saturating_sub(created_at);
    let dynamic_window = ttl_ms / 5;
    dynamic_window.clamp(
        OFFICIAL_SESSION_MIN_REFRESH_WINDOW_MS,
        OFFICIAL_SESSION_MAX_REFRESH_WINDOW_MS,
    )
}

fn session_refresh_deadline(settings: &Value) -> Option<i64> {
    session_expires_at(settings).map(|expires_at| expires_at - session_refresh_window_ms(settings))
}

fn official_session_recoverable(settings: &Value) -> bool {
    session_refresh_token(settings).is_some()
}

pub(super) fn official_session_logged_in(settings: &Value) -> bool {
    session_access_token(settings).is_some() || official_session_recoverable(settings)
}

pub(super) fn session_refresh_token(settings: &Value) -> Option<String> {
    official_settings_session(settings)
        .and_then(|session| {
            payload_string(&session, "refreshToken")
                .or_else(|| payload_string(&session, "refresh_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn session_refresh_token_app_slug(settings: &Value) -> Option<String> {
    session_refresh_token(settings).and_then(|token| {
        auth::jwt_claim_string(&token, "appSlug")
            .or_else(|| auth::jwt_claim_string(&token, "app_slug"))
    })
}

fn session_expires_at(settings: &Value) -> Option<i64> {
    official_settings_session(settings)
        .and_then(|session| session.get("expiresAt").and_then(value_as_i64))
}

pub(super) fn official_session_needs_refresh(settings: &Value) -> bool {
    if official_settings_session(settings).is_none() {
        return false;
    }

    if session_access_token(settings).is_none() {
        return official_session_recoverable(settings);
    }

    if !official_session_recoverable(settings) {
        return false;
    }

    match session_refresh_deadline(settings) {
        Some(refresh_at) => refresh_at <= now_ms() as i64,
        None => false,
    }
}

pub(super) fn merge_session_with_existing(existing: Option<&Value>, session: &mut Value) {
    let Some(session_object) = session.as_object_mut() else {
        return;
    };
    let Some(existing_object) = existing.and_then(|value| value.as_object()) else {
        return;
    };

    let user_missing = session_object
        .get("user")
        .map(|value| value.is_null())
        .unwrap_or(true);
    if user_missing {
        if let Some(user) = existing_object.get("user") {
            session_object.insert("user".to_string(), user.clone());
        }
    }

    for key in [
        "refreshToken",
        "apiKey",
        "tokenType",
        "expiresAt",
        "createdAt",
    ] {
        let missing = match session_object.get(key) {
            Some(Value::String(text)) => text.trim().is_empty(),
            Some(Value::Null) => true,
            Some(_) => false,
            None => true,
        };
        if missing {
            if let Some(value) = existing_object.get(key) {
                session_object.insert(key.to_string(), value.clone());
            }
        }
    }

    session_object.insert("updatedAt".to_string(), json!(now_ms() as i64));
}
