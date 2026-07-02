use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, State};

use super::run_authenticated_official_request;
use crate::AppState;
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

    for nested_key in ["errors", "error"] {
        if let Some(nested) = response.get(nested_key).filter(|value| value.is_object()) {
            for key in ["reason", "message", "error", "msg", "detail", "code"] {
                if let Some(value) =
                    payload_string(nested, key).filter(|item| !item.trim().is_empty())
                {
                    return value;
                }
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
        || message.contains("token_expired")
        || message.contains("invalid refresh token")
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

fn nested_payload_string(item: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = payload_string(item, key).filter(|item| !item.trim().is_empty()) {
            return Some(value);
        }
    }
    for nested_key in [
        "metadata",
        "meta",
        "extra",
        "request",
        "request_metadata",
        "requestMetadata",
        "headers",
    ] {
        let Some(nested) = item.get(nested_key).filter(|value| value.is_object()) else {
            continue;
        };
        for key in keys {
            if let Some(value) = payload_string(nested, key).filter(|item| !item.trim().is_empty())
            {
                return Some(value);
            }
        }
    }
    None
}

fn normalize_call_record_purpose(item: &Value) -> Option<&'static str> {
    let purpose = nested_payload_string(
        item,
        &[
            "purpose",
            "usage_purpose",
            "usagePurpose",
            "source",
            "source_type",
            "sourceType",
            "scenario",
            "scene",
            "tag",
            "x-redbox-usage-purpose",
            "X-RedBox-Usage-Purpose",
        ],
    )
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase()
    .replace(['-', ' ', ':', '.'], "_");

    if matches!(
        purpose.as_str(),
        "knowledge_visual_index"
            | "visual_index"
            | "knowledge_image_index"
            | "knowledge_image_understanding"
            | "document_visual_index"
            | "redbox_knowledge_visual_index"
    ) || (purpose.contains("knowledge")
        && purpose.contains("visual")
        && purpose.contains("index"))
    {
        return Some("knowledge_visual_index");
    }

    None
}

fn call_record_event_label(event_type: &str) -> Option<&'static str> {
    match event_type.trim() {
        "invite_reward" => Some("邀请奖励"),
        "order_points_topup" => Some("积分充值"),
        "order_points_refund" => Some("订单积分退回"),
        "order_points_deduct" => Some("订单积分抵扣"),
        "redeem_ai_points" => Some("兑换积分"),
        "manual_grant" => Some("后台赠送"),
        "feedback_reward" => Some("反馈奖励"),
        "initial_grant" | "wallet_init" => Some("初始积分"),
        "ai_usage_refund" => Some("AI 调用退回"),
        "points_credit" => Some("积分入账"),
        _ => None,
    }
}

fn normalize_call_record_direction(
    item: &Value,
    event_type: Option<&str>,
    points_delta: Option<f64>,
    points: f64,
) -> &'static str {
    let raw_direction = nested_payload_string(
        item,
        &[
            "direction",
            "points_direction",
            "pointsDirection",
            "movement",
            "transaction_type",
            "transactionType",
        ],
    )
    .unwrap_or_default()
    .trim()
    .to_ascii_lowercase();

    if matches!(
        raw_direction.as_str(),
        "credit"
            | "income"
            | "increase"
            | "earn"
            | "earned"
            | "grant"
            | "reward"
            | "topup"
            | "refund"
            | "入账"
            | "增加"
            | "获得"
            | "奖励"
            | "退回"
    ) {
        return "credit";
    }
    if matches!(
        raw_direction.as_str(),
        "debit"
            | "expense"
            | "decrease"
            | "consume"
            | "consumed"
            | "spend"
            | "spent"
            | "deduct"
            | "cost"
            | "支出"
            | "消耗"
            | "扣减"
            | "抵扣"
    ) {
        return "debit";
    }
    if let Some(delta) = points_delta {
        if delta > 0.0 {
            return "credit";
        }
        if delta < 0.0 {
            return "debit";
        }
    }
    if let Some(event_type) = event_type {
        if matches!(
            event_type,
            "invite_reward"
                | "order_points_topup"
                | "order_points_refund"
                | "redeem_ai_points"
                | "manual_grant"
                | "feedback_reward"
                | "initial_grant"
                | "wallet_init"
                | "ai_usage_refund"
                | "points_credit"
        ) {
            return "credit";
        }
        if event_type.contains("refund")
            || event_type.contains("reward")
            || event_type.contains("topup")
        {
            return "credit";
        }
    }
    if points > 0.0 {
        return "debit";
    }
    "neutral"
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
        let event_type = nested_payload_string(item, &["event_type", "eventType"]);
        let entry_type = nested_payload_string(item, &["entry_type", "entryType"]);
        let title = nested_payload_string(
            item,
            &[
                "title",
                "display_title",
                "displayTitle",
                "reason",
                "reason_label",
                "reasonLabel",
            ],
        )
        .or_else(|| {
            event_type
                .as_deref()
                .and_then(call_record_event_label)
                .map(ToString::to_string)
        });
        let model = title
            .clone()
            .or_else(|| payload_string(item, "model"))
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
        let points_delta = item
            .get("points_delta")
            .or_else(|| item.get("pointsDelta"))
            .or_else(|| item.get("delta"))
            .and_then(value_as_f64);
        let raw_points = item
            .get("points")
            .or_else(|| item.get("points_amount"))
            .or_else(|| item.get("pointsAmount"))
            .or_else(|| item.get("amount"))
            .or_else(|| item.get("points_cost"))
            .or_else(|| item.get("cost_points"))
            .or_else(|| item.get("cost"))
            .and_then(value_as_f64);
        let mut points = raw_points.unwrap_or(0.0);
        if (!points.is_finite() || points <= 0.0) && points_delta.unwrap_or(0.0) != 0.0 {
            points = points_delta.unwrap_or(0.0).abs();
        }
        let direction =
            normalize_call_record_direction(item, event_type.as_deref(), points_delta, points);
        let normalized_points_delta = points_delta.unwrap_or_else(|| match direction {
            "credit" => points,
            "debit" => -points,
            _ => 0.0,
        });
        let status = payload_string(item, "status")
            .or_else(|| payload_string(item, "state"))
            .unwrap_or_else(|| "success".to_string());
        let created_at = iso_time_from_value(
            item.get("created_at")
                .or_else(|| item.get("createdAt"))
                .or_else(|| item.get("time"))
                .or_else(|| item.get("timestamp")),
        );
        let purpose = normalize_call_record_purpose(item);

        let normalized = json!({
            "id": id,
            "model": model,
            "endpoint": endpoint,
            "tokens": if tokens.is_finite() { tokens } else { 0.0 },
            "points": if points.is_finite() { points } else { 0.0 },
            "pointsDelta": if normalized_points_delta.is_finite() { normalized_points_delta } else { 0.0 },
            "direction": direction,
            "title": title.unwrap_or_else(|| model.clone()),
            "entryType": entry_type,
            "eventType": event_type,
            "referenceType": nested_payload_string(item, &["reference_type", "referenceType"]),
            "balanceAfter": item.get("balance_after").or_else(|| item.get("balanceAfter")).and_then(value_as_f64),
            "status": if status.trim().is_empty() { "success" } else { status.as_str() },
            "createdAt": created_at,
            "purpose": purpose,
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

pub(super) fn fetch_remote_official_call_records(
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
        &format!("/users/me/ai-usage-logs?limit={OFFICIAL_CALL_RECORDS_PAGE_SIZE}&page=1"),
        None,
        expected_generation,
    )?;
    let items = normalize_official_call_records_value(&response);
    if items.is_empty() {
        return Err("官方调用记录接口返回了无法识别的数据结构".to_string());
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_error_message_reads_nested_errors_reason() {
        let response = json!({
            "code": 401,
            "errors": {
                "reason": "token_expired"
            }
        });
        assert_eq!(response_error_message(&response), "token_expired");
    }
}
