use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::{
    app_brand_slug, official_base_url_from_settings, official_realm_from_settings,
    official_unwrap_response_payload, payload_string, AppState,
};

pub(crate) fn normalized_limit(limit: Option<u64>, fallback: u64) -> u64 {
    limit.unwrap_or(fallback).clamp(1, 100)
}

fn encode_query_value(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

fn official_notification_context(settings: &Value) -> Value {
    let session = crate::official_settings_session(settings).unwrap_or_else(|| json!({}));
    let user = session.get("user").cloned().unwrap_or_else(|| json!({}));
    let user_id = payload_string(&user, "id")
        .or_else(|| payload_string(&user, "userId"))
        .or_else(|| payload_string(&user, "user_id"))
        .or_else(|| payload_string(&session, "userId"))
        .or_else(|| payload_string(&session, "user_id"))
        .unwrap_or_default();
    json!({
        "appSlug": app_brand_slug(),
        "userId": user_id,
        "realm": official_realm_from_settings(settings),
        "baseUrl": official_base_url_from_settings(settings),
    })
}

pub(crate) fn notification_response(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
    let mut settings = settings.clone();
    let response = crate::commands::official::run_authenticated_official_request_response(
        app,
        state,
        &mut settings,
        method,
        path,
        body,
        expected_generation,
    )?;
    let payload = official_unwrap_response_payload(&response.body);
    Ok(json!({
        "success": (200..300).contains(&response.status),
        "status": response.status,
        "data": payload,
        "raw": response.body,
        "context": official_notification_context(&settings),
    }))
}

pub(crate) fn sync_notifications_path(
    cursor: Option<String>,
    limit: Option<u64>,
    unread_only: Option<bool>,
) -> String {
    let limit = normalized_limit(limit, 20);
    let mut query = vec![format!("limit={limit}")];
    if let Some(cursor_value) = cursor
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        query.push(format!("cursor={}", encode_query_value(&cursor_value)));
    }
    if unread_only.unwrap_or(false) {
        query.push("unread_only=1".to_string());
    }
    format!("/users/me/notifications/sync?{}", query.join("&"))
}

pub(crate) fn list_notifications_path(limit: Option<u64>, unread_only: Option<bool>) -> String {
    let limit = normalized_limit(limit, 50);
    let mut query = vec![format!("limit={limit}")];
    if unread_only.unwrap_or(false) {
        query.push("unread_only=1".to_string());
    }
    format!("/users/me/notifications?{}", query.join("&"))
}

pub(crate) fn mark_notification_read_path(notification_id: &str) -> Result<String, String> {
    let trimmed_id = notification_id.trim();
    if trimmed_id.is_empty() {
        return Err("notification_id is required".to_string());
    }
    Ok(format!(
        "/users/me/notifications/{}/read",
        encode_query_value(trimmed_id)
    ))
}
