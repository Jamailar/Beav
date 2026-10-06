use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::{
    official_response_is_unauthorized, official_session_logged_in, payload_f64, payload_i64,
    run_authenticated_official_request,
};
use crate::{
    now_iso, now_ms, official_points_snapshot, official_settings_points,
    official_unwrap_response_payload, payload_field, payload_string, AppState,
};

const OFFICIAL_POINTS_SILENT_REFRESH_INTERVAL_MS: i64 = 60_000;

pub(super) fn normalize_official_points_payload(payload: &Value) -> Option<Value> {
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

pub(super) fn cached_official_points(settings: &Value) -> Value {
    official_settings_points(settings)
        .and_then(|payload| normalize_official_points_payload(&payload))
        .unwrap_or_else(|| {
            normalize_official_points_payload(&official_points_snapshot(settings))
                .unwrap_or_else(|| official_points_snapshot(settings))
        })
}

pub(super) fn official_points_need_silent_refresh(settings: &Value) -> bool {
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

pub(super) fn fetch_remote_official_points(
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
