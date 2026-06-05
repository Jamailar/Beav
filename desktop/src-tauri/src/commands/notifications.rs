use serde_json::{json, Value};
use tauri::{plugin::PermissionState, AppHandle, State};
use tauri_plugin_notification::NotificationExt;

use crate::store::settings as settings_store;
use crate::{
    app_brand_slug, auth, official_base_url_from_settings, official_realm_from_settings,
    official_unwrap_response_payload, payload_string, run_official_json_request_response,
    with_store, AppState,
};

fn permission_state_label(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "prompt",
    }
}

#[tauri::command]
pub fn notifications_permission_state(app: AppHandle) -> Result<Value, String> {
    let state = app
        .notification()
        .permission_state()
        .map(permission_state_label)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "state": state }))
}

#[tauri::command]
pub fn notifications_request_permission(app: AppHandle) -> Result<Value, String> {
    let state = app
        .notification()
        .request_permission()
        .map(permission_state_label)
        .map_err(|error| error.to_string())?;
    Ok(json!({ "state": state }))
}

#[tauri::command]
pub fn notifications_show_system(
    app: AppHandle,
    title: String,
    body: Option<String>,
    sound: Option<String>,
) -> Result<Value, String> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err("title is required".to_string());
    }

    let mut builder = app
        .notification()
        .builder()
        .title(trimmed_title.to_string());
    if let Some(body_text) = body.map(|value| value.trim().to_string()) {
        if !body_text.is_empty() {
            builder = builder.body(body_text);
        }
    }
    if let Some(sound_name) = sound.map(|value| value.trim().to_string()) {
        if !sound_name.is_empty() {
            builder = builder.sound(sound_name);
        }
    }

    builder.show().map_err(|error| error.to_string())?;
    Ok(json!({ "success": true }))
}

fn normalized_limit(limit: Option<u64>, fallback: u64) -> u64 {
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

fn notification_response(
    settings: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let response = run_official_json_request_response(settings, method, path, body)?;
    let payload = official_unwrap_response_payload(&response.body);
    Ok(json!({
        "success": (200..300).contains(&response.status),
        "status": response.status,
        "data": payload,
        "raw": response.body,
        "context": official_notification_context(settings),
    }))
}

fn ensure_notification_auth(state: &State<'_, AppState>) -> Result<(), String> {
    let snapshot = auth::auth_state_snapshot(state).unwrap_or_default();
    if !snapshot.logged_in
        || matches!(
            snapshot.status,
            auth::AuthStatus::Anonymous | auth::AuthStatus::ReauthRequired
        )
    {
        return Err("官方账号未登录".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn notifications_sync_remote(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: Option<u64>,
    unread_only: Option<bool>,
) -> Result<Value, String> {
    ensure_notification_auth(&state)?;
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
    let path = format!("/users/me/notifications/sync?{}", query.join("&"));
    let settings = with_store(&state, |store| {
        Ok(settings_store::settings_snapshot(&store))
    })?;
    notification_response(&settings, "GET", &path, None)
}

#[tauri::command]
pub fn notifications_list_remote(
    state: State<'_, AppState>,
    limit: Option<u64>,
    unread_only: Option<bool>,
) -> Result<Value, String> {
    ensure_notification_auth(&state)?;
    let limit = normalized_limit(limit, 50);
    let mut query = vec![format!("limit={limit}")];
    if unread_only.unwrap_or(false) {
        query.push("unread_only=1".to_string());
    }
    let path = format!("/users/me/notifications?{}", query.join("&"));
    let settings = with_store(&state, |store| {
        Ok(settings_store::settings_snapshot(&store))
    })?;
    notification_response(&settings, "GET", &path, None)
}

#[tauri::command]
pub fn notifications_mark_remote_read(
    state: State<'_, AppState>,
    notification_id: String,
) -> Result<Value, String> {
    ensure_notification_auth(&state)?;
    let trimmed_id = notification_id.trim();
    if trimmed_id.is_empty() {
        return Err("notification_id is required".to_string());
    }
    let path = format!(
        "/users/me/notifications/{}/read",
        encode_query_value(trimmed_id)
    );
    let settings = with_store(&state, |store| {
        Ok(settings_store::settings_snapshot(&store))
    })?;
    notification_response(&settings, "POST", &path, None)
}

#[tauri::command]
pub fn notifications_mark_all_remote_read(state: State<'_, AppState>) -> Result<Value, String> {
    ensure_notification_auth(&state)?;
    let settings = with_store(&state, |store| {
        Ok(settings_store::settings_snapshot(&store))
    })?;
    notification_response(&settings, "POST", "/users/me/notifications/read-all", None)
}
