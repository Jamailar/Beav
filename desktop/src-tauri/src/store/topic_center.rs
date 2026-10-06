use super::types::{AppStore, TopicCenterRecord, WanderHistoryRecord};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) fn migrate_wander_history(store: &mut AppStore) -> usize {
    if store.wander_history.is_empty() {
        return 0;
    }

    let mut existing_ids = store
        .topic_center
        .iter()
        .map(|record| record.id.clone())
        .collect::<HashSet<_>>();
    let mut migrated = 0;
    for record in &store.wander_history {
        if existing_ids.contains(&record.id) {
            continue;
        }
        store
            .topic_center
            .push(topic_record_from_wander_history(record));
        existing_ids.insert(record.id.clone());
        migrated += 1;
    }
    migrated
}

pub(crate) fn topic_records_for_list(
    store: &AppStore,
    include_abandoned: bool,
) -> Vec<TopicCenterRecord> {
    let mut records = store
        .topic_center
        .iter()
        .filter(|record| include_abandoned || record.status != "abandoned")
        .cloned()
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    records
}

pub(crate) fn topic_record_from_wander_history(record: &WanderHistoryRecord) -> TopicCenterRecord {
    let source_refs = serde_json::from_str::<Vec<Value>>(&record.items).unwrap_or_default();
    let raw_result = serde_json::from_str::<Value>(&record.result)
        .ok()
        .or_else(|| {
            let trimmed = record.result.trim();
            (!trimmed.is_empty()).then(|| json!({ "text": trimmed }))
        });
    let primary = raw_result
        .as_ref()
        .and_then(primary_topic_payload)
        .cloned()
        .unwrap_or_else(|| json!({}));
    let direction_frame = direction_frame_from_payload(&primary);
    let title = string_from_payload(&primary, &["topic_name", "topicName", "title", "name"])
        .or_else(|| nested_string(&primary, &["topic"], &["title"]))
        .or_else(|| {
            string_from_payload(
                &primary,
                &["content_direction", "contentDirection", "direction"],
            )
            .map(|value| short_text(&value, 40))
        })
        .unwrap_or_else(|| "未命名选题".to_string());
    let content_direction = string_from_payload(
        &primary,
        &[
            "content_direction",
            "contentDirection",
            "direction",
            "core_insight",
            "coreInsight",
        ],
    )
    .unwrap_or_default();
    let target_reader = frame_string(&direction_frame, &["target_reader", "targetReader"])
        .or_else(|| string_from_payload(&primary, &["target_reader", "targetReader", "audience"]))
        .unwrap_or_default();
    let user_problem = frame_string(&direction_frame, &["core_tension", "coreTension"])
        .or_else(|| {
            string_from_payload(
                &primary,
                &[
                    "user_problem",
                    "userProblem",
                    "pain_point",
                    "painPoint",
                    "core_tension",
                    "coreTension",
                ],
            )
        })
        .unwrap_or_default();
    let source_evidence = string_from_payload(
        &primary,
        &[
            "source_evidence",
            "sourceEvidence",
            "evidence",
            "source",
            "material_entry",
            "materialEntry",
        ],
    )
    .or_else(|| frame_string(&direction_frame, &["material_entry", "materialEntry"]))
    .unwrap_or_default();
    let status = record
        .status
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if record.abandoned_at.is_some() {
                "abandoned"
            } else {
                "active"
            }
        })
        .to_string();
    let method = infer_topic_method(&primary, &source_refs);
    let content_value = string_from_payload(
        &primary,
        &["content_value", "contentValue", "value", "promise"],
    )
    .unwrap_or_default();
    let fit_reason = string_from_payload(
        &primary,
        &[
            "fit_reason",
            "fitReason",
            "reason",
            "selection_reason",
            "selectionReason",
        ],
    )
    .or_else(|| frame_string(&direction_frame, &["material_entry", "materialEntry"]))
    .unwrap_or_default();
    TopicCenterRecord {
        id: record.id.clone(),
        title,
        content_direction,
        direction_frame,
        method: method.clone(),
        source_evidence,
        source_refs,
        target_reader,
        user_problem,
        content_value,
        fit_reason,
        score: number_from_payload(&primary, &["score"]),
        status,
        created_by: if method == "comment_insight" {
            "comment_insight".to_string()
        } else {
            "wander".to_string()
        },
        created_at: record.created_at,
        updated_at: record.abandoned_at.unwrap_or(record.created_at),
        abandoned_at: record.abandoned_at,
        raw_result,
    }
}

pub(crate) fn topic_record_from_payload(
    payload: &Value,
    fallback_id: String,
    fallback_created_by: &str,
    now: i64,
) -> TopicCenterRecord {
    let source = payload
        .get("record")
        .or_else(|| payload.get("item"))
        .or_else(|| payload.get("candidate"))
        .or_else(|| payload.get("topic"))
        .filter(|value| value.is_object())
        .unwrap_or(payload);
    let primary = primary_topic_payload(source).unwrap_or(source);
    let direction_frame = direction_frame_from_payload(primary);
    let title = string_from_payload(
        primary,
        &["topic_name", "topicName", "title", "name", "selectedTitle"],
    )
    .or_else(|| nested_string(primary, &["topic"], &["title"]))
    .or_else(|| {
        string_from_payload(
            primary,
            &[
                "content_direction",
                "contentDirection",
                "direction",
                "core_insight",
                "coreInsight",
            ],
        )
        .map(|value| short_text(&value, 48))
    })
    .unwrap_or_else(|| "未命名选题".to_string());
    let content_direction = string_from_payload(
        primary,
        &[
            "content_direction",
            "contentDirection",
            "direction",
            "core_insight",
            "coreInsight",
            "angle",
        ],
    )
    .unwrap_or_default();
    let target_reader =
        string_from_payload(primary, &["target_reader", "targetReader", "audience"])
            .or_else(|| frame_string(&direction_frame, &["target_reader", "targetReader"]))
            .unwrap_or_default();
    let user_problem = string_from_payload(
        primary,
        &[
            "user_problem",
            "userProblem",
            "pain_point",
            "painPoint",
            "core_tension",
            "coreTension",
        ],
    )
    .or_else(|| frame_string(&direction_frame, &["core_tension", "coreTension"]))
    .unwrap_or_default();
    let source_refs = source_refs_from_payload(payload)
        .or_else(|| source_refs_from_payload(primary))
        .unwrap_or_default();
    let method = string_from_payload(
        primary,
        &["method", "sourceMethod", "source_mode", "sourceMode"],
    )
    .map(|value| normalize_method(&value))
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| infer_topic_method(primary, &source_refs));
    let created_by = string_from_payload(primary, &["created_by", "createdBy"])
        .or_else(|| string_from_payload(payload, &["created_by", "createdBy"]))
        .unwrap_or_else(|| fallback_created_by.to_string());
    let created_at = integer_from_payload(primary, &["created_at", "createdAt"])
        .or_else(|| integer_from_payload(payload, &["created_at", "createdAt"]))
        .unwrap_or(now);
    let content_value = string_from_payload(
        primary,
        &[
            "content_value",
            "contentValue",
            "value",
            "promise",
            "corePromise",
        ],
    )
    .unwrap_or_default();
    let fit_reason = string_from_payload(
        primary,
        &[
            "fit_reason",
            "fitReason",
            "reason",
            "selection_reason",
            "selectionReason",
        ],
    )
    .or_else(|| frame_string(&direction_frame, &["material_entry", "materialEntry"]))
    .unwrap_or_default();
    let source_evidence = string_from_payload(
        primary,
        &[
            "source_evidence",
            "sourceEvidence",
            "evidence",
            "source",
            "sourceSummary",
            "material_entry",
            "materialEntry",
        ],
    )
    .or_else(|| frame_string(&direction_frame, &["material_entry", "materialEntry"]))
    .unwrap_or_default();
    TopicCenterRecord {
        id: string_from_payload(primary, &["id", "topicId", "topic_id"])
            .or_else(|| string_from_payload(payload, &["id", "topicId", "topic_id"]))
            .unwrap_or(fallback_id),
        title,
        content_direction,
        direction_frame,
        method,
        source_evidence,
        source_refs,
        target_reader,
        user_problem,
        content_value,
        fit_reason,
        score: number_from_payload(primary, &["score"]),
        status: string_from_payload(primary, &["status"])
            .or_else(|| string_from_payload(payload, &["status"]))
            .map(|value| normalize_status(&value))
            .unwrap_or_else(|| "active".to_string()),
        created_by,
        created_at,
        updated_at: integer_from_payload(primary, &["updated_at", "updatedAt"])
            .or_else(|| integer_from_payload(payload, &["updated_at", "updatedAt"]))
            .unwrap_or(now),
        abandoned_at: integer_from_payload(primary, &["abandoned_at", "abandonedAt"])
            .or_else(|| integer_from_payload(payload, &["abandoned_at", "abandonedAt"])),
        raw_result: Some(source.clone()),
    }
}

pub(crate) fn apply_topic_patch(record: &mut TopicCenterRecord, patch: &Value, now: i64) {
    if let Some(value) = string_from_payload(patch, &["title", "topic_name", "topicName", "name"]) {
        record.title = value;
    }
    if let Some(value) = string_from_payload(
        patch,
        &[
            "content_direction",
            "contentDirection",
            "direction",
            "core_insight",
            "coreInsight",
        ],
    ) {
        record.content_direction = value;
    }
    if let Some(value) = direction_frame_payload(patch) {
        record.direction_frame = value;
    }
    if let Some(value) = string_from_payload(patch, &["method", "sourceMethod", "sourceMode"]) {
        record.method = normalize_method(&value);
    }
    if let Some(value) = string_from_payload(
        patch,
        &[
            "source_evidence",
            "sourceEvidence",
            "evidence",
            "sourceSummary",
        ],
    ) {
        record.source_evidence = value;
    }
    if let Some(value) = source_refs_from_payload(patch) {
        record.source_refs = value;
    }
    if let Some(value) = string_from_payload(patch, &["target_reader", "targetReader", "audience"])
    {
        record.target_reader = value;
    }
    if let Some(value) = string_from_payload(
        patch,
        &[
            "user_problem",
            "userProblem",
            "pain_point",
            "painPoint",
            "core_tension",
            "coreTension",
        ],
    ) {
        record.user_problem = value;
    }
    if let Some(value) = string_from_payload(
        patch,
        &[
            "content_value",
            "contentValue",
            "value",
            "promise",
            "corePromise",
        ],
    ) {
        record.content_value = value;
    }
    if let Some(value) = string_from_payload(
        patch,
        &[
            "fit_reason",
            "fitReason",
            "reason",
            "selection_reason",
            "selectionReason",
        ],
    ) {
        record.fit_reason = value;
    }
    if let Some(value) = number_from_payload(patch, &["score"]) {
        record.score = Some(value);
    }
    if let Some(value) = string_from_payload(patch, &["status"]) {
        let status = normalize_status(&value);
        if status == "abandoned" && record.abandoned_at.is_none() {
            record.abandoned_at = Some(now);
        }
        if status != "abandoned" {
            record.abandoned_at = None;
        }
        record.status = status;
    }
    if let Some(value) = string_from_payload(patch, &["created_by", "createdBy"]) {
        record.created_by = value;
    }
    if let Some(value) = patch.get("rawResult").or_else(|| patch.get("raw_result")) {
        record.raw_result = Some(value.clone());
    }
    record.updated_at = now;
}

pub(crate) fn wander_history_from_topic_record(record: &TopicCenterRecord) -> WanderHistoryRecord {
    WanderHistoryRecord {
        id: record.id.clone(),
        items: serde_json::to_string(&record.source_refs).unwrap_or_else(|_| "[]".to_string()),
        result: serde_json::to_string(&topic_result_value(record))
            .unwrap_or_else(|_| "{}".to_string()),
        created_at: record.created_at,
        status: Some(record.status.clone()),
        abandoned_at: record.abandoned_at,
    }
}

pub(crate) fn upsert_wander_history_compat(store: &mut AppStore, record: &TopicCenterRecord) {
    let history = wander_history_from_topic_record(record);
    if let Some(existing) = store
        .wander_history
        .iter_mut()
        .find(|item| item.id == history.id)
    {
        *existing = history;
    } else {
        store.wander_history.push(history);
    }
}

pub(crate) fn remove_wander_history_compat(store: &mut AppStore, id: &str) {
    store.wander_history.retain(|record| record.id != id);
}

fn topic_result_value(record: &TopicCenterRecord) -> Value {
    let mut object = record
        .raw_result
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    object
        .entry("method".to_string())
        .or_insert_with(|| json!(record.method));
    object
        .entry("created_by".to_string())
        .or_insert_with(|| json!(record.created_by));
    object
        .entry("createdBy".to_string())
        .or_insert_with(|| json!(record.created_by));
    object
        .entry("content_direction".to_string())
        .or_insert_with(|| json!(record.content_direction));
    object
        .entry("direction_frame".to_string())
        .or_insert_with(|| direction_frame_for_result(record));
    object.entry("topic".to_string()).or_insert_with(|| {
        json!({
            "title": record.title,
            "connections": [1],
        })
    });
    Value::Object(object)
}

fn direction_frame_for_result(record: &TopicCenterRecord) -> Value {
    if record.direction_frame.is_object() {
        return record.direction_frame.clone();
    }
    json!({
        "target_reader": record.target_reader,
        "core_tension": record.user_problem,
        "angle": record.content_direction,
        "material_entry": record.source_evidence,
    })
}

fn primary_topic_payload(value: &Value) -> Option<&Value> {
    if let Some(options) = value.get("options").and_then(Value::as_array) {
        if let Some(first) = options.iter().find(|item| item.is_object()) {
            return Some(first);
        }
    }
    if let Some(options) = value.get("choices").and_then(Value::as_array) {
        if let Some(first) = options.iter().find(|item| item.is_object()) {
            return Some(first);
        }
    }
    value.is_object().then_some(value)
}

fn direction_frame_from_payload(payload: &Value) -> Value {
    direction_frame_payload(payload).unwrap_or_else(|| {
        json!({
            "target_reader": string_from_payload(payload, &["target_reader", "targetReader", "audience"]).unwrap_or_default(),
            "core_tension": string_from_payload(payload, &["user_problem", "userProblem", "pain_point", "painPoint", "core_tension", "coreTension"]).unwrap_or_default(),
            "angle": string_from_payload(payload, &["angle", "content_direction", "contentDirection", "direction"]).unwrap_or_default(),
            "material_entry": string_from_payload(payload, &["material_entry", "materialEntry", "source_evidence", "sourceEvidence"]).unwrap_or_default(),
        })
    })
}

fn direction_frame_payload(payload: &Value) -> Option<Value> {
    payload
        .get("direction_frame")
        .or_else(|| payload.get("directionFrame"))
        .filter(|value| value.is_object())
        .cloned()
}

fn source_refs_from_payload(payload: &Value) -> Option<Vec<Value>> {
    for key in [
        "source_refs",
        "sourceRefs",
        "references",
        "referenceItems",
        "items",
        "materials",
    ] {
        if let Some(items) = payload.get(key).and_then(Value::as_array) {
            return Some(items.clone());
        }
    }
    payload
        .get("sourceRef")
        .or_else(|| payload.get("source_ref"))
        .filter(|value| value.is_object())
        .map(|value| vec![value.clone()])
}

fn infer_topic_method(primary: &Value, source_refs: &[Value]) -> String {
    if let Some(method) = string_from_payload(
        primary,
        &["method", "sourceMethod", "source_mode", "sourceMode"],
    ) {
        let normalized = normalize_method(&method);
        if !normalized.is_empty() {
            return normalized;
        }
    }
    if source_refs.iter().any(is_comment_source_ref) {
        "comment_insight".to_string()
    } else {
        "wander".to_string()
    }
}

fn is_comment_source_ref(value: &Value) -> bool {
    if value.get("comments").is_some()
        || value.get("commentDigest").is_some()
        || value.get("commentSample").is_some()
    {
        return true;
    }
    let Some(meta) = value.get("meta").and_then(Value::as_object) else {
        return false;
    };
    ["sourceMode", "source_mode", "sourceType", "source_type"]
        .iter()
        .filter_map(|key| meta.get(*key).and_then(Value::as_str))
        .any(|value| value.to_ascii_lowercase().contains("comment"))
}

fn normalize_method(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "comments" | "comment" | "comment-insight" | "comment_insight" | "xhs-comment-insight" => {
            "comment_insight".to_string()
        }
        "knowledge" | "knowledge-mining" | "knowledge_mining" | "content-topic-miner" => {
            "knowledge_mining".to_string()
        }
        "history" | "history-mining" | "history_mining" => "history_mining".to_string(),
        "trend" | "trend-mining" | "trend_mining" => "trend_mining".to_string(),
        "wander" | "random" | "manual" | "wander-synthesis" => "wander".to_string(),
        other => other.to_string(),
    }
}

fn normalize_status(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "abandoned" | "discarded" | "archived" => "abandoned".to_string(),
        "draft" => "draft".to_string(),
        "used" | "selected" => "used".to_string(),
        _ => "active".to_string(),
    }
}

fn string_from_payload(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(value_to_string)
}

fn nested_string(payload: &Value, parents: &[&str], keys: &[&str]) -> Option<String> {
    parents
        .iter()
        .find_map(|parent| payload.get(*parent))
        .and_then(|value| string_from_payload(value, keys))
}

fn frame_string(frame: &Value, keys: &[&str]) -> Option<String> {
    string_from_payload(frame, keys)
}

fn value_to_string(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn number_from_payload(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        payload.get(*key).and_then(|value| {
            value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
        })
    })
}

fn integer_from_payload(payload: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        payload.get(*key).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<i64>().ok())
                })
        })
    })
}

fn short_text(value: &str, max_chars: usize) -> String {
    let text = value.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_wander_history_idempotently() {
        let mut store = AppStore::default();
        store.wander_history.push(WanderHistoryRecord {
            id: "wander-1".to_string(),
            items: serde_json::to_string(&vec![json!({
                "id": "note-1",
                "title": "素材",
                "content": "评论问题",
                "comments": [{"text": "怎么开始"}],
            })])
            .unwrap(),
            result: json!({
                "content_direction": "从不会开始切入",
                "direction_frame": {
                    "target_reader": "新手",
                    "core_tension": "想做但不敢开始",
                    "angle": "启动门槛",
                    "material_entry": "评论都在问第一步"
                },
                "topic": { "title": "别等准备好再开始", "connections": [1] }
            })
            .to_string(),
            created_at: 10,
            status: None,
            abandoned_at: None,
        });

        assert_eq!(migrate_wander_history(&mut store), 1);
        assert_eq!(migrate_wander_history(&mut store), 0);
        assert_eq!(store.topic_center.len(), 1);
        assert_eq!(store.topic_center[0].id, "wander-1");
        assert_eq!(store.topic_center[0].title, "别等准备好再开始");
        assert_eq!(store.topic_center[0].method, "comment_insight");
    }

    #[test]
    fn maps_final_topic_data_payload() {
        let record = topic_record_from_payload(
            &json!({
                    "topic_name": "每天十个选题怎么稳定产出",
                    "method": "knowledge",
                    "source_evidence": "用户目标与知识库高频问题相似",
                    "target_reader": "内容创作者",
                    "user_problem": "不知道每天写什么",
                    "core_insight": "选题不是灵感，而是方法池轮转",
                    "content_value": "给出可复用选题流程",
                    "fit_reason": "贴近用户每天生成选题的目标",
                    "score": 0.91,
                "sourceRefs": [{"id": "k1"}]
            }),
            "topic-1".to_string(),
            "agent",
            100,
        );

        assert_eq!(record.id, "topic-1");
        assert_eq!(record.title, "每天十个选题怎么稳定产出");
        assert_eq!(record.method, "knowledge_mining");
        assert_eq!(record.content_direction, "选题不是灵感，而是方法池轮转");
        assert_eq!(record.source_refs.len(), 1);
        assert_eq!(record.score, Some(0.91));

        let history = wander_history_from_topic_record(&record);
        let result = serde_json::from_str::<Value>(&history.result).unwrap();
        assert_eq!(
            result.get("method").and_then(Value::as_str),
            Some("knowledge")
        );
        assert_eq!(
            result.get("created_by").and_then(Value::as_str),
            Some("agent")
        );
    }
}
