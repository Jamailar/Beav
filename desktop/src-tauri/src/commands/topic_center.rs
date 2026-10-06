use crate::persistence::with_store_mut;
use crate::store::topic_center as topic_center_store;
use crate::{
    app_brand_display_name, make_id, now_i64, payload_string, payload_value_as_string, AppState,
};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub fn handle_topic_center_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !channel.starts_with("topic-center:") {
        return None;
    }
    Some((|| match channel {
        "topic-center:list" => list_topics(state, payload),
        "topic-center:get" => get_topic(state, payload),
        "topic-center:create" => create_topic(state, payload),
        "topic-center:update" => update_topic(state, payload),
        "topic-center:bulk-upsert" | "topic-center:upsert" => bulk_upsert_topics(state, payload),
        "topic-center:abandon" => abandon_topic(state, payload),
        "topic-center:delete" => delete_topic(state, payload),
        _ => Err(format!(
            "{} host does not recognize channel `{channel}`.",
            app_brand_display_name()
        )),
    })())
}

fn list_topics(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        let include_abandoned = payload
            .get("includeAbandoned")
            .or_else(|| payload.get("include_abandoned"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status_filter = payload_string_alias(payload, &["status"]);
        let query =
            payload_string_alias(payload, &["query", "q"]).map(|value| value.to_ascii_lowercase());
        let limit = payload
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok());
        let mut records = topic_center_store::topic_records_for_list(store, include_abandoned);
        if let Some(status) = status_filter {
            let normalized = status.trim().to_ascii_lowercase();
            records.retain(|record| record.status == normalized);
        }
        if let Some(query) = query {
            records.retain(|record| {
                [
                    record.title.as_str(),
                    record.content_direction.as_str(),
                    record.method.as_str(),
                    record.source_evidence.as_str(),
                    record.target_reader.as_str(),
                    record.user_problem.as_str(),
                    record.content_value.as_str(),
                    record.fit_reason.as_str(),
                ]
                .iter()
                .any(|value| value.to_ascii_lowercase().contains(&query))
            });
        }
        if let Some(limit) = limit {
            records.truncate(limit.max(1));
        }
        Ok(json!(records))
    })
}

fn get_topic(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let id = payload_id(payload).ok_or_else(|| "缺少选题 id".to_string())?;
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        let Some(record) = store.topic_center.iter().find(|record| record.id == id) else {
            return Err("选题不存在".to_string());
        };
        Ok(json!(record))
    })
}

fn create_topic(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let now = now_i64();
    let fallback_id = make_id("topic");
    let created_by = payload_string_alias(payload, &["createdBy", "created_by"])
        .unwrap_or_else(|| "agent".to_string());
    let record =
        topic_center_store::topic_record_from_payload(payload, fallback_id, &created_by, now);
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        upsert_topic_record(store, record.clone());
        Ok(json!({ "success": true, "item": record }))
    })
}

fn update_topic(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let id = payload_id(payload).ok_or_else(|| "缺少选题 id".to_string())?;
    let patch = payload
        .get("patch")
        .or_else(|| payload.get("item"))
        .or_else(|| payload.get("record"))
        .filter(|value| value.is_object())
        .unwrap_or(payload);
    let now = now_i64();
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        let Some(record) = store.topic_center.iter_mut().find(|record| record.id == id) else {
            return Err("选题不存在".to_string());
        };
        topic_center_store::apply_topic_patch(record, patch, now);
        let updated = record.clone();
        topic_center_store::upsert_wander_history_compat(store, &updated);
        Ok(json!({ "success": true, "item": updated }))
    })
}

fn bulk_upsert_topics(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let now = now_i64();
    let created_by = payload_string_alias(payload, &["createdBy", "created_by"])
        .unwrap_or_else(|| "agent".to_string());
    let candidates = topic_candidates(payload);
    if candidates.is_empty() {
        return Err("缺少选题候选".to_string());
    }
    let records = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            topic_center_store::topic_record_from_payload(
                candidate,
                format!("{}-{}", make_id("topic"), index + 1),
                &created_by,
                now,
            )
        })
        .collect::<Vec<_>>();
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        for record in &records {
            upsert_topic_record(store, record.clone());
        }
        Ok(json!({
            "success": true,
            "count": records.len(),
            "items": records,
        }))
    })
}

fn abandon_topic(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let id = payload_id(payload).ok_or_else(|| "缺少选题 id".to_string())?;
    let now = now_i64();
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        let Some(record) = store.topic_center.iter_mut().find(|record| record.id == id) else {
            return Err("选题不存在".to_string());
        };
        record.status = "abandoned".to_string();
        record.abandoned_at = Some(now);
        record.updated_at = now;
        let updated = record.clone();
        topic_center_store::upsert_wander_history_compat(store, &updated);
        Ok(json!({ "success": true, "item": updated }))
    })
}

fn delete_topic(state: &State<'_, AppState>, payload: &Value) -> Result<Value, String> {
    let id = payload_id(payload).ok_or_else(|| "缺少选题 id".to_string())?;
    with_store_mut(state, |store| {
        topic_center_store::migrate_wander_history(store);
        let before = store.topic_center.len();
        store.topic_center.retain(|record| record.id != id);
        topic_center_store::remove_wander_history_compat(store, &id);
        if store.topic_center.len() == before {
            return Err("选题不存在".to_string());
        }
        Ok(json!({ "success": true }))
    })
}

fn upsert_topic_record(store: &mut crate::AppStore, record: crate::TopicCenterRecord) {
    if let Some(existing) = store
        .topic_center
        .iter_mut()
        .find(|item| item.id == record.id)
    {
        *existing = record.clone();
    } else {
        store.topic_center.push(record.clone());
    }
    topic_center_store::upsert_wander_history_compat(store, &record);
}

fn topic_candidates(payload: &Value) -> Vec<Value> {
    if let Some(items) = payload
        .get("candidates")
        .or_else(|| payload.get("items"))
        .or_else(|| payload.get("topics"))
        .and_then(Value::as_array)
    {
        return items.clone();
    }
    if payload
        .get("title")
        .or_else(|| payload.get("topic_name"))
        .or_else(|| payload.get("topicName"))
        .is_some()
    {
        return vec![payload.clone()];
    }
    Vec::new()
}

fn payload_id(payload: &Value) -> Option<String> {
    payload_value_as_string(payload)
        .or_else(|| payload_string(payload, "id"))
        .or_else(|| payload_string_alias(payload, &["topicId", "topic_id"]))
}

fn payload_string_alias(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload.get(*key).and_then(|value| {
            let text = match value {
                Value::String(text) => text.trim().to_string(),
                Value::Number(number) => number.to_string(),
                Value::Bool(flag) => flag.to_string(),
                _ => return None,
            };
            (!text.is_empty()).then_some(text)
        })
    })
}
