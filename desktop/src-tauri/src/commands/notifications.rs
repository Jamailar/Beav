use serde_json::{json, Value};
use tauri::{plugin::PermissionState, AppHandle, Manager, State};
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

async fn run_remote_notification_request(
    app: AppHandle,
    method: &'static str,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        ensure_notification_auth(&state)?;
        let request_generation = auth::auth_generation(&state).ok();
        let settings = with_store(&state, |store| {
            Ok(settings_store::settings_snapshot(&store))
        })?;
        notification_response(
            &app,
            &state,
            &settings,
            method,
            &path,
            body,
            request_generation,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn notifications_sync_remote(
    app: AppHandle,
    cursor: Option<String>,
    limit: Option<u64>,
    unread_only: Option<bool>,
) -> Result<Value, String> {
    let path = sync_notifications_path(cursor, limit, unread_only);
    run_remote_notification_request(app, "GET", path, None).await
}

#[tauri::command]
pub async fn notifications_list_remote(
    app: AppHandle,
    limit: Option<u64>,
    unread_only: Option<bool>,
) -> Result<Value, String> {
    let path = list_notifications_path(limit, unread_only);
    run_remote_notification_request(app, "GET", path, None).await
}

#[tauri::command]
pub async fn notifications_mark_remote_read(
    app: AppHandle,
    notification_id: String,
) -> Result<Value, String> {
    let path = mark_notification_read_path(&notification_id)?;
    run_remote_notification_request(app, "POST", path, None).await
}

#[tauri::command]
pub async fn notifications_mark_all_remote_read(app: AppHandle) -> Result<Value, String> {
    run_remote_notification_request(
        app,
        "POST",
        "/users/me/notifications/read-all".to_string(),
        None,
    )
    .await
}
