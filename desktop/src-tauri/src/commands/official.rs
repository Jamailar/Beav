use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::persistence::{with_store, with_store_mut};
use crate::{
    append_debug_trace_state, auth, create_official_payment_form, emit_redbox_auth_data_updated,
    emit_redbox_auth_session_updated, fetch_official_models_for_settings, make_id,
    normalize_base_url, normalize_official_auth_session, now_iso, now_ms,
    official_account_summary_local, official_ai_api_key_from_settings,
    official_base_url_from_settings, official_fallback_products, official_points_snapshot,
    official_response_items, official_settings_api_keys, official_settings_call_records_list,
    official_settings_models, official_settings_orders, official_settings_points,
    official_settings_session, official_settings_wechat_login, official_sync_source_into_settings,
    official_unwrap_response_payload, open_payment_form, payload_field, payload_string,
    run_official_public_json_request, run_official_public_json_request_response,
    upsert_official_settings_session, write_settings_json_array, write_settings_json_value,
    AppState, REDBOX_OFFICIAL_BASE_URL,
};

const OFFICIAL_SESSION_MIN_REFRESH_WINDOW_MS: i64 = 60_000;
const OFFICIAL_SESSION_MAX_REFRESH_WINDOW_MS: i64 = 5 * 60_000;
const OFFICIAL_POINTS_SILENT_REFRESH_INTERVAL_MS: i64 = 60_000;
const OFFICIAL_SETTINGS_SYNC_KEYS: [&str; 19] = [
    "redbox_auth_session_json",
    "redbox_auth_api_keys_json",
    "redbox_auth_orders_json",
    "redbox_auth_points_json",
    "redbox_official_models_json",
    "redbox_auth_call_records_json",
    "redbox_auth_wechat_login_json",
    "ai_sources_json",
    "default_ai_source_id",
    "api_endpoint",
    "api_key",
    "model_name",
    "model_name_wander",
    "model_name_chatroom",
    "model_name_knowledge",
    "model_name_redclaw",
    "video_endpoint",
    "video_api_key",
    "video_model",
];

fn log_official_auth(state: &State<'_, AppState>, stage: &str, detail: impl Into<String>) {
    append_debug_trace_state(state, format!("[official-auth] {stage} {}", detail.into()));
}

fn cached_official_user(settings: &Value) -> Value {
    official_settings_session(settings)
        .and_then(|session| session.get("user").cloned())
        .unwrap_or_else(|| json!({}))
}

fn normalize_official_points_payload(payload: &Value) -> Option<Value> {
    if !payload.is_object() || official_response_is_unauthorized(200, payload) {
        return None;
    }

    let balance = [
        "points",
        "balance",
        "pointsBalance",
        "current_points",
        "currentPoints",
        "available_points",
        "availablePoints",
    ]
    .into_iter()
    .find_map(|key| payload_f64(payload, key));
    let total_earned =
        payload_f64(payload, "total_earned").or_else(|| payload_f64(payload, "totalEarned"));
    let total_spent =
        payload_f64(payload, "total_spent").or_else(|| payload_f64(payload, "totalSpent"));

    if balance.is_none() && total_earned.is_none() && total_spent.is_none() {
        return None;
    }

    let balance = balance.unwrap_or(0.0);
    let pricing_source = payload.get("pricing");
    let points_per_yuan = pricing_source
        .and_then(|value| payload_f64(value, "points_per_yuan"))
        .or_else(|| pricing_source.and_then(|value| payload_f64(value, "pointsPerYuan")))
        .or_else(|| payload_f64(payload, "points_per_yuan"))
        .or_else(|| payload_f64(payload, "pointsPerYuan"))
        .unwrap_or(100.0);
    let refreshed_at_ms = payload_i64(payload, "refreshedAtMs").unwrap_or_else(|| now_ms() as i64);
    let refreshed_at = payload_string(payload, "refreshedAt").unwrap_or_else(now_iso);
    let pricing = json!({
        "unit": pricing_source
            .and_then(|value| payload_string(value, "unit"))
            .unwrap_or_else(|| "points".to_string()),
        "rules": pricing_source
            .and_then(|value| value.get("rules").cloned())
            .unwrap_or_else(|| json!({})),
        "text_chat_cost": pricing_source
            .and_then(|value| payload_field(value, "text_chat_cost").cloned())
            .unwrap_or(Value::Null),
        "voice_chat_cost": pricing_source
            .and_then(|value| payload_field(value, "voice_chat_cost").cloned())
            .unwrap_or(Value::Null),
        "points_per_yuan": points_per_yuan,
    });

    Some(json!({
        "points": balance,
        "balance": balance,
        "pointsBalance": balance,
        "currentPoints": balance,
        "availablePoints": balance,
        "totalEarned": total_earned,
        "totalSpent": total_spent,
        "appId": payload_string(payload, "app_id"),
        "userId": payload_string(payload, "user_id"),
        "sourceUpdatedAt": payload_string(payload, "sourceUpdatedAt")
            .or_else(|| payload_string(payload, "updated_at"))
            .or_else(|| payload_string(payload, "updatedAt")),
        "refreshedAt": refreshed_at,
        "refreshedAtMs": refreshed_at_ms,
        "pricing": pricing,
    }))
}

fn cached_official_points(settings: &Value) -> Value {
    official_settings_points(settings)
        .and_then(|payload| normalize_official_points_payload(&payload))
        .unwrap_or_else(|| {
            normalize_official_points_payload(&official_points_snapshot(settings))
                .unwrap_or_else(|| official_points_snapshot(settings))
        })
}

fn official_points_need_silent_refresh(settings: &Value) -> bool {
    if !official_session_logged_in(settings) {
        return false;
    }

    match official_settings_points(settings)
        .and_then(|payload| normalize_official_points_payload(&payload))
    {
        Some(points) => match payload_i64(&points, "refreshedAtMs") {
            Some(refreshed_at) if refreshed_at > 0 => {
                (now_ms() as i64).saturating_sub(refreshed_at)
                    >= OFFICIAL_POINTS_SILENT_REFRESH_INTERVAL_MS
            }
            _ => true,
        },
        None => true,
    }
}

fn session_access_token(settings: &Value) -> Option<String> {
    official_settings_session(settings)
        .and_then(|session| {
            payload_string(&session, "accessToken")
                .or_else(|| payload_string(&session, "access_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn session_created_at(settings: &Value) -> Option<i64> {
    official_settings_session(settings).and_then(|session| {
        session
            .get("createdAt")
            .or_else(|| session.get("updatedAt"))
            .and_then(value_as_i64)
    })
}

fn session_refresh_window_ms(settings: &Value) -> i64 {
    let expires_at = session_expires_at(settings).unwrap_or_default();
    let created_at = session_created_at(settings).unwrap_or_else(|| (now_ms() as i64) - 900_000);
    let ttl_ms = expires_at.saturating_sub(created_at);
    let dynamic_window = ttl_ms / 5;
    dynamic_window.clamp(
        OFFICIAL_SESSION_MIN_REFRESH_WINDOW_MS,
        OFFICIAL_SESSION_MAX_REFRESH_WINDOW_MS,
    )
}

fn session_refresh_deadline(settings: &Value) -> Option<i64> {
    session_expires_at(settings).map(|expires_at| expires_at - session_refresh_window_ms(settings))
}

fn official_session_recoverable(settings: &Value) -> bool {
    session_refresh_token(settings).is_some()
}

fn official_session_logged_in(settings: &Value) -> bool {
    session_access_token(settings).is_some() || official_session_recoverable(settings)
}

fn upsert_session_api_key(session: &mut Value, api_key: &str) {
    let normalized = api_key.trim();
    if normalized.is_empty() {
        return;
    }
    if let Some(object) = session.as_object_mut() {
        object.insert("apiKey".to_string(), json!(normalized));
        object.insert("updatedAt".to_string(), json!(now_ms() as i64));
    }
}

fn extract_official_api_key_value(response: &Value) -> Option<String> {
    let payload = official_unwrap_response_payload(response);
    payload_string(&payload, "key")
        .or_else(|| payload_string(&payload, "api_key"))
        .or_else(|| {
            payload
                .get("api_key")
                .and_then(|value| payload_string(value, "key"))
        })
        .or_else(|| {
            payload
                .get("apiKey")
                .and_then(|value| payload_string(value, "key"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn normalize_official_api_key_record(response: &Value) -> Option<Value> {
    let payload = official_unwrap_response_payload(response);
    let api_key = payload
        .get("api_key")
        .cloned()
        .or_else(|| payload.get("apiKey").cloned())?;
    Some(json!({
        "id": payload_string(&api_key, "id").unwrap_or_default(),
        "name": payload_string(&api_key, "name").unwrap_or_else(|| "Default API Key".to_string()),
        "key_prefix": payload_string(&api_key, "key_prefix")
            .or_else(|| payload_string(&api_key, "keyPrefix"))
            .unwrap_or_default(),
        "key_last4": payload_string(&api_key, "key_last4")
            .or_else(|| payload_string(&api_key, "keyLast4"))
            .unwrap_or_default(),
        "is_active": payload_field(&api_key, "is_active")
            .or_else(|| payload_field(&api_key, "isActive"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "created_at": payload_field(&api_key, "created_at")
            .cloned()
            .or_else(|| payload_field(&api_key, "createdAt").cloned())
            .unwrap_or_else(|| json!(now_iso())),
        "last_used_at": payload_field(&api_key, "last_used_at")
            .cloned()
            .or_else(|| payload_field(&api_key, "lastUsedAt").cloned())
            .unwrap_or(Value::Null),
    }))
}

fn merge_official_api_key_records(settings: &mut Value, record: Option<Value>) {
    let Some(record) = record else {
        return;
    };
    let record_id = payload_string(&record, "id").unwrap_or_default();
    let record_prefix = payload_string(&record, "key_prefix").unwrap_or_default();
    let record_last4 = payload_string(&record, "key_last4").unwrap_or_default();
    let mut keys = official_settings_api_keys(settings);
    if let Some(existing) = keys.iter_mut().find(|item| {
        let id_matches =
            !record_id.is_empty() && payload_string(item, "id").unwrap_or_default() == record_id;
        let prefix_matches = !record_prefix.is_empty()
            && payload_string(item, "key_prefix").unwrap_or_default() == record_prefix;
        let last4_matches = !record_last4.is_empty()
            && payload_string(item, "key_last4").unwrap_or_default() == record_last4;
        id_matches || (prefix_matches && last4_matches)
    }) {
        if let Some(existing_object) = existing.as_object_mut() {
            let new_object = record.as_object().cloned().unwrap_or_default();
            let current_plaintext = existing_object
                .get("apiKey")
                .cloned()
                .unwrap_or(Value::Null);
            *existing_object = new_object;
            if !current_plaintext.is_null() {
                existing_object.insert("apiKey".to_string(), current_plaintext);
            }
        } else {
            *existing = record;
        }
    } else {
        keys.insert(0, record);
    }
    write_settings_json_array(settings, "redbox_auth_api_keys_json", &keys);
}

fn ensure_official_ai_api_key_in_settings(settings: &mut Value) -> Result<Option<String>, String> {
    if let Some(existing) = official_ai_api_key_from_settings(settings) {
        return Ok(Some(existing));
    }
    if let Some(local_plaintext) = official_settings_api_keys(settings)
        .iter()
        .find_map(|item| {
            let is_current = payload_field(item, "isCurrent")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_current {
                payload_string(item, "apiKey")
            } else {
                None
            }
        })
    {
        if let Some(mut session) = official_settings_session(settings) {
            upsert_session_api_key(&mut session, &local_plaintext);
            upsert_official_settings_session(settings, Some(&session));
        }
        sync_official_route_credentials(settings);
        return Ok(Some(local_plaintext));
    }
    let ensure_response = crate::run_official_json_request_response(
        settings,
        "POST",
        "/users/me/api-keys/ensure-default",
        Some(json!({ "name": "Default API Key" })),
    )?;
    let mut resolved_key = extract_official_api_key_value(&ensure_response.body);
    merge_official_api_key_records(
        settings,
        normalize_official_api_key_record(&ensure_response.body),
    );

    if resolved_key.is_none() {
        let created = crate::run_official_json_request_response(
            settings,
            "POST",
            "/users/me/api-keys",
            Some(json!({ "name": format!("RedBox Desktop {}", now_iso()) })),
        )?;
        resolved_key = extract_official_api_key_value(&created.body);
        merge_official_api_key_records(settings, normalize_official_api_key_record(&created.body));
    }

    if let Some(api_key) = resolved_key.clone() {
        if let Some(mut session) = official_settings_session(settings) {
            upsert_session_api_key(&mut session, &api_key);
            upsert_official_settings_session(settings, Some(&session));
        }
        sync_official_route_credentials(settings);
    }

    Ok(resolved_key)
}

fn is_official_ai_request(settings: &Value, request_url: &str, api_key: Option<&str>) -> bool {
    let official_base_url = normalize_base_url(&official_base_url_from_settings(settings));
    let request_url = normalize_base_url(request_url);
    if official_base_url.is_empty() || request_url.is_empty() {
        return false;
    }
    if !request_url.starts_with(&official_base_url) {
        return false;
    }
    let official_token = official_ai_api_key_from_settings(settings).unwrap_or_default();
    let provided_token = api_key.unwrap_or_default().trim();
    !official_token.trim().is_empty()
        && (provided_token.is_empty() || provided_token == official_token)
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|item| item as f64))
        .or_else(|| value.as_u64().map(|item| item as f64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|item| item.trim().parse::<f64>().ok())
        })
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|item| i64::try_from(item).ok()))
        .or_else(|| value.as_f64().map(|item| item as i64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|item| item.trim().parse::<i64>().ok())
        })
}

fn payload_f64(payload: &Value, key: &str) -> Option<f64> {
    payload_field(payload, key).and_then(value_as_f64)
}

fn payload_i64(payload: &Value, key: &str) -> Option<i64> {
    payload_field(payload, key).and_then(value_as_i64)
}

fn response_error_message(response: &Value) -> String {
    for key in ["message", "error", "msg", "detail", "reason"] {
        if let Some(value) = payload_string(response, key).filter(|item| !item.trim().is_empty()) {
            return value;
        }
    }

    if let Some(data) = response.get("data") {
        for key in ["message", "error", "msg", "detail", "reason"] {
            if let Some(value) = payload_string(data, key).filter(|item| !item.trim().is_empty()) {
                return value;
            }
        }
    }

    "登录态已失效".to_string()
}

fn response_code_text(response: &Value) -> String {
    for key in ["code", "errorCode", "error_code", "status", "statusCode"] {
        if let Some(value) = payload_field(response, key) {
            if let Some(code) = value.as_i64() {
                return code.to_string();
            }
            if let Some(code) = value
                .as_str()
                .map(str::trim)
                .filter(|item| !item.is_empty())
            {
                return code.to_string();
            }
        }
    }
    String::new()
}

fn official_response_is_unauthorized(status: u16, response: &Value) -> bool {
    if status == 401 {
        return true;
    }

    let code = response_code_text(response).to_uppercase();
    if matches!(
        code.as_str(),
        "401"
            | "40101"
            | "UNAUTHORIZED"
            | "TOKEN_EXPIRED"
            | "ACCESS_TOKEN_EXPIRED"
            | "AUTH_EXPIRED"
            | "INVALID_GRANT"
    ) {
        return true;
    }

    let message = response_error_message(response).to_lowercase();
    message.contains("invalid_grant")
        || message.contains("token expired")
        || message.contains("refresh token revoked")
        || message.contains("登录过期")
}

fn iso_time_from_value(value: Option<&Value>) -> String {
    match value {
        Some(raw) => raw
            .as_str()
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(now_iso),
        None => now_iso(),
    }
}

fn normalize_official_call_record_items(items: &[Value]) -> Vec<Value> {
    let mut deduped = std::collections::BTreeMap::<String, Value>::new();
    for (index, item) in items.iter().filter(|value| value.is_object()).enumerate() {
        let id = payload_string(item, "id")
            .or_else(|| payload_string(item, "record_id"))
            .or_else(|| payload_string(item, "log_id"))
            .or_else(|| payload_string(item, "request_id"))
            .unwrap_or_else(|| format!("record_{index}"));
        let model = payload_string(item, "model")
            .or_else(|| payload_string(item, "model_name"))
            .or_else(|| payload_string(item, "modelId"))
            .unwrap_or_else(|| "-".to_string());
        let endpoint = payload_string(item, "endpoint")
            .or_else(|| payload_string(item, "path"))
            .or_else(|| payload_string(item, "api"))
            .or_else(|| payload_string(item, "method"))
            .unwrap_or_else(|| "-".to_string());
        let tokens = item
            .get("total_tokens")
            .or_else(|| item.get("tokens"))
            .or_else(|| item.get("token"))
            .or_else(|| item.get("usage_tokens"))
            .and_then(value_as_f64)
            .unwrap_or(0.0);
        let points = item
            .get("points")
            .or_else(|| item.get("points_cost"))
            .or_else(|| item.get("cost_points"))
            .or_else(|| item.get("cost"))
            .and_then(value_as_f64)
            .unwrap_or(0.0);
        let status = payload_string(item, "status")
            .or_else(|| payload_string(item, "state"))
            .unwrap_or_else(|| "success".to_string());
        let created_at = iso_time_from_value(
            item.get("created_at")
                .or_else(|| item.get("createdAt"))
                .or_else(|| item.get("time"))
                .or_else(|| item.get("timestamp")),
        );

        let normalized = json!({
            "id": id,
            "model": model,
            "endpoint": endpoint,
            "tokens": if tokens.is_finite() { tokens } else { 0.0 },
            "points": if points.is_finite() { points } else { 0.0 },
            "status": if status.trim().is_empty() { "success" } else { status.as_str() },
            "createdAt": created_at,
            "raw": item,
        });
        deduped.entry(id).or_insert(normalized);
    }
    deduped.into_values().take(100).collect()
}

fn extract_official_call_record_rows(payload: &Value) -> Vec<Value> {
    const ARRAY_KEYS: [&str; 10] = [
        "items",
        "records",
        "usage_records",
        "call_records",
        "inference_records",
        "logs",
        "list",
        "data",
        "transactions",
        "recent_records",
    ];

    fn collect_rows(node: &Value, rows: &mut Vec<Value>) {
        if let Some(items) = node.as_array() {
            rows.extend(items.iter().filter(|item| item.is_object()).cloned());
            return;
        }

        let Some(object) = node.as_object() else {
            return;
        };

        for key in ARRAY_KEYS {
            let Some(value) = object.get(key) else {
                continue;
            };
            if value.is_array() {
                collect_rows(value, rows);
            } else if value.is_object() {
                collect_rows(value, rows);
            }
        }
    }

    let mut rows = Vec::new();
    collect_rows(payload, &mut rows);
    rows
}

fn normalize_official_call_records_value(value: &Value) -> Vec<Value> {
    let payload = official_unwrap_response_payload(value);
    let items = extract_official_call_record_rows(&payload);
    normalize_official_call_record_items(&items)
}

fn session_refresh_token(settings: &Value) -> Option<String> {
    official_settings_session(settings)
        .and_then(|session| {
            payload_string(&session, "refreshToken")
                .or_else(|| payload_string(&session, "refresh_token"))
        })
        .filter(|value| !value.trim().is_empty())
}

fn session_expires_at(settings: &Value) -> Option<i64> {
    official_settings_session(settings)
        .and_then(|session| session.get("expiresAt").and_then(value_as_i64))
}

fn official_session_needs_refresh(settings: &Value) -> bool {
    if official_settings_session(settings).is_none() {
        return false;
    }

    if session_access_token(settings).is_none() {
        return official_session_recoverable(settings);
    }

    if !official_session_recoverable(settings) {
        return false;
    }

    match session_refresh_deadline(settings) {
        Some(refresh_at) => refresh_at <= now_ms() as i64,
        None => false,
    }
}

fn merge_session_with_existing(existing: Option<&Value>, session: &mut Value) {
    let Some(session_object) = session.as_object_mut() else {
        return;
    };
    let Some(existing_object) = existing.and_then(|value| value.as_object()) else {
        return;
    };

    let user_missing = session_object
        .get("user")
        .map(|value| value.is_null())
        .unwrap_or(true);
    if user_missing {
        if let Some(user) = existing_object.get("user") {
            session_object.insert("user".to_string(), user.clone());
        }
    }

    for key in [
        "refreshToken",
        "apiKey",
        "tokenType",
        "expiresAt",
        "createdAt",
    ] {
        let missing = match session_object.get(key) {
            Some(Value::String(text)) => text.trim().is_empty(),
            Some(Value::Null) => true,
            Some(_) => false,
            None => true,
        };
        if missing {
            if let Some(value) = existing_object.get(key) {
                session_object.insert(key.to_string(), value.clone());
            }
        }
    }

    session_object.insert("updatedAt".to_string(), json!(now_ms() as i64));
}

fn sync_official_route_credentials(settings: &mut Value) {
    let token = official_ai_api_key_from_settings(settings).unwrap_or_default();
    let base_url = official_base_url_from_settings(settings);
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let mut changed = false;

    for source in &mut sources {
        let source_id = source
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if source_id != "redbox_official_auto" {
            continue;
        }
        if let Some(object) = source.as_object_mut() {
            object.insert("apiKey".to_string(), json!(token));
            object.insert("baseURL".to_string(), json!(base_url));
            changed = true;
        }
    }

    if let Some(object) = settings.as_object_mut() {
        if changed {
            object.insert(
                "ai_sources_json".to_string(),
                json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
            );
        }
        object.insert("api_key".to_string(), json!(token.clone()));
        object.insert("video_api_key".to_string(), json!(token));
        object.insert("api_endpoint".to_string(), json!(base_url));
    }
}

fn clear_official_source_binding(settings: &mut Value, previous_official_token: &str) {
    let official_base_url = official_base_url_from_settings(settings);
    let normalized_official_base_url = normalize_base_url(&official_base_url);
    let mut fallback_source_id = String::new();
    let mut fallback_base_url = String::new();
    let mut fallback_api_key = String::new();
    let mut fallback_model = String::new();
    let mut sources = payload_string(settings, "ai_sources_json")
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();
    let mut changed = false;

    for source in &mut sources {
        let source_id = source
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if source_id == "redbox_official_auto" {
            if let Some(object) = source.as_object_mut() {
                object.insert("name".to_string(), json!("RedBox Official"));
                object.insert("presetId".to_string(), json!("redbox-official"));
                object.insert("baseURL".to_string(), json!(official_base_url.clone()));
                object.insert("apiKey".to_string(), json!(""));
                object.insert("models".to_string(), json!(Vec::<String>::new()));
                object.insert("modelsMeta".to_string(), json!(Vec::<Value>::new()));
                object.insert("model".to_string(), json!(""));
                object.insert("protocol".to_string(), json!("openai"));
                changed = true;
            }
            continue;
        }

        if fallback_source_id.is_empty() {
            fallback_source_id = source_id;
            fallback_base_url = payload_string(source, "baseURL").unwrap_or_default();
            fallback_api_key = payload_string(source, "apiKey").unwrap_or_default();
            fallback_model = payload_string(source, "model").unwrap_or_default();
        }
    }

    let current_default_source_id =
        payload_string(settings, "default_ai_source_id").unwrap_or_default();
    let current_api_endpoint =
        normalize_base_url(&payload_string(settings, "api_endpoint").unwrap_or_default());
    let current_api_key = payload_string(settings, "api_key").unwrap_or_default();
    let current_video_api_key = payload_string(settings, "video_api_key").unwrap_or_default();
    let should_reset_default_source = current_default_source_id == "redbox_official_auto";
    let should_reset_root_route = should_reset_default_source
        || (!current_api_endpoint.is_empty()
            && current_api_endpoint == normalized_official_base_url)
        || (!previous_official_token.trim().is_empty()
            && current_api_key == previous_official_token);
    let should_clear_video_api_key = !current_video_api_key.is_empty()
        && (should_reset_root_route
            || (!previous_official_token.trim().is_empty()
                && current_video_api_key == previous_official_token));

    if let Some(object) = settings.as_object_mut() {
        if changed {
            object.insert(
                "ai_sources_json".to_string(),
                json!(serde_json::to_string(&sources).unwrap_or_else(|_| "[]".to_string())),
            );
        }

        if should_reset_default_source {
            object.insert(
                "default_ai_source_id".to_string(),
                json!(if fallback_source_id.is_empty() {
                    "redbox_official_auto".to_string()
                } else {
                    fallback_source_id.clone()
                }),
            );
        }

        if should_reset_root_route {
            if fallback_source_id.is_empty() {
                object.insert("api_endpoint".to_string(), json!(""));
                object.insert("api_key".to_string(), json!(""));
                object.insert("model_name".to_string(), json!(""));
            } else {
                object.insert("api_endpoint".to_string(), json!(fallback_base_url));
                object.insert("api_key".to_string(), json!(fallback_api_key));
                object.insert("model_name".to_string(), json!(fallback_model));
            }
        }

        if should_clear_video_api_key || should_reset_root_route {
            object.insert("video_api_key".to_string(), json!(""));
        }
    }
}

fn clear_official_auth_state(settings: &mut Value) {
    let previous_official_token = official_ai_api_key_from_settings(settings).unwrap_or_default();
    upsert_official_settings_session(settings, None);
    clear_official_source_binding(settings, &previous_official_token);
    if let Some(object) = settings.as_object_mut() {
        object.insert("redbox_auth_points_json".to_string(), json!(""));
        object.insert("redbox_auth_call_records_json".to_string(), json!("[]"));
        object.insert("redbox_auth_wechat_login_json".to_string(), json!(""));
        object.insert("redbox_official_models_json".to_string(), json!("[]"));
    }
}

fn force_official_reauth(
    app: &AppHandle,
    state: &State<'_, AppState>,
    expected_generation: Option<u64>,
    source: &str,
) {
    let mut settings =
        with_store(state, |store| Ok(store.settings.clone())).unwrap_or_else(|_| json!({}));
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
    let mut settings = with_store(state, |store| Ok(store.settings.clone()))?;
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
            let latest_settings = with_store(state, |store| Ok(store.settings.clone()))?;
            let refreshed_token = official_ai_api_key_from_settings(&latest_settings)
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

fn update_wechat_login_snapshot(settings: &mut Value, session_id: &str, status: &str, raw: &Value) {
    let mut snapshot = official_settings_wechat_login(settings).unwrap_or_else(|| json!({}));
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("sessionId".to_string(), json!(session_id));
        object.insert("status".to_string(), json!(status));
        object.insert("updatedAt".to_string(), json!(now_ms()));
        object.insert("raw".to_string(), raw.clone());
        if status == "CONFIRMED" {
            object.insert("confirmedAt".to_string(), json!(now_ms()));
        }
    }
    write_settings_json_value(settings, "redbox_auth_wechat_login_json", &snapshot);
}

fn merge_official_settings(settings: &mut Value, source: &Value) {
    let Some(target) = settings.as_object_mut() else {
        *settings = source.clone();
        return;
    };
    let source_object = source.as_object().cloned().unwrap_or_default();
    for key in OFFICIAL_SETTINGS_SYNC_KEYS {
        if let Some(value) = source_object.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn refresh_official_auth_session_in_settings(settings: &mut Value) -> Result<Value, String> {
    let refresh_token =
        session_refresh_token(settings).ok_or_else(|| "当前会话缺少 refresh token".to_string())?;
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
    with_store_mut(state, |store| {
        merge_official_settings(&mut store.settings, settings);
        Ok(())
    })?;
    let _ = auth::sync_auth_runtime_from_settings(Some(app), state, settings);
    let _ = app.emit(
        "settings:updated",
        json!({
            "updatedAt": now_iso(),
            "source": source,
        }),
    );
    emit_redbox_auth_session_updated(app, official_settings_session(settings));
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
    let latest_settings = with_store(state, |store| Ok(store.settings.clone()))?;
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

fn fetch_official_models_with_recovery(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    expected_generation: Option<u64>,
) -> Vec<Value> {
    match run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        "/models",
        None,
        expected_generation,
    ) {
        Ok(remote) => {
            let items = official_response_items(&remote);
            if items.is_empty() {
                official_settings_models(settings)
            } else {
                items
            }
        }
        Err(_) => official_settings_models(settings),
    }
}

fn fetch_remote_official_points(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    expected_generation: Option<u64>,
) -> Result<Value, String> {
    let response = run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        "/users/me/points",
        None,
        expected_generation,
    )?;
    let payload = official_unwrap_response_payload(&response);
    normalize_official_points_payload(&payload)
        .ok_or_else(|| "官方积分接口返回了无法识别的数据结构".to_string())
}

fn sync_remote_orders_into_settings(settings: &mut Value, order: &Value) {
    let out_trade_no = payload_string(order, "out_trade_no")
        .or_else(|| payload_string(order, "outTradeNo"))
        .unwrap_or_default();
    if out_trade_no.is_empty() {
        return;
    }
    let mut orders = official_settings_orders(settings);
    let mut updated = false;
    for item in &mut orders {
        let current = payload_string(item, "out_trade_no")
            .or_else(|| payload_string(item, "outTradeNo"))
            .unwrap_or_default();
        if current == out_trade_no {
            *item = order.clone();
            updated = true;
            break;
        }
    }
    if !updated {
        orders.insert(0, order.clone());
    }
    write_settings_json_array(settings, "redbox_auth_orders_json", &orders);
}

fn seed_official_models_from_cache(settings: &mut Value) {
    let models = official_settings_models(settings);
    write_settings_json_array(settings, "redbox_official_models_json", &models);
    if !models.is_empty() {
        official_sync_source_into_settings(settings, &models);
    }
}

fn query_remote_order_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    out_trade_no: &str,
    expected_generation: Option<u64>,
) -> Option<Value> {
    let normalized = out_trade_no.trim();
    if normalized.is_empty() {
        return None;
    }
    let encoded = normalized.replace(' ', "%20");
    let remote = run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        &format!("/payments/orders/status?out_trade_no={encoded}"),
        None,
        expected_generation,
    )
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/payments/orders/{encoded}"),
            None,
            expected_generation,
        )
    })
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/billing/orders/status?out_trade_no={encoded}"),
            None,
            expected_generation,
        )
    })
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/billing/orders/{encoded}"),
            None,
            expected_generation,
        )
    })
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/orders/{encoded}"),
            None,
            expected_generation,
        )
    })
    .ok()?;
    Some(official_unwrap_response_payload(&remote))
}

fn fetch_remote_official_call_records(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    expected_generation: Option<u64>,
) -> Result<Vec<Value>, String> {
    let response = run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        "/users/me/ai-usage-logs",
        None,
        expected_generation,
    )?;
    let items = normalize_official_call_records_value(&response);
    if items.is_empty() {
        return Err("官方调用记录接口返回了无法识别的数据结构".to_string());
    }
    Ok(items)
}

fn update_official_session_user(settings: &mut Value, user: &Value) {
    let next_session = official_settings_session(settings).map(|mut session| {
        if let Some(object) = session.as_object_mut() {
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

    if let Ok(response) = run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        "/users/me",
        None,
        expected_generation,
    ) {
        let user = official_unwrap_response_payload(&response);
        update_official_session_user(settings, &user);
        refreshed = true;
    }

    if let Ok(points) = fetch_remote_official_points(app, state, settings, expected_generation) {
        write_settings_json_value(settings, "redbox_auth_points_json", &points);
        refreshed = true;
    }

    let models = fetch_official_models_with_recovery(app, state, settings, expected_generation);
    if !models.is_empty() {
        write_settings_json_array(settings, "redbox_official_models_json", &models);
        official_sync_source_into_settings(settings, &models);
        refreshed = true;
    }

    if let Ok(records) =
        fetch_remote_official_call_records(app, state, settings, expected_generation)
    {
        write_settings_json_array(settings, "redbox_auth_call_records_json", &records);
        refreshed = true;
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
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
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
    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
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
        Ok(official_settings_session(&store.settings))
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

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        if let Err(error) = refresh_official_cached_data(&app, &state) {
            if error != "官方账号未登录" {
                eprintln!("[RedBox official refresh] {error}");
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
    let result = match channel {
        "redbox-auth:get-config"
        | "redbox-auth:bootstrap"
        | "redbox-auth:get-session-cached"
        | "redbox-auth:get-session"
        | "redbox-auth:logout"
        | "redbox-auth:send-sms-code"
        | "redbox-auth:login-sms"
        | "redbox-auth:register-sms"
        | "redbox-auth:wechat-url"
        | "redbox-auth:wechat-status"
        | "redbox-auth:login-wechat-code"
        | "redbox-auth:refresh"
        | "redbox-auth:me"
        | "redbox-auth:points"
        | "redbox-auth:models"
        | "redbox-auth:api-keys:list"
        | "redbox-auth:api-keys:create"
        | "redbox-auth:api-keys:set-current"
        | "redbox-auth:products"
        | "redbox-auth:call-records"
        | "redbox-auth:create-page-pay-order"
        | "redbox-auth:create-wechat-native-order"
        | "redbox-auth:order-status"
        | "redbox-auth:open-payment-form"
        | "official:auth:get-session"
        | "official:auth:set-session"
        | "official:auth:clear-session"
        | "official:models:list"
        | "official:account:summary"
        | "official:billing:products"
        | "official:billing:list-orders"
        | "official:billing:create-order"
        | "official:billing:list-calls" => (|| -> Result<Value, String> {
            match channel {
                "redbox-auth:get-config" => Ok(json!({
                    "success": true,
                    "gatewayBase": "https://api.ziz.hk",
                    "appSlug": "redbox",
                    "defaultWechatState": "redconvert-desktop",
                })),
                "redbox-auth:get-session-cached" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "session": official_settings_session(&store.settings)
                    }))
                }),
                "redbox-auth:bootstrap" => {
                    let reason =
                        payload_string(payload, "reason").unwrap_or_else(|| "manual".to_string());
                    bootstrap_official_auth_session(app, state, &reason)
                }
                "redbox-auth:get-session" => {
                    bootstrap_official_auth_session(app, state, "get-session")
                }
                "redbox-auth:logout" => {
                    log_official_auth(state, "logout-request", "manual logout");
                    let logout_generation = auth::bump_auth_generation(state, "logout")?;
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    clear_official_auth_state(&mut settings);
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-logout",
                        None,
                        Some(logout_generation),
                    )?;
                    let _ = auth::mark_auth_logged_out(app, state);
                    Ok(json!({ "success": true, "routing": { "cleared": true } }))
                }
                "redbox-auth:send-sms-code" => {
                    let phone = payload_string(payload, "phone").unwrap_or_default();
                    if phone.trim().is_empty() {
                        Ok(json!({ "success": false, "error": "请输入手机号" }))
                    } else {
                        let request = json!({ "phone": phone });
                        let result = with_store(state, |store| {
                            run_official_public_json_request(
                                &store.settings,
                                "POST",
                                "/auth/send-sms-code",
                                Some(request.clone()),
                            )
                        });
                        match result {
                            Ok(_) => Ok(json!({ "success": true })),
                            Err(error) => Ok(json!({ "success": false, "error": error })),
                        }
                    }
                }
                "redbox-auth:login-sms" | "redbox-auth:register-sms" => {
                    let phone = payload_string(payload, "phone").unwrap_or_default();
                    let code = payload_string(payload, "code").unwrap_or_default();
                    let invite_code = payload_string(payload, "inviteCode");
                    if phone.trim().is_empty() || code.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "请输入手机号和验证码" }));
                    }
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let response = run_official_public_json_request(
                        &settings,
                        "POST",
                        if channel == "redbox-auth:login-sms" {
                            "/auth/login/sms"
                        } else {
                            "/auth/register/sms"
                        },
                        Some(json!({
                            "phone": phone,
                            "code": code,
                            "invite_code": invite_code.clone().filter(|value| !value.trim().is_empty()),
                        })),
                    )?;
                    let session = normalize_official_auth_session(&response)?;
                    upsert_official_settings_session(&mut settings, Some(&session));
                    let _ = ensure_official_ai_api_key_in_settings(&mut settings)?;
                    sync_official_route_credentials(&mut settings);
                    seed_official_models_from_cache(&mut settings);
                    let login_generation = auth::bump_auth_generation(
                        state,
                        if channel == "redbox-auth:login-sms" {
                            "login-sms"
                        } else {
                            "register-sms"
                        },
                    )?;
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        if channel == "redbox-auth:login-sms" {
                            "official-login-sms"
                        } else {
                            "official-register-sms"
                        },
                        None,
                        Some(login_generation),
                    )?;
                    log_official_auth(
                        state,
                        "login-success",
                        format!(
                            "mode={} sessionAccess={} refreshToken={} expiresAt={}",
                            if channel == "redbox-auth:login-sms" {
                                "sms-login"
                            } else {
                                "sms-register"
                            },
                            payload_string(&session, "accessToken").is_some(),
                            payload_string(&session, "refreshToken").is_some(),
                            payload_i64(&session, "expiresAt").unwrap_or_default()
                        ),
                    );
                    let response =
                        json!({ "success": true, "session": session, "routeSynced": true });
                    emit_redbox_auth_session_updated(app, response.get("session").cloned());
                    trigger_official_cached_data_refresh(app.clone());
                    Ok(response)
                }
                "redbox-auth:wechat-url" => with_store_mut(state, |store| {
                    let mut settings = store.settings.clone();
                    let state_text = payload_string(payload, "state")
                        .unwrap_or_else(|| "redconvert-desktop".to_string());
                    let response = run_official_public_json_request(
                        &settings,
                        "GET",
                        &format!(
                            "/auth/login/wechat/url?state={}",
                            state_text.replace(' ', "%20")
                        ),
                        None,
                    )?;
                    let payload = official_unwrap_response_payload(&response);
                    let data = json!({
                        "enabled": payload_field(&payload, "enabled").and_then(|value| value.as_bool()).unwrap_or(true),
                        "sessionId": payload_string(&payload, "session_id").or_else(|| payload_string(&payload, "sessionId")).unwrap_or_default(),
                        "qrContentUrl": payload_string(&payload, "qr_content_url").or_else(|| payload_string(&payload, "qrContentUrl")).or_else(|| payload_string(&payload, "url")).unwrap_or_default(),
                        "url": payload_string(&payload, "url").unwrap_or_default(),
                        "expiresIn": payload_field(&payload, "expires_in").or_else(|| payload_field(&payload, "expiresIn")).and_then(|value| value.as_i64()).unwrap_or(120),
                        "status": payload_string(&payload, "status").unwrap_or_else(|| "PENDING".to_string()),
                        "createdAt": now_ms(),
                    });
                    write_settings_json_value(
                        &mut settings,
                        "redbox_auth_wechat_login_json",
                        &data,
                    );
                    store.settings = settings;
                    Ok(json!({ "success": true, "data": data }))
                }),
                "redbox-auth:wechat-status" => {
                    let _guard = state
                        .official_wechat_status_lock
                        .lock()
                        .map_err(|_| "微信登录状态锁已损坏".to_string())?;
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let pending =
                        official_settings_wechat_login(&settings).unwrap_or_else(|| json!({}));
                    let requested_session_id =
                        payload_string(payload, "sessionId").unwrap_or_default();
                    let pending_session_id =
                        payload_string(&pending, "sessionId").unwrap_or_default();
                    let session_id = if requested_session_id.is_empty() {
                        pending_session_id
                    } else {
                        requested_session_id
                    };
                    if session_id.is_empty() {
                        return Ok(json!({ "success": false, "error": "sessionId 不能为空" }));
                    }
                    let existing_status = payload_string(&pending, "status")
                        .unwrap_or_default()
                        .to_uppercase();
                    let existing_session_id =
                        payload_string(&pending, "sessionId").unwrap_or_default();
                    if existing_status == "CONFIRMED"
                        && existing_session_id == session_id
                        && official_settings_session(&settings).is_some()
                    {
                        return Ok(json!({
                            "success": true,
                            "data": {
                                "status": "CONFIRMED",
                                "sessionId": session_id,
                                "session": official_settings_session(&settings),
                                "raw": pending.get("raw").cloned().unwrap_or_else(|| json!({})),
                            }
                        }));
                    }
                    let response = run_official_public_json_request(
                        &settings,
                        "GET",
                        &format!(
                            "/auth/login/wechat/status?session_id={}",
                            session_id.replace(' ', "%20")
                        ),
                        None,
                    )?;
                    let payload = official_unwrap_response_payload(&response);
                    let status = payload_string(&payload, "status")
                        .unwrap_or_else(|| "PENDING".to_string())
                        .to_uppercase();
                    if existing_status != status || status == "CONFIRMED" || status == "SCANNED" {
                        log_official_auth(
                            state,
                            "wechat-status",
                            format!(
                                "sessionId={} previous={} next={}",
                                session_id, existing_status, status
                            ),
                        );
                    }
                    update_wechat_login_snapshot(&mut settings, &session_id, &status, &payload);
                    let session = if status == "CONFIRMED" {
                        payload
                            .get("auth_payload")
                            .map(normalize_official_auth_session)
                            .transpose()?
                    } else {
                        None
                    };
                    if let Some(ref session_value) = session {
                        upsert_official_settings_session(&mut settings, Some(session_value));
                        let _ = ensure_official_ai_api_key_in_settings(&mut settings)?;
                        sync_official_route_credentials(&mut settings);
                        seed_official_models_from_cache(&mut settings);
                    }
                    let response = json!({
                        "result": {
                            "success": true,
                            "data": {
                                "status": status,
                                "sessionId": session_id,
                                "session": session,
                                "raw": payload,
                            }
                        },
                        "settings": settings,
                        "session": session,
                        "status": status,
                    });
                    if response.pointer("/status").and_then(|value| value.as_str())
                        == Some("CONFIRMED")
                    {
                        if let Some(settings) = response.get("settings") {
                            let login_generation =
                                auth::bump_auth_generation(state, "login-wechat-poll")?;
                            apply_official_settings_update(
                                app,
                                state,
                                settings,
                                "official-wechat-confirmed",
                                None,
                                Some(login_generation),
                            )?;
                        }
                        if let Some(session) = response.get("session") {
                            log_official_auth(
                                state,
                                "login-success",
                                format!(
                                    "mode=wechat-poll sessionAccess={} refreshToken={} expiresAt={}",
                                    payload_string(session, "accessToken").is_some(),
                                    payload_string(session, "refreshToken").is_some(),
                                    payload_i64(session, "expiresAt").unwrap_or_default()
                                ),
                            );
                        }
                        emit_redbox_auth_session_updated(
                            app,
                            response
                                .pointer("/session")
                                .cloned()
                                .filter(|value| !value.is_null()),
                        );
                        trigger_official_cached_data_refresh(app.clone());
                    }
                    Ok(response
                        .get("result")
                        .cloned()
                        .unwrap_or_else(|| json!({ "success": false })))
                }
                "redbox-auth:login-wechat-code" => {
                    let code = payload_string(payload, "code").unwrap_or_default();
                    if code.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "缺少微信授权 code" }));
                    }
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let response = run_official_public_json_request(
                        &settings,
                        "POST",
                        "/auth/login/wechat",
                        Some(json!({ "code": code })),
                    )?;
                    let session = normalize_official_auth_session(&response)?;
                    upsert_official_settings_session(&mut settings, Some(&session));
                    let _ = ensure_official_ai_api_key_in_settings(&mut settings)?;
                    sync_official_route_credentials(&mut settings);
                    seed_official_models_from_cache(&mut settings);
                    let login_generation = auth::bump_auth_generation(state, "login-wechat-code")?;
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-login-wechat-code",
                        None,
                        Some(login_generation),
                    )?;
                    log_official_auth(
                        state,
                        "login-success",
                        format!(
                            "mode=wechat-code sessionAccess={} refreshToken={} expiresAt={}",
                            payload_string(&session, "accessToken").is_some(),
                            payload_string(&session, "refreshToken").is_some(),
                            payload_i64(&session, "expiresAt").unwrap_or_default()
                        ),
                    );
                    let response =
                        json!({ "success": true, "session": session, "routeSynced": true });
                    emit_redbox_auth_session_updated(app, response.get("session").cloned());
                    trigger_official_cached_data_refresh(app.clone());
                    Ok(response)
                }
                "redbox-auth:refresh" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    if !official_session_logged_in(&settings_snapshot) {
                        return Ok(json!({ "success": false, "error": "官方账号未登录" }));
                    }
                    let started = trigger_official_cached_data_refresh(app.clone());
                    let response = json!({
                        "success": true,
                        "queued": true,
                        "started": started,
                        "alreadyInFlight": !started,
                        "requestedAt": now_iso(),
                        "session": official_settings_session(&settings_snapshot),
                    });
                    Ok(response)
                }
                "redbox-auth:me" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "user": cached_official_user(&store.settings),
                    }))
                }),
                "redbox-auth:points" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let cached_points = cached_official_points(&settings);
                    let stale = official_points_need_silent_refresh(&settings);
                    let mut error = None;
                    let points = match fetch_remote_official_points(
                        app,
                        state,
                        &mut settings,
                        request_generation,
                    ) {
                        Ok(points) => {
                            write_settings_json_value(
                                &mut settings,
                                "redbox_auth_points_json",
                                &points,
                            );
                            points
                        }
                        Err(next_error) => {
                            error = Some(next_error);
                            cached_points
                        }
                    };
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-points-query",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({
                        "success": error.is_none() || points.is_object(),
                        "points": points,
                        "stale": stale,
                        "error": error,
                    }))
                }
                "redbox-auth:models" => with_store(state, |store| {
                    Ok(json!({
                        "success": true,
                        "models": official_settings_models(&store.settings),
                    }))
                }),
                "redbox-auth:api-keys:list" => with_store(state, |store| {
                    let mut settings = store.settings.clone();
                    let remote = crate::run_official_json_request(
                        &settings,
                        "GET",
                        "/users/me/api-keys",
                        None,
                    )?;
                    let remote_items = official_response_items(&remote);
                    let local_items = official_settings_api_keys(&settings);
                    let merged = remote_items
                        .into_iter()
                        .map(|item| {
                            let id = payload_string(&item, "id").unwrap_or_default();
                            let prefix = payload_string(&item, "key_prefix")
                                .or_else(|| payload_string(&item, "keyPrefix"))
                                .unwrap_or_default();
                            let last4 = payload_string(&item, "key_last4")
                                .or_else(|| payload_string(&item, "keyLast4"))
                                .unwrap_or_default();
                            let local_plaintext = local_items.iter().find_map(|local| {
                                let id_matches = !id.is_empty()
                                    && payload_string(local, "id").unwrap_or_default() == id;
                                let prefix_matches = !prefix.is_empty()
                                    && payload_string(local, "key_prefix").unwrap_or_default()
                                        == prefix;
                                let last4_matches = !last4.is_empty()
                                    && payload_string(local, "key_last4").unwrap_or_default()
                                        == last4;
                                if id_matches || (prefix_matches && last4_matches) {
                                    payload_string(local, "apiKey")
                                } else {
                                    None
                                }
                            });
                            let mut object = item.as_object().cloned().unwrap_or_default();
                            if let Some(api_key) = local_plaintext {
                                object.insert("apiKey".to_string(), json!(api_key));
                            }
                            Value::Object(object)
                        })
                        .collect::<Vec<_>>();
                    write_settings_json_array(&mut settings, "redbox_auth_api_keys_json", &merged);
                    Ok(json!({
                        "success": true,
                        "keys": merged,
                        "settings": settings,
                    }))
                })
                .and_then(|response| {
                    let next_settings = response
                        .get("settings")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    apply_official_settings_update(
                        app,
                        state,
                        &next_settings,
                        "official-api-key-list",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({
                        "success": true,
                        "keys": response.get("keys").cloned().unwrap_or_else(|| json!([]))
                    }))
                }),
                "redbox-auth:api-keys:create" => {
                    let name = payload_string(payload, "name")
                        .unwrap_or_else(|| "Default API Key".to_string());
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let response = crate::run_official_json_request(
                        &settings,
                        "POST",
                        "/users/me/api-keys",
                        Some(json!({ "name": name })),
                    )?;
                    let mut item =
                        normalize_official_api_key_record(&response).unwrap_or_else(|| {
                            json!({
                                "id": "",
                                "name": "Default API Key",
                                "key_prefix": "",
                                "key_last4": "",
                                "is_active": true,
                                "created_at": now_iso(),
                                "last_used_at": Value::Null,
                            })
                        });
                    if let Some(object) = item.as_object_mut() {
                        object.insert(
                            "apiKey".to_string(),
                            json!(extract_official_api_key_value(&response).unwrap_or_default()),
                        );
                        object.insert("isCurrent".to_string(), json!(true));
                    }
                    merge_official_api_key_records(&mut settings, Some(item.clone()));
                    if let Some(mut session) = official_settings_session(&settings) {
                        if let Some(api_key) = payload_string(&item, "apiKey") {
                            upsert_session_api_key(&mut session, &api_key);
                            upsert_official_settings_session(&mut settings, Some(&session));
                        }
                    }
                    let models = fetch_official_models_for_settings(&settings);
                    write_settings_json_array(
                        &mut settings,
                        "redbox_official_models_json",
                        &models,
                    );
                    sync_official_route_credentials(&mut settings);
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-api-key-create",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "data": item }))
                }
                "redbox-auth:api-keys:set-current" => {
                    let api_key = payload_string(payload, "apiKey").unwrap_or_default();
                    if api_key.trim().is_empty() {
                        return Ok(json!({ "success": false, "error": "缺少 API Key" }));
                    }
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let response = {
                        let mut settings = settings_snapshot.clone();
                        let mut keys = official_settings_api_keys(&settings);
                        let key_present_locally = keys.iter().any(|item| {
                            payload_string(item, "apiKey")
                                .map(|value| value == api_key)
                                .unwrap_or(false)
                        });
                        if !key_present_locally {
                            return Ok(json!({
                                "success": false,
                                "error": "当前设备没有该 API Key 明文，无法切换为当前使用 Key。请新建一个 API Key。"
                            }));
                        }
                        for item in &mut keys {
                            let is_match = payload_string(item, "apiKey")
                                .map(|value| value == api_key)
                                .unwrap_or(false);
                            if let Some(object) = item.as_object_mut() {
                                object.insert("isCurrent".to_string(), json!(is_match));
                            }
                        }
                        write_settings_json_array(
                            &mut settings,
                            "redbox_auth_api_keys_json",
                            &keys,
                        );
                        let session = official_settings_session(&settings).map(|mut session| {
                            if let Some(object) = session.as_object_mut() {
                                object.insert("apiKey".to_string(), json!(api_key));
                                object.insert("updatedAt".to_string(), json!(now_ms() as i64));
                            }
                            session
                        });
                        let models = fetch_official_models_for_settings(&settings);
                        write_settings_json_array(
                            &mut settings,
                            "redbox_official_models_json",
                            &models,
                        );
                        if let Some(ref session_value) = session {
                            upsert_official_settings_session(&mut settings, Some(session_value));
                            sync_official_route_credentials(&mut settings);
                            if !models.is_empty() {
                                official_sync_source_into_settings(&mut settings, &models);
                            }
                        }
                        apply_official_settings_update(
                            app,
                            state,
                            &settings,
                            "official-api-key-set-current",
                            None,
                            request_generation,
                        )?;
                        json!({ "success": true, "session": session, "routeSynced": session.is_some() })
                    };
                    emit_redbox_auth_session_updated(
                        app,
                        response
                            .get("session")
                            .cloned()
                            .filter(|value| !value.is_null()),
                    );
                    trigger_official_cached_data_refresh(app.clone());
                    Ok(response)
                }
                "redbox-auth:products" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let remote = run_authenticated_official_request(
                        app,
                        state,
                        &mut settings,
                        "GET",
                        "/payments/products",
                        None,
                        request_generation,
                    )
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "GET",
                            "/billing/products",
                            None,
                            request_generation,
                        )
                    })
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "GET",
                            "/products",
                            None,
                            request_generation,
                        )
                    })
                    .ok();
                    let products = remote
                        .as_ref()
                        .map(official_response_items)
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(official_fallback_products);
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-products",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "products": products }))
                }
                "redbox-auth:call-records" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let cached_records = normalize_official_call_record_items(
                        &official_settings_call_records_list(&settings),
                    );
                    let remote = fetch_remote_official_call_records(
                        app,
                        state,
                        &mut settings,
                        request_generation,
                    );
                    let mut error = None;
                    let records = match remote {
                        Ok(records) => {
                            write_settings_json_array(
                                &mut settings,
                                "redbox_auth_call_records_json",
                                &records,
                            );
                            records
                        }
                        Err(next_error) => {
                            error = Some(next_error);
                            cached_records
                        }
                    };
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-call-records",
                        None,
                        request_generation,
                    )?;
                    if let Some(message) = error {
                        let has_records = !records.is_empty();
                        return Ok(json!({
                            "success": has_records,
                            "records": records,
                            "error": message,
                        }));
                    }
                    Ok(json!({ "success": true, "records": records }))
                }
                "redbox-auth:create-page-pay-order" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let amount = payload_f64(payload, "amount").unwrap_or(9.9);
                    let subject = payload_string(payload, "subject")
                        .unwrap_or_else(|| format!("积分充值 ¥{amount:.2}"));
                    let order = run_authenticated_official_request_skip_preflight_refresh(
                        app,
                        state,
                        &mut settings,
                        "POST",
                        "/payments/orders/page-pay",
                        Some(json!({
                            "product_id": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "productId": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "amount": amount,
                            "amount_yuan": amount,
                            "subject": subject,
                            "title": subject,
                            "points_to_deduct": payload_i64(payload, "pointsToDeduct").unwrap_or(0),
                            "pointsToDeduct": payload_i64(payload, "pointsToDeduct").unwrap_or(0),
                        })),
                        request_generation,
                    )
                    .map(|response| official_unwrap_response_payload(&response))
                    .unwrap_or_else(|_| {
                        let out_trade_no = make_id("order");
                        let payment_form = create_official_payment_form(&out_trade_no, amount, &subject);
                        json!({
                            "id": out_trade_no,
                            "out_trade_no": out_trade_no,
                            "outTradeNo": out_trade_no,
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "amount": amount,
                            "subject": subject,
                            "payment_form": payment_form,
                            "created_at": now_iso(),
                        })
                    });
                    let mut orders = official_settings_orders(&settings);
                    orders.insert(0, order.clone());
                    write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-order-create",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "order": order }))
                }
                "redbox-auth:create-wechat-native-order" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let amount = payload_f64(payload, "amount").unwrap_or(9.9);
                    let out_trade_no = make_id("wxpay");
                    let order = run_authenticated_official_request(
                        app,
                        state,
                        &mut settings,
                        "POST",
                        "/payments/orders/wechat-native",
                        Some(json!({
                            "product_id": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "productId": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                            "amount": amount,
                            "amount_yuan": amount,
                            "subject": payload_string(payload, "subject").unwrap_or_else(|| format!("积分充值 ¥{amount:.2}")),
                        })),
                        request_generation,
                    )
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "POST",
                            "/wechat/pay/native",
                            Some(json!({
                                "amount": amount,
                                "out_trade_no": out_trade_no,
                            })),
                            request_generation,
                        )
                    })
                    .map(|response| official_unwrap_response_payload(&response))
                    .unwrap_or_else(|_| {
                        json!({
                            "id": out_trade_no,
                            "out_trade_no": out_trade_no,
                            "outTradeNo": out_trade_no,
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "amount": amount,
                            "code_url": format!("weixin://wxpay/bizpayurl?pr={}", out_trade_no),
                            "created_at": now_iso(),
                        })
                    });
                    let mut orders = official_settings_orders(&settings);
                    orders.insert(0, order.clone());
                    write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-wechat-order-create",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "order": order }))
                }
                "redbox-auth:order-status" => {
                    let out_trade_no = payload_string(payload, "outTradeNo").unwrap_or_default();
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let order = query_remote_order_status(
                        app,
                        state,
                        &mut settings,
                        &out_trade_no,
                        request_generation,
                    )
                    .unwrap_or_else(|| {
                        official_settings_orders(&settings)
                            .into_iter()
                            .find(|item| {
                                payload_string(item, "out_trade_no")
                                    .or_else(|| payload_string(item, "outTradeNo"))
                                    .map(|value| value == out_trade_no)
                                    .unwrap_or(false)
                            })
                            .unwrap_or_else(|| {
                                json!({
                                    "out_trade_no": out_trade_no,
                                    "outTradeNo": out_trade_no,
                                    "status": "PENDING",
                                    "trade_status": "PENDING",
                                })
                            })
                    });
                    sync_remote_orders_into_settings(&mut settings, &order);
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-order-status",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "order": order }))
                }
                "redbox-auth:open-payment-form" => {
                    let payment_form = payload_string(payload, "paymentForm").unwrap_or_default();
                    match open_payment_form(&payment_form) {
                        Ok(opened) => Ok(json!({ "success": true, "opened": opened })),
                        Err(error) => Ok(json!({ "success": false, "error": error })),
                    }
                }
                "official:auth:get-session" => with_store(state, |store| {
                    let session = official_settings_session(&store.settings);
                    Ok(json!({ "success": true, "session": session }))
                }),
                "official:auth:set-session" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let session = payload_field(payload, "session")
                        .cloned()
                        .unwrap_or(payload.clone());
                    upsert_official_settings_session(&mut settings, Some(&session));
                    sync_official_route_credentials(&mut settings);
                    let models = official_settings_models(&settings);
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                    let generation =
                        auth::bump_auth_generation(state, "official-auth-set-session")?;
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-auth-set-session",
                        None,
                        Some(generation),
                    )?;
                    Ok(json!({ "success": true, "session": session }))
                }
                "official:auth:clear-session" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    clear_official_auth_state(&mut settings);
                    let generation =
                        auth::bump_auth_generation(state, "official-auth-clear-session")?;
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-auth-clear-session",
                        None,
                        Some(generation),
                    )?;
                    Ok(json!({ "success": true }))
                }
                "official:models:list" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let mut models = official_settings_models(&settings);
                    if models.is_empty() {
                        models = fetch_official_models_with_recovery(
                            app,
                            state,
                            &mut settings,
                            request_generation,
                        );
                    }
                    if let Some(object) = settings.as_object_mut() {
                        object.insert(
                            "redbox_official_models_json".to_string(),
                            json!(
                                serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
                            ),
                        );
                    }
                    if !models.is_empty() {
                        official_sync_source_into_settings(&mut settings, &models);
                    }
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-models-list",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "models": models }))
                }
                "official:account:summary" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let models = official_settings_models(&settings);
                    let remote = run_authenticated_official_request(
                        app,
                        state,
                        &mut settings,
                        "GET",
                        "/account",
                        None,
                        request_generation,
                    )
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "GET",
                            "/me",
                            None,
                            request_generation,
                        )
                    })
                    .ok();
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-account-summary",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({
                        "success": true,
                        "summary": remote.unwrap_or_else(|| official_account_summary_local(&settings, &models))
                    }))
                }
                "official:billing:products" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let remote = run_authenticated_official_request(
                        app,
                        state,
                        &mut settings,
                        "GET",
                        "/billing/products",
                        None,
                        request_generation,
                    )
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "GET",
                            "/products",
                            None,
                            request_generation,
                        )
                    })
                    .ok();
                    let products = remote
                        .as_ref()
                        .map(official_response_items)
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(official_fallback_products);
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-billing-products",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "products": products }))
                }
                "official:billing:list-orders" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let remote = run_authenticated_official_request(
                        app,
                        state,
                        &mut settings,
                        "GET",
                        "/billing/orders",
                        None,
                        request_generation,
                    )
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "GET",
                            "/orders",
                            None,
                            request_generation,
                        )
                    })
                    .ok();
                    let orders = remote
                        .as_ref()
                        .map(official_response_items)
                        .unwrap_or_default();
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-billing-list-orders",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "orders": orders }))
                }
                "official:billing:create-order" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let product_id = payload_string(payload, "productId").unwrap_or_default();
                    let amount = payload_f64(payload, "amount");
                    let body = json!({
                        "product_id": product_id,
                        "productId": payload_string(payload, "productId"),
                        "amount": amount,
                        "currency": payload_string(payload, "currency").unwrap_or_else(|| "CNY".to_string()),
                    });
                    let order = run_authenticated_official_request(
                        app,
                        state,
                        &mut settings,
                        "POST",
                        "/billing/orders",
                        Some(body.clone()),
                        request_generation,
                    )
                    .or_else(|_| {
                        run_authenticated_official_request(
                            app,
                            state,
                            &mut settings,
                            "POST",
                            "/orders",
                            Some(body),
                            request_generation,
                        )
                    })
                    .unwrap_or_else(|_| {
                        json!({
                            "id": make_id("official-order"),
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "payment_url": REDBOX_OFFICIAL_BASE_URL,
                            "amount": amount.unwrap_or(0.0),
                            "product_id": product_id,
                            "created_at": now_iso(),
                        })
                    });
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-billing-create-order",
                        None,
                        request_generation,
                    )?;
                    Ok(json!({ "success": true, "order": order }))
                }
                "official:billing:list-calls" => {
                    let settings_snapshot = with_store(state, |store| Ok(store.settings.clone()))?;
                    let mut settings = settings_snapshot.clone();
                    let result = match fetch_remote_official_call_records(
                        app,
                        state,
                        &mut settings,
                        request_generation,
                    ) {
                        Ok(records) => json!({ "success": true, "records": records }),
                        Err(error) => json!({ "success": false, "records": [], "error": error }),
                    };
                    apply_official_settings_update(
                        app,
                        state,
                        &settings,
                        "official-billing-list-calls",
                        None,
                        request_generation,
                    )?;
                    Ok(result)
                }
                _ => unreachable!("channel prefiltered"),
            }
        })(),
        _ => return None,
    };

    Some(result)
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
        assert_eq!(payload_string(&records[0], "id").as_deref(), Some("req-1"));
        assert_eq!(payload_string(&records[1], "id").as_deref(), Some("req-2"));
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
            Some("https://api.ziz.hk/redbox/v1")
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
            Some("https://api.ziz.hk/redbox/v1")
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
                    "name": "RedBox Official",
                    "presetId": "redbox-official",
                    "baseURL": "https://api.ziz.hk/redbox/v1",
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
            "api_endpoint": "https://api.ziz.hk/redbox/v1",
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
