use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;

use crate::{now_iso, official_unwrap_response_payload, payload_field, payload_string};

pub(super) const OFFICIAL_CALL_RECORDS_PAGE_SIZE: usize = 30;

pub(super) fn value_as_f64(value: &Value) -> Option<f64> {
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

pub(super) fn value_as_i64(value: &Value) -> Option<i64> {
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

pub(super) fn payload_f64(payload: &Value, key: &str) -> Option<f64> {
    payload_field(payload, key).and_then(value_as_f64)
}

pub(super) fn payload_i64(payload: &Value, key: &str) -> Option<i64> {
    payload_field(payload, key).and_then(value_as_i64)
}

pub(super) fn response_error_message(response: &Value) -> String {
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

pub(super) fn official_response_is_unauthorized(status: u16, response: &Value) -> bool {
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

fn timestamp_millis_from_numeric(value: i64) -> Option<i64> {
    if value <= 0 {
        return None;
    }
    if value >= 1_000_000_000_000 {
        Some(value)
    } else {
        value.checked_mul(1000)
    }
}

fn timestamp_millis_from_text(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = trimmed.parse::<i64>() {
        return timestamp_millis_from_numeric(parsed);
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    for format in ["%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(parsed.and_utc().timestamp_millis());
        }
    }
    None
}

fn timestamp_millis_from_value(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64().and_then(timestamp_millis_from_numeric),
        Some(Value::String(text)) => timestamp_millis_from_text(text),
        Some(other) => other
            .as_str()
            .and_then(timestamp_millis_from_text)
            .or_else(|| other.as_i64().and_then(timestamp_millis_from_numeric)),
        None => None,
    }
}

fn iso_time_from_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(_)) => timestamp_millis_from_value(value)
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .map(|time| time.to_rfc3339())
            .unwrap_or_else(now_iso),
        Some(raw) => raw
            .as_str()
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(now_iso),
        None => now_iso(),
    }
}

pub(super) fn normalize_official_call_record_items(items: &[Value]) -> Vec<Value> {
    let mut seen_ids = HashSet::<String>::new();
    let mut records = Vec::<Value>::new();
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
        if seen_ids.insert(id) {
            records.push(normalized);
        }
    }
    records.sort_by(|left, right| {
        let left_time = timestamp_millis_from_value(left.get("createdAt")).unwrap_or(0);
        let right_time = timestamp_millis_from_value(right.get("createdAt")).unwrap_or(0);
        right_time.cmp(&left_time).then_with(|| {
            payload_string(right, "id")
                .unwrap_or_default()
                .cmp(&payload_string(left, "id").unwrap_or_default())
        })
    });
    records
        .into_iter()
        .take(OFFICIAL_CALL_RECORDS_PAGE_SIZE)
        .collect()
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

pub(super) fn normalize_official_call_records_value(value: &Value) -> Vec<Value> {
    let payload = official_unwrap_response_payload(value);
    let items = extract_official_call_record_rows(&payload);
    normalize_official_call_record_items(&items)
}
