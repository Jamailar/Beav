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
    official_settings_session(settings)
        .as_ref()
        .is_some_and(|session| auth::session_refresh_token_is_current(Some(session)))
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

fn value_is_missing(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => text.trim().is_empty(),
        Some(Value::Null) => true,
        Some(_) => false,
        None => true,
    }
}

fn merge_missing_user_membership_fields(
    existing_user: Option<&Value>,
    next_user: Option<&mut Value>,
) {
    let Some(existing_user) = existing_user.and_then(Value::as_object) else {
        return;
    };
    let Some(next_user) = next_user.and_then(Value::as_object_mut) else {
        return;
    };

    for key in [
        "membership_type",
        "membershipType",
        "memberType",
        "membership_expires_at",
        "membershipExpiresAt",
        "membership",
        "memberships",
        "entitlements",
        "subscription",
        "founderMembership",
        "founder_sponsor",
    ] {
        if value_is_missing(next_user.get(key)) {
            if let Some(value) = existing_user.get(key) {
                next_user.insert(key.to_string(), value.clone());
            }
        }
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
    } else {
        merge_missing_user_membership_fields(
            existing_object.get("user"),
            session_object.get_mut("user"),
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_session_with_existing_preserves_missing_user_membership_fields() {
        let existing = json!({
            "accessToken": "old-access",
            "refreshToken": "old-refresh",
            "user": {
                "id": "user-1",
                "display_name": "Jamba",
                "membership_type": "PREMIUM",
                "membership_expires_at": "2126-05-24T07:07:15.586Z"
            }
        });
        let mut next = json!({
            "accessToken": "new-access",
            "user": {
                "id": "user-1",
                "display_name": "Jamba"
            }
        });

        merge_session_with_existing(Some(&existing), &mut next);

        assert_eq!(
            next.pointer("/user/membership_type")
                .and_then(Value::as_str),
            Some("PREMIUM")
        );
        assert_eq!(
            next.pointer("/user/membership_expires_at")
                .and_then(Value::as_str),
            Some("2126-05-24T07:07:15.586Z")
        );
        assert_eq!(
            next.get("refreshToken").and_then(Value::as_str),
            Some("old-refresh")
        );
    }

    #[test]
    fn merge_session_with_existing_does_not_override_explicit_user_membership_fields() {
        let existing = json!({
            "user": {
                "id": "user-1",
                "membership_type": "PREMIUM"
            }
        });
        let mut next = json!({
            "user": {
                "id": "user-1",
                "membership_type": "FREE"
            }
        });

        merge_session_with_existing(Some(&existing), &mut next);

        assert_eq!(
            next.pointer("/user/membership_type")
                .and_then(Value::as_str),
            Some("FREE")
        );
    }

    #[test]
    fn expired_refresh_token_is_not_recoverable_login_state() {
        use base64::Engine;

        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let expired_payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"exp":1}"#);
        let settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "refreshToken": format!("{header}.{expired_payload}.signature"),
            }))
            .unwrap(),
        });

        assert!(!official_session_logged_in(&settings));
        assert!(!official_session_needs_refresh(&settings));
    }
}
