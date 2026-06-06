use serde_json::Value;
use tauri::{AppHandle, State};

use super::*;
use crate::AppState;

fn run_authenticated_official_request_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    preflight_refresh: bool,
    expected_generation: Option<u64>,
) -> Result<crate::HttpJsonResponse, String> {
    if preflight_refresh && official_session_needs_refresh(settings) {
        log_official_auth(state, "request-preflight-refresh", format!("path={path}"));
        refresh_official_auth_session_with_lock(
            app,
            state,
            settings,
            false,
            "preflight",
            expected_generation,
        )?;
    }

    let response = crate::run_official_json_request_response(settings, method, path, body.clone())?;
    if !official_response_is_unauthorized(response.status, &response.body) {
        return Ok(response);
    }

    log_official_auth(
        state,
        "request-unauthorized",
        format!("path={path} status={} retrying refresh", response.status),
    );
    refresh_official_auth_session_with_lock(
        app,
        state,
        settings,
        true,
        "retry",
        expected_generation,
    )?;
    let retry = crate::run_official_json_request_response(settings, method, path, body)?;
    if !official_response_is_unauthorized(retry.status, &retry.body) {
        return Ok(retry);
    }

    let error = response_error_message(&retry.body);
    let kind = auth::classify_auth_error(&error);
    log_official_auth(
        state,
        "request-retry-failed",
        format!("path={path} kind={kind:?} error={error}"),
    );
    if kind == auth::AuthErrorKind::ReauthRequired {
        clear_official_auth_state(settings);
        let _ = apply_official_settings_update(
            app,
            state,
            settings,
            "official-auth-unauthorized",
            None,
            expected_generation,
        );
        let _ = auth::mark_auth_reauth_required(app, state, error.clone());
    } else {
        let _ = auth::mark_auth_degraded(app, state, error.clone(), kind);
    }
    Err(error)
}

pub(crate) fn run_authenticated_official_request_response(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<crate::HttpJsonResponse, String> {
    run_authenticated_official_request_inner(
        app,
        state,
        settings,
        method,
        path,
        body,
        true,
        expected_generation,
    )
}

pub(super) fn run_authenticated_official_request(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
    run_authenticated_official_request_response(
        app,
        state,
        settings,
        method,
        path,
        body,
        expected_generation,
    )
    .map(|response| response.body)
}

pub(crate) fn run_authenticated_official_request_response_skip_preflight_refresh(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<crate::HttpJsonResponse, String> {
    run_authenticated_official_request_inner(
        app,
        state,
        settings,
        method,
        path,
        body,
        false,
        expected_generation,
    )
}

pub(super) fn run_authenticated_official_request_skip_preflight_refresh(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
    run_authenticated_official_request_response_skip_preflight_refresh(
        app,
        state,
        settings,
        method,
        path,
        body,
        expected_generation,
    )
    .map(|response| response.body)
}
