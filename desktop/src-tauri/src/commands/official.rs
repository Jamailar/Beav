mod account;
mod api_keys;
mod auth_flow;
mod auth_refresh;
mod billing;
mod cache;
mod call_records;
mod capture;
mod models;
mod points;
mod pricing;
mod request;
mod session;
mod settings_sync;
mod settings_update;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[cfg(test)]
use crate::official_base_url_for_realm;
use crate::persistence::{with_store, with_store_mut};
use crate::{
    app_brand_display_name, app_brand_slug, append_debug_trace_state, auth,
    emit_redbox_auth_session_updated, make_id, normalize_official_auth_session,
    normalize_official_model_catalog, now_iso, now_ms, official_access_token_from_settings,
    official_account_summary_local, official_ai_api_key_from_settings, official_fallback_products,
    official_realm_from_settings, official_realms_payload, official_response_items,
    official_settings_api_keys, official_settings_call_records_list, official_settings_models,
    official_settings_orders, official_settings_pricing, official_settings_session,
    official_settings_wechat_login, official_sync_source_into_settings,
    official_unwrap_response_payload, open_payment_form, payload_field, payload_string,
    run_official_public_json_request, run_official_public_json_request_response,
    upsert_official_settings_session, write_settings_json_array, write_settings_json_value,
    AppState,
};
use api_keys::ensure_official_ai_api_key_in_settings;
#[cfg(test)]
use api_keys::has_official_plaintext_api_key_record;
pub(crate) use auth_refresh::refresh_official_auth_for_ai_request;
#[cfg(test)]
use auth_refresh::refresh_official_auth_session_in_settings;
use auth_refresh::{force_official_reauth, refresh_official_auth_session_with_lock};
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
use request::run_authenticated_official_request;
pub(crate) use request::run_authenticated_official_request_response;
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
use settings_update::apply_official_settings_update;

fn log_official_auth(state: &State<'_, AppState>, stage: &str, detail: impl Into<String>) {
    append_debug_trace_state(state, format!("[official-auth] {stage} {}", detail.into()));
}

fn cached_official_user(settings: &Value) -> Value {
    official_settings_session(settings)
        .and_then(|session| session.get("user").cloned())
        .unwrap_or_else(|| json!({}))
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
        .or_else(|| {
            capture::handle_capture_channel(app, state, channel, payload, request_generation)
        })
        .or_else(|| models::handle_models_channel(app, state, channel, payload, request_generation))
}

#[cfg(test)]
#[path = "official/tests.rs"]
mod tests;
