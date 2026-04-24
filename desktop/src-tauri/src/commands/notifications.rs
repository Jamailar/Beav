use serde_json::{json, Value};
use tauri::{plugin::PermissionState, AppHandle};
use tauri_plugin_notification::NotificationExt;

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
