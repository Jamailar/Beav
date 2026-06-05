use serde_json::{json, Value};
use tauri::{plugin::PermissionState, AppHandle, State};
use tauri_plugin_notification::NotificationExt;

mod remote;

use crate::store::settings as settings_store;
use crate::{auth, with_store, AppState};
use remote::{
    list_notifications_path, mark_notification_read_path, notification_response,
    sync_notifications_path,
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
    let path = sync_notifications_path(cursor, limit, unread_only);
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
    let path = list_notifications_path(limit, unread_only);
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
    let path = mark_notification_read_path(&notification_id)?;
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
