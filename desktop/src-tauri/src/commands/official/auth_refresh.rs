use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::*;
use crate::store::settings as settings_store;
use crate::AppState;

fn auth_generation_is_current(
    state: &State<'_, AppState>,
    expected_generation: Option<u64>,
    stage: &str,
) -> bool {
    let Some(expected_generation) = expected_generation else {
        return true;
    };
    match auth::auth_generation_matches(state, expected_generation) {
        Ok(true) => true,
        Ok(false) => {
            log_official_auth(
                state,
                stage,
                format!("expectedGeneration={expected_generation}"),
            );
            false
        }
        Err(error) => {
            log_official_auth(
                state,
                stage,
                format!("generation-check-failed error={error}"),
            );
            false
        }
    }
}

pub(super) fn force_official_reauth(
    app: &AppHandle,
    state: &State<'_, AppState>,
    expected_generation: Option<u64>,
    source: &str,
    message: impl Into<String>,
) {
    if !auth_generation_is_current(state, expected_generation, "reauth-stale-skipped") {
        return;
    }
    let message = message.into();
    let mut settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))
        .unwrap_or_else(|_| json!({}));
    clear_official_auth_state(&mut settings);
    let _ =
        apply_official_settings_update(app, state, &settings, source, None, expected_generation);
    if auth_generation_is_current(
        state,
        expected_generation,
        "reauth-stale-skipped-after-update",
    ) {
        let _ = auth::mark_auth_reauth_required(app, state, message);
    }
}

pub(crate) fn refresh_official_auth_for_ai_request(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request_url: &str,
    api_key: Option<&str>,
    reason: &str,
) -> Result<Option<String>, String> {
    let generation = auth::auth_generation(state)?;
    let mut settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    if !is_official_ai_request(&settings, request_url, api_key) {
        return Ok(None);
    }

    log_official_auth(
        state,
        "ai-401",
        format!("reason={reason} url={request_url} attempting token refresh"),
    );

    match refresh_official_auth_session_with_lock(
        app,
        state,
        &mut settings,
        true,
        "ai-401",
        Some(generation),
    ) {
        Ok(_) => {
            let latest_settings =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let refreshed_token = if request_url.contains("/ai/video-retalk/") {
                official_access_token_from_settings(&latest_settings)
                    .or_else(|| official_ai_api_key_from_settings(&latest_settings))
            } else {
                official_ai_api_key_from_settings(&latest_settings)
            }
            .filter(|value| !value.trim().is_empty());
            if refreshed_token.is_some() {
                log_official_auth(
                    state,
                    "ai-401-refresh-success",
                    format!("url={request_url}"),
                );
                Ok(refreshed_token)
            } else {
                log_official_auth(
                    state,
                    "ai-401-refresh-missing-token",
                    format!("url={request_url}"),
                );
                force_official_reauth(
                    app,
                    state,
                    Some(generation),
                    "official-ai-reauth",
                    "登录失效，请重新登录",
                );
                Err("登录失效，请重新登录".to_string())
            }
        }
        Err(error) => {
            log_official_auth(
                state,
                "ai-401-refresh-failed",
                format!("url={request_url} error={error}"),
            );
            force_official_reauth(
                app,
                state,
                Some(generation),
                "official-ai-reauth",
                "登录失效，请重新登录",
            );
            Err("登录失效，请重新登录".to_string())
        }
    }
}

pub(super) fn refresh_official_auth_session_in_settings(
    settings: &mut Value,
) -> Result<Value, String> {
    let refresh_token =
        session_refresh_token(settings).ok_or_else(|| "当前会话缺少 refresh token".to_string())?;
    if let Some(expires_at) = auth::jwt_expiration_ms(&refresh_token) {
        if expires_at <= now_ms() as i64 {
            return Err("refresh token expired".to_string());
        }
    }
    if let Some(app_slug) = session_refresh_token_app_slug(settings) {
        if !official_refresh_token_app_slug_is_compatible(&app_slug) {
            return Err(format!(
                "旧账号体系登录态不可用于 {}，请重新登录。tokenAppSlug={app_slug}",
                app_brand_display_name()
            ));
        }
    }
    let existing_session = official_settings_session(settings);
    let request_candidates = [
        (
            "/auth/refresh",
            json!({
                "refresh_token": refresh_token,
            }),
        ),
        (
            "/auth/refresh",
            json!({
                "refreshToken": refresh_token,
            }),
        ),
        (
            "/auth/refresh-token",
            json!({
                "refresh_token": refresh_token,
            }),
        ),
    ];
    let mut last_error = None;

    for (path, body) in request_candidates {
        match run_official_public_json_request_response(settings, "POST", path, Some(body.clone()))
        {
            Ok(response) => {
                if !(200..300).contains(&response.status) {
                    let error = response_error_message(&response.body);
                    let kind = auth::classify_auth_error(&error);
                    if kind == auth::AuthErrorKind::ReauthRequired
                        || kind == auth::AuthErrorKind::NetworkTransient
                        || kind == auth::AuthErrorKind::ServerTransient
                    {
                        return Err(error);
                    }
                    last_error = Some(error);
                    continue;
                }
                match normalize_official_auth_session(&response.body) {
                    Ok(mut session) => {
                        merge_session_with_existing(existing_session.as_ref(), &mut session);
                        upsert_official_settings_session(settings, Some(&session));
                        let _ = ensure_official_ai_api_key_in_settings(settings)?;
                        sync_official_route_credentials(settings);
                        return Ok(session);
                    }
                    Err(error) => {
                        if auth::classify_auth_error(&error) == auth::AuthErrorKind::ReauthRequired
                        {
                            return Err(error);
                        }
                        last_error = Some(error);
                    }
                }
            }
            Err(error) => {
                let kind = auth::classify_auth_error(&error);
                if kind == auth::AuthErrorKind::ReauthRequired
                    || kind == auth::AuthErrorKind::NetworkTransient
                    || kind == auth::AuthErrorKind::ServerTransient
                {
                    return Err(error);
                }
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "刷新登录态失败".to_string()))
}

fn official_refresh_token_app_slug_is_compatible(app_slug: &str) -> bool {
    let normalized = app_slug.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return true;
    }
    normalized == app_brand_slug() || matches!(normalized.as_str(), "redbox" | "beav" | "thrive")
}

fn should_force_reauth_after_exhausted_refresh(error: &str) -> bool {
    let normalized = error.trim().to_lowercase();
    normalized.contains("登录结果缺少 access_token")
        || normalized.contains("missing access_token")
        || normalized.contains("missing access token")
}

fn mark_refresh_failure(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    expected_generation: Option<u64>,
    error: String,
) {
    let kind = auth::classify_auth_error(&error);
    log_official_auth(
        state,
        "refresh-failed",
        format!("kind={kind:?} error={error}"),
    );
    if kind == auth::AuthErrorKind::ReauthRequired
        || should_force_reauth_after_exhausted_refresh(&error)
    {
        if !auth_generation_is_current(state, expected_generation, "refresh-reauth-stale-skipped") {
            return;
        }
        clear_official_auth_state(settings);
        let _ = apply_official_settings_update(
            app,
            state,
            settings,
            "official-auth-refresh-failed",
            None,
            expected_generation,
        );
        if auth_generation_is_current(
            state,
            expected_generation,
            "refresh-reauth-stale-skipped-after-update",
        ) {
            let _ = auth::mark_auth_reauth_required(app, state, error);
        }
        return;
    }
    let _ = auth::mark_auth_degraded(app, state, error, kind);
}

pub(super) fn refresh_official_auth_session_with_lock(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    force: bool,
    reason: &str,
    expected_generation: Option<u64>,
) -> Result<Option<Value>, String> {
    if let Some(expected_generation) = expected_generation {
        let matches = auth::auth_generation_matches(state, expected_generation)?;
        if !matches {
            log_official_auth(
                state,
                "stale-refresh-skipped",
                format!("reason={reason} expectedGeneration={expected_generation}"),
            );
            return Err("auth generation changed; stale refresh skipped".to_string());
        }
    }
    log_official_auth(
        state,
        "refresh-request",
        format!("force={force} reason={reason}"),
    );
    let _guard = state
        .official_auth_refresh_lock
        .lock()
        .map_err(|_| "官方登录态刷新锁已损坏".to_string())?;
    if let Some(expected_generation) = expected_generation {
        let matches = auth::auth_generation_matches(state, expected_generation)?;
        if !matches {
            log_official_auth(
                state,
                "stale-refresh-skipped-after-lock",
                format!("reason={reason} expectedGeneration={expected_generation}"),
            );
            return Err("auth generation changed; stale refresh skipped".to_string());
        }
    }
    let latest_settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    merge_official_settings(settings, &latest_settings);

    if official_settings_session(settings).is_none() {
        log_official_auth(state, "refresh-abort", "no session in settings");
        let snapshot = auth::auth_state_snapshot(state).unwrap_or_default();
        if snapshot.status == auth::AuthStatus::ReauthRequired {
            return Err(snapshot
                .last_error
                .unwrap_or_else(|| "登录失效，请重新登录".to_string()));
        }
        let _ = auth::mark_auth_logged_out(app, state);
        return Err("官方账号未登录".to_string());
    }
    if !force && !official_session_needs_refresh(settings) {
        log_official_auth(state, "refresh-skip", "session does not need refresh");
        return Ok(official_settings_session(settings));
    }
    let _ = auth::mark_auth_refreshing(app, state);

    match refresh_official_auth_session_in_settings(settings) {
        Ok(session) => {
            log_official_auth(
                state,
                "refresh-success",
                format!(
                    "accessToken={} refreshToken={} expiresAt={}",
                    payload_string(&session, "accessToken").is_some(),
                    payload_string(&session, "refreshToken").is_some(),
                    payload_i64(&session, "expiresAt").unwrap_or_default()
                ),
            );
            apply_official_settings_update(
                app,
                state,
                settings,
                &format!("official-auth-refresh:{reason}"),
                None,
                expected_generation,
            )?;
            Ok(Some(session))
        }
        Err(error) => {
            mark_refresh_failure(app, state, settings, expected_generation, error.clone());
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        official_refresh_token_app_slug_is_compatible, should_force_reauth_after_exhausted_refresh,
    };

    #[test]
    fn exhausted_refresh_missing_access_token_requires_reauth() {
        assert!(should_force_reauth_after_exhausted_refresh(
            "登录结果缺少 access_token"
        ));
        assert!(should_force_reauth_after_exhausted_refresh(
            "missing access token"
        ));
        assert!(!should_force_reauth_after_exhausted_refresh(
            "network timeout while refreshing token"
        ));
    }

    #[test]
    fn official_refresh_token_app_slug_accepts_shared_account_slugs() {
        assert!(official_refresh_token_app_slug_is_compatible("redbox"));
        assert!(official_refresh_token_app_slug_is_compatible("beav"));
        assert!(official_refresh_token_app_slug_is_compatible("thrive"));
        assert!(!official_refresh_token_app_slug_is_compatible(
            "unknown-app"
        ));
    }
}
