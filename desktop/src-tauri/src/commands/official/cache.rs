use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

use super::*;
use crate::store::settings as settings_store;

fn update_official_session_user(settings: &mut Value, user: &Value) {
    let next_session = official_settings_session(settings).map(|mut session| {
        if let Some(object) = session.as_object_mut() {
            if object.get("user") == Some(user) {
                return session;
            }
            object.insert("user".to_string(), user.clone());
            object.insert("updatedAt".to_string(), json!(now_ms() as i64));
        }
        session
    });
    if let Some(session_value) = next_session.as_ref() {
        upsert_official_settings_session(settings, Some(session_value));
        sync_official_route_credentials(settings);
    }
}

fn refresh_official_cached_data_into_settings(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
    if !official_session_logged_in(settings) {
        return Err("官方账号未登录".to_string());
    }

    let mut refreshed = false;

    if official_session_needs_refresh(settings) {
        refresh_official_auth_session_with_lock(
            app,
            state,
            settings,
            false,
            "cache-refresh",
            expected_generation,
        )?;
    }

    match run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        "/users/me",
        None,
        expected_generation,
    ) {
        Ok(response) => {
            let user = official_unwrap_response_payload(&response);
            update_official_session_user(settings, &user);
            refreshed = true;
        }
        Err(error) => {
            if auth::classify_auth_error(&error) == auth::AuthErrorKind::ReauthRequired {
                return Err(error);
            }
            ensure_bootstrap_not_reauth_required(state)?;
        }
    }

    match fetch_remote_official_points(app, state, settings, expected_generation) {
        Ok(points) => {
            write_settings_json_value(settings, "redbox_auth_points_json", &points);
            refreshed = true;
        }
        Err(error) => {
            if auth::classify_auth_error(&error) == auth::AuthErrorKind::ReauthRequired {
                return Err(error);
            }
            ensure_bootstrap_not_reauth_required(state)?;
        }
    }

    let models = fetch_official_models_with_recovery(app, state, settings, expected_generation);
    ensure_bootstrap_not_reauth_required(state)?;
    if !models.is_empty() {
        write_settings_json_array(settings, "redbox_official_models_json", &models);
        official_sync_source_into_settings(settings, &models, false);
        refreshed = true;
    }

    match fetch_remote_official_call_records(app, state, settings, expected_generation) {
        Ok(records) => {
            write_settings_json_array(settings, "redbox_auth_call_records_json", &records);
            refreshed = true;
        }
        Err(error) => {
            if auth::classify_auth_error(&error) == auth::AuthErrorKind::ReauthRequired {
                return Err(error);
            }
            ensure_bootstrap_not_reauth_required(state)?;
        }
    }

    Ok(json!({
        "user": cached_official_user(settings),
        "points": cached_official_points(settings),
        "models": official_settings_models(settings),
        "records": official_settings_call_records_list(settings),
        "refreshedAt": now_iso(),
        "stale": !refreshed,
    }))
}

fn ensure_bootstrap_not_reauth_required(state: &State<'_, AppState>) -> Result<(), String> {
    let snapshot = auth::auth_state_snapshot(state).unwrap_or_default();
    if snapshot.status == auth::AuthStatus::ReauthRequired {
        return Err(snapshot
            .last_error
            .unwrap_or_else(|| "登录失效，请重新登录".to_string()));
    }
    Ok(())
}

pub(crate) fn refresh_official_cached_data(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    log_official_auth(
        state,
        "background-refresh",
        "refresh_official_cached_data invoked",
    );
    let generation = auth::auth_generation(state)?;
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    if !official_session_logged_in(&settings_snapshot) {
        return Err("官方账号未登录".to_string());
    }

    let mut updated_settings = settings_snapshot.clone();
    let refreshed = refresh_official_cached_data_into_settings(
        app,
        state,
        &mut updated_settings,
        Some(generation),
    )?;
    apply_official_settings_update(
        app,
        state,
        &updated_settings,
        "official-background-refresh",
        Some(refreshed.clone()),
        Some(generation),
    )?;
    Ok(refreshed)
}

pub(crate) fn bootstrap_official_auth_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    reason: &str,
) -> Result<Value, String> {
    log_official_auth(state, "bootstrap", format!("reason={reason}"));
    let generation = auth::auth_generation(state)?;
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    if !official_session_logged_in(&settings_snapshot) {
        let mut cleaned_settings = settings_snapshot.clone();
        clear_official_auth_state(&mut cleaned_settings);
        let _ = apply_official_settings_update(
            app,
            state,
            &cleaned_settings,
            "official-bootstrap-cleared",
            None,
            Some(generation),
        );
        return Ok(json!({
            "success": true,
            "loggedIn": false,
            "session": Value::Null,
            "reason": reason,
        }));
    }

    let session = with_store(state, |store| {
        let settings = settings_store::settings_snapshot(&store);
        Ok(official_settings_session(&settings))
    })?;
    let snapshot = auth::auth_state_snapshot(state).unwrap_or_default();
    let refreshed = match refresh_official_cached_data(app, state) {
        Ok(payload) => payload,
        Err(error) if session.is_some() || snapshot.logged_in => {
            let kind = auth::classify_auth_error(&error);
            if kind == auth::AuthErrorKind::ReauthRequired {
                let auth_state = auth::auth_state_snapshot(state).unwrap_or_default();
                return Ok(json!({
                    "success": true,
                    "loggedIn": false,
                    "session": Value::Null,
                    "data": {
                        "user": Value::Null,
                        "points": Value::Null,
                        "models": Vec::<Value>::new(),
                        "records": Vec::<Value>::new(),
                        "refreshedAt": now_iso(),
                        "stale": true,
                        "error": error,
                    },
                    "authState": auth_state,
                    "reason": reason,
                }));
            }
            let _ = auth::mark_auth_degraded(app, state, error.clone(), kind);
            json!({
                "user": cached_official_user(&settings_snapshot),
                "points": cached_official_points(&settings_snapshot),
                "models": official_settings_models(&settings_snapshot),
                "records": official_settings_call_records_list(&settings_snapshot),
                "refreshedAt": now_iso(),
                "stale": true,
                "error": error,
            })
        }
        Err(error) => return Err(error),
    };
    Ok(json!({
        "success": true,
        "loggedIn": session.is_some() || snapshot.logged_in,
        "session": session,
        "data": refreshed,
        "authState": auth::auth_state_snapshot(state).unwrap_or_default(),
        "reason": reason,
    }))
}

fn spawn_official_cached_data_refresh(app: AppHandle) -> bool {
    let state = app.state::<AppState>();
    if state
        .official_cache_refresh_inflight
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Err(error) = refresh_official_cached_data(&app, &state) {
            if error != "官方账号未登录" {
                eprintln!("[{} official refresh] {error}", app_brand_display_name());
            }
        }
        state
            .official_cache_refresh_inflight
            .store(false, Ordering::Release);
    });
    true
}

pub(crate) fn trigger_official_cached_data_refresh(app: AppHandle) -> bool {
    spawn_official_cached_data_refresh(app)
}
