mod account;
mod api_keys;
mod auth_flow;
mod billing;
mod cache;
mod call_records;
mod models;
mod points;
mod pricing;
mod session;
mod settings_sync;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[cfg(test)]
use crate::official_base_url_for_realm;
use crate::persistence::{with_store, with_store_mut};
use crate::store::settings as settings_store;
use crate::{
    app_brand_display_name, app_brand_slug, append_debug_trace_state, auth,
    create_official_payment_form, emit_redbox_auth_data_updated, emit_redbox_auth_session_updated,
    make_id, normalize_official_auth_session, now_iso, now_ms, official_access_token_from_settings,
    official_account_summary_local, official_ai_api_key_from_settings,
    official_base_url_from_settings, official_fallback_products, official_realm_from_settings,
    official_realms_payload, official_response_items, official_settings_api_keys,
    official_settings_call_records_list, official_settings_models, official_settings_orders,
    official_settings_pricing, official_settings_session, official_settings_wechat_login,
    official_sync_source_into_settings, official_unwrap_response_payload, open_payment_form,
    payload_field, payload_string, run_official_public_json_request,
    run_official_public_json_request_response, upsert_official_settings_session,
    write_settings_json_array, write_settings_json_value, AppState,
};
use api_keys::ensure_official_ai_api_key_in_settings;
#[cfg(test)]
use api_keys::has_official_plaintext_api_key_record;
pub(crate) use cache::{bootstrap_official_auth_session, trigger_official_cached_data_refresh};
#[cfg(test)]
use call_records::value_as_f64;
use call_records::{
    fetch_remote_official_call_records, normalize_official_call_record_items,
    official_response_is_unauthorized, payload_f64, payload_i64, response_error_message,
};
#[cfg(test)]
use call_records::{normalize_official_call_records_value, OFFICIAL_CALL_RECORDS_PAGE_SIZE};
use models::{fetch_official_models_with_recovery, seed_official_models_from_cache};
#[cfg(test)]
use points::normalize_official_points_payload;
use points::{
    cached_official_points, fetch_remote_official_points, official_points_need_silent_refresh,
};
pub(crate) use pricing::refresh_official_pricing_cache;
#[cfg(test)]
use session::session_refresh_window_ms;
use session::{
    merge_session_with_existing, official_session_logged_in, official_session_needs_refresh,
    session_access_token, session_refresh_token, session_refresh_token_app_slug,
};
use settings_sync::{
    clear_official_auth_state, is_official_ai_request, merge_official_settings,
    switch_official_realm, sync_official_route_credentials,
};

fn log_official_auth(state: &State<'_, AppState>, stage: &str, detail: impl Into<String>) {
    append_debug_trace_state(state, format!("[official-auth] {stage} {}", detail.into()));
}

fn cached_official_user(settings: &Value) -> Value {
    official_settings_session(settings)
        .and_then(|session| session.get("user").cloned())
        .unwrap_or_else(|| json!({}))
}

fn force_official_reauth(
    app: &AppHandle,
    state: &State<'_, AppState>,
    expected_generation: Option<u64>,
    source: &str,
) {
    let mut settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))
        .unwrap_or_else(|_| json!({}));
    clear_official_auth_state(&mut settings);
    let _ =
        apply_official_settings_update(app, state, &settings, source, None, expected_generation);
    let _ = auth::mark_auth_reauth_required(app, state, "登录失效，请重新登录");
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
                force_official_reauth(app, state, Some(generation), "official-ai-reauth");
                Err("登录失效，请重新登录".to_string())
            }
        }
        Err(error) => {
            log_official_auth(
                state,
                "ai-401-refresh-failed",
                format!("url={request_url} error={error}"),
            );
            force_official_reauth(app, state, Some(generation), "official-ai-reauth");
            Err("登录失效，请重新登录".to_string())
        }
    }
}

fn refresh_official_auth_session_in_settings(settings: &mut Value) -> Result<Value, String> {
    let refresh_token =
        session_refresh_token(settings).ok_or_else(|| "当前会话缺少 refresh token".to_string())?;
    if let Some(app_slug) = session_refresh_token_app_slug(settings) {
        if app_slug != app_brand_slug() {
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
                    last_error = Some(response_error_message(&response.body));
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
                        last_error = Some(error);
                    }
                }
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "刷新登录态失败".to_string()))
}

fn should_suppress_refresh_error(error: &str) -> bool {
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
    if kind == auth::AuthErrorKind::ReauthRequired {
        clear_official_auth_state(settings);
        let _ = apply_official_settings_update(
            app,
            state,
            settings,
            "official-auth-refresh-failed",
            None,
            expected_generation,
        );
        let _ = auth::mark_auth_reauth_required(app, state, error);
        return;
    }
    if should_suppress_refresh_error(&error) {
        return;
    }
    let _ = auth::mark_auth_degraded(app, state, error, kind);
}

fn apply_official_settings_update(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &Value,
    source: &str,
    data_payload: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    if let Some(expected_generation) = expected_generation {
        let matches = auth::auth_generation_matches(state, expected_generation)?;
        if !matches {
            log_official_auth(
                state,
                "stale-update-dropped",
                format!("source={source} expectedGeneration={expected_generation}"),
            );
            return Err("auth generation changed; stale update dropped".to_string());
        }
    }
    let mut next_settings = settings.clone();
    let model_config_exists =
        crate::ai_model_manager::legacy_config::model_config_path(&state.store_path).exists();
    let model_defaults_initialized = crate::model_defaults_initialized(&next_settings);
    let mut should_sync_model_config = model_config_exists || model_defaults_initialized;
    if !model_config_exists && !model_defaults_initialized {
        match crate::fetch_official_default_model_slots_for_settings(&next_settings) {
            Ok(default_slots) => {
                let catalog_models = official_settings_models(&next_settings);
                should_sync_model_config = crate::seed_official_default_models_into_settings(
                    &mut next_settings,
                    &default_slots,
                    &catalog_models,
                );
            }
            Err(error) => {
                log_official_auth(
                    state,
                    "default-models-fetch-failed",
                    format!("source={source} error={error}"),
                );
            }
        }
    }
    match crate::ai_model_manager::defaults::repair_missing_official_defaults_in_settings(
        &mut next_settings,
    ) {
        Ok(repaired) => {
            should_sync_model_config = should_sync_model_config || repaired;
        }
        Err(error) => {
            log_official_auth(
                state,
                "default-models-repair-failed",
                format!("source={source} error={error}"),
            );
        }
    }
    let merged_settings = with_store_mut(state, |store| {
        Ok(settings_store::update_settings(store, |settings| {
            merge_official_settings(settings, &next_settings);
            crate::ai_model_manager::legacy_projection::normalize_settings_projection(settings);
        }))
    })?;
    if should_sync_model_config {
        if let Err(error) = crate::ai_model_manager::store::sync_model_config_file(
            &state.store_path,
            &merged_settings,
        ) {
            log_official_auth(
                state,
                "model-config-sync-failed",
                format!("source={source} error={error}"),
            );
        }
    }
    let _ = auth::sync_auth_runtime_from_settings(Some(app), state, &merged_settings);
    let _ = app.emit(
        "settings:updated",
        json!({
            "updatedAt": now_iso(),
            "source": source,
        }),
    );
    emit_redbox_auth_session_updated(app, official_settings_session(&merged_settings));
    if let Some(payload) = data_payload {
        emit_redbox_auth_data_updated(app, payload);
    }
    Ok(())
}

fn refresh_official_auth_session_with_lock(
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
    let _ = auth::mark_auth_refreshing(app, state);
    let latest_settings = with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    merge_official_settings(settings, &latest_settings);

    if official_settings_session(settings).is_none() {
        log_official_auth(state, "refresh-abort", "no session in settings");
        return Err("官方账号未登录".to_string());
    }
    if !force && !official_session_needs_refresh(settings) {
        log_official_auth(state, "refresh-skip", "session does not need refresh");
        return Ok(official_settings_session(settings));
    }

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

fn run_authenticated_official_request_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    preflight_refresh: bool,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
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
        return Ok(response.body);
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
        return Ok(retry.body);
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

fn run_authenticated_official_request(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
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

fn run_authenticated_official_request_skip_preflight_refresh(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
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

pub fn handle_official_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if channel == "auth:get-state" {
        return Some(
            serde_json::to_value(auth::auth_state_snapshot(state).unwrap_or_default())
                .map_err(|error| error.to_string()),
        );
    }
    let channel = match channel {
        "auth:login-sms" => "redbox-auth:login-sms",
        "auth:login-wechat-start" => "redbox-auth:wechat-url",
        "auth:login-wechat-poll" => "redbox-auth:wechat-status",
        "auth:logout" => "redbox-auth:logout",
        "auth:refresh-now" => "redbox-auth:refresh",
        _ => channel,
    };
    let request_generation = auth::auth_generation(state).ok();

    auth_flow::handle_auth_channel(app, state, channel, payload, request_generation)
        .or_else(|| {
            account::handle_account_channel(app, state, channel, payload, request_generation)
        })
        .or_else(|| {
            api_keys::handle_api_keys_channel(app, state, channel, payload, request_generation)
        })
        .or_else(|| {
            billing::handle_billing_channel(app, state, channel, payload, request_generation)
        })
        .or_else(|| models::handle_models_channel(app, state, channel, payload, request_generation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_official_call_record_items_maps_legacy_fields() {
        let records = normalize_official_call_record_items(&[json!({
            "id": "call-1",
            "model": "qwen3.5-plus",
            "points_cost": 0.01,
            "time": "2026-04-16T05:55:28.198Z",
            "token": 0,
        })]);
        assert_eq!(records.len(), 1);
        assert_eq!(payload_string(&records[0], "id").as_deref(), Some("call-1"));
        assert_eq!(
            payload_string(&records[0], "model").as_deref(),
            Some("qwen3.5-plus")
        );
        assert_eq!(records[0].get("points").and_then(value_as_f64), Some(0.01));
        assert_eq!(records[0].get("tokens").and_then(value_as_f64), Some(0.0));
        assert_eq!(
            payload_string(&records[0], "createdAt").as_deref(),
            Some("2026-04-16T05:55:28.198Z")
        );
    }

    #[test]
    fn normalize_official_call_records_value_extracts_nested_records() {
        let records = normalize_official_call_records_value(&json!({
            "success": true,
            "data": {
                "records": [
                    {
                        "request_id": "req-1",
                        "model_name": "gpt-4.1",
                        "cost_points": 1.25,
                        "total_tokens": 321,
                        "created_at": "2026-04-16T06:00:00Z"
                    }
                ]
            }
        }));
        assert_eq!(records.len(), 1);
        assert_eq!(payload_string(&records[0], "id").as_deref(), Some("req-1"));
        assert_eq!(records[0].get("points").and_then(value_as_f64), Some(1.25));
        assert_eq!(records[0].get("tokens").and_then(value_as_f64), Some(321.0));
    }

    #[test]
    fn normalize_official_call_records_value_merges_multiple_payload_arrays() {
        let records = normalize_official_call_records_value(&json!({
            "data": {
                "records": [
                    {
                        "request_id": "req-1",
                        "model_name": "gpt-4.1",
                        "cost_points": 1.25,
                        "total_tokens": 321,
                        "created_at": "2026-04-16T06:00:00Z"
                    }
                ],
                "logs": [
                    {
                        "log_id": "req-2",
                        "model": "gpt-4.1-mini",
                        "points_cost": 0.5,
                        "token": 120,
                        "time": "2026-04-16T07:00:00Z"
                    }
                ]
            }
        }));

        assert_eq!(records.len(), 2);
        assert_eq!(payload_string(&records[0], "id").as_deref(), Some("req-2"));
        assert_eq!(payload_string(&records[1], "id").as_deref(), Some("req-1"));
    }

    #[test]
    fn normalize_official_call_record_items_sorts_desc_and_limits_page_size() {
        let items = (0..35)
            .map(|index| {
                json!({
                    "id": format!("record-{index:02}"),
                    "model": "qwen3.5-flash",
                    "points_cost": 0.1,
                    "token": 100,
                    "created_at": 1_776_000_000_000_i64 + (index * 1000),
                })
            })
            .collect::<Vec<_>>();

        let records = normalize_official_call_record_items(&items);

        assert_eq!(records.len(), OFFICIAL_CALL_RECORDS_PAGE_SIZE);
        assert_eq!(
            payload_string(&records[0], "id").as_deref(),
            Some("record-34")
        );
        assert_eq!(
            payload_string(&records[OFFICIAL_CALL_RECORDS_PAGE_SIZE - 1], "id").as_deref(),
            Some("record-05")
        );
    }

    #[test]
    fn normalize_official_call_record_items_sorts_string_times_desc() {
        let records = normalize_official_call_record_items(&[
            json!({
                "id": "early",
                "model": "qwen3.5-flash",
                "created_at": "2026-05-20T21:33:40Z",
            }),
            json!({
                "id": "latest",
                "model": "qwen3.5-plus",
                "created_at": "2026-05-22T10:49:58Z",
            }),
            json!({
                "id": "middle",
                "model": "qwen3.5-plus",
                "created_at": "2026-05-21T12:47:12Z",
            }),
        ]);

        assert_eq!(payload_string(&records[0], "id").as_deref(), Some("latest"));
        assert_eq!(payload_string(&records[1], "id").as_deref(), Some("middle"));
        assert_eq!(payload_string(&records[2], "id").as_deref(), Some("early"));
    }

    #[test]
    fn session_without_expiry_but_with_refresh_token_does_not_force_refresh() {
        let settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
                "createdAt": now_ms() as i64,
            }))
            .unwrap(),
        });

        assert!(!official_session_needs_refresh(&settings));
    }

    #[test]
    fn session_refresh_window_uses_twenty_percent_with_bounds() {
        let created_at = 1_000_000_i64;
        let settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
                "createdAt": created_at,
                "expiresAt": created_at + (30 * 60 * 1000),
            }))
            .unwrap(),
        });

        assert_eq!(session_refresh_window_ms(&settings), 5 * 60_000);
    }

    #[test]
    fn unauthorized_detection_accepts_http_status_and_error_message() {
        assert!(official_response_is_unauthorized(401, &json!({})));
        assert!(official_response_is_unauthorized(
            200,
            &json!({
                "success": false,
                "message": "Access token expired, please login again",
            })
        ));
        assert!(!official_response_is_unauthorized(
            200,
            &json!({
                "success": false,
                "message": "network timeout",
            })
        ));
    }

    #[test]
    fn normalize_official_points_payload_maps_balance_response() {
        let normalized = normalize_official_points_payload(&json!({
            "app_id": "app-1",
            "user_id": "user-1",
            "balance": 1296.06,
            "total_earned": 4970,
            "total_spent": 3673.94,
            "updated_at": "2026-04-17T02:26:18.038Z",
            "pricing": {
                "unit": "points",
                "points_per_yuan": 100
            }
        }))
        .expect("points payload should normalize");

        assert_eq!(
            normalized.get("balance").and_then(value_as_f64),
            Some(1296.06)
        );
        assert_eq!(
            normalized.get("points").and_then(value_as_f64),
            Some(1296.06)
        );
        assert_eq!(
            normalized
                .pointer("/pricing/points_per_yuan")
                .and_then(value_as_f64),
            Some(100.0)
        );
    }

    #[test]
    fn cached_official_points_ignores_unauthorized_error_payload() {
        let settings = json!({
            "redbox_auth_points_json": serde_json::to_string(&json!({
                "code": 401,
                "message": "Token expired",
            }))
            .unwrap(),
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "user": {
                    "pointsBalance": 88.5
                }
            }))
            .unwrap(),
        });

        let cached = cached_official_points(&settings);
        assert_eq!(cached.get("balance").and_then(value_as_f64), Some(88.5));
        assert_eq!(cached.get("points").and_then(value_as_f64), Some(88.5));
    }

    #[test]
    fn sync_official_route_credentials_uses_normalized_official_base_url() {
        let official_cn_base_url = official_base_url_for_realm("cn");
        let mut settings = json!({
            "redbox_official_base_url": "https://api.ziz.hk",
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-1",
                "apiKey": "rbx-live-1",
            }))
            .unwrap(),
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "redbox_official_auto",
                "baseURL": "",
                "apiKey": ""
            })])
            .unwrap(),
        });

        sync_official_route_credentials(&mut settings);

        assert_eq!(
            payload_string(&settings, "api_endpoint").as_deref(),
            Some(official_cn_base_url.as_str())
        );
        assert_eq!(
            payload_string(&settings, "api_key").as_deref(),
            Some("rbx-live-1")
        );
        let sources = payload_string(&settings, "ai_sources_json")
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();
        assert_eq!(
            sources
                .first()
                .and_then(|item| payload_string(item, "baseURL"))
                .as_deref(),
            Some(official_cn_base_url.as_str())
        );
        assert_eq!(
            sources
                .first()
                .and_then(|item| payload_string(item, "apiKey"))
                .as_deref(),
            Some("rbx-live-1")
        );
    }

    #[test]
    fn redacted_api_key_record_is_not_enough_for_ai_requests() {
        let redacted_only = json!({
            "redbox_auth_api_keys_json": serde_json::to_string(&vec![json!({
                "id": "key-1",
                "key_prefix": "rbx",
                "key_last4": "1234",
                "isCurrent": true
            })]).unwrap()
        });
        let with_plaintext = json!({
            "redbox_auth_api_keys_json": serde_json::to_string(&vec![json!({
                "id": "key-1",
                "key_prefix": "rbx",
                "key_last4": "1234",
                "apiKey": "rbx-live-1",
                "isCurrent": true
            })]).unwrap()
        });

        assert!(!has_official_plaintext_api_key_record(&redacted_only));
        assert!(has_official_plaintext_api_key_record(&with_plaintext));
    }

    #[test]
    fn switch_official_realm_sets_global_endpoint_without_reusing_cn_session() {
        let official_global_base_url = official_base_url_for_realm("global");
        let mut settings = json!({
            "redbox_official_realm": "cn",
            "redbox_official_base_url": "https://api.ziz.hk",
            "redbox_auth_session_json": "",
            "api_endpoint": official_base_url_for_realm("cn"),
            "api_key": "",
        });

        switch_official_realm(&mut settings, "global").expect("switch realm");

        assert_eq!(
            payload_string(&settings, "redbox_official_realm").as_deref(),
            Some("global")
        );
        assert_eq!(
            payload_string(&settings, "redbox_official_base_url").as_deref(),
            Some(official_global_base_url.as_str())
        );
        assert_eq!(
            payload_string(&settings, "api_endpoint").as_deref(),
            Some(official_global_base_url.as_str())
        );
        assert!(official_settings_session(&settings).is_none());
    }

    #[test]
    fn switch_official_realm_requires_logout() {
        let mut settings = json!({
            "redbox_official_realm": "cn",
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
            }))
            .unwrap(),
        });

        assert!(switch_official_realm(&mut settings, "global").is_err());
        assert_eq!(
            payload_string(&settings, "redbox_official_realm").as_deref(),
            Some("cn")
        );
    }

    #[test]
    fn refresh_official_auth_rejects_legacy_redbox_refresh_token_before_http() {
        use base64::Engine;

        let incompatible_slug = if app_brand_slug() == "redbox" {
            "thrive"
        } else {
            "redbox"
        };
        let token_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
            r#"{{"appSlug":"{incompatible_slug}","type":"refresh"}}"#
        ));
        let token = format!("header.{token_payload}.signature");
        let mut settings = json!({
            "redbox_official_realm": "cn",
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "refreshToken": token,
            }))
            .unwrap(),
        });

        let error = refresh_official_auth_session_in_settings(&mut settings)
            .expect_err("legacy token should be rejected locally");
        assert!(error.contains(&format!(
            "旧账号体系登录态不可用于 {}",
            app_brand_display_name()
        )));
        assert_eq!(
            session_refresh_token_app_slug(&settings).as_deref(),
            Some(incompatible_slug)
        );
    }

    #[test]
    fn merge_official_settings_preserves_custom_default_route_from_stale_update() {
        let official_cn_base_url = official_base_url_for_realm("cn");
        let mut settings = json!({
            "default_ai_source_id": "custom-source",
            "api_endpoint": "https://custom.example/v1",
            "api_key": "custom-key",
            "model_name": "custom-model",
            "model_name_wander": "custom-wander",
            "ai_sources_json": serde_json::to_string(&vec![
                json!({
                    "id": "redbox_official_auto",
                    "name": format!("{} Official", app_brand_display_name()),
                    "presetId": "redbox-official",
                    "baseURL": official_cn_base_url,
                    "apiKey": "",
                    "model": "qwen3.5-plus",
                    "models": ["qwen3.5-plus"],
                    "protocol": "openai",
                }),
                json!({
                    "id": "custom-source",
                    "name": "Custom",
                    "presetId": "custom",
                    "baseURL": "https://custom.example/v1",
                    "apiKey": "custom-key",
                    "model": "custom-model",
                    "models": ["custom-model"],
                    "protocol": "openai",
                }),
            ])
            .unwrap(),
        });
        let stale_official_update = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-2",
                "apiKey": "official-key",
            }))
            .unwrap(),
            "default_ai_source_id": "redbox_official_auto",
            "api_endpoint": official_base_url_for_realm("cn"),
            "api_key": "official-key",
            "model_name": "gpt-5.5",
            "model_name_wander": "",
            "video_api_key": "official-key",
            "redbox_official_models_json": serde_json::to_string(&vec![json!({
                "id": "gpt-5.5",
                "capabilities": ["chat"],
            })])
            .unwrap(),
            "ai_sources_json": serde_json::to_string(&vec![json!({
                "id": "redbox_official_auto",
                "name": format!("{} Official", app_brand_display_name()),
                "presetId": "redbox-official",
                "baseURL": official_base_url_for_realm("cn"),
                "apiKey": "official-key",
                "model": "gpt-5.5",
                "models": ["gpt-5.5"],
                "protocol": "openai",
            })])
            .unwrap(),
        });

        merge_official_settings(&mut settings, &stale_official_update);

        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("custom-source")
        );
        assert_eq!(
            payload_string(&settings, "api_endpoint").as_deref(),
            Some("https://custom.example/v1")
        );
        assert_eq!(
            payload_string(&settings, "api_key").as_deref(),
            Some("custom-key")
        );
        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("custom-model")
        );
        assert_eq!(
            payload_string(&settings, "model_name_wander").as_deref(),
            Some("custom-wander")
        );
        assert_eq!(
            payload_string(&settings, "video_api_key").as_deref(),
            Some("official-key")
        );

        let sources = payload_string(&settings, "ai_sources_json")
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();
        assert!(sources
            .iter()
            .any(|item| payload_string(item, "id").as_deref() == Some("custom-source")));
        let official_source = sources
            .iter()
            .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        assert_eq!(
            payload_string(&official_source, "apiKey").as_deref(),
            Some("official-key")
        );
        assert_eq!(
            payload_string(&official_source, "model").as_deref(),
            Some("gpt-5.5")
        );
    }

    #[test]
    fn official_account_summary_separates_login_state_and_ai_key_presence() {
        let settings = json!({
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
                "apiKey": "rbx-live-1",
                "user": {
                    "name": "Jam"
                }
            }))
            .unwrap(),
        });

        let summary = official_account_summary_local(&settings, &[]);
        assert_eq!(summary.get("loggedIn").and_then(Value::as_bool), Some(true));
        assert_eq!(
            summary.get("apiKeyPresent").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            summary.get("displayName").and_then(Value::as_str),
            Some("Jam")
        );
    }

    #[test]
    fn clear_official_auth_state_resets_official_source_and_falls_back_default_source() {
        let official_cn_base_url = official_base_url_for_realm("cn");
        let mut settings = json!({
            "redbox_official_base_url": "https://api.ziz.hk",
            "redbox_auth_session_json": serde_json::to_string(&json!({
                "accessToken": "access-1",
                "apiKey": "official-token",
            }))
            .unwrap(),
            "ai_sources_json": serde_json::to_string(&vec![
                json!({
                    "id": "redbox_official_auto",
                    "name": format!("{} Official", app_brand_display_name()),
                    "presetId": "redbox-official",
                    "baseURL": official_cn_base_url,
                    "apiKey": "official-token",
                    "models": ["qwen3.5-plus"],
                    "modelsMeta": [{ "id": "qwen3.5-plus" }],
                    "model": "qwen3.5-plus",
                    "protocol": "openai",
                }),
                json!({
                    "id": "openai-main",
                    "name": "OpenAI",
                    "presetId": "openai",
                    "baseURL": "https://api.openai.com/v1",
                    "apiKey": "sk-test",
                    "models": ["gpt-5.3-codex"],
                    "model": "gpt-5.3-codex",
                    "protocol": "openai",
                }),
            ])
            .unwrap(),
            "default_ai_source_id": "redbox_official_auto",
            "api_endpoint": official_base_url_for_realm("cn"),
            "api_key": "official-token",
            "model_name": "qwen3.5-plus",
            "video_api_key": "official-token",
        });

        clear_official_auth_state(&mut settings);

        assert_eq!(
            payload_string(&settings, "default_ai_source_id").as_deref(),
            Some("openai-main")
        );
        assert_eq!(
            payload_string(&settings, "api_endpoint").as_deref(),
            Some("https://api.openai.com/v1")
        );
        assert_eq!(
            payload_string(&settings, "api_key").as_deref(),
            Some("sk-test")
        );
        assert_eq!(
            payload_string(&settings, "model_name").as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(payload_string(&settings, "video_api_key").as_deref(), None);

        let sources = payload_string(&settings, "ai_sources_json")
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_default();
        let official_source = sources
            .iter()
            .find(|item| payload_string(item, "id").as_deref() == Some("redbox_official_auto"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        assert_eq!(payload_string(&official_source, "apiKey").as_deref(), None);
        assert_eq!(payload_string(&official_source, "model").as_deref(), None);
        assert_eq!(
            official_source
                .get("models")
                .and_then(|value| value.as_array())
                .map(|items| items.len()),
            Some(0)
        );
        assert_eq!(
            official_source
                .get("modelsMeta")
                .and_then(|value| value.as_array())
                .map(|items| items.len()),
            Some(0)
        );
    }

    #[test]
    fn refresh_flow_prefers_public_refresh_route_shape() {
        let refresh_token = "refresh-1";
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

        assert_eq!(request_candidates[0].0, "/auth/refresh");
        assert_eq!(
            payload_string(&request_candidates[0].1, "refresh_token").as_deref(),
            Some("refresh-1")
        );
        assert!(request_candidates
            .iter()
            .all(|(path, _)| *path != "/auth/token/refresh"));
    }
}
